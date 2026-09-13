const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const state = require("../state");
const { writeFileAtomic } = require("../core/fs-atomic");
const { sanitizeTestError } = require("../core/scan");
const { getLibraries, resolveLibraryRel, resolveSafeRelPath } = require("../libraries/registry");
const { subtitleCacheName, courseSubtitlePath } = require("../ai/subtitles-helpers");
const { getSubtitleDir, getSubtitleProcessedDir } = require("./workspace");

const COURSE_SUBTITLE_DIR = ".courseplayer/subtitles";
const SUBTITLE_MIN_CUE_S = 0.2;

function formatVttTime(sec) {
  const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    s,
  ).padStart(2, "0")}.${String(mm).padStart(3, "0")}`;
}

function splitCueLines(text, maxLines = 2, maxChars = 42) {
  const words = text.trim().split(/\s+/);
  if (words.length === 1) return [words[0]];
  const lines = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (lines.length === maxLines - 1) {
      cur = cur ? cur + " " + w : w;
      continue;
    }
    const candidate = cur ? cur + " " + w : w;
    if (cur && candidate.length > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text.trim()];
}

function renderVtt(segments) {
  const lines = ["WEBVTT", ""];
  for (const seg of segments) {
    if (!seg || typeof seg.text !== "string" || !seg.text.trim()) continue;
    const start = Math.max(0, Number(seg.start) || 0);
    let end = Number(seg.end) || start;
    if (end <= start) end = start + SUBTITLE_MIN_CUE_S;
    lines.push(`${formatVttTime(start)} --> ${formatVttTime(end)}`);
    for (const line of splitCueLines(seg.text)) lines.push(line);
    lines.push("");
  }
  return lines.join("\n");
}

function formatSrt(segments) {
  const lines = [];
  let n = 0;
  const toSrt = (sec) => {
    const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
      s,
    ).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  for (const seg of segments) {
    if (!seg || typeof seg.text !== "string" || !seg.text.trim()) continue;
    const start = Math.max(0, Number(seg.start) || 0);
    let end = Number(seg.end) || start;
    if (end <= start) end = start + SUBTITLE_MIN_CUE_S;
    n++;
    lines.push(String(n));
    lines.push(`${toSrt(start)} --> ${toSrt(end)}`);
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}

function parseVttSegments(vttText) {
  if (typeof vttText !== "string" || !vttText.trim()) return [];
  const lines = vttText.split(/\r?\n/);
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
      if (!cur) break;
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

async function writeCourseSubtitle(lib, rel, hash, vttText) {
  const dest = courseSubtitlePath(lib, rel, hash);
  if (!dest) return false;
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await writeFileAtomic(dest, vttText);
    return true;
  } catch (err) {
    console.log(
      `[SUBTITLE] não foi possível gravar em ${path.dirname(dest)} (${sanitizeTestError(err.message)}); mantendo espelho em data/subtitles/`,
    );
    return false;
  }
}

function getCandidateSubtitleHashes(lib, rel, primaryHash) {
  const hashes = new Set();
  if (primaryHash) hashes.add(primaryHash);
  if (typeof rel !== "string" || !rel) return [...hashes];

  if (lib && lib.id) {
    hashes.add(subtitleCacheName(lib.id, rel));
  }
  if (lib && lib.id !== state.DEFAULT_LIBRARY_ID) {
    hashes.add(subtitleCacheName(state.DEFAULT_LIBRARY_ID, rel));
  }
  hashes.add(crypto.createHash("sha1").update(rel).digest("hex").slice(0, 24));

  const parts = rel.split("/");
  for (let i = 1; i < parts.length - 1; i++) {
    const subRel = parts.slice(i).join("/");
    hashes.add(crypto.createHash("sha1").update(subRel).digest("hex").slice(0, 24));
    if (lib && lib.id) {
      hashes.add(subtitleCacheName(lib.id, subRel));
    }
    hashes.add(subtitleCacheName(state.DEFAULT_LIBRARY_ID, subRel));
  }
  return [...hashes];
}

async function resolveSubtitleVttPath(lib, rel, hash) {
  const candidateHashes = getCandidateSubtitleHashes(lib, rel, hash);

  for (const h of candidateHashes) {
    const courseVtt = courseSubtitlePath(lib, rel, h);
    if (courseVtt) {
      const st = await fs.stat(courseVtt).catch(() => null);
      if (st && st.size > 0) return courseVtt;
    }
    if (lib && lib.path && typeof rel === "string" && rel.includes("/")) {
      const parts = rel.split("/");
      for (let i = parts.length - 1; i >= 1; i--) {
        const candidate = path.join(lib.path, parts.slice(0, i).join(path.sep), COURSE_SUBTITLE_DIR, h + ".vtt");
        if (candidate !== courseVtt) {
          const st = await fs.stat(candidate).catch(() => null);
          if (st && st.size > 0) return candidate;
        }
      }
    }
    const mirror = path.join(getSubtitleDir(), h + ".vtt");
    const st = await fs.stat(mirror).catch(() => null);
    if (st && st.size > 0) return mirror;
  }

  return null;
}

async function removeCourseSubtitle(lib, rel, hash) {
  const subDir = getSubtitleDir();
  const found = await resolveSubtitleVttPath(lib, rel, hash);
  if (found && !found.startsWith(subDir)) {
    await fs.rm(found, { force: true }).catch(() => {});
  }
  const dest = courseSubtitlePath(lib, rel, hash);
  if (dest && dest !== found) {
    await fs.rm(dest, { force: true }).catch(() => {});
  }
}

async function hasFinalVtt(lib, rel, hash) {
  const vtt = await resolveSubtitleVttPath(lib, rel, hash);
  return !!vtt;
}

async function sweepCourseSubtitles() {
  const roots = getLibraries()
    .filter((l) => l.enabled !== false)
    .map((l) => l.path);
  await Promise.all(
    roots.map(async (root) => {
      let names = [];
      try {
        names = await fs.readdir(root);
      } catch {
        return;
      }
      await Promise.all(
        names
          .filter((n) => !n.startsWith(".") && n !== state.APP_DIR_NAME)
          .map(async (n) => {
            const courseSub = path.join(root, n, COURSE_SUBTITLE_DIR);
            await fs.rm(courseSub, { recursive: true, force: true }).catch(() => {});
            const parent = path.join(root, n, ".courseplayer");
            const st = await fs.stat(parent).catch(() => null);
            if (st && st.isDirectory()) {
              const items = await fs.readdir(parent).catch(() => []);
              if (items.length === 0) await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
            }
          }),
      );
    }),
  );
}

// Já existe legenda válida (processed + VTT)? Skip-if-ready
async function hasValidSubtitle(lib, rel, abs, loadValidProcessedFn = null) {
  const sourceStat = await fs.stat(abs).catch(() => null);
  if (!sourceStat) return false;
  const hash = subtitleCacheName(lib.id, rel);
  if (loadValidProcessedFn) {
    const processedPath = path.join(getSubtitleProcessedDir(), hash + ".json");
    const doc = await loadValidProcessedFn(processedPath, abs, sourceStat);
    if (doc && (await hasFinalVtt(lib, rel, hash))) return true;
  }
  if (await hasFinalVtt(lib, rel, hash)) return true;
  return false;
}

module.exports = {
  COURSE_SUBTITLE_DIR,
  SUBTITLE_MIN_CUE_S,
  formatVttTime,
  splitCueLines,
  renderVtt,
  formatSrt,
  parseVttSegments,
  writeCourseSubtitle,
  getCandidateSubtitleHashes,
  resolveSubtitleVttPath,
  removeCourseSubtitle,
  hasFinalVtt,
  sweepCourseSubtitles,
  hasValidSubtitle,
};
