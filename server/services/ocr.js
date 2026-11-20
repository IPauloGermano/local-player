// Serviço de OCR Local Offline (Engine Plugável: Tesseract CLI / Tesseract.js + Rasterização PDF)
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");
const { execFile } = require("child_process");
const state = require("../state");
const { executableName } = require("../core/platform");
const { saveDocumentCache } = require("./document-extractors");
const { validateLlmEndpointUrl } = require("./web-search");
const { AI_LLM_PROVIDER_TYPES } = require("../ai/config");

const MAX_OCR_PAGES_PER_CALL = 5;
const DEFAULT_OCR_TIMEOUT_MS = 30000;
const DEFAULT_REMOTE_OCR_TIMEOUT_MS = 45000;
const MAX_VLM_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOCLING_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_TRAINEDDATA_BYTES = 25 * 1024 * 1024;
const DEFAULT_OCR_DPI = 200;
const WORKER_IDLE_MS = 60000;
const OCR_DOWNLOADABLE_LANGUAGES = Object.freeze(["por", "eng", "spa", "fra", "deu", "ita"]);
const TESSDATA_FAST_BASE_URL = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main";

let _pdfjsPromise = null;
function loadPdfJs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
      _pdfjsPromise = null;
      throw err;
    });
  }
  return _pdfjsPromise;
}

// ---------- Sanitização e Detecção Multiplataforma ----------

function sanitizeOcrLanguage(raw) {
  const cleaned = String(raw || "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (/^[a-z]{2,3}(\+[a-z]{2,3}){0,3}$/.test(cleaned)) {
    return cleaned;
  }
  return "por+eng";
}

function resolveCandidateBin(exeBase, envPath, extraDirs = []) {
  if (envPath && fsSync.existsSync(envPath)) return envPath;
  const binName = executableName(exeBase);
  const dirs = [
    path.join(state.APP_DIR, "bin", "ocr"),
    path.join(state.APP_DIR, "bin", "ffmpeg"),
    path.join(state.APP_DIR, "bin"),
    ...extraDirs,
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, binName);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return binName;
}

function execFilePromise(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        maxBuffer: opts.maxBuffer || 15 * 1024 * 1024,
        timeout: opts.timeout || DEFAULT_OCR_TIMEOUT_MS,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          if (opts.signal && opts.signal.aborted) {
            const abortErr = new Error("Operação de OCR cancelada.");
            abortErr.name = "AbortError";
            return reject(abortErr);
          }
          return reject(err);
        }
        resolve({ stdout, stderr });
      },
    );

    if (opts.signal) {
      if (opts.signal.aborted) {
        try { child.kill(); } catch {}
      } else {
        const onAbort = () => {
          try { child.kill(); } catch {}
        };
        opts.signal.addEventListener("abort", onAbort, { once: true });
        child.once("close", () => {
          opts.signal.removeEventListener("abort", onAbort);
        });
      }
    }
  });
}

let _binProbeCache = null;

async function probeBinary(bin, args) {
  try {
    await execFilePromise(bin, args, { timeout: 5000 });
    return true;
  } catch (err) {
    // Algumas versões de pdftoppm -v imprimem versão em stderr e retornam código 0 ou 99
    if (err && typeof err.code === "number" && err.stderr && /pdftoppm|poppler|tesseract/i.test(String(err.stderr))) {
      return true;
    }
    return false;
  }
}

function resolveOcrModelsDir() {
  if (process.env.OCR_MODEL_DIR) return path.resolve(process.env.OCR_MODEL_DIR);
  const candidates = [
    path.join(state.DATA_DIR, "models", "ocr"),
    path.join(state.APP_DIR, "models", "ocr"),
  ];
  for (const dir of candidates) {
    if (fsSync.existsSync(dir)) return dir;
  }
  return candidates[0];
}

