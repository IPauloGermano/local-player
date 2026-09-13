const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const state = require("../state");
const { readJsonFile, writeFileAtomic } = require("../core/fs-atomic");
const { sanitizeTestError } = require("../core/scan");
const { resolveSafeRelPath, resolveLibraryRel, fileWithinLibrary } = require("../core/paths");
const { getLibraryById, getDefaultLibrary, DEFAULT_LIBRARY_ID } = require("../libraries/registry");
const { loadAiConfig, findTranscriptionProvider } = require("../ai/config");
const {
  subtitleCacheName,
  courseSubtitlePath,
  getOptimalTranscriptionThreads,
  parseSubtitleSegments,
} = require("../ai/subtitles-helpers");

const {
  getSubtitleDir,
  getSubtitleRawDir,
  getSubtitleProcessedDir,
  getSubtitleWorkDir,
  getSubtitleJobsFile,
  WORKSPACE_AUTO_ROOT,
  resolveWorkspaceDir,
  ensureWorkspaceSpace,
  ensureSubtitleDirs,
} = require("./workspace");

const {
  renderVtt,
  writeCourseSubtitle,
  hasFinalVtt,
  hasValidSubtitle,
} = require("./vtt");

const { postprocessSegments } = require("./postprocess");
const { backupEditedSubtitle } = require("./editor");

const PRIORITY_DEMAND = 0;
const PRIORITY_NEXT = 1;
const PRIORITY_FIRST = 2;
const PRIORITY_BG = 3;
const PREEMPT_GRACE_MS = 20000;
const PREEMPT_RETRY_PRIORITY = PRIORITY_BG;
const BACKGROUND_BATCH = 20;

const SUBTITLE_VERSION = 1;

const WHISPER_TIMEOUT_BASE_MS = 15 * 60 * 1000;
const WHISPER_TIMEOUT_PER_SEC_MS = 3000;
const WHISPER_TIMEOUT_MARGIN_MS = 10 * 60 * 1000;
const WHISPER_TIMEOUT_MAX_MS = 6 * 60 * 60 * 1000;
const WHISPER_STALL_TIMEOUT_DEFAULT_MS = 15 * 60 * 1000;

function resolveWhisperStallTimeoutMs() {
  const env = process.env.WHISPER_STALL_TIMEOUT_MS;
  if (env !== undefined) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return WHISPER_STALL_TIMEOUT_DEFAULT_MS;
}

const EXTRACT_TIMEOUT_BASE_MS = 5 * 60 * 1000;
const EXTRACT_TIMEOUT_MAX_MS = 30 * 60 * 1000;

function whisperTimeoutForWav(wavSizeBytes) {
  const env = process.env.WHISPER_TIMEOUT_MS;
  if (env !== undefined) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const durationSec =
    Number.isFinite(wavSizeBytes) && wavSizeBytes > 44
      ? (wavSizeBytes - 44) / 32000
      : 0;
  const scaled =
    WHISPER_TIMEOUT_BASE_MS +
    Math.ceil(durationSec * WHISPER_TIMEOUT_PER_SEC_MS) +
    WHISPER_TIMEOUT_MARGIN_MS;
  return Math.min(Math.max(scaled, WHISPER_TIMEOUT_BASE_MS), WHISPER_TIMEOUT_MAX_MS);
}

function extractTimeoutForSource(sourceSizeBytes) {
  const env = process.env.FFMPEG_EXTRACT_TIMEOUT_MS;
  if (env !== undefined) {
    const n = parseInt(env, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const bySize =
    Number.isFinite(sourceSizeBytes) && sourceSizeBytes > 0
      ? Math.ceil(sourceSizeBytes / (2 * 1024 * 1024)) * 1000 + 60 * 1000
      : 0;
  return Math.min(Math.max(EXTRACT_TIMEOUT_BASE_MS, bySize), EXTRACT_TIMEOUT_MAX_MS);
}

const activeSubtitleHashes = new Set();
const waitingSourceHashes = new Set();
let subtitleMax = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_TRANSCRIPTIONS || "1", 10),
);

const SUBTITLE_STATUS_WAITING_SOURCE = "waiting-source";
const DEVICE_UNAVAILABLE_CODES = new Set([
  "ENODEV", "EIO", "ESTALE", "ENXIO", "EBUSY", "ENOTCONN", "ENOENT",
]);

function isDeviceUnavailableCode(code) {
  return typeof code === "string" && DEVICE_UNAVAILABLE_CODES.has(code);
}

function getFfmpegBin() {
  return process.env.FFMPEG_BIN || "ffmpeg";
}

function getWhisperBin() {
  return process.env.WHISPER_BIN || null;
}

function getWhisperModelDir() {
  return process.env.WHISPER_MODEL_DIR || null;
}

function getBinDir() {
  return path.join(state.APP_DIR, "bin");
}

function getModelsDir() {
  return path.join(state.APP_DIR, "models");
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function scanDirForNames(dir, prefixes) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => prefixes.some((pr) => n.startsWith(pr)));
}

function modelSearchPrefix(provider, modelId) {
  const base = provider.modelFilePattern.replace("{model}", modelId);
  const m = base.match(/^(.*)(\.\w+)$/);
  return m ? m[1] : base;
}

async function resolveWhisperBinary(provider) {
  const wbin = getWhisperBin();
  if (provider.id === "whisper" && wbin) {
    if (await fileExists(wbin)) return wbin;
  }
  const found = await scanDirForNames(getBinDir(), provider.binaryNames);
  if (found.length) return path.join(getBinDir(), found[0]);
  return null;
}

