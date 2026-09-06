// Utilitários de Legendas, Nomes de Cache, Segmentação e Guardrails de Tradução
const crypto = require("crypto");
const path = require("path");
const os = require("os");

const APP_DIR = path.resolve(__dirname, "..", "..");
const COURSE_SUBTITLE_DIR = path.join(".courseplayer", "subtitles");

function getDataDir() {
  return process.env.LP_DATA_DIR
    ? path.resolve(process.env.LP_DATA_DIR)
    : path.join(APP_DIR, "data");
}

function clampStr(v, max) {
  return typeof v === "string" ? v.slice(0, max) : "";
}

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

function translationCacheName(hash, lang) {
  return `${hash}-${clampStr(lang, 10)}`;
}

function translationDocPath(hash, lang) {
  const subtitleTranslationDir = path.join(getDataDir(), "subtitles", "translations");
  return path.join(subtitleTranslationDir, translationCacheName(hash, lang) + ".json");
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

function subtitleTranslatePrompt(targetLang, keepTerms) {
  const termsRule = keepTerms
    ? "\n" +
      "- PRESERVE SEM TRADUZIR: termos técnicos, nomes de linguagens de programação (SQL, Python, " +
      "Node.js...), código, comandos, marcas, siglas, números, unidades, nomes próprios e títulos " +
      "de produtos/ferramentas."
    : "";
  return (
    "Você é um tradutor profissional de legendas de vídeo para " +
    targetLang +
    ". Recebe um JSON array de objetos {\"id\", \"text\"} com a transcrição em outro idioma. " +
    "Para cada item devolva a TRADUÇÃO FIEL e fluente para " +
    targetLang +
    ".\n" +
    "Regras obrigatórias:\n" +
    "- Traduza o significado exato do texto; não resuma, não explique, não adicione nem omita." +
    termsRule +
    "\n" +
    "- Use gramática, pontuação e ortografia corretas em " +
    targetLang +
    " (variação Brasil).\n" +
    "- NÃO altere os \"id\" e devolva exatamente o mesmo conjunto de ids, um por item, na " +
    "mesma ordem.\n" +
    "- NÃO inclua timestamps (você não os recebe e não deve retorná-los).\n" +
    "- Devolva SOMENTE um JSON array: [{\"id\": \"...\", \"text\": \"...\"}, ...] sem " +
    "texto antes ou depois."
  );
}

function applyLlmTranslationGuardrail(original, translated) {
  const arr = Array.isArray(translated)
    ? translated
    : translated && Array.isArray(translated.segments)
      ? translated.segments
      : null;
  if (!arr || !Array.isArray(arr)) return null;

  const expected = new Set(original.map((s) => s.id));
  const byId = new Map(original.map((s) => [s.id, s]));
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    if (!item || typeof item.id === "undefined") return null;
    const id = String(item.id);
    if (!expected.has(id)) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    if (typeof item.text !== "string") return null;
    out.push({
      id,
      text: item.text.trim(),
      start: byId.get(id).start,
      end: byId.get(id).end,
    });
  }
  if (seen.size !== expected.size) return null;

  out.sort(
    (a, b) => original.findIndex((s) => s.id === a.id) - original.findIndex((s) => s.id === b.id),
  );

  for (let i = 0; i < out.length; i++) {
    const oLen = original[i].text.replace(/\s+/g, "").length;
    const cLen = out[i].text.replace(/\s+/g, "").length;
    if (oLen > 0 && (cLen < oLen * 0.25 || cLen > oLen * 6)) return null;
  }
  return out;
}

module.exports = {
  transcodeCacheName,
  subtitleCacheName,
  translationCacheName,
  translationDocPath,
  courseSubtitlePath,
  getOptimalTranscriptionThreads,
  parseSubtitleSegments,
  subtitleTranslatePrompt,
  applyLlmTranslationGuardrail,
};
