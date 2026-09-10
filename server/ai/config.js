// Configuração persistente e sanitização de Inteligência Artificial (Whisper / LLM / Skills)

const AI_TRANSCRIPTION_PROVIDERS = [
  {
    id: "whisper",
    name: "Whisper",
    runtime: "whisper.cpp",
    local: true,
    binaryNames: ["whisper-cli", "whisper-cli-"],
    modelFilePattern: "ggml-{model}.bin",
    capabilities: { vad: false, wordTimestamps: false, threads: true },
    models: [
      { id: "tiny", name: "Tiny" },
      { id: "base", name: "Base" },
      { id: "small", name: "Small" },
      { id: "medium", name: "Medium" },
      { id: "large-v3-turbo", name: "Large v3 Turbo" },
    ],
    languages: [
      { id: "auto", name: "Detecção automática" },
      { id: "pt", name: "Português (Brasil)" },
      { id: "en", name: "Inglês" },
      { id: "es", name: "Espanhol" },
      { id: "fr", name: "Francês" },
      { id: "de", name: "Alemão" },
      { id: "it", name: "Italiano" },
      { id: "nl", name: "Holandês" },
      { id: "ja", name: "Japonês" },
      { id: "ko", name: "Coreano" },
      { id: "zh", name: "Chinês" },
      { id: "ru", name: "Russo" },
    ],
  },
  {
    id: "moonshine",
    name: "Moonshine",
    runtime: "onnx",
    local: true,
    binaryNames: ["moonshine", "moonshine-"],
    modelFilePattern: "moonshine-{model}",
    capabilities: { vad: false, wordTimestamps: false, threads: false },
    models: [
      { id: "tiny", name: "Tiny" },
      { id: "base", name: "Base" },
    ],
    languages: [
      { id: "en", name: "Inglês" },
    ],
  },
];

const AI_LLM_PROVIDER_TYPES = [
  { id: "openai-compatible", name: "OpenAI-compatible", chatEndpoint: "/chat/completions" },
];