async function resolveWhisperModelFile(provider, modelId) {
  const wmd = getWhisperModelDir();
  const candidateModelDirs = [
    provider.id === "whisper" && wmd ? wmd : null,
    path.join(state.DATA_DIR, "models"),
    path.join(state.APP_DIR, "..", "models"),
    path.join(process.cwd(), "models"),
    getModelsDir(),
  ].filter(Boolean);
  const prefix = modelSearchPrefix(provider, modelId);
  for (const dir of candidateModelDirs) {
    const found = await scanDirForNames(dir, [prefix]);
    if (found.length) return path.join(dir, found[0]);
  }
  return null;
}

async function transcriptionAvailability(cfg) {
  if (!cfg.transcription.enabled) {
    return { available: false, reason: "disabled" };
  }
  const provider = findTranscriptionProvider(cfg.transcription.provider);
  if (!provider) return { available: false, reason: "unknown_provider" };
  if (!provider.local) return { available: false, reason: "not_local" };
  if (!(await resolveWhisperBinary(provider))) {
    return { available: false, reason: "binary_not_installed" };
  }
  if (!(await resolveWhisperModelFile(provider, cfg.transcription.model))) {
    return { available: false, reason: "model_not_installed" };
  }
  return { available: true, provider, reason: null };
}

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

function subtitleJobPersistShape(job) {
  return {
    hash: job.hash,
    libraryId: job.libraryId,
    rel: job.rel,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error || null,
    priority: job.priority ?? PRIORITY_FIRST,
    language: job.language,
    provider: job.provider,
    model: job.model,
  };
}

async function persistSubtitleJobs() {
  const payload = {};
  for (const job of state.subtitleJobs.values()) {
    payload[job.hash] = subtitleJobPersistShape(job);
  }
  await writeFileAtomic(getSubtitleJobsFile(), JSON.stringify(payload, null, 2)).catch(
    () => {},
  );
}

async function loadSubtitleJobs() {
  if (state.subtitleJobsLoaded) return;
  state.subtitleJobsLoaded = true;
  await ensureSubtitleDirs();
  const jobsFile = getSubtitleJobsFile();
  const read = await readJsonFile(jobsFile);
  if (!read.ok) {
    if (read.raw !== null) {
      const corruptFile = jobsFile + ".corrupt-" + Date.now();
      await fs.rename(jobsFile, corruptFile).catch(() => {});
      console.error(`[SUBTITLE][WARN] ${path.basename(jobsFile)} corrompido — preservado em ${path.basename(corruptFile)}; fila recomeça vazia`);
    }
    return;
  }
  if (!read.parsed) return;
  for (const [hash, rec] of Object.entries(read.parsed)) {
    if (!rec || typeof rec.hash !== "string" || !rec.hash) continue;
    const job = {
      hash: rec.hash,
      libraryId: rec.libraryId || DEFAULT_LIBRARY_ID,
      rel: rec.rel || "",
      status: rec.status || "cancelled",
      priority: Number.isInteger(rec.priority)
        ? Math.min(3, Math.max(0, rec.priority))
        : PRIORITY_FIRST,
      force: false,
      stageStartedAt: null,
      requeueOnCancel: false,
      createdAt: rec.createdAt || Date.now(),
      updatedAt: rec.updatedAt || Date.now(),
      error: rec.error || null,
      language: rec.language || null,
      provider: rec.provider || null,
      model: rec.model || null,
      proc: null,
      progress: "",
      percent: null,
    };
    if (job.rel) {
      const lib = getLibraryById(job.libraryId);
      const safe = lib ? resolveLibraryRel(lib, job.rel) : resolveSafeRelPath(job.rel);
      job.abs = safe ? safe.abs : null;
    }
    if (job.status === SUBTITLE_STATUS_WAITING_SOURCE) {
      waitingSourceHashes.add(job.hash);
    }
    const active = new Set([
      "queued", "extracting", "transcribing", "processing", "formatting",
    ]);
    if (active.has(job.status)) {
      const rawPath = path.join(getSubtitleRawDir(), job.hash + ".json");
      if (await fileExists(rawPath)) {
        job.status = "processing";
        job.progress = "Retomando do pós-processamento";
      } else {
        job.status = "queued";
        job.progress = "";
      }
      state.subtitleQueue.push(job.hash);
    }
    state.subtitleJobs.set(job.hash, job);
  }
  await persistSubtitleJobs();
  scheduleNextSubtitleJob();
}

function getSubtitleJob(hash) {
  return state.subtitleJobs.get(hash) || null;
}

function updateSubtitleJob(hash, patch, persist = true) {
  const job = state.subtitleJobs.get(hash);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  if (persist) persistSubtitleJobs();
  return job;
}

async function removeWhisperWorkOutput(hash) {
  const dirs = [getSubtitleWorkDir()];
  const cfg = await loadAiConfig().catch(() => null);
  if (cfg) {
    const w = await resolveWorkspaceDir(cfg).catch(() => WORKSPACE_AUTO_ROOT);
    dirs.push(path.join(w, "work"));
  } else {
    dirs.push(path.join(WORKSPACE_AUTO_ROOT, "work"));
  }
  for (const d of new Set(dirs)) {
    await Promise.all([
      fs.rm(path.join(d, hash + ".json"), { force: true }).catch(() => {}),
      fs.rm(path.join(d, hash + ".txt"), { force: true }).catch(() => {}),
    ]);
  }
}