async function listInstalledTrainedData(modelsDir) {
  const langs = new Set();
  const dirs = [
    modelsDir,
    path.join(state.DATA_DIR, "models", "ocr"),
    path.join(state.APP_DIR, "models", "ocr"),
  ];
  for (const dir of dirs) {
    const entries = await fs.readdir(dir).catch(() => []);
    for (const name of entries) {
      const m = /^([a-z]{2,3})\.traineddata(?:\.gz)?$/i.exec(name);
      if (m) langs.add(m[1].toLowerCase());
    }
  }
  return Array.from(langs).sort();
}

async function detectOcrCapabilities(forceRefresh = false) {
  if (_binProbeCache && !forceRefresh) {
    const modelsDir = resolveOcrModelsDir();
    const installedLanguages = await listInstalledTrainedData(modelsDir);
    return { ..._binProbeCache, modelsDir, installedLanguages };
  }

  const tesseractBin = resolveCandidateBin("tesseract", process.env.TESSERACT_BIN);
  const pdftoppmBin = resolveCandidateBin("pdftoppm", process.env.PDFTOPPM_BIN);
  const [tesseractCliAvailable, pdftoppmAvailable] = await Promise.all([
    probeBinary(tesseractBin, ["--version"]),
    probeBinary(pdftoppmBin, ["-v"]),
  ]);

  let tesseractJsAvailable = false;
  try {
    require.resolve("tesseract.js");
    tesseractJsAvailable = true;
  } catch {
    tesseractJsAvailable = false;
  }

  _binProbeCache = {
    tesseractBin,
    pdftoppmBin,
    tesseractCliAvailable,
    tesseractJsAvailable,
    pdftoppmAvailable,
  };

  const modelsDir = resolveOcrModelsDir();
  const installedLanguages = await listInstalledTrainedData(modelsDir);
  return {
    ..._binProbeCache,
    modelsDir,
    installedLanguages,
  };
}

async function getOcrStatus(cfg) {
  const caps = await detectOcrCapabilities();
  const ocrCfg = (cfg && cfg.ocr) || {};
  const providers = (cfg && cfg.llm && Array.isArray(cfg.llm.providers)) ? cfg.llm.providers : [];
  const vlmProvider =
    providers.find((p) => p.id === ocrCfg.vlmProviderId) ||
    providers.find((p) => p.id === (cfg && cfg.tutor && cfg.tutor.providerId)) ||
    providers[0] ||
    null;
  const vlmConfigured = !!(vlmProvider && vlmProvider.baseUrl && (ocrCfg.vlmModel || vlmProvider.defaultModel));
  const doclingConfigured = !!(ocrCfg.doclingUrl && /^https?:\/\//.test(ocrCfg.doclingUrl));
  const canRunOffline = caps.tesseractCliAvailable || caps.tesseractJsAvailable;
  return {
    enabled: ocrCfg.enabled !== false,
    engine: ocrCfg.engine || "auto",
    language: sanitizeOcrLanguage(ocrCfg.language),
    maxPagesPerCall: ocrCfg.maxPagesPerCall || 3,
    dpi: ocrCfg.dpi || DEFAULT_OCR_DPI,
    vlmProviderId: ocrCfg.vlmProviderId || "",
    vlmModel: ocrCfg.vlmModel || "",
    doclingUrl: ocrCfg.doclingUrl || "",
    tesseractCliAvailable: caps.tesseractCliAvailable,
    tesseractJsAvailable: caps.tesseractJsAvailable,
    pdftoppmAvailable: caps.pdftoppmAvailable,
    installedLanguages: caps.installedLanguages,
    modelsDir: caps.modelsDir,
    canRunOffline,
    vlmConfigured,
    doclingConfigured,
    canRun: canRunOffline || vlmConfigured || doclingConfigured,
  };
}

// ---------- Codificador PNG Puro em Node.js (zero dependências nativas) ----------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(typeStr, payload) {
  const typeBuf = Buffer.from(typeStr, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  const crcInput = Buffer.concat([typeBuf, payload]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, payload, crcBuf]);
}

