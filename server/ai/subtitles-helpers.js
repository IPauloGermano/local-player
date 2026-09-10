// Utilitários de Legendas, Nomes de Cache e Segmentação
const crypto = require("crypto");
const path = require("path");
const os = require("os");

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

function parseSubtitleSegments(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const cleanText = text.replace(/^\uFEFF/, "");
  const lines = cleanText.split(/\r?\n/);
  const segments = [];

  const parseTimestamp = (str) => {
    const parts = str.trim().replace(",", ".").split(":");
    if (parts.length === 3) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    } else if (parts.length === 2) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(str) || 0;
  };

  const tsRegex = /((?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?)\s+-->\s+((?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = tsRegex.exec(line);
    if (!match) continue;

    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);

    const textLines = [];
    i++;
    while (i < lines.length) {
      const cur = lines[i].trim();
      if (!cur) {
        break;
      }
      if (tsRegex.test(cur) || (i + 1 < lines.length && /^\d+$/.test(cur) && tsRegex.test(lines[i + 1].trim()))) {
        i--;
        break;
      }
      if (!/^\d+$/.test(cur)) {
        textLines.push(cur.replace(/<[^>]*>/g, "").trim());
      }
      i++;
    }

    const segText = textLines.join(" ").trim();
    if (segText && Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      segments.push({ id: `s${segments.length + 1}`, start, end, text: segText });
    }
  }
  return segments;
}

module.exports = {
  transcodeCacheName,
  subtitleCacheName,
  courseSubtitlePath,
  getOptimalTranscriptionThreads,
  parseSubtitleSegments,
};