function cancelSubtitleJob(hash, opts = {}) {
  const job = state.subtitleJobs.get(hash);
  if (!job) return false;
  if (job.status === "queued") {
    const idx = state.subtitleQueue.indexOf(hash);
    if (idx >= 0) state.subtitleQueue.splice(idx, 1);
    updateSubtitleJob(hash, { status: "cancelled", progress: "Cancelado", error: null });
    console.log(`[SUBTITLE] cancelado: ${job.rel}`);
    return true;
  }
  const active = new Set([
    "extracting", "transcribing", "processing", "formatting",
  ]);
  if (active.has(job.status)) {
    updateSubtitleJob(hash, {
      status: "cancelled",
      progress: "Cancelando…",
      error: null,
      requeueOnCancel: opts.preempt === true,
    });
    if (job.proc) {
      try { job.proc.kill("SIGTERM"); } catch {}
    }
    job.proc = null;
    removeWhisperWorkOutput(hash).catch(() => {});
    console.log(
      opts.preempt
        ? `[SUBTITLE] preemptado: ${job.rel} (re-enfileira em P${PREEMPT_RETRY_PRIORITY})`
        : `[SUBTITLE] cancelando: ${job.rel}`,
    );
    return true;
  }
  if (job.status === SUBTITLE_STATUS_WAITING_SOURCE) {
    waitingSourceHashes.delete(hash);
    updateSubtitleJob(hash, { status: "cancelled", progress: "Cancelado", error: null });
    console.log(`[SUBTITLE] cancelado (aguardava fonte): ${job.rel}`);
    return true;
  }
  return false;
}

function isPreemptible(job) {
  if (!job) return false;
  if (job.status === "extracting") return true;
  if (job.status === "transcribing") {
    const started = job.stageStartedAt || job.updatedAt || 0;
    return Date.now() - started < PREEMPT_GRACE_MS;
  }
  return false;
}

function maybePreemptFor(priority) {
  let target = null;
  for (const hash of activeSubtitleHashes) {
    const job = state.subtitleJobs.get(hash);
    if (!job || job.priority <= priority) continue;
    if (!isPreemptible(job)) continue;
    if (!target || job.priority > target.job.priority) target = { hash, job };
  }
  if (target) {
    cancelSubtitleJob(target.hash, { preempt: true });
    return true;
  }
  return false;
}

function refreshSubtitleMax(value) {
  const n = Number(value);
  subtitleMax = Number.isFinite(n)
    ? Math.min(8, Math.max(1, Math.floor(n)))
    : subtitleMax;
}

function sortSubtitleQueue() {
  state.subtitleQueue.sort(
    (a, b) =>
      (state.subtitleJobs.get(a)?.priority ?? PRIORITY_FIRST) -
      (state.subtitleJobs.get(b)?.priority ?? PRIORITY_FIRST),
  );
}

function scheduleNextSubtitleJob() {
  sortSubtitleQueue();
  while (activeSubtitleHashes.size < subtitleMax && state.subtitleQueue.length) {
    const hash = state.subtitleQueue.shift();
    const job = state.subtitleJobs.get(hash);
    if (!job || (job.status !== "queued" && job.status !== "processing")) continue;
    activeSubtitleHashes.add(hash);
    runSubtitlePipeline(job).catch(() => {});
  }
}

function startSubtitleJob(lib, rel, abs, opts = {}) {
  const baseHash = subtitleCacheName(lib.id, rel);
  const hash = baseHash;
  const priority = Number.isInteger(opts.priority)
    ? Math.min(3, Math.max(0, opts.priority))
    : PRIORITY_DEMAND;
  const force = opts.force === true;
  const existing = state.subtitleJobs.get(hash);
  const active = new Set([
    "queued", "extracting", "transcribing", "processing", "formatting",
  ]);
  if (existing && active.has(existing.status)) {
    if (force) {
      console.log(`[SUBTITLE] force solicitado para job ativo; cancelando execução anterior para reiniciar: ${rel}`);
      cancelSubtitleJob(hash);
      activeSubtitleHashes.delete(hash);
    } else {
      const promoted = priority < existing.priority;
      if (promoted) {
        updateSubtitleJob(hash, { priority });
        console.log(`[SUBTITLE] promovido P${priority}: ${rel}`);
      }
      return { job: existing, alreadyRunning: true, promoted };
    }
  }
  const job = {
    hash,
    libraryId: lib.id,
    rel,
    abs,
    status: "queued",
    priority,
    force,
    stageStartedAt: null,
    requeueOnCancel: false,
    progress: "Na fila",
    percent: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    language: null,
    provider: null,
    model: null,
    proc: null,
  };
  state.subtitleJobs.set(hash, job);
  state.subtitleQueue.push(hash);
  persistSubtitleJobs();
  maybePreemptFor(priority);
  scheduleNextSubtitleJob();
  return { job, alreadyRunning: false, promoted: false };
}

async function subtitleJobPublic(hash) {
  const job = state.subtitleJobs.get(hash);
  if (!job) return null;
  const lib = getLibraryById(job.libraryId) || getDefaultLibrary();
  return {
    hash: job.hash,
    libraryId: job.libraryId,
    rel: job.rel,
    status: job.status,
    stage: job.status,
    priority: job.priority,
    progress: job.progress || "",
    percent: job.percent ?? null,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    language: job.language,
    provider: job.provider,
    model: job.model,
    hasVtt: await hasFinalVtt(lib, job.rel, job.hash),
  };
}

async function resumeWaitingSource() {
  if (!waitingSourceHashes.size) return;
  for (const hash of [...waitingSourceHashes]) {
    const job = state.subtitleJobs.get(hash);
    if (!job || job.status !== SUBTITLE_STATUS_WAITING_SOURCE) {
      waitingSourceHashes.delete(hash);
      continue;
    }
    const st = await fs.stat(job.abs).catch(() => null);
    if (!st) continue;
    if (Date.now() - st.mtimeMs < 15000) continue;
    waitingSourceHashes.delete(hash);
    updateSubtitleJob(hash, {
      status: "queued",
      progress: "Na fila",
      error: null,
      priority: job.priority ?? PRIORITY_DEMAND,
    });
    state.subtitleQueue.push(hash);
    console.log(`[SUBTITLE][DEVICE] fonte voltou, re-enfileirando: ${job.rel}`);
  }
  scheduleNextSubtitleJob();
}

