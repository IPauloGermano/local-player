// Detecção de providers e status do ecossistema de IA (Whisper / Modelos)

const fs = require("fs/promises");
const path = require("path");
const state = require("../state");
const {
  AI_TRANSCRIPTION_PROVIDERS,
  loadAiConfig,
} = require("./config");
const { sanitizeTestError } = require("../core/scan");
const { resolveWorkspaceDir, getWorkspaceFreeBytes } = require("../subtitles/workspace");
const { transcriptionAvailability } = require("../subtitles/pipeline");

const BIN_DIR = path.join(state.APP_DIR, "bin");
const MODELS_DIR = path.join(state.APP_DIR, "models");
const WHISPER_BIN = process.env.WHISPER_BIN || null;
const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || null;

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function scanDirForNames(dir, prefixes) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  return names.filter(n => prefixes.some(pr => n.startsWith(pr)));
}

function modelSearchPrefix(provider, modelId) {
  const base = provider.modelFilePattern.replace("{model}", modelId);
  const m = base.match(/^(.*)(\.\w+)$/);
  return m ? m[1] : base;
}

async function detectTranscriptionProvider(provider) {
  let binaryAvailable = false;
  if (provider.id === "whisper" && WHISPER_BIN) {
    binaryAvailable = await fileExists(WHISPER_BIN);
  }
  if (!binaryAvailable) {
    binaryAvailable = (await scanDirForNames(BIN_DIR, provider.binaryNames)).length > 0;
  }
  const candidateModelDirs = [
    provider.id === "whisper" && WHISPER_MODEL_DIR ? WHISPER_MODEL_DIR : null,
    path.join(state.DATA_DIR, "models"),
    path.join(state.APP_DIR, "..", "models"),
    path.join(process.cwd(), "models"),
    MODELS_DIR,
  ].filter(Boolean);
  const models = [];
  for (const m of provider.models) {
    let installed = false;
    let sizeBytes = null;
    const prefix = modelSearchPrefix(provider, m.id);
    for (const dir of candidateModelDirs) {
      const found = await scanDirForNames(dir, [prefix]);
      if (found.length) {
        installed = true;
        try { sizeBytes = (await fs.stat(path.join(dir, found[0]))).size; } catch {}
        break;
      }
    }
    models.push({ id: m.id, name: m.name, installed, sizeBytes });
  }
  const installedModel = (models.find(x => x.installed) || {}).id || null;
  return {
    id: provider.id,
    name: provider.name,
    runtime: provider.runtime,
    local: provider.local,
    available: binaryAvailable,
    modelInstalled: !!installedModel,
    installedModel,
    models,
    languages: provider.languages.map(l => ({ id: l.id, name: l.name })),
    capabilities: provider.capabilities || { vad: false, wordTimestamps: false, threads: false },
  };
}

async function getAiStatus() {
  const cfg = await loadAiConfig();
  const transcription = { providers: [], configured: null };
  for (const p of AI_TRANSCRIPTION_PROVIDERS) {
    transcription.providers.push(await detectTranscriptionProvider(p));
  }
  const configuredProvider = transcription.providers.find(p => p.id === cfg.transcription.provider) || null;
  const configuredModelInstalled = configuredProvider
    ? ((configuredProvider.models.find(m => m.id === cfg.transcription.model) || {}).installed ?? false)
    : false;
  transcription.configured = {
    provider: cfg.transcription.provider,
    model: cfg.transcription.model,
    language: cfg.transcription.language,
    enabled: cfg.transcription.enabled,
    available: configuredProvider ? configuredProvider.available : false,
    modelInstalled: configuredModelInstalled,
    vad: cfg.transcription.vad === true,
    vadSupported: configuredProvider ? configuredProvider.capabilities?.vad === true : false,
    pregenFirstLesson: cfg.transcription.pregenFirstLesson === true,
    pregenNextLesson: cfg.transcription.pregenNextLesson === true,
    background: cfg.transcription.background === true,
  };
  try {
    transcription.configured.canGenerate =
      (await transcriptionAvailability(cfg)).available === true;
  } catch {
    transcription.configured.canGenerate = false;
  }
  const llm = {
    providers: cfg.llm.providers.map(p => ({
      id: p.id,
      type: p.type,
      name: p.name,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      hasApiKey: !!p.apiKey,
      configured: !!p.baseUrl,
    })),
  };
  let workspace = { mode: cfg.workspace.mode, dir: cfg.workspace.dir, dirResolved: null, freeBytes: null, error: null };
  try {
    const resolved = await resolveWorkspaceDir(cfg);
    workspace.dirResolved = resolved;
    workspace.freeBytes = await getWorkspaceFreeBytes(resolved);
  } catch (err) {
    workspace.error = sanitizeTestError(err.message || "workspace error");
  }
  return { transcription, llm, advanced: cfg.advanced, workspace, updatedAt: cfg.updatedAt };
}

async function dirSize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fs.stat(p).catch(() => null))?.size || 0;
  }
  return total;
}

module.exports = {
  BIN_DIR,
  MODELS_DIR,
  WHISPER_BIN,
  WHISPER_MODEL_DIR,
  fileExists,
  scanDirForNames,
  modelSearchPrefix,
  detectTranscriptionProvider,
  getAiStatus,
  dirSize,
};