function encodeRawToPng({ width, height, data, channels = 3 }) {
  const w = Math.floor(Number(width));
  const h = Math.floor(Number(height));
  if (!w || !h || !data) {
    throw new Error("Dados de imagem inválidos para codificação PNG.");
  }
  const colorType = channels === 1 ? 0 : channels === 4 ? 6 : 2;
  const rowBytes = w * channels;
  const raw = Buffer.alloc(h * (rowBytes + 1));
  const src = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  for (let y = 0; y < h; y++) {
    const dstOff = y * (rowBytes + 1);
    raw[dstOff] = 0; // filtro None
    const srcOff = y * rowBytes;
    const copyLen = Math.min(rowBytes, Math.max(0, src.length - srcOff));
    if (copyLen > 0) {
      src.copy(raw, dstOff + 1, srcOff, srcOff + copyLen);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function unpack1BppToGray(width, height, packed) {
  const out = Buffer.alloc(width * height);
  const bytesPerRow = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIdx = y * bytesPerRow + (x >> 3);
      const bit = (packed[byteIdx] >> (7 - (x & 7))) & 1;
      out[y * width + x] = bit ? 255 : 0;
    }
  }
  return out;
}

function convertPdfJsImageToPng(imgObj, ImageKind) {
  if (!imgObj || !imgObj.width || !imgObj.height || !imgObj.data) return null;
  const { width, height, data, kind } = imgObj;
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);

  // Caso já seja JPEG embutido
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { buffer: bytes, mime: "image/jpeg", width, height, source: "pdfjs-jpeg" };
  }

  const GRAY_1BPP = (ImageKind && ImageKind.GRAYSCALE_1BPP) || 1;
  const RGB_24BPP = (ImageKind && ImageKind.RGB_24BPP) || 2;
  const RGBA_32BPP = (ImageKind && ImageKind.RGBA_32BPP) || 3;

  let channels = 3;
  let pixelBuf = bytes;
  if (kind === GRAY_1BPP) {
    channels = 1;
    pixelBuf = unpack1BppToGray(width, height, bytes);
  } else if (kind === RGBA_32BPP || bytes.length === width * height * 4) {
    channels = 4;
  } else if (kind === RGB_24BPP || bytes.length === width * height * 3) {
    channels = 3;
  } else if (bytes.length === width * height) {
    channels = 1;
  }

  const png = encodeRawToPng({ width, height, data: pixelBuf, channels });
  return { buffer: png, mime: "image/png", width, height, source: "pdfjs-image" };
}

// ---------- Rasterização / Extração de Imagem de Página PDF ----------

async function rasterizePdfPageWithPdftoppm(absPath, pageNumber, opts = {}) {
  const caps = await detectOcrCapabilities();
  if (!caps.pdftoppmAvailable) return null;

  const dpi = Math.max(100, Math.min(300, Math.floor(Number(opts.dpi) || DEFAULT_OCR_DPI)));
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-ocr-ppm-"));
  const outPrefix = path.join(tmpDir, "page");
  try {
    await execFilePromise(
      caps.pdftoppmBin,
      [
        "-png",
        "-r", String(dpi),
        "-f", String(pageNumber),
        "-l", String(pageNumber),
        "-singlefile",
        absPath,
        outPrefix,
      ],
      { signal: opts.signal, timeout: opts.timeoutMs || DEFAULT_OCR_TIMEOUT_MS },
    );
    const pngPath = `${outPrefix}.png`;
    const buffer = await fs.readFile(pngPath);
    const width = buffer.length > 24 ? buffer.readUInt32BE(16) : 0;
    const height = buffer.length > 24 ? buffer.readUInt32BE(20) : 0;
    return { buffer, mime: "image/png", width, height, source: "pdftoppm" };
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function getPdfJsObjAsync(objs, name, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    try {
      if (objs.has && objs.has(name)) {
        clearTimeout(timer);
        settled = true;
        return resolve(objs.get(name));
      }
      objs.get(name, (val) => {
        if (!settled) {
          clearTimeout(timer);
          settled = true;
          resolve(val || null);
        }
      });
    } catch {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }
  });
}