let waitingSourceWatcher = setInterval(() => {
  resumeWaitingSource().catch(() => {});
}, 30000);
waitingSourceWatcher.unref();

function extractAudioToWav(srcAbs, wavPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      srcAbs,
      "-vn",
      "-dn",
      "-sn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      wavPath,
    ];
    const proc = spawn(getFfmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    if (typeof opts.setProc === "function") opts.setProc(proc);
    let stderr = "";
    let completed = false;

    const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 5 * 60 * 1000;
    const timeoutTimer = timeoutMs > 0 ? setTimeout(() => {
      if (completed) return;
      completed = true;
      try {
        proc.kill("SIGTERM");
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
      } catch {}
      if (typeof opts.setProc === "function") opts.setProc(null);
      reject(new Error(`Tempo limite para extração de áudio excedido (${Math.round(timeoutMs / 60000)} min).`));
    }, timeoutMs) : null;

    proc.stderr.on("data", (c) => {
      stderr += c.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.on("error", (err) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutTimer);
      if (typeof opts.setProc === "function") opts.setProc(null);
      reject(new Error(`não foi possível iniciar o FFmpeg: ${err.message}`));
    });
    proc.on("close", async (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeoutTimer);
      if (typeof opts.setProc === "function") opts.setProc(null);
      if (code === 0) {
        try {
          const st = await fs.stat(wavPath).catch(() => null);
          if (!st || st.size < 512) {
            return reject(new Error("Áudio extraído está vazio ou o arquivo de vídeo não possui faixa de áudio audível."));
          }
          resolve();
        } catch (e) {
          resolve();
        }
      } else {
        const tail = stderr.trim().split("\n").pop() || "";
        reject(
          new Error(`ffmpeg saiu com código ${code}${tail ? `: ${tail}` : ""}`),
        );
      }
    });
  });
}

