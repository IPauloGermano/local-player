// Ciclo de vida do servidor: inicialização da persistência, ociosidade, auto-shutdown e browser

const fs = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");
const state = require("../state");
const { ensureRemovableDrivesMounted } = require("../core/device");
const { readJsonFile, writeFileAtomic, writeFileAtomicSync, requestVolumeSync } = require("../core/fs-atomic");
const {
  getLibraries,
  initLibraries,
} = require("../libraries/registry");
const {
  libraryProgressDir,
  libraryProgressFile,
  libraryProgressBackupFile,
  libraryProgressBackup2File,
  readProgress,
  updateProgress,
  restoreProgressFromBackup,
  restoreLibraryProgressFromBackup,
  migrateProgressKeys,
} = require("../progress/store");
const { loadLibraryTreeCache } = require("../core/tree-cache");
const {
  loadSubtitleJobs,
  updateSubtitleJob,
  subtitleJobPersistShape,
} = require("../subtitles/pipeline");
const { cleanupSubtitleOrphans } = require("../subtitles/workspace");

function recordActivity() {
  state.lastActivityAt = Date.now();
}

function getIdleTimeoutMs() {
  if (process.env.LP_IDLE_TIMEOUT_MS !== undefined) {
    return Math.max(0, parseInt(process.env.LP_IDLE_TIMEOUT_MS, 10) || 0);
  }
  return state.idleTimeoutMinutes > 0 ? state.idleTimeoutMinutes * 60 * 1000 : 0;
}

async function loadSystemConfig() {
  try {
    const raw = await fs.readFile(state.SYSTEM_CONFIG_FILE, "utf-8");
    const json = JSON.parse(raw);
    if (typeof json.idleTimeoutMinutes === "number" && json.idleTimeoutMinutes >= 0) {
      if (process.env.LP_IDLE_TIMEOUT_MINUTES === undefined) {
        state.idleTimeoutMinutes = json.idleTimeoutMinutes;
      }
    }
  } catch {}
}

async function saveSystemConfig() {
  try {
    await writeFileAtomic(state.SYSTEM_CONFIG_FILE, JSON.stringify({ idleTimeoutMinutes: state.idleTimeoutMinutes }, null, 2));
  } catch (err) {
    console.warn("[SYSTEM] Falha ao salvar system-config.json:", err && err.message);
  }
}