const AI_LLM_PRESETS = [
  { id: "ollama", name: "Ollama (Local)", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio (Local)", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp", name: "llama.cpp / vLLM (Local)", baseUrl: "http://127.0.0.1:8080/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "omniroute", name: "OmniRoute" },
  { id: "custom", name: "Personalizado / outro compatível" },
];

const AI_STR_LIMITS = { name: 80, baseUrl: 500, model: 120, apiKey: 500 };

function objOr(v, dflt) { return v && typeof v === "object" && !Array.isArray(v) ? v : dflt; }
function clampStr(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }

function defaultAiConfig() {
  return {
    transcription: {
      enabled: true,
      provider: "whisper",
      model: "small",
      language: "pt",
      generateMode: "auto",
      pregenFirstLesson: true,
      pregenNextLesson: true,
      background: false,
      vad: true,
    },
    tutor: {
      enabled: true,
      providerId: "",
      model: "",
      temperature: 0.3,
      systemPrompt: "",
      includeTranscription: true,
      includeMaterials: true,
      webSearch: {
        enabled: true,
        provider: "duckduckgo",
        maxResults: 3,
        autoSearch: true,
      },
      maxContextTokens: 16000,
    },
    skills: {
      caveman: {
        enabled: false,
        mode: "caveman",
        preserveCode: true,
        customInstructions: "",
        applyToTutor: true,
      },
      rtk: {
        enabled: false,
        stripBoilerplate: true,
        filterLogs: true,
        maxLinesPerSnippet: 60,
        applyToMaterials: true,
      },
      headroom: {
        enabled: false,
        compressCode: true,
        compressJson: true,
        alignCache: true,
        applyToContext: true,
      },
    },
    postprocessing: { capitalize: true, segment: true, technicalDictionary: false },
    llm: { providers: [] },
    advanced: {
      maxConcurrentTranscriptions: 1,
      maxConcurrentAiJobs: 1,
      transcriptionThreads: 0,
      llmTimeoutMs: 15000,
    },
    workspace: { mode: "auto", dir: "" },
    updatedAt: null,
  };
}

function findTranscriptionProvider(id) {
  return AI_TRANSCRIPTION_PROVIDERS.find(p => p.id === id) || null;
}

function sanitizeAiConfig(raw) {
  if (!objOr(raw)) return defaultAiConfig();
  const out = defaultAiConfig();

  const tr = objOr(raw.transcription, {});
  out.transcription.enabled = tr.enabled !== false;
  out.transcription.generateMode =
    tr.generateMode === "manual" ? "manual" : "auto";
  out.transcription.pregenFirstLesson = tr.pregenFirstLesson !== false;
  out.transcription.pregenNextLesson = tr.pregenNextLesson !== false;
  out.transcription.background = tr.background === true;
  out.transcription.vad = tr.vad !== false;
  const curProv = findTranscriptionProvider(tr.provider);
  out.transcription.provider = curProv ? curProv.id : out.transcription.provider;
  if (curProv) {
    const m = curProv.models.some(x => x.id === tr.model);
    out.transcription.model = m ? clampStr(tr.model, 40) : curProv.models[0].id;
    const l = curProv.languages.some(x => x.id === tr.language);
    out.transcription.language = l ? clampStr(tr.language, 10) : curProv.languages[0].id;
  }

  const pp = objOr(raw.postprocessing, {});
  out.postprocessing.capitalize = pp.capitalize !== false;
  out.postprocessing.segment = pp.segment !== false;
  out.postprocessing.technicalDictionary = pp.technicalDictionary === true;

  const tu = objOr(raw.tutor, {});
  out.tutor.enabled = tu.enabled !== false;
  out.tutor.providerId = clampStr(tu.providerId, 80);
  out.tutor.model = clampStr(tu.model, AI_STR_LIMITS.model);
  const temp = Number(tu.temperature);
  out.tutor.temperature = Number.isFinite(temp) ? Math.min(2.0, Math.max(0.0, temp)) : 0.3;
  out.tutor.systemPrompt = clampStr(tu.systemPrompt, 4000);
  out.tutor.includeTranscription = tu.includeTranscription !== false;
  out.tutor.includeMaterials = tu.includeMaterials !== false;
  const tws = objOr(tu.webSearch, {});
  out.tutor.webSearch = {
    enabled: tws.enabled !== false,
    provider: ["duckduckgo", "searxng", "custom"].includes(tws.provider) ? tws.provider : "duckduckgo",
    maxResults: Number.isFinite(Number(tws.maxResults)) ? Math.min(10, Math.max(1, Math.floor(Number(tws.maxResults)))) : 3,
    autoSearch: tws.autoSearch !== false,
  };

  const sk = objOr(raw.skills, {});
  const cv = objOr(sk.caveman, {});
  out.skills.caveman.enabled = cv.enabled === true;
  out.skills.caveman.mode = ["caveman", "concise", "custom"].includes(cv.mode) ? cv.mode : "caveman";
  out.skills.caveman.preserveCode = cv.preserveCode !== false;
  out.skills.caveman.customInstructions = clampStr(cv.customInstructions, 2000);
  out.skills.caveman.applyToTutor = cv.applyToTutor !== false;

  const rtk = objOr(sk.rtk, {});
  out.skills.rtk.enabled = rtk.enabled === true;
  out.skills.rtk.stripBoilerplate = rtk.stripBoilerplate !== false;
  out.skills.rtk.filterLogs = rtk.filterLogs !== false;
  const maxL = Number(rtk.maxLinesPerSnippet);
  out.skills.rtk.maxLinesPerSnippet = Number.isFinite(maxL) ? Math.min(500, Math.max(10, Math.floor(maxL))) : 60;
  out.skills.rtk.applyToMaterials = rtk.applyToMaterials !== false;

  const hr = objOr(sk.headroom, {});
  out.skills.headroom.enabled = hr.enabled === true;
  out.skills.headroom.compressCode = hr.compressCode !== false;
  out.skills.headroom.compressJson = hr.compressJson !== false;
  out.skills.headroom.alignCache = hr.alignCache !== false;
  out.skills.headroom.applyToContext = hr.applyToContext !== false;

  const llm = objOr(raw.llm, {});
  if (Array.isArray(llm.providers)) {
    for (const p of llm.providers) {
      if (!objOr(p) || !clampStr(p.id, 80)) continue;
      const type = AI_LLM_PROVIDER_TYPES.find(t => t.id === p.type);
      const baseUrl = clampStr(p.baseUrl, AI_STR_LIMITS.baseUrl);
      out.llm.providers.push({
        id: clampStr(p.id, 80),
        type: type ? type.id : AI_LLM_PROVIDER_TYPES[0].id,
        name: clampStr(p.name, AI_STR_LIMITS.name) || clampStr(p.id, 80),
        baseUrl: (baseUrl === "" || /^https?:\/\//.test(baseUrl)) ? baseUrl : "",
        apiKey: typeof p.apiKey === "string" ? clampStr(p.apiKey, AI_STR_LIMITS.apiKey) : "",
        defaultModel: clampStr(p.defaultModel, AI_STR_LIMITS.model),
      });
    }
  }

  const ad = objOr(raw.advanced, {});
  const mct = Number(ad.maxConcurrentTranscriptions);
  out.advanced.maxConcurrentTranscriptions = Number.isFinite(mct)
    ? Math.min(8, Math.max(1, Math.floor(mct))) : out.advanced.maxConcurrentTranscriptions;
  const mca = Number(ad.maxConcurrentAiJobs);
  out.advanced.maxConcurrentAiJobs = Number.isFinite(mca)
    ? Math.min(8, Math.max(1, Math.floor(mca))) : out.advanced.maxConcurrentAiJobs;
  const th = Number(ad.transcriptionThreads);
  out.advanced.transcriptionThreads = Number.isFinite(th)
    ? Math.min(16, Math.max(0, Math.floor(th))) : out.advanced.transcriptionThreads;
  const to = Number(ad.llmTimeoutMs);
  out.advanced.llmTimeoutMs = Number.isFinite(to)
    ? Math.min(120000, Math.max(1000, Math.floor(to))) : out.advanced.llmTimeoutMs;

  const ws = objOr(raw.workspace, {});
  if (ws.mode === "custom") {
    const dir = clampStr(ws.dir, 2048);
    out.workspace.mode = "custom";
    out.workspace.dir = dir;
  }
  out.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt.slice(0, 40) : null;
  return out;
}

function sanitizePatchProvider(p) {
  if (!objOr(p) || !clampStr(p.id, 80)) return null;
  const type = AI_LLM_PROVIDER_TYPES.find(t => t.id === p.type);
  const baseUrl = clampStr(p.baseUrl, AI_STR_LIMITS.baseUrl);
  return {
    id: clampStr(p.id, 80),
    type: type ? type.id : AI_LLM_PROVIDER_TYPES[0].id,
    name: clampStr(p.name, AI_STR_LIMITS.name) || clampStr(p.id, 80),
    baseUrl: (baseUrl === "" || /^https?:\/\//.test(baseUrl)) ? baseUrl : "",
    apiKey: typeof p.apiKey === "string" ? clampStr(p.apiKey, AI_STR_LIMITS.apiKey) : "",
    defaultModel: clampStr(p.defaultModel, AI_STR_LIMITS.model),
  };
}

function applyAiPatch(config, patch) {
  const out = JSON.parse(JSON.stringify(config));
  const src = objOr(patch, {});

  const removeId = clampStr(src.llm && src.llm.removeProviderId, 80);
  if (Array.isArray(src.llm && src.llm.providers)) {
    const seen = new Set();
    for (const p of src.llm.providers) {
      const np = sanitizePatchProvider(p);
      if (!np || seen.has(np.id)) continue;
      seen.add(np.id);
      const existing = out.llm.providers.find(x => x.id === np.id);
      if (existing) {
        if (p.type !== undefined) existing.type = np.type;
        if (p.name !== undefined) existing.name = np.name;
        if (p.baseUrl !== undefined) existing.baseUrl = np.baseUrl;
        if (p.defaultModel !== undefined) existing.defaultModel = np.defaultModel;
        if (np.apiKey) existing.apiKey = np.apiKey;
        else if (p.clearApiKey === true) existing.apiKey = "";
      } else {
        out.llm.providers.push(np);
      }
    }
  }
  if (removeId) out.llm.providers = out.llm.providers.filter(x => x.id !== removeId);

  const tu = objOr(src.tutor, {});
  if (Object.keys(tu).length) {
    if (tu.enabled !== undefined) out.tutor.enabled = tu.enabled === true;
    if (tu.providerId !== undefined) {
      const has = out.llm.providers.some(x => x.id === tu.providerId);
      if (tu.providerId !== "" && !has) throw new Error("Provedor do Tutor IA inválido.");
      out.tutor.providerId = clampStr(tu.providerId, 80);
    }
    if (tu.model !== undefined) out.tutor.model = clampStr(tu.model, AI_STR_LIMITS.model);
    if (tu.temperature !== undefined) {
      const temp = Number(tu.temperature);
      out.tutor.temperature = Number.isFinite(temp) ? Math.min(2.0, Math.max(0.0, temp)) : 0.3;
    }
    if (tu.systemPrompt !== undefined) out.tutor.systemPrompt = clampStr(tu.systemPrompt, 4000);
    if (tu.includeTranscription !== undefined) out.tutor.includeTranscription = tu.includeTranscription === true;
    if (tu.includeMaterials !== undefined) out.tutor.includeMaterials = tu.includeMaterials === true;
    if (tu.webSearch !== undefined && typeof tu.webSearch === "object") {
      out.tutor.webSearch = {
        ...out.tutor.webSearch,
        ...(tu.webSearch.enabled !== undefined ? { enabled: tu.webSearch.enabled === true } : {}),
        ...(tu.webSearch.provider !== undefined && ["duckduckgo", "searxng", "custom"].includes(tu.webSearch.provider) ? { provider: tu.webSearch.provider } : {}),
        ...(tu.webSearch.maxResults !== undefined && Number.isFinite(Number(tu.webSearch.maxResults)) ? { maxResults: Math.min(10, Math.max(1, Math.floor(Number(tu.webSearch.maxResults)))) } : {}),
        ...(tu.webSearch.autoSearch !== undefined ? { autoSearch: tu.webSearch.autoSearch === true } : {}),
      };
    }
    if (tu.maxContextTokens !== undefined) {
      const mct = Number(tu.maxContextTokens);
      out.tutor.maxContextTokens = Number.isFinite(mct) ? Math.min(64000, Math.max(1000, Math.floor(mct))) : 16000;
    }
  }

  const tr = objOr(src.transcription, {});
  if (Object.keys(tr).length) {
    if (tr.provider !== undefined) {
      const prov = findTranscriptionProvider(tr.provider);
      if (tr.provider !== "" && !prov) throw new Error("Provedor de transcrição inválido.");
      out.transcription.provider = prov ? prov.id : "";
    }
    const curProv = findTranscriptionProvider(out.transcription.provider);
    if (tr.model !== undefined) {
      if (curProv) {
        const m = curProv.models.some(x => x.id === tr.model);
        if (!m) throw new Error("Modelo inválido para o provedor selecionado.");
        out.transcription.model = clampStr(tr.model, 40);
      }
    }
    if (tr.language !== undefined) {
      if (curProv) {
        const l = curProv.languages.some(x => x.id === tr.language);
        if (!l) throw new Error("Idioma inválido para o provedor selecionado.");
        out.transcription.language = clampStr(tr.language, 10);
      }
    }
    if (tr.enabled !== undefined) out.transcription.enabled = tr.enabled === true;
    if (tr.generateMode !== undefined) {
      out.transcription.generateMode = tr.generateMode === "manual" ? "manual" : "auto";
    }
    if (tr.pregenFirstLesson !== undefined) out.transcription.pregenFirstLesson = tr.pregenFirstLesson !== false;
    if (tr.pregenNextLesson !== undefined) out.transcription.pregenNextLesson = tr.pregenNextLesson !== false;
    if (tr.background !== undefined) out.transcription.background = tr.background === true;
    if (tr.vad !== undefined) out.transcription.vad = tr.vad !== false;
  }

  const pp = objOr(src.postprocessing, {});
  if (Object.keys(pp).length) {
    if (pp.capitalize !== undefined) out.postprocessing.capitalize = pp.capitalize !== false;
    if (pp.segment !== undefined) out.postprocessing.segment = pp.segment !== false;
    if (pp.technicalDictionary !== undefined) out.postprocessing.technicalDictionary = pp.technicalDictionary === true;
  }

  const ad = objOr(src.advanced, {});
  if (Object.keys(ad).length) {
    const mct = Number(ad.maxConcurrentTranscriptions);
    out.advanced.maxConcurrentTranscriptions = Number.isFinite(mct)
      ? Math.min(8, Math.max(1, Math.floor(mct))) : out.advanced.maxConcurrentTranscriptions;
    const mj = Number(ad.maxConcurrentAiJobs);
    out.advanced.maxConcurrentAiJobs = Number.isFinite(mj)
      ? Math.min(8, Math.max(1, Math.floor(mj))) : out.advanced.maxConcurrentAiJobs;
    const th = Number(ad.transcriptionThreads);
    out.advanced.transcriptionThreads = Number.isFinite(th)
      ? Math.min(16, Math.max(0, Math.floor(th))) : out.advanced.transcriptionThreads;
    const to = Number(ad.llmTimeoutMs);
    out.advanced.llmTimeoutMs = Number.isFinite(to)
      ? Math.min(120000, Math.max(1000, Math.floor(to))) : out.advanced.llmTimeoutMs;
  }

  const sk = objOr(src.skills, {});
  if (Object.keys(sk).length) {
    if (!out.skills) out.skills = defaultAiConfig().skills;
    const cv = objOr(sk.caveman, {});
    if (Object.keys(cv).length) {
      if (cv.enabled !== undefined) out.skills.caveman.enabled = cv.enabled === true;
      if (cv.mode !== undefined && ["caveman", "concise", "custom"].includes(cv.mode)) {
        out.skills.caveman.mode = cv.mode;
      }
      if (cv.preserveCode !== undefined) out.skills.caveman.preserveCode = cv.preserveCode !== false;
      if (cv.customInstructions !== undefined) out.skills.caveman.customInstructions = clampStr(cv.customInstructions, 2000);
      if (cv.applyToTutor !== undefined) out.skills.caveman.applyToTutor = cv.applyToTutor === true;
    }
    const rtk = objOr(sk.rtk, {});
    if (Object.keys(rtk).length) {
      if (rtk.enabled !== undefined) out.skills.rtk.enabled = rtk.enabled === true;
      if (rtk.stripBoilerplate !== undefined) out.skills.rtk.stripBoilerplate = rtk.stripBoilerplate !== false;
      if (rtk.filterLogs !== undefined) out.skills.rtk.filterLogs = rtk.filterLogs !== false;
      if (rtk.maxLinesPerSnippet !== undefined) {
        const maxL = Number(rtk.maxLinesPerSnippet);
        out.skills.rtk.maxLinesPerSnippet = Number.isFinite(maxL) ? Math.min(500, Math.max(10, Math.floor(maxL))) : 60;
      }
      if (rtk.applyToMaterials !== undefined) out.skills.rtk.applyToMaterials = rtk.applyToMaterials !== false;
    }
    const hr = objOr(sk.headroom, {});
    if (Object.keys(hr).length) {
      if (hr.enabled !== undefined) out.skills.headroom.enabled = hr.enabled === true;
      if (hr.compressCode !== undefined) out.skills.headroom.compressCode = hr.compressCode === true;
      if (hr.compressJson !== undefined) out.skills.headroom.compressJson = hr.compressJson === true;
      if (hr.alignCache !== undefined) out.skills.headroom.alignCache = hr.alignCache === true;
      if (hr.applyToContext !== undefined) out.skills.headroom.applyToContext = hr.applyToContext === true;
    }
  }

  const ws = objOr(src.workspace, {});
  if (Object.keys(ws).length) {
    const dir = clampStr(ws.dir, 2048);
    out.workspace.mode = ws.mode === "custom" ? "custom" : "auto";
    out.workspace.dir = out.workspace.mode === "custom" ? dir : "";
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

function maskAiConfig(config) {
  return {
    transcription: { ...config.transcription },
    tutor: { ...config.tutor },
    postprocessing: { ...config.postprocessing },
    skills: config.skills ? JSON.parse(JSON.stringify(config.skills)) : defaultAiConfig().skills,
    llm: {
      providers: (config.llm && config.llm.providers ? config.llm.providers : []).map(p => ({
        id: p.id,
        type: p.type,
        name: p.name,
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
        hasApiKey: !!p.apiKey,
      })),
    },
    advanced: { ...config.advanced },
    workspace: { ...config.workspace },
    updatedAt: config.updatedAt,
  };
}

module.exports = {
  AI_TRANSCRIPTION_PROVIDERS,
  AI_LLM_PROVIDER_TYPES,
  AI_LLM_PRESETS,
  AI_STR_LIMITS,
  defaultAiConfig,
  findTranscriptionProvider,
  sanitizeAiConfig,
  sanitizePatchProvider,
  applyAiPatch,
  maskAiConfig,
};
