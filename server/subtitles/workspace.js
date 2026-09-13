const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const state = require("../state");
const { loadAiConfig, objOr } = require("../ai/config");

function getSubtitleDir() {
  return path.join(state.DATA_DIR, "subtitles");
}
function getSubtitleRawDir() {
  return path.join(getSubtitleDir(), "raw");
}
function getSubtitleProcessedDir() {
  return path.join(getSubtitleDir(), "processed");
}
function getSubtitleWorkDir() {
  return path.join(getSubtitleDir(), "work");
}
function getSubtitleEditedDir() {
  return path.join(getSubtitleDir(), "edited");
}
function getSubtitleBackupDir() {
  return path.join(getSubtitleDir(), "backup");
}
function getSubtitleJobsFile() {
  return path.join(getSubtitleDir(), "jobs.json");
}

const WORKSPACE_AUTO_ROOT = path.join(os.tmpdir(), "local-player-workspace");
const WORKSPACE_MIN_FREE_BYTES = 300 * 1024 * 1024;
const WORKSPACE_SUBDIRS = ["audio", "work"];

async function safeMkdir(dir) {
  const stack = [];
  let cur = path.resolve(String(dir).slice(0, 4096));
  for (;;) {
    try {
      await fs.access(cur);
      break;
    } catch {
      /* ENOENT — caminho ainda não existe */
    }
    stack.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    await fs.mkdir(stack[i]);
  }
}

async function resolveWorkspaceDir(cfg) {
  const w = objOr(cfg && cfg.workspace, {});
  const want =
    w.mode === "custom" && w.dir
      ? path.resolve(String(w.dir).slice(0, 2048))
      : null;
  const dir = want || WORKSPACE_AUTO_ROOT;
  for (const sub of WORKSPACE_SUBDIRS) {
    try {
      await safeMkdir(path.join(dir, sub));
    } catch (err) {
      if (want) return resolveWorkspaceDir({ workspace: { mode: "auto", dir: "" } });
      throw err;
    }
  }
  return dir;
}

async function ensureWorkspaceWritable(dir) {
  await safeMkdir(dir);
  const probe = path.join(dir, ".lp-workspace-probe");
  await fs.writeFile(probe, "ok", { encoding: "utf8" });
  await fs.rm(probe, { force: true });
  return dir;
}

async function getWorkspaceFreeBytes(dir) {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

async function ensureWorkspaceSpace(dir, durationSeconds) {
  const free = await getWorkspaceFreeBytes(dir);
  if (free === null) return null;
  const need = Math.min(
    Math.max(durationSeconds * 32000, 64 * 1024 * 1024),
    1024 * 1024 * 1024,
  ) + 32 * 1024 * 1024;
  if (free < WORKSPACE_MIN_FREE_BYTES || free < need) {
    return { free, need };
  }
  return null;
}

function subtitleJobKeepSet() {
  const keep = new Set();
  const active = new Set([
    "queued", "extracting", "transcribing", "processing", "formatting",
  ]);
  for (const job of state.subtitleJobs.values()) {
    if (active.has(job.status)) keep.add(job.hash);
  }
  return keep;
}

async function cleanupWorkspace(cfg) {
  const dir = await resolveWorkspaceDir(cfg);
  const keep = subtitleJobKeepSet();
  let removed = 0;
  for (const sub of WORKSPACE_SUBDIRS) {
    const subdir = path.join(dir, sub);
    const names = await fs.readdir(subdir).catch(() => []);
    for (const n of names) {
      const m = /^([0-9a-f]{24})\./.exec(n);
      if (m && keep.has(m[1])) continue;
      await fs.rm(path.join(subdir, n), { force: true }).catch(() => {});
      removed++;
    }
  }
  return { removed };
}

async function cleanupSubtitleOrphans() {
  const keep = subtitleJobKeepSet();
  let removed = 0;
  try {
    const cfg = await loadAiConfig();
    const dir = await resolveWorkspaceDir(cfg);
    for (const sub of WORKSPACE_SUBDIRS) {
      const subdir = path.join(dir, sub);
      const names = await fs.readdir(subdir).catch(() => []);
      for (const n of names) {
        const m = /^([0-9a-f]{24})\./.exec(n);
        if (m && keep.has(m[1])) continue;
        await fs.rm(path.join(subdir, n), { force: true }).catch(() => {});
        removed++;
      }
    }
  } catch {}
  const legacy = await fs.readdir(getSubtitleWorkDir()).catch(() => []);
  for (const n of legacy) {
    const m = /^([0-9a-f]{24})\.(json|txt)$/.exec(n);
    if (!m) continue;
    if (keep.has(m[1])) continue;
    await fs.rm(path.join(getSubtitleWorkDir(), n), { force: true }).catch(() => {});
    removed++;
  }
  if (removed) {
    console.log(`[SUBTITLE][INFO] boot: ${removed} arquivo(s) derivado(s) órfão(s) removido(s)`);
  }
  return { removed };
}

async function ensureSubtitleDirs() {
  await Promise.all([
    fs.mkdir(getSubtitleDir(), { recursive: true }),
    fs.mkdir(getSubtitleRawDir(), { recursive: true }),
    fs.mkdir(getSubtitleProcessedDir(), { recursive: true }),
    fs.mkdir(getSubtitleWorkDir(), { recursive: true }),
    fs.mkdir(getSubtitleEditedDir(), { recursive: true }),
    fs.mkdir(getSubtitleBackupDir(), { recursive: true }),
  ]);
}

module.exports = {
  getSubtitleDir,
  getSubtitleRawDir,
  getSubtitleProcessedDir,
  getSubtitleWorkDir,
  getSubtitleEditedDir,
  getSubtitleBackupDir,
  getSubtitleJobsFile,
  get SUBTITLE_DIR() { return getSubtitleDir(); },
  get SUBTITLE_RAW_DIR() { return getSubtitleRawDir(); },
  get SUBTITLE_PROCESSED_DIR() { return getSubtitleProcessedDir(); },
  get SUBTITLE_WORK_DIR() { return getSubtitleWorkDir(); },
  get SUBTITLE_EDITED_DIR() { return getSubtitleEditedDir(); },
  get SUBTITLE_BACKUP_DIR() { return getSubtitleBackupDir(); },
  get SUBTITLE_JOBS_FILE() { return getSubtitleJobsFile(); },
  WORKSPACE_AUTO_ROOT,
  WORKSPACE_MIN_FREE_BYTES,
  WORKSPACE_SUBDIRS,
  safeMkdir,
  resolveWorkspaceDir,
  ensureWorkspaceWritable,
  getWorkspaceFreeBytes,
  ensureWorkspaceSpace,
  subtitleJobKeepSet,
  cleanupWorkspace,
  cleanupSubtitleOrphans,
  ensureSubtitleDirs,
};