async function extractPdfPageImageWithPdfJs(absPath, pageNumber, opts = {}) {
  if (opts.signal && opts.signal.aborted) {
    const e = new Error("Operação cancelada.");
    e.name = "AbortError";
    throw e;
  }
  const buf = await fs.readFile(absPath).catch(() => null);
  if (!buf || buf.length < 8) return null;

  let doc = null;
  try {
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({
      data: Uint8Array.from(buf),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    doc = await loadingTask.promise;
    if (pageNumber < 1 || pageNumber > doc.numPages) return null;

    const page = await doc.getPage(pageNumber);
    const opList = await page.getOperatorList();
    const OPS = pdfjs.OPS || {};
    const candidates = [];

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];
      if (fn === OPS.paintInlineImageXObject && args && args[0]) {
        candidates.push(args[0]);
      } else if (
        (fn === OPS.paintImageXObject || fn === OPS.paintImageXObjectRepeat || fn === OPS.paintJpegXObject) &&
        args &&
        typeof args[0] === "string"
      ) {
        const name = args[0];
        const store = name.startsWith("g_") && page.commonObjs ? page.commonObjs : page.objs;
        const imgObj = await getPdfJsObjAsync(store, name);
        if (imgObj) candidates.push(imgObj);
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return convertPdfJsImageToPng(candidates[0], pdfjs.ImageKind);
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    return null;
  } finally {
    if (doc && typeof doc.destroy === "function") {
      try { await doc.destroy(); } catch {}
    }
  }
}

async function extractPdfPageImage(absPath, pageNumber, opts = {}) {
  if (!opts.skipPdftoppm) {
    const ppm = await rasterizePdfPageWithPdftoppm(absPath, pageNumber, opts);
    if (ppm) return ppm;
  }
  return extractPdfPageImageWithPdfJs(absPath, pageNumber, opts);
}

// ---------- Fila de Concorrência = 1 (Proteção de CPU/RAM) ----------

let _ocrRunning = false;
const _ocrWaitQueue = [];

function acquireOcrSlot(signal) {
  if (signal && signal.aborted) {
    const e = new Error("Operação de OCR cancelada.");
    e.name = "AbortError";
    return Promise.reject(e);
  }
  if (!_ocrRunning) {
    _ocrRunning = true;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, onAbort: null };
    if (signal) {
      waiter.onAbort = () => {
        const idx = _ocrWaitQueue.indexOf(waiter);
        if (idx !== -1) _ocrWaitQueue.splice(idx, 1);
        const e = new Error("Operação de OCR cancelada.");
        e.name = "AbortError";
        reject(e);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }
    _ocrWaitQueue.push(waiter);
  });
}

function releaseOcrSlot() {
  while (_ocrWaitQueue.length > 0) {
    const next = _ocrWaitQueue.shift();
    if (next.onAbort) {
      // listener de abort removido se ainda ativo
    }
    next.resolve();
    return;
  }
  _ocrRunning = false;
}

// ---------- Motores de OCR (Tesseract CLI e Tesseract.js WASM) ----------

async function runTesseractCli(imageBuffer, opts = {}) {
  const caps = await detectOcrCapabilities();
  if (!caps.tesseractCliAvailable) return null;
  const lang = sanitizeOcrLanguage(opts.language);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-ocr-tess-"));
  const ext = opts.mime === "image/jpeg" ? ".jpg" : ".png";
  const imgPath = path.join(tmpDir, "input" + ext);
  try {
    await fs.writeFile(imgPath, imageBuffer);
    const { stdout } = await execFilePromise(
      caps.tesseractBin,
      [imgPath, "stdout", "-l", lang, "--psm", "3"],
      { signal: opts.signal, timeout: opts.timeoutMs || DEFAULT_OCR_TIMEOUT_MS },
    );
    return {
      text: String(stdout || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
      engine: "tesseract-cli",
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

let _tessWorker = null;
let _tessWorkerLang = null;
let _tessIdleTimer = null;

async function terminateOcrWorker() {
  if (_tessIdleTimer) {
    clearTimeout(_tessIdleTimer);
    _tessIdleTimer = null;
  }
  if (_tessWorker) {
    const w = _tessWorker;
    _tessWorker = null;
    _tessWorkerLang = null;
    try { await w.terminate(); } catch {}
  }
}

function scheduleWorkerIdleTerminate() {
  if (_tessIdleTimer) clearTimeout(_tessIdleTimer);
  _tessIdleTimer = setTimeout(() => {
    terminateOcrWorker().catch(() => {});
  }, WORKER_IDLE_MS);
  if (typeof _tessIdleTimer.unref === "function") {
    _tessIdleTimer.unref();
  }
}

async function runTesseractJs(imageBuffer, opts = {}) {
  if (opts.signal && opts.signal.aborted) {
    const e = new Error("Operação de OCR cancelada.");
    e.name = "AbortError";
    throw e;
  }

  let Tesseract;
  try {
    Tesseract = require("tesseract.js");
  } catch {
    return null;
  }

  const lang = sanitizeOcrLanguage(opts.language);
  const modelsDir = resolveOcrModelsDir();
  await fs.mkdir(modelsDir, { recursive: true }).catch(() => {});
  const installed = await listInstalledTrainedData(modelsDir);
  const needed = lang.split("+");
  const allLocal = needed.every((l) => installed.includes(l));

  if (_tessWorker && _tessWorkerLang !== lang) {
    await terminateOcrWorker();
  }

  if (!_tessWorker) {
    const workerOpts = { cachePath: modelsDir };
    if (allLocal) {
      workerOpts.langPath = modelsDir;
    }
    _tessWorker = await Tesseract.createWorker(lang, 1, workerOpts);
    _tessWorkerLang = lang;
  }

  const timeoutMs = opts.timeoutMs || DEFAULT_OCR_TIMEOUT_MS;
  let timer = null;
  let onAbort = null;
  try {
    const result = await Promise.race([
      _tessWorker.recognize(imageBuffer),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          terminateOcrWorker().catch(() => {});
          reject(new Error("Tempo limite excedido no OCR."));
        }, timeoutMs);
        if (opts.signal) {
          onAbort = () => {
            terminateOcrWorker().catch(() => {});
            const e = new Error("Operação de OCR cancelada.");
            e.name = "AbortError";
            reject(e);
          };
          if (opts.signal.aborted) onAbort();
          else opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
    scheduleWorkerIdleTerminate();
    const text = String(result?.data?.text || "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { text, engine: "tesseract-js" };
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && opts.signal) {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }
}

// ---------- Motores Avançados Opcionais (VLM Multimodal & IBM Docling) ----------

async function validateOcrServiceUrl(rawUrl) {
  const base = await validateLlmEndpointUrl(rawUrl);
  if (!base.ok) return base;
  const h = (base.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (
    h === "169.254.169.254" ||
    h.startsWith("169.254.") ||
    h === "fd00:ec2::254" ||
    h.startsWith("fe80:") ||
    h === "metadata.google.internal"
  ) {
    return { ok: false, error: `Host de metadata/link-local bloqueado por segurança: ${h}` };
  }
  return base;
}

function createLinkedAbortController(parentSignal, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let onAbort = null;
  if (parentSignal) {
    if (parentSignal.aborted) {
      ctrl.abort();
    } else {
      onAbort = () => ctrl.abort();
      parentSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    cleanup() {
      clearTimeout(timer);
      if (onAbort && parentSignal) parentSignal.removeEventListener("abort", onAbort);
    },
  };
}

async function runVlmOcr(imageBuffer, cfg, opts = {}) {
  if (imageBuffer.length > MAX_VLM_IMAGE_BYTES) {
    throw new Error("Imagem da página excede o limite de 10 MB para OCR via VLM.");
  }
  const ocrCfg = (cfg && cfg.ocr) || {};
  const providers = (cfg && cfg.llm && Array.isArray(cfg.llm.providers)) ? cfg.llm.providers : [];
  const providerId = ocrCfg.vlmProviderId || (cfg && cfg.tutor && cfg.tutor.providerId) || "";
  const provider = providers.find((p) => p.id === providerId) || providers[0] || null;
  if (!provider || !provider.baseUrl) {
    throw new Error("Nenhum provedor LLM configurado para OCR via VLM.");
  }
  const model = ocrCfg.vlmModel || provider.defaultModel || "";
  if (!model) {
    throw new Error("Nenhum modelo multimodal configurado para OCR via VLM.");
  }
  const type =
    AI_LLM_PROVIDER_TYPES.find((t) => t.id === provider.type) ||
    AI_LLM_PROVIDER_TYPES[0];
  const endpoint = provider.baseUrl.replace(/\/+$/, "") + type.chatEndpoint;
  const check = await validateOcrServiceUrl(endpoint);
  if (!check.ok) throw new Error(check.error);

  const mime = opts.mime === "image/jpeg" ? "image/jpeg" : "image/png";
  const dataUri = `data:${mime};base64,${imageBuffer.toString("base64")}`;
  const linked = createLinkedAbortController(opts.signal, opts.timeoutMs || DEFAULT_REMOTE_OCR_TIMEOUT_MS);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        ...(provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "Extraia fielmente todo o texto visível na imagem desta página de documento para Markdown limpo. Preserve tabelas em Markdown e fórmulas matemáticas em LaTeX ($ e $$). Não invente conteúdo nem adicione comentários fora da transcrição.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcreva fielmente todo o conteúdo textual, tabelas e fórmulas desta página." },
              { type: "image_url", image_url: { url: dataUri } },
            ],
          },
        ],
      }),
      signal: linked.signal,
    });
    if (!resp.ok) {
      throw new Error(`Falha no OCR via VLM (HTTP ${resp.status}).`);
    }
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = typeof content === "string"
      ? content.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
      : "";
    return { text, engine: "vlm" };
  } finally {
    linked.cleanup();
  }
}

async function runDoclingOcr(imageBuffer, cfg, opts = {}) {
  if (imageBuffer.length > MAX_DOCLING_IMAGE_BYTES) {
    throw new Error("Imagem da página excede o limite de 15 MB para OCR via Docling.");
  }
  const baseUrl = String((cfg && cfg.ocr && cfg.ocr.doclingUrl) || "").trim().replace(/\/+$/, "");
  const check = await validateOcrServiceUrl(baseUrl);
  if (!check.ok) throw new Error(check.error);

  const endpoint = `${baseUrl}/v1/convert/file`;
  const mime = opts.mime === "image/jpeg" ? "image/jpeg" : "image/png";
  const ext = mime === "image/jpeg" ? "jpg" : "png";
  const form = new FormData();
  form.append("files", new Blob([imageBuffer], { type: mime }), `page.${ext}`);
  form.append("to_formats", "md");

  const linked = createLinkedAbortController(opts.signal, opts.timeoutMs || DEFAULT_REMOTE_OCR_TIMEOUT_MS);
  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      body: form,
      signal: linked.signal,
    });
    if (!resp.ok) {
      throw new Error(`Falha no OCR via Docling (HTTP ${resp.status}).`);
    }
    const data = await resp.json();
    const raw =
      data?.document?.md_content ||
      data?.document?.text_content ||
      data?.md_content ||
      data?.markdown ||
      data?.text ||
      "";
    const text = String(raw).replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { text, engine: "docling" };
  } finally {
    linked.cleanup();
  }
}