async function initPersistence() {
  await ensureRemovableDrivesMounted().catch(() => {});
  await loadSystemConfig();
  await initLibraries();

  try {
    const files = await fs.readdir(state.DATA_DIR);
    await Promise.all(
      files
        .filter((f) => f.endsWith(".tmp"))
        .map((f) => fs.unlink(path.join(state.DATA_DIR, f)).catch(() => {})),
    );
  } catch {}

  for (const lib of getLibraries()) {
    const pDir = libraryProgressDir(lib);
    if (pDir && pDir !== state.DATA_DIR) {
      try {
        const files = await fs.readdir(pDir);
        await Promise.all(
          files
            .filter((f) => f.endsWith(".tmp"))
            .map((f) => fs.unlink(path.join(pDir, f)).catch(() => {})),
        );
      } catch {}
    }
  }

  try {
    await fs.mkdir(state.TRANSCODE_DIR, { recursive: true });
    const files = await fs.readdir(state.TRANSCODE_DIR);
    await Promise.all(
      files
        .filter((f) => f.endsWith(".tmp"))
        .map((f) => fs.unlink(path.join(state.TRANSCODE_DIR, f)).catch(() => {})),
    );
  } catch {}

  await restoreProgressFromBackup();
  for (const lib of getLibraries()) {
    await restoreLibraryProgressFromBackup(lib);
  }

  const [main, backup, backup2] = await Promise.all([
    readJsonFile(state.PROGRESS_FILE),
    readJsonFile(state.PROGRESS_BACKUP_FILE),
    readJsonFile(state.PROGRESS_BACKUP2_FILE),
  ]);
  if (main.ok && !backup.ok) {
    await writeFileAtomic(state.PROGRESS_BACKUP_FILE, main.raw).catch(() => {});
  }
  if (backup.ok && !backup2.ok) {
    await writeFileAtomic(state.PROGRESS_BACKUP2_FILE, backup.raw).catch(() => {});
  }
  requestVolumeSync(state.PROGRESS_FILE);

  for (const lib of getLibraries()) {
    const file = libraryProgressFile(lib);
    const bak1 = libraryProgressBackupFile(lib);
    const bak2 = libraryProgressBackup2File(lib);
    if (!file) continue;
    try {
      const [libMain, libBak, libBak2] = await Promise.all([
        readJsonFile(file),
        bak1 ? readJsonFile(bak1) : { ok: false, raw: null },
        bak2 ? readJsonFile(bak2) : { ok: false, raw: null },
      ]);
      if (libMain.ok && !libBak.ok && bak1) {
        await writeFileAtomic(bak1, libMain.raw).catch(() => {});
      }
      if (libBak.ok && !libBak2.ok && bak2) {
        await writeFileAtomic(bak2, libBak.raw).catch(() => {});
      }
      if (file) requestVolumeSync(file);
    } catch {}
  }

  await loadSubtitleJobs();
  await cleanupSubtitleOrphans();
  await migrateProgressKeys();

  try {
    const currentState = await readProgress();
    if (Object.keys(currentState).length > 0) {
      await updateProgress(() => {}, { allowShrink: false });
    }
  } catch {}

  for (const lib of getLibraries()) {
    if (lib.enabled !== false && !state.treeCaches.has(lib.id)) {
      try {
        const cached = await loadLibraryTreeCache(lib);
        if (cached) {
          state.treeCaches.set(lib.id, cached);
        }
      } catch {}
    }
  }
}

function isSystemBusy() {
  if (state.shuttingDown) return true;
  if (typeof state.heavySlots !== "undefined" && state.heavySlots.used > 0) return true;
  if (typeof state.transcodeJobs !== "undefined") {
    for (const job of state.transcodeJobs.values()) {
      if (job.status === "processing") return true;
    }
    if (typeof state.transcodeQueue !== "undefined" && state.transcodeQueue.length > 0) return true;
  }
  if (typeof state.subtitleJobs !== "undefined") {
    for (const job of state.subtitleJobs.values()) {
      if (
        job.status === "queued" ||
        ["extracting", "transcribing", "processing", "formatting"].includes(job.status)
      ) {
        return true;
      }
    }
  }
  return false;
}

function checkIdleStatus() {
  const timeoutMs = getIdleTimeoutMs();
  if (timeoutMs <= 0) return false;
  if (isSystemBusy()) {
    recordActivity();
    return false;
  }
  const elapsedMs = Date.now() - state.lastActivityAt;
  if (elapsedMs >= timeoutMs) {
    const desc = process.env.LP_IDLE_TIMEOUT_MS
      ? `${elapsedMs}ms`
      : `${state.idleTimeoutMinutes} minutos`;
    console.log(`[IDLE] Inatividade detectada por ${desc} (nenhuma aba aberta ou atividade).`);
    console.log("[IDLE] Encerrando o servidor automaticamente para economia de bateria.");
    if (state.idleCheckTimer) {
      clearInterval(state.idleCheckTimer);
      state.idleCheckTimer = null;
    }
    shutdownNow(0);
    return true;
  }
  return false;
}

function startIdleCheckLoop() {
  if (state.idleCheckTimer) clearInterval(state.idleCheckTimer);
  const intervalMs = process.env.LP_IDLE_CHECK_INTERVAL_MS
    ? Math.max(50, parseInt(process.env.LP_IDLE_CHECK_INTERVAL_MS, 10) || 60000)
    : 60000;
  state.idleCheckTimer = setInterval(checkIdleStatus, intervalMs);
  if (state.idleCheckTimer && state.idleCheckTimer.unref) {
    state.idleCheckTimer.unref();
  }
}

