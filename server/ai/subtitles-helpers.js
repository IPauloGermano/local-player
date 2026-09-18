// Utilitários de Legendas, Nomes de Cache e Segmentação
const crypto = require("crypto");
const path = require("path");
const os = require("os");
// Parser canônico compartilhado com o frontend (public/scope.js, puro).
const { parseVttSegments } = require("../../public/scope.js");

const COURSE_SUBTITLE_DIR = path.join(".courseplayer", "subtitles");

function transcodeCacheName(libId, rel) {
  return crypto
    .createHash("sha1")
    .update(`${libId}\0${rel}`)
    .digest("hex")
    .slice(0, 24) + ".mp4";
}

function subtitleCacheName(libId, rel) {
  return crypto
    .createHash("sha1")
    .update(`${libId}\0${rel}`)
    .digest("hex")
    .slice(0, 24);
}

function courseSubtitlePath(lib, rel, hash) {
  if (!lib || !lib.path) return null;
  const idx = rel.indexOf("/");
  if (idx <= 0) return null;
  const courseName = rel.slice(0, idx);
  return path.join(lib.path, courseName, COURSE_SUBTITLE_DIR, hash + ".vtt");
}

function getOptimalTranscriptionThreads(configuredThreads) {
  if (typeof configuredThreads === "number" && configuredThreads > 0) {
    return Math.min(16, Math.max(1, Math.floor(configuredThreads)));
  }
  const cpus = (os.cpus() && os.cpus().length) || 4;
  return Math.max(1, Math.min(8, cpus));
}

// Nome histórico mantido (pipeline, tutor, testes): delega ao parser canônico
// de public/scope.js — mesma lógica, sem duplicação.
function parseSubtitleSegments(text) {
  return parseVttSegments(text);
}

module.exports = {
  transcodeCacheName,
  subtitleCacheName,
  courseSubtitlePath,
  getOptimalTranscriptionThreads,
  parseSubtitleSegments,
};