function runWhisperTranscription({
  provider,
  model,
  language,
  wavPath,
  outPrefix,
  vad = false,
  threads = 0,
  onProgress = null,
  setProc = null,
  timeoutMs = WHISPER_TIMEOUT_BASE_MS,
  stallTimeoutMs,
}) {
  return new Promise((resolve) => {
    resolveWhisperBinary(provider)
      .then(async (bin) => {
        if (!bin) {
          return resolve({ ok: false, error: "Binário do Whisper não instalado." });
        }
        const modelFile = await resolveWhisperModelFile(provider, model);
        if (!modelFile) {
          return resolve({ ok: false, error: "Modelo do Whisper não instalado." });
        }

        const effectiveThreads = getOptimalTranscriptionThreads(threads);

        const buildArgs = (level, useVad) => {
          const args = [
            "-m", modelFile,
            "-f", wavPath,
            "-l", language || "pt",
            "-of", outPrefix,
          ];
          if (level === 1) {
            args.push("-oj", "-otxt", "-ovtt", "-t", String(effectiveThreads), "-pp", "-bs", "2");
            if (useVad) args.push("-vad");
          } else if (level === 2) {
            args.push("-oj", "-otxt", "-t", String(effectiveThreads), "-pp");
            if (useVad) args.push("-vad");
          } else {
            args.push("-oj", "-otxt", "-t", String(effectiveThreads));
          }
          return args;
        };

        const runOnce = (level, useVad) =>
          new Promise((runResolve) => {
            const args = buildArgs(level, useVad);
            const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
            if (setProc) setProc(proc);

            let stderr = "";
            let stdout = "";
            let completed = false;

            const effectiveTimeoutMs = timeoutMs !== undefined ? timeoutMs : WHISPER_TIMEOUT_BASE_MS;
            const effectiveStallMs = stallTimeoutMs !== undefined ? stallTimeoutMs : resolveWhisperStallTimeoutMs();
            const killProc = () => {
              try {
                proc.kill("SIGTERM");
                setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 3000);
              } catch {}
            };
            let stallTimer = null;
            const timeoutTimer = effectiveTimeoutMs > 0 ? setTimeout(() => {
              if (completed) return;
              completed = true;
              clearTimeout(stallTimer);
              const mins = Math.round(effectiveTimeoutMs / 60000);
              console.error(`[SUBTITLE] Timeout de transcrição Whisper após ${mins} minutos.`);
              killProc();
              if (setProc) setProc(null);
              runResolve({
                ok: false,
                error: `Tempo limite de transcrição excedido (${mins} min).`,
                stderr,
              });
            }, effectiveTimeoutMs) : null;

            const armStallTimer = () => {
              if (!(effectiveStallMs > 0)) return;
              clearTimeout(stallTimer);
              stallTimer = setTimeout(() => {
                if (completed) return;
                completed = true;
                clearTimeout(timeoutTimer);
                const mins = Math.round(effectiveStallMs / 60000);
                console.error(`[SUBTITLE] Whisper sem atividade há ${mins} minutos; cancelando transcrição travada.`);
                killProc();
                if (setProc) setProc(null);
                runResolve({
                  ok: false,
                  error: `Transcrição travada (sem atividade há ${mins} min).`,
                  stderr,
                });
              }, effectiveStallMs);
            };
            armStallTimer();

            proc.stdout.on("data", (c) => {
              stdout += c.toString();
              if (stdout.length > 32000) stdout = stdout.slice(-32000);
            });

            proc.stderr.on("data", (c) => {
              const chunk = c.toString();
              stderr += chunk;
              if (stderr.length > 8000) stderr = stderr.slice(-8000);
              armStallTimer();
              if (onProgress) {
                const m = /progress\s*=\s*(\d+(?:\.\d+)?)\s*%/.exec(chunk);
                if (m) onProgress(Math.min(100, Math.round(Number(m[1]))));
              }
            });

            proc.on("error", (err) => {
              if (completed) return;
              completed = true;
              clearTimeout(timeoutTimer);
              clearTimeout(stallTimer);
              if (setProc) setProc(null);
              runResolve({
                ok: false,
                error: `não foi possível iniciar o Whisper: ${err.message}`,
              });
            });

            proc.on("close", async (code) => {
              if (completed) return;
              completed = true;
              clearTimeout(timeoutTimer);
              clearTimeout(stallTimer);
              if (setProc) setProc(null);

              if (code !== 0) {
                const tail = stderr.trim().split("\n").pop() || "";
                return runResolve({
                  ok: false,
                  error: `whisper saiu com código ${code}${tail ? `: ${tail}` : ""}`,
                  stderr,
                });
              }

              let doc = null;
              const jsonCandidates = [outPrefix + ".json", outPrefix + ".wav.json"];
              for (const jPath of jsonCandidates) {
                if (await fileExists(jPath)) {
                  const read = await readJsonFile(jPath);
                  if (read.ok && read.parsed) {
                    doc = read.parsed;
                    break;
                  }
                }
              }

              let segs = [];
              let rawText = "";
              let detectedLang = null;

              if (doc) {
                if (Array.isArray(doc.segments)) {
                  segs = doc.segments
                    .filter((s) => s && (typeof s.text === "string" || s.t0 !== undefined))
                    .map((s) => {
                      const start = s.start !== undefined ? Number(s.start) : (Number(s.t0) / 100);
                      const end = s.end !== undefined ? Number(s.end) : (Number(s.t1) / 100);
                      return {
                        start: Math.max(0, Number.isFinite(start) ? start : 0),
                        end: Math.max(0, Number.isFinite(end) ? end : start + 1),
                        text: String(s.text || "").trim(),
                      };
                    })
                    .filter((s) => s.text.length > 0);
                }

                if (!segs.length) {
                  const transList = Array.isArray(doc.transcription)
                    ? doc.transcription
                    : (doc.result && Array.isArray(doc.result.transcription) ? doc.result.transcription : []);
                  if (transList.length) {
                    segs = transList
                      .filter((s) => s && typeof s.text === "string" && s.text.trim())
                      .map((s) => {
                        const fromMs = s.offsets ? s.offsets.from : (s.from !== undefined ? s.from : (s.timestamps ? s.timestamps.from : 0));
                        const toMs = s.offsets ? s.offsets.to : (s.to !== undefined ? s.to : (s.timestamps ? s.timestamps.to : 0));
                        const start = Number(fromMs) / 1000;
                        const end = Number(toMs) / 1000;
                        return {
                          start: Math.max(0, Number.isFinite(start) ? start : 0),
                          end: Math.max(0, Number.isFinite(end) && end > start ? end : start + 2),
                          text: String(s.text).trim(),
                        };
                      });
                  }
                }

                if (typeof doc.text === "string") rawText = doc.text;
                detectedLang = (doc.result && typeof doc.result.language === "string" ? doc.result.language : (typeof doc.language === "string" ? doc.language : null)) || null;
              }

              if (!segs.length) {
                const vttPath = outPrefix + ".vtt";
                if (await fileExists(vttPath)) {
                  const vttTxt = await fs.readFile(vttPath, "utf8").catch(() => "");
                  if (vttTxt) {
                    const parsedVtt = parseSubtitleSegments(vttTxt);
                    if (parsedVtt.length) segs = parsedVtt;
                  }
                }
              }

              if (!segs.length) {
                const srtPath = outPrefix + ".srt";
                if (await fileExists(srtPath)) {
                  const srtTxt = await fs.readFile(srtPath, "utf8").catch(() => "");
                  if (srtTxt) {
                    const parsedSrt = parseSubtitleSegments(srtTxt);
                    if (parsedSrt.length) segs = parsedSrt;
                  }
                }
              }

              if (!rawText) {
                const txtPath = outPrefix + ".txt";
                if (await fileExists(txtPath)) {
                  const txt = await fs.readFile(txtPath, "utf8").catch(() => "");
                  if (txt && txt.trim()) rawText = txt.trim();
                }
              }

              if (!segs.length && stdout.includes("-->")) {
                const parsedStdout = parseSubtitleSegments(stdout);
                if (parsedStdout.length) segs = parsedStdout;
              }

              if (!segs.length && rawText) {
                const sentences = rawText.match(/[^.!?]+[.!?]*/g) || [rawText];
                let curTime = 0;
                for (let i = 0; i < sentences.length; i++) {
                  const sText = sentences[i].trim();
                  if (!sText) continue;
                  const wordCount = sText.split(/\s+/).length;
                  const dur = Math.max(2, Math.min(8, wordCount * 0.4));
                  segs.push({
                    id: `s${segs.length + 1}`,
                    start: Math.round(curTime * 10) / 10,
                    end: Math.round((curTime + dur) * 10) / 10,
                    text: sText,
                  });
                  curTime += dur + 0.2;
                }
              }

              if (!rawText && segs.length) {
                rawText = segs.map((s) => s.text).join(" ");
              }

              if (!segs.length && !rawText) {
                const tail = stderr.trim().split("\n").pop() || "";
                return runResolve({
                  ok: false,
                  error: `Whisper concluiu sem gerar texto ou legendas.${tail ? ` (${tail})` : ""}`,
                  stderr,
                });
              }

              runResolve({
                ok: true,
                rawText,
                segments: segs,
                language: detectedLang || language || "pt",
              });
            });
          });

        const first = await runOnce(1, vad);
        if (first.ok) return resolve(first);

        if (/unknown argument|unrecognized|invalid option|unknown option|-vad|-bs|-ovtt/.test(first.stderr || "")) {
          console.log("[SUBTITLE] whisper rejeitou flags avançadas; retry com modo padrão");
          const second = await runOnce(2, false);
          if (second.ok) return resolve(second);

          if (/unknown argument|unrecognized|invalid option|unknown option|-pp/.test(second.stderr || "")) {
            console.log("[SUBTITLE] whisper rejeitou flags intermediárias; retry com conjunto mínimo");
            const third = await runOnce(3, false);
            return resolve(third.ok ? third : second);
          }
          return resolve(second);
        }

        return resolve(first);
      })
      .catch((err) =>
        resolve({ ok: false, error: sanitizeTestError(err.message || "erro") }),
      );
  });
}

