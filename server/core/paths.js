const path = require("path");
const fs = require("fs/promises");
const { ROOT, APP_DIR } = require("../state");

// Garante que um caminho relativo pedido pelo cliente não escapa da raiz da
// biblioteca. `base` opcional ancora a resolução no path canônico de uma
// biblioteca (default: ROOT — caso particular da biblioteca padrão).
function resolveSafeRelPath(relPath, base) {
  if (typeof relPath !== "string" || !relPath) return null;
  const normalized = path.normalize(relPath).replace(/^([/\\])+/, "");
  if (normalized === ".." || normalized.startsWith(".." + path.sep) || normalized.startsWith("../")) {
    return null;
  }
  const rootBase = path.resolve(base || ROOT);
  const abs = path.resolve(rootBase, normalized);

  const isWin = process.platform === "win32";
  const absComp = isWin ? abs.toLowerCase() : abs;
  const baseComp = isWin ? rootBase.toLowerCase() : rootBase;
  const baseWithSep = baseComp.endsWith(path.sep) ? baseComp : baseComp + path.sep;

  if (absComp !== baseComp && !absComp.startsWith(baseWithSep)) return null;

  // `rel` é SEMPRE canônico com "/" — mesmo formato da árvore do scan e das
  // URLs (multiplataforma). No Windows, `path.normalize` devolveria "\" e as
  // chaves de progresso deixariam de bater com os paths vindos do scan. O
  // `abs` mantém o separador nativo porque é o que o filesystem consome.
  return { abs, rel: normalized.split(path.sep).join("/") };
}

// Análogo ao resolveSafeRelPath, ancorado no path CANÔNICO de uma biblioteca
// (config confiável) — nunca num path enviado pelo navegador. O rel volta com
// "/" (mesmo contrato); `abs` com o separador nativo do filesystem.
function resolveLibraryRel(lib, rel) {
  if (!lib || typeof lib.path !== "string" || !lib.path) return null;
  return resolveSafeRelPath(rel, lib.path);
}

// Requer que o arquivo esteja DENTRO do path canônico da biblioteca depois de
// resolver symlinks/junctions (realpath). `resolveSafeRelPath` é puramente
// lexical: um symlink DENTRO da biblioteca apontando para fora (ex.:
// link → /etc/passwd, link → o data/ de outra biblioteca) passaria por ele e o
// sendFile/ffmpeg/whisper seguiria o link. Este check fecha a brecha em todos
// os pontos que ABREM o arquivo — nunca servir/processar um alvo que escapa da
// biblioteca autorizada. Sem dependência de suporte a symlink (multiplataforma).
async function fileWithinLibrary(lib, abs) {
  if (!lib || typeof lib.path !== "string" || !lib.path || !abs) return false;
  let realDir;
  try {
    realDir = await fs.realpath(lib.path);
  } catch {
    return false;
  }
  let realFile;
  try {
    realFile = await fs.realpath(abs);
  } catch {
    return false;
  }
  const sep = path.sep;
  const isWin = process.platform === "win32";
  const rd = isWin ? realDir.toLowerCase() : realDir;
  const rf = isWin ? realFile.toLowerCase() : realFile;
  const rdWithSep = rd.endsWith(sep) ? rd : rd + sep;
  return rf === rd || rf.startsWith(rdWithSep);
}

// BUG-001: o primeiro segmento do rel canônico é a pasta do app? O app vive
// DENTRO de ROOT, então `resolveSafeRelPath` deixa passar `_LocalPlayer/*`;
// este check fecha essa brecha em qualquer rota que resolva path de cliente.
// Case-exato no Linux, case-insensitive no Windows (filesystem nativo).
function isAppDirRel(safe, lib) {
  if (!safe || !safe.abs) return false;
  const appPath = path.resolve(APP_DIR);
  const safeAbs = path.resolve(safe.abs);
  const sep = path.sep;
  if (process.platform === "win32") {
    const a = appPath.toLowerCase();
    const s = safeAbs.toLowerCase();
    const aWithSep = a.endsWith(sep) ? a : a + sep;
    return s === a || s.startsWith(aWithSep);
  }
  const aWithSep = appPath.endsWith(sep) ? appPath : appPath + sep;
  return safeAbs === appPath || safeAbs.startsWith(aWithSep);
}

module.exports = {
  resolveSafeRelPath,
  resolveLibraryRel,
  fileWithinLibrary,
  isAppDirRel,
};
