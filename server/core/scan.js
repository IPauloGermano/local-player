const path = require("path");
const fs = require("fs/promises");
const { naturalSort, normalizeDisplayTitle } = require("./titles");
const { APP_DIR_NAME } = require("../state");

const VIDEO_EXT = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".m4v",
  ".wmv",
]);

const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
]);

// Tipos com CONTEÚDO ATIVO que o navegador pode executar quando renderizados no
// top-level (HTML/SVG/XML/JS/JSON). Materiais desses tipos são servidos como
// download (Content-Disposition: attachment) para nunca rodarem no origin da
// app; `X-Content-Type-Options: nosniff` cobre o restante (anti MIME-sniff).
const ACTIVE_EXT = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".svg",
  ".xml",
  ".js",
  ".mjs",
  ".json",
]);

const IGNORED_EXT = new Set([".ini", ".db", ".lnk"]);

const COVER_NAME_HINTS = [
  "cover",
  "thumbnail",
  "poster",
  "banner",
  "image",
  "img",
];

function pickCoverImage(entries, relDir) {
  const candidates = [];
  for (const entry of entries) {
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    const lowerName = entry.name.toLowerCase();
    const hintScore = COVER_NAME_HINTS.some((hint) => lowerName.includes(hint))
      ? 100
      : 0;
    candidates.push({ relPath, score: hintScore, name: lowerName });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates[0].relPath;
}

function chooseCoverImage(currentCover, childCovers) {
  const candidates = [];
  if (currentCover) {
    candidates.push({ relPath: currentCover, score: 200, name: currentCover });
  }
  for (const childCover of childCovers) {
    if (!childCover) continue;
    candidates.push({
      relPath: childCover.relPath,
      score: childCover.score,
      name: childCover.name,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates[0].relPath;
}

// BUG-005: stats do scan com concorrência limitada. Em bibliotecas grandes o
// fs.stat sequencial é o gargalo do scan (medido: ~5x mais lento que um pool
// pequeno neste pendrive), mas disparar tudo de uma vez explode o número de
// file descriptors abertos. Este pool executa `fn` sobre `items` com no
// máximo `limit` chamadas simultâneas e preserva a ordem por índice.
const SCAN_STAT_CONCURRENCY = 16;
const SCAN_DIR_CONCURRENCY = 8;
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const count = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function scanDir(absDir, relDir) {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return { children: [], videoCount: 0, coverImage: null, type: "folder" };
  }

  const dirs = [];
  const files = [];
  // Marcador explícito `.topic` (arquivo vazio) dentro da pasta declara que
  // ela é um TÓPICO. É dotfile: ignorado pelo scan (nunca vira material nem
  // resultado de busca) e pelo static — não pode ser confundido com
  // `.courseplayer` (pasta de artefatos de legenda, propósito diferente).
  let hasTopicMarker = false;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      if (entry.name === ".topic" && !entry.isDirectory()) hasTopicMarker = true;
      continue;
    }
    if (relDir === "" && entry.name === APP_DIR_NAME) continue;
    // Sem suporte a symlinks/junctions (invariante multiplataforma): um link
    // dentro da biblioteca pode apontar para FORA dela. Não indexar diretórios
    // linkados (evita recursão fora da raiz) nem arquivos linkados (não podem
    // ser servidos/processados). O realpath containment no serve/processo é a
    // segunda barreira para paths vindos do frontend.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) dirs.push(entry);
    else files.push(entry);
  }
  dirs.sort(naturalSort);
  files.sort(naturalSort);

  const directCover = pickCoverImage(files, relDir);

  // Filtra antes de estat: ignora extensões e a capa direta (mesma lógica
  // sequencial anterior), montando a lista de candidatos com os dados fixos.
  const candidates = [];
  for (const entry of files) {
    const ext = path.extname(entry.name).toLowerCase();
    if (IGNORED_EXT.has(ext)) continue;
    const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    // A imagem de capa/banner é usada como thumbnail do card, não deve
    // aparecer como material na sidebar nem nos resultados de busca.
    if (entryRel === directCover) continue;
    candidates.push({ entry, ext, entryRel });
  }

  // Executa o scan das subpastas (com concorrência controlada) e o stat dos
  // arquivos da pasta atual em paralelo. A ordem é preservada por mapLimit.
  const [subResults, sizes] = await Promise.all([
    mapLimit(dirs, SCAN_DIR_CONCURRENCY, async (entry) => {
      const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const entryAbs = path.join(absDir, entry.name);
      const sub = await scanDir(entryAbs, entryRel);
      return { entry, entryRel, sub };
    }),
    mapLimit(candidates, SCAN_STAT_CONCURRENCY, async (c) => {
      try {
        return (await fs.stat(path.join(absDir, c.entry.name))).size;
      } catch {
        return null;
      }
    }),
  ]);

  const children = [];
  let videoCount = 0;
  const childCoverCandidates = [];

  for (const { entry, entryRel, sub } of subResults) {
    videoCount += sub.videoCount;
    children.push({
      // Classificação explícita: "topic" (marcador `.topic` ou nome com "(TP)")
      // ou "folder" (curso/module — comportamento normal). Sem heurística.
      type: sub.type,
      name: entry.name,
      path: entryRel,
      // Tópicos: título normalizado sem prefixo de módulo e sem numeração
      // inicial ("1. Language" -> "Language", "(TP)" removido); a primeira
      // letra vem sempre maiúscula (toDisplayCase). Módulos/cursos mantêm a
      // numeração.
      title: normalizeDisplayTitle(
        entry.name,
        sub.type === "topic"
          ? { keepNumber: false }
          : { keepNumber: true },
      ),
      children: sub.children,
      videoCount: sub.videoCount,
      coverImage: sub.coverImage,
    });
    if (sub.coverImage) {
      childCoverCandidates.push({
        relPath: sub.coverImage,
        score: 50,
        name: sub.coverImage.toLowerCase(),
      });
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    const { entry, ext, entryRel } = candidates[i];
    const size = sizes[i];
    if (size === null) continue;
    if (VIDEO_EXT.has(ext)) {
      videoCount += 1;
      children.push({
        type: "video",
        name: entry.name,
        path: entryRel,
        ext,
        size,
        // Título de exibição já normalizado (prefixos, numeração e
        // capitalização padronizados), calculado na camada de dados — vale
        // para todos os cursos, atuais e futuros, e evita duplicar a
        // lógica em cada ponto de renderização.
        title: normalizeDisplayTitle(entry.name, { isVideo: true }),
      });
    } else {
      children.push({
        type: "file",
        name: entry.name,
        path: entryRel,
        ext,
        size,
      });
    }
  }

  // Classificação explícita e previsível (sem inferência estrutural):
  //   - arquivo `.topic` dentro da pasta  ⇒ TÓPICO
  //   - nome real terminando em "(TP)"    ⇒ TÓPICO
  //   - senão                             ⇒ folder (curso/módulo normal)
  // Todo o restante (conteúdo direto, subpastas, profundidade, contagens de
  // vídeo/aula) NÃO influencia. O `name` real nunca muda; "(TP)" é removido
  // só do título de exibição em normalizeDisplayTitle.
  const isTopicBySuffix = /\(TP\)\s*$/i.test(path.basename(absDir));
  const type = hasTopicMarker || isTopicBySuffix ? "topic" : "folder";

  const coverImage = chooseCoverImage(directCover, childCoverCandidates);

  return { children, videoCount, coverImage, type };
}

function sanitizeTestError(msg) {
  return String(msg).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

// Scan de UMA biblioteca com try/catch próprio: uma biblioteca indisponível
// retorna { status:"unavailable", error } sem lançar e não derruba as demais.
async function scanLibrary(lib) {
  try {
    // Caminho inexistente/inacessível ⇒ unavailable. O scanDir sozinho
    // engoliria ENOENT e devolveria árvore vazia com status "ok", mascarando
    // um drive desmontado como biblioteca válida sem cursos.
    const st = await fs.stat(lib.path);
    if (!st.isDirectory()) {
      return { status: "unavailable", error: "not a directory", tree: null };
    }
    const result = await scanDir(lib.path, "");
    return {
      status: "ok",
      error: null,
      tree: {
        children: result.children,
        videoCount: result.videoCount,
        scannedAt: Date.now(),
      },
    };
  } catch (err) {
    return {
      status: "unavailable",
      error: sanitizeTestError(err.message || "scan error"),
      tree: null,
    };
  }
}

module.exports = {
  VIDEO_EXT,
  IMAGE_EXT,
  ACTIVE_EXT,
  IGNORED_EXT,
  COVER_NAME_HINTS,
  SCAN_STAT_CONCURRENCY,
  SCAN_DIR_CONCURRENCY,
  pickCoverImage,
  chooseCoverImage,
  mapLimit,
  scanDir,
  scanLibrary,
  sanitizeTestError,
};
