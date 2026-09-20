// Rotas HTTP da Central de Inteligência Artificial e Armazenamento

const fs = require("fs/promises");
const path = require("path");
const state = require("../state");
const { requireAdminOrLocal } = require("../core/security");
const { validateLlmEndpointUrl } = require("../services/web-search");
const { sanitizeDisplayPath } = require("../core/titles");
const { sanitizeTestError } = require("../core/scan");
const { ensureWorkspaceWritable, resolveWorkspaceDir, getWorkspaceFreeBytes } = require("../subtitles/workspace");
const { requestDesktopIpc } = require("../core/desktop-ipc");
const {
  AI_STR_LIMITS,
  objOr,
  clampStr,
  loadAiConfig,
  saveAiConfig,
  applyAiPatch,
  maskAiConfig,
} = require("./config");
const {
  getAiStatus,
  dirSize,
  WHISPER_BIN,
  WHISPER_MODEL_DIR,
} = require("./status");

function registerAiRoutes(app) {
  // Status de armazenamento (Fase 6): números REAIS de espaço para a aba
  // "Dados e armazenamento" das Configurações. Nunca aceita path de cliente.
  app.get("/api/storage/status", async (req, res) => {
    try {
      const cfg = await loadAiConfig();
      const wsDir = await resolveWorkspaceDir(cfg).catch(() => null);
      const statfsFree = async (dir) => {
        try {
          const s = await fs.statfs(dir);
          return Number(s.bavail) * Number(s.bsize);
        } catch {
          return null;
        }
      };
      const subtitleDir = path.join(state.DATA_DIR, "subtitles");
      res.json({
        dataBytes: await dirSize(state.DATA_DIR),
        transcodeBytes: await dirSize(state.TRANSCODE_DIR),
        subtitlesBytes: await dirSize(subtitleDir),
        appFreeBytes: await statfsFree(state.DATA_DIR),
        workspace: {
          mode: cfg.workspace.mode,
          dir: sanitizeDisplayPath(cfg.workspace.dir),
          dirResolved:
            cfg.workspace.mode === "custom" && wsDir
              ? sanitizeDisplayPath(wsDir)
              : "Temporário do sistema (automático)",
          freeBytes: wsDir ? await getWorkspaceFreeBytes(wsDir) : null,
        },
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "storage error") });
    }
  });

  app.get("/api/ai/status", async (req, res) => {
    try {
      res.json(await getAiStatus());
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "status error") });
    }
  });

  app.get("/api/ai/config", async (req, res) => {
    try {
      res.json(maskAiConfig(await loadAiConfig()));
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "config error") });
    }
  });

  app.post("/api/ai/config", requireAdminOrLocal, async (req, res) => {
    try {
      const config = await saveAiConfig((cfg) => applyAiPatch(cfg, req.body));
      // Valida o workspace custom antes de aceitar: deve ser criável/escrevível
      // (preferencialmente num disco local — mas sem presumir caminhos).
      if (config.workspace.mode === "custom") {
        try {
          await ensureWorkspaceWritable(config.workspace.dir);
        } catch (err) {
          config.workspace.mode = "auto";
          config.workspace.dir = "";
          await saveAiConfig(() => config);
          return res.status(400).json({
            error: "Diretório de trabalho inválido: " + sanitizeTestError(err.message || "não criável"),
          });
        }
      }
      res.json(maskAiConfig(config));
    } catch (err) {
      res.status(400).json({ error: sanitizeTestError(err.message || "config error") });
    }
  });

  app.post("/api/ai/reset", requireAdminOrLocal, async (req, res) => {
    try {
      await fs.rm(state.AI_CONFIG_FILE, { force: true });
      res.json(maskAiConfig(await loadAiConfig()));
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "reset error") });
    }
  });

  app.post("/api/ai/llm/test", requireAdminOrLocal, async (req, res) => {
    try {
      const body = objOr(req.body, {});
      let provider = null;
      let apiKey = "";
      if (body.providerId) {
        const cfg = await loadAiConfig();
        provider = cfg.llm.providers.find((p) => p.id === clampStr(body.providerId, 80)) || null;
        if (!provider) return res.status(400).json({ ok: false, error: "Provedor não encontrado." });
        apiKey = provider.apiKey;
      } else {
        provider = {
          baseUrl: clampStr(body.baseUrl, AI_STR_LIMITS.baseUrl),
          defaultModel: clampStr(body.model, AI_STR_LIMITS.model),
        };
        apiKey = clampStr(body.apiKey, AI_STR_LIMITS.apiKey);
      }
      const baseUrl = (provider.baseUrl || "").replace(/\/+$/, "");
      if (!/^https?:\/\//.test(baseUrl)) {
        return res.status(400).json({ ok: false, error: "URL inválida (use http:// ou https://)." });
      }
      const model = provider.defaultModel;
      if (!model) return res.status(400).json({ ok: false, error: "Informe um modelo para o teste." });
      const timeoutMs = (await loadAiConfig()).advanced.llmTimeoutMs;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const started = Date.now();
      try {
        const endpoint = baseUrl.endsWith("/chat/completions")
          ? baseUrl
          : `${baseUrl}/chat/completions`;

        // Endpoints LLM locais (Ollama, LM Studio, llama.cpp) usam loopback
        // com portas próprias — validação específica, não a anti-SSRF da web.
        const safeCheck = await validateLlmEndpointUrl(endpoint);
        if (!safeCheck.ok) {
          return res.status(400).json({ ok: false, error: safeCheck.error });
        }

        const resp = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "Responda apenas: OK" }],
            max_tokens: 5,
            temperature: 0,
          }),
          redirect: "manual",
          signal: ctrl.signal,
        });
        const latencyMs = Date.now() - started;
        if (!resp.ok) {
          let detail = `HTTP ${resp.status}`;
          try {
            const j = await resp.json();
            if (j && typeof j.error === "string") detail = sanitizeTestError(j.error);
            else if (j && j.error && typeof j.error.message === "string") detail = sanitizeTestError(j.error.message);
          } catch {}
          return res.json({ ok: false, error: detail, status: resp.status, latencyMs });
        }
        console.log(`[AI] teste de conexão OK: ${model} (${latencyMs}ms)`);
        return res.json({ ok: true, model, latencyMs });
      } catch (err) {
        const latencyMs = Date.now() - started;
        const reason = err && err.name === "AbortError"
          ? `Tempo limite excedido (${Math.round(timeoutMs / 1000)}s).`
          : (err && err.cause && err.cause.code
            ? `Falha de rede (${err.cause.code}).`
            : sanitizeTestError(err.message || "erro"));
        return res.json({ ok: false, error: reason, latencyMs });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      res.status(400).json({ ok: false, error: sanitizeTestError(err.message || "test error") });
    }
  });

  app.get("/api/ai/models/info", async (req, res) => {
    const modelDir = (WHISPER_MODEL_DIR && typeof WHISPER_MODEL_DIR === "string")
      ? WHISPER_MODEL_DIR
      : path.join(state.DATA_DIR, "models");
    res.json({
      ok: true,
      modelDir,
      whisperBin: WHISPER_BIN || "Integrado / bin/",
      isDesktop: typeof process.send === "function",
    });
  });

  app.post("/api/ai/models/select-file", requireAdminOrLocal, async (req, res) => {
    if (typeof process.send !== "function") {
      return res.json({ supported: false, error: "not_desktop" });
    }
    const result = await requestDesktopIpc("select-model-file");
    res.json(result);
  });

  app.post("/api/ai/models/open-folder", requireAdminOrLocal, async (req, res) => {
    if (typeof process.send !== "function") {
      return res.json({ supported: false, error: "not_desktop" });
    }
    const result = await requestDesktopIpc("open-models-folder");
    res.json(result);
  });
}

module.exports = {
  registerAiRoutes,
};
