const path = require("path");
const fs = require("fs/promises");
const { writeFileAtomic, readJsonFile } = require("./fs-atomic");
const { sanitizeDisplayPath } = require("./titles");
const { ensureRemovableDrivesMounted } = require("./device");
const { scanLibrary } = require("./scan");
const {
  DATA_DIR,
  treeCaches,
  scanningLibraryIds,
  tutorContextCache,
} = require("../state");

let _loadLibraries = null;
let _getLibraries = null;

function setLibraryHooks(hooks = {}) {
  if (hooks.loadLibraries) _loadLibraries = hooks.loadLibraries;
  if (hooks.getLibraries) _getLibraries = hooks.getLibraries;
}

function libraryTreeCacheFile(libId) {
  return path.join(DATA_DIR, `tree-cache-${libId}.json`);
}

async function saveLibraryTreeCache(lib, scanned) {
  if (!scanned || scanned.status !== "ok" || !scanned.tree) return;
  const file = libraryTreeCacheFile(lib.id);
  const payload = {
    version: 1,
    libraryId: lib.id,
    libraryPath: lib.path,
    status: scanned.status,
    lastScanAt: scanned.lastScanAt || Date.now(),
    tree: scanned.tree,
  };
  try {
    await writeFileAtomic(file, JSON.stringify(payload));
  } catch (err) {
    console.error(`[TREE] Falha ao persistir cache da biblioteca ${lib.name || lib.id}:`, err && err.message);
  }
}

async function loadLibraryTreeCache(lib) {
  const file = libraryTreeCacheFile(lib.id);
  const res = await readJsonFile(file);
  if (!res.ok || !res.parsed || !res.parsed.tree) return null;
  const doc = res.parsed;
  if (doc.libraryPath && path.resolve(doc.libraryPath) !== path.resolve(lib.path)) {
    return null;
  }
  const st = await fs.stat(lib.path).catch(() => null);
  if (!st || !st.isDirectory()) {
    return {
      status: "unavailable",
      error: "not a directory",
      tree: null,
      lastScanAt: doc.lastScanAt || null,
    };
  }
  return {
    status: "ok",
    error: null,
    lastScanAt: doc.lastScanAt || Date.now(),
    tree: doc.tree,
  };
}

// Formato público de uma biblioteca para /api/libraries e /api/tree (status
// computado; nunca expõe estado interno).
function librarySummary(lib, cached) {
  const tree = cached && cached.tree;
  let courseCount = 0;
  if (tree && Array.isArray(tree.children)) {
    const count = (nodes) =>
      nodes.reduce(
        (acc, n) =>
          acc +
          (n.type === "folder" ? 1 + count(n.children || []) : 0),
        0,
      );
    courseCount = count(tree.children);
  }
  const isEnabled = lib.enabled !== false;
  const isDefault = lib.isDefault === true;
  return {
    id: lib.id,
    name: lib.name,
    path: isDefault ? null : sanitizeDisplayPath(lib.path),
    enabled: isEnabled,
    isDefault,
    status: !isEnabled ? "disabled" : (cached ? cached.status : "unknown"),
    error: cached ? cached.error : null,
    lastScanAt: cached ? cached.lastScanAt : null,
    courseCount,
    tree,
  };
}

// Re-escaneia UMA biblioteca (deduplicado por id) e atualiza o cache dela (em memória e em disco).
// Retorna o summary com status/lastScanAt/error atuais.
async function rescanLibrary(lib) {
  if (scanningLibraryIds.has(lib.id)) {
    // Scan já em andamento: devolve o estado atual sem duplicar.
    return librarySummary(lib, treeCaches.get(lib.id) || {});
  }
  scanningLibraryIds.add(lib.id);
  try {
    tutorContextCache.clear();
    const scanned = await scanLibrary(lib);
    scanned.lastScanAt = Date.now();
    treeCaches.set(lib.id, scanned);
    if (scanned.status === "ok") {
      await saveLibraryTreeCache(lib, scanned);
    }
    return librarySummary(lib, scanned);
  } finally {
    scanningLibraryIds.delete(lib.id);
  }
}

// Árvore consolidada (opção A da auditoria): lista de { library, tree }.
// Scan SEQUENCIAL das bibliotecas habilitadas (pendrive/disco externo: paralelo
// martela o barramento/USB). `force` re-escaneia tudo; desativadas não escaneiam,
// mas são mantidas na lista (com status 'disabled' e sem árvore) para que o
// frontend em Configurações > Bibliotecas possa exibi-las, reativá-las ou removê-las.
// Se houver cache persistido em disco e não for `force`, o carregamento é instantâneo.
async function getTree(force) {
  let loadLibs = _loadLibraries;
  let getLibs = _getLibraries;
  if (!loadLibs || !getLibs) {
    try {
      const idx = require("../index");
      if (!loadLibs && idx.loadLibraries) loadLibs = idx.loadLibraries;
      if (!getLibs && idx.getLibraries) getLibs = idx.getLibraries;
    } catch {}
  }
  if (typeof loadLibs === "function") await loadLibs();
  const libraries = typeof getLibs === "function" ? getLibs() : [];
  const results = [];
  for (const lib of libraries) {
    if (lib.enabled === false) {
      results.push(librarySummary(lib, null));
      continue;
    }
    let cached = treeCaches.get(lib.id);
    if (!cached && !force) {
      cached = await loadLibraryTreeCache(lib).catch(() => null);
      if (cached) {
        treeCaches.set(lib.id, cached);
      }
    }
    // Se a biblioteca estava marcada como indisponível (ex.: pendrive conectado após o boot),
    // tenta verificar se o caminho já está acessível ou se pode ser montado agora.
    if (cached && cached.status === "unavailable" && !force) {
      let st = await fs.stat(lib.path).catch(() => null);
      if (!st || !st.isDirectory()) {
        await ensureRemovableDrivesMounted().catch(() => false);
        st = await fs.stat(lib.path).catch(() => null);
      }
      if (st && st.isDirectory()) {
        cached = null; // Caminho da biblioteca disponível: descarta o cache indisponível e força scan
      }
    }
    if (!cached || force) {
      results.push(await rescanLibrary(lib));
    } else {
      results.push(librarySummary(lib, cached));
    }
  }
  return { libraries: results };
}

module.exports = {
  scanningLibraryIds,
  treeCaches,
  libraryTreeCacheFile,
  saveLibraryTreeCache,
  loadLibraryTreeCache,
  librarySummary,
  rescanLibrary,
  getTree,
  setLibraryHooks,
};