async function runSubtitlePipeline(job) {
  const hash = job.hash;
  const rel = job.rel;
  const lib = getLibraryById(job.libraryId) || getDefaultLibrary();
  try {
    const cfg = await loadAiConfig();
    state.refreshHeavyMax(cfg.advanced.maxConcurrentAiJobs);
    refreshSubtitleMax(cfg.advanced.maxConcurrentTranscriptions);
    const workspaceDir = await resolveWorkspaceDir(cfg);
    updateSubtitleJob(hash, {
      language: cfg.transcription.language,
      provider: cfg.transcription.provider,
      model: cfg.transcription.model,
    });

    const avail = await transcriptionAvailability(cfg);
    if (!avail.available) {
      const msg =
        avail.reason === "disabled"
          ? "Transcrição desabilitada nas configurações."
          : avail.reason === "binary_not_installed"
            ? "Binário do Whisper não instalado."
            : avail.reason === "model_not_installed"
              ? "Modelo do Whisper não instalado."
              : "Provedor de transcrição indisponível.";
      updateSubtitleJob(hash, { status: "failed", progress: "", error: msg });
      console.log(`[SUBTITLE] falhou (unavailable: ${avail.reason}): ${rel}`);
      return;
    }

    const sourceStat = await fs.stat(job.abs).catch((err) => ({ __err: err }));
    if (!sourceStat) {
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: "Arquivo de vídeo não encontrado.",
      });
      return;
    }
    if (sourceStat.__err) {
      if (isDeviceUnavailableCode(sourceStat.__err.code)) {
        updateSubtitleJob(hash, {
          status: SUBTITLE_STATUS_WAITING_SOURCE,
          progress: "",
          error: "Dispositivo indisponível — aguardando a fonte voltar.",
        });
        waitingSourceHashes.add(hash);
        console.log(
          `[SUBTITLE][DEVICE] fonte indisponível (${sourceStat.__err.code}), aguardando: ${rel}`,
        );
      } else {
        updateSubtitleJob(hash, {
          status: "failed",
          progress: "",
          error: `Erro ao acessar o vídeo: ${sanitizeTestError(sourceStat.__err.code || sourceStat.__err.message)}`,
        });
        console.log(`[SUBTITLE] falhou (acesso: ${sourceStat.__err.code}): ${rel}`);
      }
      return;
    }

    if (!(await fileWithinLibrary(lib, job.abs))) {
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: "Arquivo fora da biblioteca.",
      });
      console.log(`[SUBTITLE] recusado (fora da biblioteca): ${rel}`);
      return;
    }

    // 0) force: regenerar do zero
    if (job.force) {
      console.log(`[SUBTITLE] force: regenerando do zero: ${rel}`);
      updateSubtitleJob(hash, { force: false }, false);
      await backupEditedSubtitle(hash);
      const targets = [
        path.join(getSubtitleRawDir(), hash + ".json"),
        path.join(getSubtitleProcessedDir(), hash + ".json"),
        path.join(getSubtitleDir(), hash + ".vtt"),
      ];
      const courseVtt = courseSubtitlePath(lib, rel, hash);
      if (courseVtt) targets.push(courseVtt);
      await Promise.all(targets.map((p) => fs.rm(p, { force: true }).catch(() => {})));
    }

    // 1) Cache já pronto e válido
    const processedPath = path.join(getSubtitleProcessedDir(), hash + ".json");
    if ((await loadValidProcessed(processedPath, job.abs, sourceStat)) || (await hasFinalVtt(lib, rel, hash))) {
      updateSubtitleJob(hash, { status: "completed", progress: "Cache encontrado", error: null });
      console.log(`[SUBTITLE] cache encontrado (VTT pronto): ${rel}`);
      return;
    }

    // 2) Retoma do raw se existir
    const rawPath = path.join(getSubtitleRawDir(), hash + ".json");
    let rawDoc = null;
    if (await fileExists(rawPath)) {
      const r = await readJsonFile(rawPath);
      if (r.ok && r.parsed && r.parsed.version === SUBTITLE_VERSION) {
        const rs = r.parsed.source;
        if (rs && rs.mtimeMs === sourceStat.mtimeMs && rs.size === sourceStat.size) {
          rawDoc = r.parsed;
        }
      }
    }

    if (!rawDoc) {
      // 3) Extração de áudio
      if (job.status === "cancelled") return;
      const wavPath = path.join(workspaceDir, "audio", hash + ".wav");
      const spaceIssue = await ensureWorkspaceSpace(workspaceDir, sourceStat.size / 600000);
      if (spaceIssue) {
        updateSubtitleJob(hash, {
          status: "failed",
          progress: "",
          error: `Espaço insuficiente no workspace (~${Math.round(spaceIssue.free / 1048576)}MB livres; precisa ~${Math.round(spaceIssue.need / 1048576)}MB). Limpe o workspace ou escolha outro diretório.`,
        });
        console.log(`[SUBTITLE] workspace sem espaço: ${rel}`);
        return;
      }
      updateSubtitleJob(hash, { status: "extracting", progress: "Extraindo áudio…", stageStartedAt: Date.now() });
      console.log(`[SUBTITLE][PROCESS] extraindo áudio: ${rel}`);
      const releaseHeavy = await state.acquireHeavySlot();
      if (job.status === "cancelled" || !state.subtitleJobs.has(hash)) {
        releaseHeavy();
        await fs.unlink(wavPath).catch(() => {});
        return;
      }
      try {
        await extractAudioToWav(job.abs, wavPath, {
          setProc: (p) => { job.proc = p; },
          timeoutMs: extractTimeoutForSource(sourceStat.size),
        });
      } finally {
        job.proc = null;
        releaseHeavy();
      }
      if (job.status === "cancelled" || !state.subtitleJobs.has(hash)) {
        await fs.unlink(wavPath).catch(() => {});
        return;
      }

      // 4) Transcrição
      updateSubtitleJob(hash, { status: "transcribing", progress: "Transcrevendo…", percent: null });
      console.log(`[SUBTITLE][PROCESS] transcrevendo: ${rel}`);
      const releaseHeavy2 = await state.acquireHeavySlot();
      if (job.status === "cancelled" || !state.subtitleJobs.has(hash)) {
        releaseHeavy2();
        await fs.unlink(wavPath).catch(() => {});
        return;
      }
      try {
        const wavStat = await fs.stat(wavPath).catch(() => null);
        const whisperTimeoutMs = whisperTimeoutForWav(wavStat ? wavStat.size : null);
        const result = await runWhisperTranscription({
          provider: avail.provider,
          model: cfg.transcription.model,
          language: cfg.transcription.language,
          vad: cfg.transcription.vad === true && avail.provider.capabilities?.vad === true,
          threads: cfg.advanced.transcriptionThreads || 0,
          wavPath,
          outPrefix: path.join(workspaceDir, "work", hash),
          timeoutMs: whisperTimeoutMs,
          onProgress: (percent) => {
            if (job.status === "transcribing") {
              updateSubtitleJob(hash, { percent }, false);
            }
          },
          setProc: (proc) => {
            job.proc = proc;
          },
        });
        job.proc = null;
        if (!result.ok) throw new Error(result.error || "Falha na transcrição.");
        rawDoc = {
          version: SUBTITLE_VERSION,
          source: { rel, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
          language: result.language || cfg.transcription.language,
          provider: avail.provider.id,
          model: cfg.transcription.model,
          createdAt: new Date().toISOString(),
          rawText: result.rawText || "",
          segments: result.segments || [],
        };
        await writeFileAtomic(rawPath, JSON.stringify(rawDoc, null, 2));
      } finally {
        releaseHeavy2();
        await fs.unlink(wavPath).catch(() => {});
        const workPrefix = path.join(workspaceDir, "work", hash);
        await Promise.all([
          fs.rm(workPrefix + ".json", { force: true }).catch(() => {}),
          fs.rm(workPrefix + ".txt", { force: true }).catch(() => {}),
        ]);
      }
      if (job.status === "cancelled") {
        if (!job.requeueOnCancel) {
          await fs.rm(rawPath, { force: true }).catch(() => {});
        }
        return;
      }
    }

    // 5) Pós-processamento determinístico
    updateSubtitleJob(hash, { status: "processing", progress: "Pós-processando…" });
    console.log(`[SUBTITLE][PROCESS] pós-processando: ${rel}`);
    let processedSegments = await postprocessSegments(rawDoc.segments || [], cfg);
    const processedDoc = {
      version: SUBTITLE_VERSION,
      source: rawDoc.source,
      language: rawDoc.language,
      provider: rawDoc.provider,
      model: rawDoc.model,
      createdAt: new Date().toISOString(),
      segments: processedSegments,
    };

    // 6) Formatação → WebVTT
    updateSubtitleJob(hash, { status: "formatting", progress: "Formatando legendas…" });
    console.log(`[SUBTITLE][PROCESS] formatando VTT: ${rel}`);
    processedDoc.segments = processedSegments;
    await writeFileAtomic(processedPath, JSON.stringify(processedDoc, null, 2));
    const vttText = renderVtt(processedSegments);
    await writeFileAtomic(path.join(getSubtitleDir(), hash + ".vtt"), vttText);
    await writeCourseSubtitle(lib, rel, hash, vttText);

    updateSubtitleJob(hash, { status: "completed", progress: "", error: null, percent: null });
    console.log(
      `[SUBTITLE][PROCESS] concluído: ${rel} (${processedSegments.length} segmentos)`,
    );
  } catch (err) {
    if (job.status !== "cancelled") {
      const devErr = await fs.stat(job.abs).catch((e) => e);
      if (devErr && isDeviceUnavailableCode(devErr.code)) {
        updateSubtitleJob(hash, {
          status: SUBTITLE_STATUS_WAITING_SOURCE,
          progress: "",
          error: "Dispositivo indisponível — aguardando a fonte voltar.",
        });
        waitingSourceHashes.add(hash);
        console.log(
          `[SUBTITLE][DEVICE] fonte sumiu durante o processamento (${devErr.code}), aguardando: ${rel}`,
        );
        return;
      }
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: sanitizeTestError(err.message || "erro"),
      });
      console.error(
        `[SUBTITLE] falhou: ${rel} (${sanitizeTestError(err.message || "erro")})`,
      );
    }
  } finally {
    activeSubtitleHashes.delete(hash);
    if (job.requeueOnCancel) {
      updateSubtitleJob(
        hash,
        {
          status: "queued",
          priority: PREEMPT_RETRY_PRIORITY,
          requeueOnCancel: false,
          progress: "Na fila",
          error: null,
          stageStartedAt: null,
          proc: null,
          percent: null,
        },
        false,
      );
      state.subtitleQueue.push(hash);
      console.log(
        `[SUBTITLE] re-enfileirado em P${PREEMPT_RETRY_PRIORITY}: ${rel}`,
      );
    }
    scheduleNextSubtitleJob();
  }
}

