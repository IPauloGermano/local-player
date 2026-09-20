const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const { writeFileAtomic, readJsonFile } = require("../core/fs-atomic");
const { resolveLibraryRel } = require("../core/paths");
const state = require("../state");
const {
  APP_DIR,
  ROOT,
  DEFAULT_LIBRARY_ID,
} = state;

function defaultLibraryEntry() {
  return {
    id: DEFAULT_LIBRARY_ID,
    name: path.basename(ROOT) || "Biblioteca padrão",
    path: ROOT,
    enabled: true,
    isDefault: true,
    createdAt: Date.now(),
  };
}

function getLibraries() {
  return state.librariesCache || [];
}

function getLibraryById(id) {
  if (typeof id !== "string") return null;
  return getLibraries().find((l) => l.id === id) || null;
}

function getDefaultLibrary() {
  const libs = getLibraries();
  return libs.find((l) => l.isDefault) || libs[0] || null;
}

// Resolve a biblioteca de uma requisição: `libraryId` explícito (query/body) ou
// a biblioteca padrão quando ausente. Id desconhecido → null (o caller responde
// 400 — nunca degrada silenciosamente para a padrão num id digitado errado).
function requestLibrary(req) {
  if (!req) return getDefaultLibrary();
  if (typeof req === "string") {
    return getLibraryById(req) || null;
  }
  const id =
    (req.query && typeof req.query.libraryId === "string" && req.query.libraryId) ||
    (req.query && typeof req.query.libId === "string" && req.query.libId) ||
    (req.body && typeof req.body.libraryId === "string" && req.body.libraryId) ||
    (req.body && typeof req.body.libId === "string" && req.body.libId) ||
    "";
  if (!id) return getDefaultLibrary();
  return getLibraryById(id);
}

async function persistLibraries() {
  const data = { libraries: getLibraries(), updatedAt: Date.now() };
  const serialized = JSON.stringify(data, null, 2);
  const current = await readJsonFile(state.LIBRARIES_FILE);
  if (current.ok && current.raw === serialized) return;
  await writeFileAtomic(state.LIBRARIES_FILE, serialized);
}

// Garante uma identidade portátil (.courseplayer/library.json) gravada na raiz
// da própria biblioteca. Se o drive/pasta já foi usado antes em outra máquina
// ou na versão Web, recupera o mesmo id estável para preservar todos os hashes
// de legendas (sha1(libId\0rel)) e chaves de progresso sem forçar regeração.
async function ensureLibraryDiskId(libPath, proposedId = null, libName = null) {
  if (!libPath || typeof libPath !== "string") return proposedId || crypto.randomUUID();
  try {
    const metaFile = path.join(libPath, ".courseplayer", "library.json");
    const read = await readJsonFile(metaFile);
    if (read.ok && read.parsed && typeof read.parsed.id === "string" && read.parsed.id.trim()) {
      return read.parsed.id.trim();
    }
    const finalId = proposedId || crypto.randomUUID();
    await fs.mkdir(path.dirname(metaFile), { recursive: true }).catch(() => {});
    await writeFileAtomic(metaFile, JSON.stringify({ id: finalId, name: libName || path.basename(libPath) }, null, 2)).catch(() => {});
    return finalId;
  } catch {
    return proposedId || crypto.randomUUID();
  }
}

