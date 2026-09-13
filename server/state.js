const path = require("path");

const APP_DIR = path.resolve(__dirname, "..");
const DEFAULT_LIBRARY_ID = "default";
const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const MAX_LOG_ENTRIES = 800;
const TRANSCODE_SEEK_WAIT_MS = 60000;
const SHUTDOWN_PROGRESS_FLUSH_MS = 2000;

function getRootDir() {
  return process.env.LP_ROOT_DIR
    ? path.resolve(process.env.LP_ROOT_DIR)
    : path.resolve(APP_DIR, "..");
}

function getDataDir() {
  return process.env.LP_DATA_DIR
    ? path.resolve(process.env.LP_DATA_DIR)
    : path.join(APP_DIR, "data");
}

let idleTimeoutMinutes = process.env.LP_IDLE_TIMEOUT_MINUTES !== undefined
  ? Math.max(0, parseInt(process.env.LP_IDLE_TIMEOUT_MINUTES, 10) || 0)
  : DEFAULT_IDLE_TIMEOUT_MINUTES;

let lastActivityAt = Date.now();
let idleCheckTimer = null;
let server = null;
let shuttingDown = false;
let librariesCache = null;
let progressWriteQueue = Promise.resolve();
let subtitleJobsLoaded = false;

const MAX_CONCURRENT_AI_JOBS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AI_JOBS || "1", 10),
);
let heavyMax = MAX_CONCURRENT_AI_JOBS;
const heavySlots = { used: 0, waiters: [] };

function acquireHeavySlot() {
  return new Promise((resolve) => {
    if (heavySlots.used < heavyMax) {
      heavySlots.used++;
      resolve(releaseHeavySlot);
    } else {
      heavySlots.waiters.push(resolve);
    }
  });
}

function releaseHeavySlot() {
  heavySlots.used = Math.max(0, heavySlots.used - 1);
  const next = heavySlots.waiters.shift();
  if (next) {
    heavySlots.used++;
    next(releaseHeavySlot);
  }
}

function refreshHeavyMax(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) {
    heavyMax = Math.min(8, Math.floor(n));
  }
  while (heavySlots.used < heavyMax && heavySlots.waiters.length > 0) {
    const next = heavySlots.waiters.shift();
    if (next) {
      heavySlots.used++;
      next(releaseHeavySlot);
    }
  }
}

const MAX_CONCURRENT_TRANSCODES = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_TRANSCODES || "1", 10),
);

// Mapas e filas compartilhadas (singletons)
const treeCaches = new Map(); // libraryId -> { status, error, tree, lastScanAt }
const transcodeJobs = new Map(); // cacheName -> job
const transcodeQueue = [];
const subtitleJobs = new Map(); // hash -> job
const subtitleQueue = [];
const logBuffer = []; // { ts, level, tag, msg }
const scanningLibraryIds = new Set(); // bibliotecas com scan em andamento
const tutorContextCache = new Map(); // lessonKey -> context

module.exports = {
  APP_DIR,
  DEFAULT_LIBRARY_ID,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  MAX_LOG_ENTRIES,
  TRANSCODE_SEEK_WAIT_MS,
  SHUTDOWN_PROGRESS_FLUSH_MS,
  MAX_CONCURRENT_AI_JOBS,
  MAX_CONCURRENT_TRANSCODES,
  get ROOT() { return getRootDir(); },
  get APP_DIR_NAME() { return path.basename(APP_DIR); },
  get DATA_DIR() { return getDataDir(); },
  get PROGRESS_FILE() { return path.join(getDataDir(), "progress.json"); },
  get PROGRESS_BACKUP_FILE() { return path.join(getDataDir(), "progress.json.bak"); },
  get PROGRESS_BACKUP2_FILE() { return path.join(getDataDir(), "progress.json.bak.1"); },
  get LIBRARIES_FILE() { return path.join(getDataDir(), "libraries.json"); },
  get SYSTEM_CONFIG_FILE() { return path.join(getDataDir(), "system-config.json"); },
  get AI_CONFIG_FILE() { return path.join(getDataDir(), "ai-config.json"); },
  get TRANSCODE_DIR() { return path.join(getDataDir(), "transcoded"); },
  get SUBTITLE_JOBS_FILE() { return path.join(getDataDir(), "subtitles", "jobs.json"); },
  get PORT() { return process.env.PORT || 4173; },
  get HOST() { return process.env.HOST || "127.0.0.1"; },
  get SPA_INDEX_PATH() { return path.join(APP_DIR, "public", "index.html"); },

  // Singletons mutáveis
  treeCaches,
  transcodeJobs,
  transcodeQueue,
  subtitleJobs,
  subtitleQueue,
  logBuffer,
  heavySlots,
  acquireHeavySlot,
  releaseHeavySlot,
  refreshHeavyMax,
  scanningLibraryIds,
  tutorContextCache,

  get heavyMax() { return heavyMax; },
  set heavyMax(v) { heavyMax = v; },

  get idleTimeoutMinutes() { return idleTimeoutMinutes; },
  set idleTimeoutMinutes(v) { idleTimeoutMinutes = v; },

  get lastActivityAt() { return lastActivityAt; },
  set lastActivityAt(v) { lastActivityAt = v; },

  get idleCheckTimer() { return idleCheckTimer; },
  set idleCheckTimer(v) { idleCheckTimer = v; },

  get server() { return server; },
  set server(v) { server = v; },

  get shuttingDown() { return shuttingDown; },
  set shuttingDown(v) { shuttingDown = v; },

  get librariesCache() { return librariesCache; },
  set librariesCache(v) { librariesCache = v; },

  get progressWriteQueue() { return progressWriteQueue; },
  set progressWriteQueue(v) { progressWriteQueue = v; },

  get subtitleJobsLoaded() { return subtitleJobsLoaded; },
  set subtitleJobsLoaded(v) { subtitleJobsLoaded = v; },
};