function firstVideoOfCourse(node) {
  for (const child of node.children || []) {
    if (child.type === "folder") {
      const v = firstVideoOfCourse(child);
      if (v) return v;
    } else if (child.type === "video") {
      return child;
    }
  }
  return null;
}

async function maybePregenFirstLessons(tree) {
  const cfg = await loadAiConfig();
  if (!cfg.transcription.enabled || cfg.transcription.pregenFirstLesson !== true) return;
  if (cfg.transcription.generateMode === "manual") return;
  const avail = await transcriptionAvailability(cfg);
  if (!avail.available) return;
  await loadSubtitleJobs();
  for (const lib of (tree.libraries || []).filter((l) => l.tree)) {
    const courses = [];
    const collectCourseRoots = (node, parentType) => {
      for (const child of node.children || []) {
        if (child.type !== "folder") continue;
        if (parentType !== "folder") courses.push(child);
        collectCourseRoots(child, child.type);
      }
    };
    collectCourseRoots(lib.tree, "root");
    for (const course of courses) {
      const first = firstVideoOfCourse(course);
      if (!first) continue;
      const safe = resolveLibraryRel(lib, first.path);
      if (!safe) continue;
      if (await hasValidSubtitle(lib, safe.rel, safe.abs)) continue;
      startSubtitleJob(lib, safe.rel, safe.abs, { priority: PRIORITY_FIRST });
      console.log(`[SUBTITLE] pré-geração P2 (primeira aula): ${lib.id} ${safe.rel}`);
    }
  }
}