async function ocrImageBuffer(imageBuffer, opts = {}) {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
    return { text: "", engine: null };
  }
  await acquireOcrSlot(opts.signal);
  try {
    if (opts.signal && opts.signal.aborted) {
      const e = new Error("Operação de OCR cancelada.");
      e.name = "AbortError";
      throw e;
    }

    if (typeof opts.customOcrRunner === "function") {
      return await opts.customOcrRunner(imageBuffer, opts);
    }

    const engine = opts.engine || (opts.cfg && opts.cfg.ocr && opts.cfg.ocr.engine) || "auto";
    if (engine === "off") return { text: "", engine: null };

    if (engine === "vlm") {
      return await runVlmOcr(imageBuffer, opts.cfg, opts);
    }

    if (engine === "docling") {
      return await runDoclingOcr(imageBuffer, opts.cfg, opts);
    }

    if (engine === "tesseract-cli" || engine === "auto") {
      try {
        const cliRes = await runTesseractCli(imageBuffer, opts);
        if (cliRes) return cliRes;
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        if (engine === "tesseract-cli") throw err;
      }
    }

    if (engine === "tesseract-js" || engine === "auto") {
      const jsRes = await runTesseractJs(imageBuffer, opts);
      if (jsRes) return jsRes;
    }

    return { text: "", engine: null };
  } finally {
    releaseOcrSlot();
  }
}