function openBrowserInBackground() {
  if (process.env.LP_DATA_DIR) return; // testes/sandbox
  if (process.env.LP_NO_BROWSER === "1" || process.env.LP_NO_BROWSER === "true") return;
  const host = state.HOST && state.HOST !== "0.0.0.0" && state.HOST !== "::" ? state.HOST : "127.0.0.1";
  const url = `http://${host}:${state.PORT}/`;
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function shutdownNow(code = 0) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  if (state.idleCheckTimer) {
    clearInterval(state.idleCheckTimer);
    state.idleCheckTimer = null;
  }
  console.log("[SHUTDOWN] encerrando processos e jobs ativos…");

  const subtitleProcs = [];
  for (const hash of [...state.subtitleJobs.keys()]) {
    const job = state.subtitleJobs.get(hash);
    if (!job) continue;
    if (job.status === "queued") {
      updateSubtitleJob(hash, { status: "cancelled", progress: "Cancelado", error: null }, false);
    } else if (["extracting", "transcribing", "processing", "formatting"].includes(job.status)) {
      updateSubtitleJob(hash, { status: "cancelled", progress: "Cancelando…", error: null }, false);
      if (job.proc) {
        subtitleProcs.push(job.proc);
        job.proc = null;
      }
    }
  }
  state.subtitleQueue.length = 0;

  const transcodeProcs = [...state.transcodeJobs.values()]
    .filter((j) => j.proc)
    .map((j) => j.proc);
  state.transcodeJobs.clear();
  state.transcodeQueue.length = 0;
  for (const p of subtitleProcs) { try { p.kill("SIGTERM"); } catch {} }
  for (const p of transcodeProcs) { try { p.kill("SIGTERM"); } catch {} }

  await Promise.race([
    state.progressWriteQueue,
    new Promise((resolve) => setTimeout(resolve, state.SHUTDOWN_PROGRESS_FLUSH_MS)),
  ]);

  try {
    const payload = {};
    for (const job of state.subtitleJobs.values()) {
      payload[job.hash] = subtitleJobPersistShape(job);
    }
    writeFileAtomicSync(state.SUBTITLE_JOBS_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("[SHUTDOWN] falha ao persistir jobs:", err);
  }

  let exited = false;
  const forceExit = setTimeout(() => {
    if (exited) return;
    for (const p of subtitleProcs) { try { p.kill("SIGKILL"); } catch {} }
    for (const p of transcodeProcs) { try { p.kill("SIGKILL"); } catch {} }
    exited = true;
    process.exit(code);
  }, 5000);

  if (state.server && typeof state.server.close === "function") {
    state.server.close(() => {
      if (exited) return;
      exited = true;
      clearTimeout(forceExit);
      process.exit(code);
    });
  } else {
    exited = true;
    clearTimeout(forceExit);
    process.exit(code);
  }

  setTimeout(() => {
    if (!exited) {
      for (const p of subtitleProcs) { try { p.kill("SIGKILL"); } catch {} }
      for (const p of transcodeProcs) { try { p.kill("SIGKILL"); } catch {} }
    }
  }, 3000);
}

function getIdleTimeoutMinutes() {
  return state.idleTimeoutMinutes;
}

function setIdleTimeoutMinutes(m) {
  state.idleTimeoutMinutes = m;
}

function lastActivityAt() {
  return state.lastActivityAt;
}

function setLastActivityAt(ts) {
  state.lastActivityAt = ts;
}

module.exports = {
  recordActivity,
  getIdleTimeoutMs,
  getIdleTimeoutMinutes,
  setIdleTimeoutMinutes,
  lastActivityAt,
  setLastActivityAt,
  loadSystemConfig,
  saveSystemConfig,
  initPersistence,
  isSystemBusy,
  checkIdleStatus,
  startIdleCheckLoop,
  openBrowserInBackground,
  shutdownNow,
};