async function maybePregenBackground(tree) {
  const cfg = await loadAiConfig();
  if (!cfg.transcription.enabled || cfg.transcription.background !== true) return;
  const avail = await transcriptionAvailability(cfg);
  if (!avail.available) return;
  await loadSubtitleJobs();
  const active = ["queued", "extracting", "transcribing", "processing", "formatting"];
  const pendingHigher = [...state.subtitleJobs.values()].some(
    (j) => active.includes(j.status) && j.priority < PRIORITY_BG,
  );
  if (pendingHigher) return;
  const videos = [];
  const walk = (lib, node) => {
    for (const c of node.children || []) {
      if (c.type === "folder") walk(lib, c);
      else if (c.type === "video") videos.push({ lib, node: c });
    }
  };
  for (const lib of (tree.libraries || []).filter((l) => l.tree)) {
    for (const course of (lib.tree.children || []).filter((c) => c.type === "folder")) {
      walk(lib, course);
    }
  }
  let enqueued = 0;
  for (const { lib, node: v } of videos) {
    if (enqueued >= BACKGROUND_BATCH) break;
    const safe = resolveLibraryRel(lib, v.path);
    if (!safe) continue;
    if (await hasValidSubtitle(lib, safe.rel, safe.abs)) continue;
    startSubtitleJob(lib, safe.rel, safe.abs, { priority: PRIORITY_BG });
    enqueued += 1;
  }
  if (enqueued > 0) {
    console.log(`[SUBTITLE] background P3: ${enqueued} vídeos enfileirados (lote máx. ${BACKGROUND_BATCH})`);
  }
}

function scheduleSubtitlePregen(tree) {
  maybePregenFirstLessons(tree).catch(() => {});
  maybePregenBackground(tree).catch(() => {});
}

module.exports = {
  PRIORITY_DEMAND,
  PRIORITY_NEXT,
  PRIORITY_FIRST,
  PRIORITY_BG,
  PREEMPT_GRACE_MS,
  PREEMPT_RETRY_PRIORITY,
  BACKGROUND_BATCH,
  SUBTITLE_VERSION,
  WHISPER_TIMEOUT_BASE_MS,
  WHISPER_TIMEOUT_PER_SEC_MS,
  WHISPER_TIMEOUT_MARGIN_MS,
  WHISPER_TIMEOUT_MAX_MS,
  WHISPER_STALL_TIMEOUT_DEFAULT_MS,
  resolveWhisperStallTimeoutMs,
  EXTRACT_TIMEOUT_BASE_MS,
  EXTRACT_TIMEOUT_MAX_MS,
  whisperTimeoutForWav,
  extractTimeoutForSource,
  SUBTITLE_STATUS_WAITING_SOURCE,
  DEVICE_UNAVAILABLE_CODES,
  isDeviceUnavailableCode,
  activeSubtitleHashes,
  waitingSourceHashes,
  fileExists,
  scanDirForNames,
  modelSearchPrefix,
  resolveWhisperBinary,
  resolveWhisperModelFile,
  transcriptionAvailability,
  loadValidProcessed,
  subtitleJobPersistShape,
  persistSubtitleJobs,
  loadSubtitleJobs,
  getSubtitleJob,
  updateSubtitleJob,
  removeWhisperWorkOutput,
  cancelSubtitleJob,
  isPreemptible,
  maybePreemptFor,
  refreshSubtitleMax,
  sortSubtitleQueue,
  scheduleNextSubtitleJob,
  startSubtitleJob,
  subtitleJobPublic,
  resumeWaitingSource,
  extractAudioToWav,
  runWhisperTranscription,
  runSubtitlePipeline,
  subtitleJobs: state.subtitleJobs,
  subtitleQueue: state.subtitleQueue,
  firstVideoOfCourse,
  maybePregenFirstLessons,
  maybePregenBackground,
  scheduleSubtitlePregen,
};