// Carrega o registry do disco. Arquivo ausente → semeia a biblioteca
// padrão; corrompido → preserva o original como .corrupt-<ts> e re-semeia.
async function loadLibraries() {
  const read = await readJsonFile(state.LIBRARIES_FILE);
  let entries = null;
  if (read.ok && read.parsed && Array.isArray(read.parsed.libraries)) {
    entries = read.parsed.libraries.filter(
      (l) => l && typeof l.id === "string" && typeof l.path === "string",
    );
  } else if (read.raw !== null) {
    console.log(
      `[LIBRARIES] ${path.basename(state.LIBRARIES_FILE)} ilegível; renomeado para .corrupt-<ts> e re-semeado`,
    );
    await fs
      .rename(state.LIBRARIES_FILE, `${state.LIBRARIES_FILE}.corrupt-${Date.now()}`)
      .catch(() => {});
  }
  if (entries === null) {
    // Arquivo não existia ou estava corrompido: semeia a biblioteca padrão inicial
    entries = [defaultLibraryEntry()];
  } else if (!entries.some((l) => l.isDefault || l.id === DEFAULT_LIBRARY_ID)) {
    entries.unshift(defaultLibraryEntry());
  }

  // Sincroniza com a identidade persistente do disco (.courseplayer/library.json)
  let needsPersist = false;
  for (const l of entries) {
    if (!l.isDefault && l.path && typeof l.path === "string") {
      const diskId = await ensureLibraryDiskId(l.path, l.id, l.name);
      if (diskId && diskId !== l.id) {
        l.id = diskId;
        needsPersist = true;
      }
    }
  }

  state.librariesCache = entries;
  if (needsPersist) {
    await persistLibraries().catch(() => {});
  }
  return state.librariesCache;
}

async function initLibraries() {
  await loadLibraries();
  return getLibraries();
}

// Valida e canonicaliza um path proposto de biblioteca. NUNCA toca o filesystem
// além do realpath (resolve symlinks/junctions). Regras da auditoria §6/§13:
// absoluto obrigatório, sem NUL/traversal, dir proibido (app/data/public/
// node_modules) e sem aninhamento com bibliotecas existentes.
async function validateLibraryPath(inputPath, ignoreLibId = null) {
  if (typeof inputPath !== "string") {
    return { ok: false, error: "path deve ser uma string" };
  }
  const p = inputPath.trim();
  if (!p) return { ok: false, error: "path vazio" };
  if (p.includes("\0")) return { ok: false, error: "path inválido" };
  if (!path.isAbsolute(p)) return { ok: false, error: "path deve ser absoluto" };
  let abs = path.resolve(p);
  try {
    abs = await fs.realpath(abs); // resolve symlinks/junctions → canônico
  } catch {}
  const sep = path.sep;
  const norm = (x) => (x.endsWith(sep) ? x.slice(0, -1) : x);
  const absN = norm(abs);
  // Diretórios proibidos: a pasta do app (e subdirs) e a pasta de dados.
  const forbidden = [
    APP_DIR,
    path.join(APP_DIR, "public"),
    path.join(APP_DIR, "node_modules"),
    state.DATA_DIR,
  ];
  for (const dir of forbidden) {
    let canon;
    try {
      canon = await fs.realpath(dir);
    } catch {
      canon = path.resolve(dir);
    }
    const c = norm(canon);
    if (c === absN || absN.startsWith(c + sep)) {
      return { ok: false, error: "diretório proibido (pasta do app/data)" };
    }
  }
  // Aninhamento com bibliotecas existentes (ancestral/descendente) — evita
  // raízes ambíguas e double-scan.
  for (const lib of getLibraries()) {
    if (ignoreLibId && lib.id === ignoreLibId) continue;
    const c = norm(lib.path);
    if (c === absN || absN.startsWith(c + sep) || c.startsWith(absN + sep)) {
      return {
        ok: false,
        error: `path conflita com biblioteca existente "${lib.name || lib.id}" (${lib.path})`,
      };
    }
  }
  return { ok: true, path: abs };
}

function setLibraries(entries) {
  state.librariesCache = entries;
  return state.librariesCache;
}

function addLibrary(entry) {
  state.librariesCache = getLibraries().concat(entry);
  return state.librariesCache;
}

function removeLibrary(id) {
  state.librariesCache = getLibraries().filter((l) => l.id !== id);
  return state.librariesCache;
}

module.exports = {
  get librariesCache() { return state.librariesCache; },
  set librariesCache(v) { state.librariesCache = v; },
  setLibraries,
  addLibrary,
  removeLibrary,
  defaultLibraryEntry,
  getLibraries,
  getLibraryById,
  getDefaultLibrary,
  requestLibrary,
  persistLibraries,
  ensureLibraryDiskId,
  loadLibraries,
  initLibraries,
  validateLibraryPath,
  resolveLibraryRel,
};