// ---------- Orquestrador Sob Demanda por Página + Cache Incremental ----------

async function ocrPdfPages(entry, doc, pageNumbers, cfg = null, opts = {}) {
  if (!entry || !entry.absPath || !doc || !Array.isArray(doc.pages)) return doc;
  const ocrCfg = (cfg && cfg.ocr) || {};
  if (ocrCfg.enabled === false || ocrCfg.engine === "off") return doc;

  const limit = Math.max(
    1,
    Math.min(MAX_OCR_PAGES_PER_CALL, Number(ocrCfg.maxPagesPerCall) || 3),
  );
  const targets = Array.from(new Set((pageNumbers || []).map((n) => Math.floor(Number(n)))))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= (doc.pageCount || doc.pages.length))
    .slice(0, limit);

  if (targets.length === 0) return doc;

  let changed = false;
  for (const pageNum of targets) {
    if (opts.signal && opts.signal.aborted) break;
    const pObj = doc.pages.find((p) => p.page === pageNum);
    if (pObj && pObj.status === "text_ready") continue;

    if (typeof opts.onStatus === "function") {
      opts.onStatus({
        status: "ocr_page",
        doc: entry.name,
        page: pageNum,
        label: `Executando OCR na página ${pageNum} de ${entry.name}...`,
      });
    }

    const rendered = await extractPdfPageImage(entry.absPath, pageNum, {
      dpi: ocrCfg.dpi || DEFAULT_OCR_DPI,
      signal: opts.signal,
      skipPdftoppm: opts.skipPdftoppm,
    });
    if (!rendered || !rendered.buffer) continue;

    const ocrRes = await ocrImageBuffer(rendered.buffer, {
      mime: rendered.mime,
      cfg,
      engine: opts.engine || ocrCfg.engine || "auto",
      language: opts.language || ocrCfg.language || "por+eng",
      signal: opts.signal,
      timeoutMs: opts.timeoutMs || DEFAULT_OCR_TIMEOUT_MS,
      customOcrRunner: opts.customOcrRunner,
    });

    const cleanText = String(ocrRes?.text || "").trim();
    const alphaCount = (cleanText.match(/[a-zA-Z0-9\u00C0-\u024F]/g) || []).length;
    if (cleanText.length >= 4 && alphaCount >= 3) {
      const updated = {
        page: pageNum,
        text: cleanText,
        status: "text_ready",
        source: `ocr:${ocrRes.engine || "local"}`,
        chars: cleanText.length,
      };
      if (pObj) Object.assign(pObj, updated);
      else doc.pages.push(updated);
      changed = true;
    }
  }

  if (changed) {
    doc.pages.sort((a, b) => a.page - b.page);
    doc.textPages = doc.pages.filter((p) => p.status === "text_ready").length;
    doc.ocrNeededPages = doc.pages.filter((p) => p.status === "needs_ocr").map((p) => p.page);
    doc.scanned = doc.pages.length > 0 && doc.textPages === 0;
    if (doc.cachePath) {
      await saveDocumentCache(doc.cachePath, doc).catch(() => {});
    }
  }

  return doc;
}

