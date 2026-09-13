const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const { spawn } = require("child_process");
const state = require("../state");
const { fileWithinLibrary } = require("../core/paths");
const { transcodeCacheName } = require("../ai/subtitles-helpers");

const FFMPEG_BIN_ENV = process.env.FFMPEG_BIN || "";
const FFPROBE_BIN_ENV = process.env.FFPROBE_BIN || "";
const FFMPEG_BIN_DIR = path.join(state.APP_DIR, "bin", "ffmpeg");

function resolveToolBin(exeName, envPath) {
  if (envPath) return envPath;
  const candidates =
    process.platform === "win32" ? [exeName + ".exe", exeName] : [exeName];
  for (const n of candidates) {
    const local = path.join(FFMPEG_BIN_DIR, n);
    if (fsSync.existsSync(local)) return local;
  }
  return exeName; // cai para o PATH
}

const FFMPEG_BIN = resolveToolBin("ffmpeg", FFMPEG_BIN_ENV);
const FFPROBE_BIN = resolveToolBin("ffprobe", FFPROBE_BIN_ENV);

let ffmpegAvailable = null;
let ffprobeAvailable = null;

// Detecta a presença do binário (FFMPEG_BIN/FFPROBE_BIN via env ou PATH).
function detectTool(bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function ensureTools() {
  if (ffmpegAvailable === null) ffmpegAvailable = await detectTool(FFMPEG_BIN);
  if (ffprobeAvailable === null) ffprobeAvailable = await detectTool(FFPROBE_BIN);
}

function execFileAsync(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`exit ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function parseFfmpegInfo(stderr) {
  const streams = [];
  const fmt = /Input #0, ([^,]+),/.exec(stderr);
  const format = fmt ? fmt[1].trim() : "";
  const re = /Stream #\d+:\d+[^\n]*: ([^:]+): ([a-zA-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(stderr))) {
    streams.push({
      codec_type: m[1].trim().toLowerCase(),
      codec_name: m[2].trim().toLowerCase(),
    });
  }
  if (!streams.length) return null;
  return { format_name: format, streams };
}

// Codecs/contêineres que Chromium/Firefox modernos reproduzem de forma confiável.
const BROWSER_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1", "theora"]);
const BROWSER_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const BROWSER_CONTAINERS = new Set(["mp4", "mov", "m4v", "webm", "ogg"]);

function isBrowserCompatibleVideo(probe) {
  if (!probe || !Array.isArray(probe.streams)) return false;
  // ffprobe JSON aninha o formato em `format.format_name`; o fallback de
  // `parseFfmpegInfo` (stderr do ffmpeg) o coloca no topo — aceita ambos.
  const rawContainer = probe.format_name || (probe.format && probe.format.format_name) || "";
  const container = rawContainer.split(",")[0].trim().toLowerCase();
  if (!BROWSER_CONTAINERS.has(container)) return false;
  let videoOk = false;
  for (const s of probe.streams) {
    const codec = (s.codec_name || "").toLowerCase();
    if (s.codec_type === "video") {
      if (!BROWSER_VIDEO_CODECS.has(codec)) return false;
      videoOk = true;
    } else if (s.codec_type === "audio" && !BROWSER_AUDIO_CODECS.has(codec)) {
      return false;
    }
  }
  return videoOk;
}

// Analisa o arquivo para decidir compatibilidade sem confiar só na extensão
// (spec 3). Usa ffprobe; sem ffprobe, cai para o stderr do `ffmpeg -i`.
async function probeMedia(abs) {
  if (ffprobeAvailable) {
    try {
      const { stdout } = await execFileAsync(FFPROBE_BIN, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        abs,
      ]);
      const parsed = JSON.parse(stdout);
      if (parsed && Array.isArray(parsed.streams)) return parsed;
    } catch {}
  }
  if (ffmpegAvailable) {
    try {
      // `ffmpeg -i` sempre sai com código != 0; o stderr é o dado útil.
      const { stderr } = await execFileAsync(FFMPEG_BIN, ["-i", abs]);
      return parseFfmpegInfo(stderr);
    } catch (err) {
      if (err && err.stderr) return parseFfmpegInfo(err.stderr);
    }
  }
  return null;
}

const { transcodeJobs, transcodeQueue, acquireHeavySlot } = state;
let activeTranscodes = 0;

function getActiveTranscodes() {
  return activeTranscodes;
}

// Deduplica: várias requisições do mesmo vídeo compartilham UM job/ffmpeg.
function startTranscodeJob(libraryId, cacheName, rel, srcAbs, tmpPath, finalPath, probe) {
  const existing = transcodeJobs.get(cacheName);
  if (existing) {
    existing.lastConsumerAt = Date.now();
    return existing;
  }
  const duration = probe && probe.format ? Number(probe.format.duration) : null;
  const job = {
    cacheName,
    libraryId,
    rel,
    srcAbs,
    tmpPath,
    finalPath,
    status: "queued", // queued | processing | completed | failed
    error: null,
    proc: null,
    percent: null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    createdAt: Date.now(),
    lastConsumerAt: Date.now(),
  };
  transcodeJobs.set(cacheName, job);
  transcodeQueue.push(job);
  console.log(`[TRANSCODE] iniciado: ${rel}`);
  scheduleNextTranscode();
  return job;
}

function scheduleNextTranscode() {
  while (activeTranscodes < state.MAX_CONCURRENT_TRANSCODES && transcodeQueue.length) {
    const job = transcodeQueue.shift();
    if (job.status !== "queued") continue;
    activeTranscodes++;
    runTranscode(job).catch(() => {});
  }
}

async function runTranscode(job) {
  // Portão global de jobs pesados: segura UM slot compartilhado com whisper
  // (nunca ffmpeg+whisper simultâneos). Liberado quando o processo termina
  // (close/error) ou se o spawn falhar na hora.
  const releaseHeavy = await acquireHeavySlot();
  let heavyReleased = false;
  const releaseHeavyOnce = () => {
    if (!heavyReleased) {
      heavyReleased = true;
      releaseHeavy();
    }
  };

  if (
    job.status === "cancelled" ||
    !transcodeJobs.has(job.cacheName) ||
    transcodeJobs.get(job.cacheName) !== job
  ) {
    activeTranscodes = Math.max(0, activeTranscodes - 1);
    releaseHeavyOnce();
    scheduleNextTranscode();
    return;
  }

  job.status = "processing";
  // Argumentos fixos, sem shell (spec 23): nada do usuário entra no comando.
  // -movflags frag_keyframe+empty_moov+default_base_moof: MP4 fragmentado com
  //   init no início (substitui o faststart — ver relatório/limitações).
  // -g 60: fragmentos ~2s — 1º frame chega antes e o seek fica mais fino.
  const args = [
    "-y",
    "-i",
    job.srcAbs,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "60",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "-progress",
    "pipe:1",
    "-nostats",
    "-loglevel",
    "error",
    job.tmpPath,
  ];
  let proc;
  try {
    proc = spawn(FFMPEG_BIN, args, {
      cwd: state.TRANSCODE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Spawn síncrono falhou: libera o slot e encerra sem travar a fila.
    job.status = "failed";
    job.error = `não foi possível iniciar o FFmpeg: ${err.message}`;
    console.error(`[TRANSCODE] falhou: ${job.rel} (${job.error})`);
    job.proc = null;
    activeTranscodes--;
    transcodeJobs.delete(job.cacheName);
    releaseHeavyOnce();
    scheduleNextTranscode();
    return;
  }
  job.proc = proc;
  let stderr = "";
  let lastLogPercent = -10;

  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    let outSec = null;
    const us = /out_time_us=(\d+)/.exec(text);
    const ms = /out_time_ms=(\d+)/.exec(text);
    if (us) outSec = parseInt(us[1], 10) / 1e6;
    else if (ms) outSec = parseInt(ms[1], 10) / 1e3;
    if (outSec != null && job.duration && job.duration > 0) {
      job.percent = Math.min(100, Math.round((outSec / job.duration) * 100));
      if (job.percent >= lastLogPercent + 25) {
        lastLogPercent = job.percent;
        console.log(`[TRANSCODE] progresso ${job.percent}%: ${job.rel}`);
      }
    }
  });
  proc.stderr.on("data", (c) => {
    stderr += c.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  proc.on("error", (err) => {
    job.status = "failed";
    job.error = `não foi possível iniciar o FFmpeg: ${err.message}`;
    console.error(`[TRANSCODE] falhou: ${job.rel} (${job.error})`);
    job.proc = null;
    activeTranscodes--;
    transcodeJobs.delete(job.cacheName);
    releaseHeavyOnce();
    scheduleNextTranscode();
  });

  proc.on("close", async (code) => {
    activeTranscodes--;
    job.proc = null;
    if (code === 0) {
      try {
        // O .tmp só vira final após sucesso (rename atômico no mesmo FS).
        await fs.rename(job.tmpPath, job.finalPath);
        job.status = "completed";
        job.percent = 100;
        console.log(`[TRANSCODE] concluído: ${job.rel} → ${job.cacheName}`);
      } catch (err) {
        job.status = "failed";
        job.error = `falha ao finalizar o cache: ${err.message}`;
        console.error(`[TRANSCODE] falhou: ${job.rel} (${job.error})`);
      }
    } else {
      job.status = "failed";
      const tail = stderr.trim().split("\n").pop();
      job.error = `ffmpeg saiu com código ${code}${tail ? `: ${tail}` : ""}`;
      console.error(`[TRANSCODE] falhou: ${job.rel} (${job.error})`);
      await fs.unlink(job.tmpPath).catch(() => {});
    }
    // Remove do Map (streams ativos seguram o job por closure). Falhas ficam
    // um tempo para o fallback reportar o erro claro; completos sobem logo.
    const retention = job.status === "completed" ? 1000 : 10 * 60 * 1000;
    setTimeout(() => transcodeJobs.delete(job.cacheName), retention);
    releaseHeavyOnce();
    scheduleNextTranscode();
  });
}

// Cancela jobs enfileirados que perderam todos os consumidores (spec 18).
setInterval(() => {
  const now = Date.now();
  for (const job of transcodeJobs.values()) {
    if (job.status === "queued" && now - job.lastConsumerAt > 120000) {
      const idx = transcodeQueue.indexOf(job);
      if (idx >= 0) transcodeQueue.splice(idx, 1);
      transcodeJobs.delete(job.cacheName);
      console.log(`[TRANSCODE] cancelado (sem consumidores): ${job.rel}`);
    }
  }
}, 60000).unref();

// URL de mídia: a biblioteca PADRÃO usa o formato legado "/media/<rel>"
// (back-compat de links/bookmarks); as demais prefixam "/media/<libId>/<rel>".
function mediaUrlFromRel(lib, rel) {
  const enc = rel.split("/").map(encodeURIComponent).join("/");
  return lib && lib.id !== state.DEFAULT_LIBRARY_ID
    ? `/media/${encodeURIComponent(lib.id)}/${enc}`
    : `/media/${enc}`;
}

async function getTranscodePlan(lib, rel, abs) {
  await ensureTools();
  const cacheName = transcodeCacheName(lib.id, rel);
  const finalPath = path.join(state.TRANSCODE_DIR, cacheName);
  const tmpPath = finalPath + ".tmp";

  // Symlink/junction apontando para fora da biblioteca: recusa antes de passar
  // o caminho ao ffprobe/ffmpeg (ssrf/filesystem — nunca analisar alvo externo).
  if (!(await fileWithinLibrary(lib, abs))) {
    return { error: true, message: "Arquivo não encontrado." };
  }

  const origStat = await fs.stat(abs).catch(() => null);
  if (!origStat) return { error: true, message: "Arquivo não encontrado." };

  // Cache válido? O original não mudou desde a conversão (spec 6).
  const finalStat = await fs.stat(finalPath).catch(() => null);
  if (finalStat && finalStat.mtimeMs >= origStat.mtimeMs) {
    console.log(`[TRANSCODE] cache encontrado: ${rel}`);
    return { compatible: false, status: "ready", url: `/transcoded/${cacheName}` };
  }

  // Job ativo (concluído nesta sessão ou em andamento): deduplica.
  const existing = transcodeJobs.get(cacheName);
  if (existing && existing.status === "failed") {
    return { error: true, message: existing.error || "Falha ao transcodificar este vídeo." };
  }
  if (existing && (existing.status === "queued" || existing.status === "processing")) {
    existing.lastConsumerAt = Date.now();
    console.log(`[TRANSCODE] aguardando job existente: ${rel}`);
    return { compatible: false, status: "transcoding", url: `/transcoded/${cacheName}` };
  }

  // O navegador reproduz o original? Não transcodifica (spec 2).
  const probe = await probeMedia(abs);
  if (probe && isBrowserCompatibleVideo(probe)) {
    return { compatible: true, url: mediaUrlFromRel(lib, rel) };
  }

  if (!ffmpegAvailable) {
    return {
      error: true,
      message:
        "Este vídeo não é compatível com o navegador e o FFmpeg não está disponível neste computador.",
    };
  }

  const job = startTranscodeJob(lib.id, cacheName, rel, abs, tmpPath, finalPath, probe);
  return { compatible: false, status: "transcoding", url: `/transcoded/${cacheName}` };
}

function parseByteRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    start = 0;
    end = m[2] ? parseInt(m[2], 10) : null; // bytes=-N: raro; trata como 0-N
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : null;
  }
  if (!Number.isFinite(start) || start < 0) return null;
  return { start, end: end == null ? null : Math.max(start, end) };
}

// Serva o .tmp enquanto o ffmpeg escreve: o <video> começa a tocar assim que o
// init + 1º fragmento existem. Seek para além do já convertido espera até o
// ffmpeg alcançar (limite TRANSCODE_SEEK_WAIT_MS) e então responde 416.
async function serveGrowingFile(req, res, job) {
  const tmpPath = job.tmpPath;
  // O fallback responde na hora; o ffmpeg pode ainda não ter criado o .tmp
  // quando o cliente já pede a URL (e um job enfileirado espera o slot).
  // Espera até o init existir (limite generoso) em vez de dar 404 prematuro
  // que derrubaria o <video>.
  const deadline = Date.now() + 30000;
  let currentSize = 0;
  while (Date.now() < deadline) {
    if (job.status === "completed" || job.status === "failed") break;
    try {
      currentSize = (await fs.stat(tmpPath)).size;
    } catch {}
    if (currentSize > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  // Corrida: o transcode terminou entre a checagem de job ativo e o stat —
  // o .tmp já foi renomeado. Serve o final (Range completo) em vez de 404.
  if (job.status === "completed") {
    return res.sendFile(job.finalPath, (err) => {
      if (err && err.code !== "ECONNRESET") res.destroy();
    });
  }
  if (job.status === "failed") {
    return res.status(500).end();
  }
  if (currentSize === 0) {
    return res.status(404).end();
  }

  const range = parseByteRange(req.headers.range);
  let start = range ? range.start : 0;
  const end = range ? range.end : null;

  if (range && start > 0 && start >= currentSize) {
    const deadline = Date.now() + state.TRANSCODE_SEEK_WAIT_MS;
    while (Date.now() < deadline && job.status !== "failed" && job.status !== "completed") {
      await new Promise((r) => setTimeout(r, 300));
      try {
        currentSize = (await fs.stat(tmpPath)).size;
      } catch {}
      if (start < currentSize) break;
    }
    if (start >= currentSize) {
      return res
        .status(416)
        .set("Content-Range", `bytes */${currentSize}`)
        .end();
    }
  }

  res.set("Content-Type", "video/mp4");
  res.set("Accept-Ranges", "bytes");
  res.set("Cache-Control", "private, no-store");

  if (range) {
    // Total ainda desconhecido (arquivo cresce): Content-Range com "*".
    const availEnd = Math.max(start + 1, currentSize);
    res.status(206);
    res.set("Content-Range", `bytes ${start}-${availEnd - 1}/*`);
  } else {
    res.status(200);
  }

  streamGrowingFile(res, job, start, end);
}

// Lê o arquivo conforme ele cresce e entrega ao cliente; encerra quando o job
// conclui (EOF) ou falha. O fd aponta para o inode mesmo após o rename.
function streamGrowingFile(res, job, start, end) {
  const tmpPath = job.tmpPath;
  const BUF = Buffer.alloc(64 * 1024);
  let offset = start;
  let fd = null;
  let closed = false;
  let timer = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (fd) {
      const f = fd;
      fd = null;
      f.close().catch(() => {});
    }
  };
  const finish = () => {
    cleanup();
    res.end();
  };
  const fail = () => {
    cleanup();
    res.destroy();
  };
  res.on("close", cleanup);

  async function loop() {
    if (closed) return;
    if (end != null && offset >= end) {
      finish();
      return;
    }
    let stat;
    try {
      stat = await fd.stat();
    } catch {
      fail();
      return;
    }
    if (offset >= stat.size) {
      if (job.status === "completed") {
        finish();
        return;
      }
      if (job.status === "failed") {
        fail();
        return;
      }
      timer = setTimeout(loop, 200);
      return;
    }
    const limit = end == null ? Infinity : end - offset;
    const want = Math.min(BUF.length, limit, stat.size - offset);
    const { bytesRead } = await fd.read(BUF, 0, want, offset);
    if (bytesRead <= 0) {
      if (job.status === "completed") {
        finish();
        return;
      }
      timer = setTimeout(loop, 200);
      return;
    }
    offset += bytesRead;
    // Cópia: o subarray é uma view sobre o BUF que a próxima leitura reescreve;
    // Buffer.from garante que os bytes enviados não sejam corrompidos.
    const chunk = Buffer.from(BUF.subarray(0, bytesRead));
    if (!res.write(chunk)) {
      await new Promise((r) => res.once("drain", r));
    }
    if (closed) return;
    if (end != null && offset >= end) {
      finish();
      return;
    }
    timer = setTimeout(loop, 20);
  }

  fs.open(tmpPath, "r")
    .then((f) => {
      fd = f;
      loop();
    })
    .catch(() => {
      // Corrida de rename: o transcode terminou entre o cabeçalho e o open, e
      // o .tmp já virou final — abre o final (mesmo conteúdo, fd preso ao
      // inode) em vez de destruir a resposta com empty reply.
      if (job.status === "completed") {
        fs.open(job.finalPath, "r")
          .then((f) => {
            fd = f;
            loop();
          })
          .catch(() => fail());
      } else {
        fail();
      }
    });
}

const TRANSCODED_NAME_RE = /^([0-9a-f]{24})\.mp4$/;

async function clearTranscodeCache() {
  const allJobs = [...transcodeJobs.values()];
  for (const j of allJobs) {
    j.status = "cancelled";
    if (j.proc) {
      try { j.proc.kill("SIGTERM"); } catch {}
    }
  }
  transcodeJobs.clear();
  transcodeQueue.length = 0;
  activeTranscodes = 0;
  setTimeout(() => {
    for (const j of allJobs) {
      if (j.proc) {
        try { j.proc.kill("SIGKILL"); } catch {}
        j.proc = null;
      }
    }
  }, 2000);
  const files = await fs.readdir(state.TRANSCODE_DIR).catch(() => []);
  await Promise.all(
    files.map((f) => fs.rm(path.join(state.TRANSCODE_DIR, f), { force: true }).catch(() => {})),
  );
  console.log("[TRANSCODE] cache limpo");
}

function discardQueuedTranscodeJobsForLibrary(libraryId) {
  for (const [cacheName, job] of transcodeJobs) {
    if (job.libraryId === libraryId && job.status === "queued") {
      const idx = transcodeQueue.indexOf(job);
      if (idx >= 0) transcodeQueue.splice(idx, 1);
      transcodeJobs.delete(cacheName);
      console.log(`[TRANSCODE] descartado (biblioteca removida): ${job.rel}`);
    }
  }
}

function transcodeHasActiveJobs(libraryId) {
  for (const job of transcodeJobs.values()) {
    if (job.libraryId === libraryId && job.status === "processing") return true;
  }
  return false;
}

module.exports = {
  resolveToolBin,
  FFMPEG_BIN,
  FFPROBE_BIN,
  detectTool,
  ensureTools,
  execFileAsync,
  parseFfmpegInfo,
  probeMedia,
  BROWSER_VIDEO_CODECS,
  BROWSER_AUDIO_CODECS,
  BROWSER_CONTAINERS,
  isBrowserCompatibleVideo,
  transcodeJobs,
  transcodeQueue,
  getActiveTranscodes,
  startTranscodeJob,
  scheduleNextTranscode,
  runTranscode,
  mediaUrlFromRel,
  getTranscodePlan,
  parseByteRange,
  serveGrowingFile,
  streamGrowingFile,
  TRANSCODED_NAME_RE,
  clearTranscodeCache,
  discardQueuedTranscodeJobsForLibrary,
  transcodeHasActiveJobs,
  acquireHeavySlot,
  releaseHeavySlot: state.releaseHeavySlot,
  refreshHeavyMax: state.refreshHeavyMax,
  heavySlots: state.heavySlots,
  get ffmpegAvailable() { return ffmpegAvailable; },
  set ffmpegAvailable(v) { ffmpegAvailable = v; },
  get ffprobeAvailable() { return ffprobeAvailable; },
  set ffprobeAvailable(v) { ffprobeAvailable = v; },
};
