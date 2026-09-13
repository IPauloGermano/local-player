const path = require("path");
const fs = require("fs/promises");
const { readJsonFile, writeFileAtomic } = require("../core/fs-atomic");
const { sanitizeTestError } = require("../core/scan");
const {
  getSubtitleDir,
  getSubtitleProcessedDir,
  getSubtitleEditedDir,
  getSubtitleBackupDir,
} = require("./workspace");
const {
  renderVtt,
  writeCourseSubtitle,
  resolveSubtitleVttPath,
  parseVttSegments,
} = require("./vtt");

const SUBTITLE_VERSION = 1;
const SUBTITLE_EDITOR_VERSION = 1;
const SUBTITLE_EDIT_MAX_SEGMENTS = 2000;
const SUBTITLE_EDIT_MAX_TEXT = 2000;
const SUBTITLE_EDIT_MIN_S = 0.05;

async function loadValidProcessed(processedPath, abs, sourceStat) {
  const read = await readJsonFile(processedPath);
  if (!read.ok || !read.parsed || read.parsed.version !== SUBTITLE_VERSION) {
    return null;
  }
  const doc = read.parsed;
  const src = doc.source || {};
  if (src.mtimeMs === sourceStat.mtimeMs && src.size === sourceStat.size) {
    return doc;
  }
  return null;
}

async function loadEditableDoc(lib, rel, hash, abs, sourceStat) {
  // 1) Edição manual
  const editedPath = path.join(getSubtitleEditedDir(), hash + ".json");
  const ed = await readJsonFile(editedPath);
  if (ed.ok && ed.parsed && Array.isArray(ed.parsed.segments)) {
    const doc = ed.parsed;
    const src = doc.source || {};
    const staleSource =
      !sourceStat ||
      !(src.mtimeMs === sourceStat.mtimeMs && src.size === sourceStat.size);
    return {
      hash,
      rel,
      source: "edited",
      segments: doc.segments,
      version: Number.isInteger(doc.version) ? doc.version : 0,
      updatedAt: doc.updatedAt || null,
      edited: true,
      staleSource: !!staleSource,
      language: doc.language || null,
      provider: doc.provider || null,
      model: doc.model || null,
    };
  }
  // 2) Processed válido
  if (sourceStat) {
    const processedPath = path.join(getSubtitleProcessedDir(), hash + ".json");
    const proc = await loadValidProcessed(processedPath, abs, sourceStat);
    if (proc && Array.isArray(proc.segments)) {
      return {
        hash,
        rel,
        source: "processed",
        segments: proc.segments,
        version: 0,
        updatedAt: proc.createdAt || null,
        edited: false,
        staleSource: false,
        language: proc.language || null,
        provider: proc.provider || null,
        model: proc.model || null,
      };
    }
  }
  // 3) VTT final
  const vttPath = await resolveSubtitleVttPath(lib, rel, hash);
  if (vttPath) {
    const txt = await fs.readFile(vttPath, "utf8").catch(() => null);
    if (txt) {
      const segs = parseVttSegments(txt);
      if (segs && segs.length) {
        return {
          hash,
          rel,
          source: "vtt",
          segments: segs,
          version: 0,
          updatedAt: null,
          edited: false,
          staleSource: false,
          language: null,
          provider: null,
          model: null,
        };
      }
    }
  }
  return null;
}

function validateEditorSegments(segments) {
  if (!Array.isArray(segments) || segments.length > SUBTITLE_EDIT_MAX_SEGMENTS) {
    return null;
  }
  const out = [];
  const ids = new Set();
  for (const s of segments) {
    if (!s || typeof s !== "object") return null;
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : null;
    if (!id || id.length > 64 || ids.has(id)) return null;
    const start = Number(s.start);
    const end = Number(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < 0) return null;
    if (end - start < SUBTITLE_EDIT_MIN_S) return null;
    const text = typeof s.text === "string" ? s.text.replace(/\r\n/g, "\n").trim() : null;
    if (text === null || !text || text.length > SUBTITLE_EDIT_MAX_TEXT) return null;
    ids.add(id);
    out.push({
      id,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text,
    });
  }
  return out.length ? out : null;
}

async function saveEditedSubtitle(lib, rel, hash, abs, segments, expectedVersion, sourceStat) {
  const editedPath = path.join(getSubtitleEditedDir(), hash + ".json");
  const cur = await readJsonFile(editedPath);
  const curVersion =
    cur.ok && Number.isInteger(cur.parsed.version) ? cur.parsed.version : 0;
  if (expectedVersion != null && expectedVersion !== curVersion) {
    return { conflict: true, serverVersion: curVersion };
  }
  const version = curVersion + 1;
  const now = new Date().toISOString();
  const doc = {
    editorVersion: SUBTITLE_EDITOR_VERSION,
    docVersion: SUBTITLE_VERSION,
    source: { rel, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
    segments,
    version,
    updatedAt: now,
    editedAt: now,
  };
  await fs.mkdir(getSubtitleEditedDir(), { recursive: true });
  await writeFileAtomic(editedPath, JSON.stringify(doc, null, 2));
  const vttText = renderVtt(segments);
  await writeFileAtomic(path.join(getSubtitleDir(), hash + ".vtt"), vttText);
  await writeCourseSubtitle(lib, rel, hash, vttText);
  return { conflict: false, version, updatedAt: now };
}

async function backupEditedSubtitle(hash) {
  const editedPath = path.join(getSubtitleEditedDir(), hash + ".json");
  const st = await fs.stat(editedPath).catch(() => null);
  if (!st) return false;
  try {
    await fs.mkdir(getSubtitleBackupDir(), { recursive: true });
    const backupName = `${hash}.${Date.now()}.json`;
    await fs.copyFile(editedPath, path.join(getSubtitleBackupDir(), backupName));
    await fs.rm(editedPath, { force: true });
    console.log(`[SUBTITLE] versão editada preservada em backup/${backupName}`);
    return true;
  } catch (err) {
    console.log(
      `[SUBTITLE] não foi possível preservar a edição manual (${sanitizeTestError(
        err.message,
      )})`,
    );
    return false;
  }
}

module.exports = {
  SUBTITLE_EDITOR_VERSION,
  SUBTITLE_EDIT_MAX_SEGMENTS,
  SUBTITLE_EDIT_MAX_TEXT,
  SUBTITLE_EDIT_MIN_S,
  loadEditableDoc,
  validateEditorSegments,
  saveEditedSubtitle,
  backupEditedSubtitle,
};