async function testDoclingConnection(rawUrl, opts = {}) {
  const baseUrl = String(rawUrl || "").trim().replace(/\/+$/, "");
  const check = await validateOcrServiceUrl(baseUrl);
  if (!check.ok) {
    return { ok: false, invalidUrl: true, error: check.error };
  }
  const timeoutMs = Number(opts.timeoutMs) || 8000;
  const started = Date.now();
  const linked = createLinkedAbortController(opts.signal, timeoutMs);
  try {
    let resp = await fetch(`${baseUrl}/health`, {
      method: "GET",
      redirect: "manual",
      signal: linked.signal,
    });
    if (resp.status === 404 || resp.status === 405) {
      resp = await fetch(`${baseUrl}/docs`, {
        method: "GET",
        redirect: "manual",
        signal: linked.signal,
      });
    }
    const latencyMs = Date.now() - started;
    if (resp.ok) {
      return { ok: true, status: resp.status, latencyMs };
    }
    return {
      ok: false,
      status: resp.status,
      latencyMs,
      error: `Servidor Docling retornou HTTP ${resp.status}.`,
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const reason = err && err.name === "AbortError"
      ? `Tempo limite excedido (${Math.round(timeoutMs / 1000)}s).`
      : (err && err.cause && err.cause.code
        ? `Falha de rede (${err.cause.code}).`
        : String((err && err.message) || "Erro ao conectar ao Docling."));
    return { ok: false, latencyMs, error: reason };
  } finally {
    linked.cleanup();
  }
}

async function writeBinaryFileAtomic(filePath, buffer) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(buffer);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  await fh.close();
  await fs.rename(tmp, filePath);
}

async function downloadTrainedData(lang, opts = {}) {
  const code = String(lang || "").trim().toLowerCase();
  if (!OCR_DOWNLOADABLE_LANGUAGES.includes(code)) {
    throw new Error(`Idioma OCR não suportado: "${code}". Permitidos: ${OCR_DOWNLOADABLE_LANGUAGES.join(", ")}.`);
  }
  const baseUrl = opts.baseUrl
    ? String(opts.baseUrl).replace(/\/+$/, "")
    : TESSDATA_FAST_BASE_URL;
  const url = `${baseUrl}/${code}.traineddata`;
  const timeoutMs = Number(opts.timeoutMs) || 60000;
  const linked = createLinkedAbortController(opts.signal, timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: linked.signal,
    });
    if (!resp.ok) {
      throw new Error(`Falha ao baixar modelo de idioma ${code} (HTTP ${resp.status}).`);
    }
    const contentLen = Number(resp.headers.get("content-length") || 0);
    if (contentLen > MAX_TRAINEDDATA_BYTES) {
      throw new Error("Arquivo de idioma excede o limite de segurança (25 MB).");
    }
    const chunks = [];
    let total = 0;
    if (resp.body && typeof resp.body.getReader === "function") {
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_TRAINEDDATA_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error("Arquivo de idioma excede o limite de segurança (25 MB).");
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const ab = await resp.arrayBuffer();
      if (ab.byteLength > MAX_TRAINEDDATA_BYTES) {
        throw new Error("Arquivo de idioma excede o limite de segurança (25 MB).");
      }
      chunks.push(Buffer.from(ab));
      total = ab.byteLength;
    }

    if (total < 100) {
      throw new Error("Arquivo de idioma baixado parece corrompido ou vazio.");
    }

    const buf = Buffer.concat(chunks);
    const modelsDir = opts.modelsDir ? path.resolve(opts.modelsDir) : resolveOcrModelsDir();
    const targetPath = path.join(modelsDir, `${code}.traineddata`);
    await writeBinaryFileAtomic(targetPath, buf);
    const installedLanguages = await listInstalledTrainedData(modelsDir);
    return {
      ok: true,
      lang: code,
      filePath: targetPath,
      sizeBytes: buf.length,
      modelsDir,
      installedLanguages,
    };
  } finally {
    linked.cleanup();
  }
}

module.exports = {
  MAX_OCR_PAGES_PER_CALL,
  DEFAULT_OCR_DPI,
  OCR_DOWNLOADABLE_LANGUAGES,
  sanitizeOcrLanguage,
  validateOcrServiceUrl,
  resolveOcrModelsDir,
  detectOcrCapabilities,
  getOcrStatus,
  encodeRawToPng,
  extractPdfPageImage,
  runVlmOcr,
  runDoclingOcr,
  testDoclingConnection,
  downloadTrainedData,
  ocrImageBuffer,
  ocrPdfPages,
  terminateOcrWorker,
};
