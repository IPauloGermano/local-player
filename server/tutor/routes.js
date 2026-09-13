const path = require("path");
const state = require("../state");
const { VIDEO_EXT, sanitizeTestError, scanLibrary } = require("../core/scan");
const { resolveLibraryRel, isAppDirRel, fileWithinLibrary } = require("../core/paths");
const { requestLibrary } = require("../libraries/registry");
const { loadAiConfig, AI_LLM_PROVIDER_TYPES, objOr } = require("../ai/config");
const { applyRtkMaterialFiltering, applyHeadroomContextCompression } = require("../ai/skills");
const {
  buildQuizPrompt,
  buildFlashcardsPrompt,
  extractAndParseJson,
  sanitizeQuizResult,
  sanitizeFlashcardsResult,
} = require("../ai/study");
const {
  detectWebSearchIntent,
  searchVerifiedVideos,
  verifyYouTubeVideo,
  fetchSafeWebPage,
  htmlToCleanMarkdown,
  fetchAndSummarizeWebSources,
} = require("../services/web-search");
const { findNodeByPath, findParentFolder } = require("../../public/scope.js");
const { buildLessonTutorContext, buildTutorSystemPrompt } = require("./context");
const { streamLlmChat } = require("./chat");

function registerTutorRoutes(app) {
  app.get("/api/tutor/context", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ ok: false, error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ ok: false, error: "invalid path" });
    if (isAppDirRel(safe, lib)) return res.status(400).json({ ok: false, error: "invalid path" });
    if (!(await fileWithinLibrary(lib, safe.abs))) {
      return res.status(400).json({ ok: false, error: "invalid path" });
    }
    const ext = path.extname(safe.abs).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return res.status(400).json({ ok: false, error: "not a video" });

    try {
      const cfg = await loadAiConfig();
      const scannedLib = state.treeCaches.get(lib.id) || (await scanLibrary(lib));
      const tree = (scannedLib && scannedLib.tree) ? scannedLib.tree : scannedLib;
      const videoNode = findNodeByPath(tree, safe.rel);
      const parentFolder = findParentFolder(tree, safe.rel);
      const courseRel = safe.rel.split("/")[0];
      const courseNode = findNodeByPath(tree, courseRel) || parentFolder;
      const query = typeof req.query.q === "string" ? req.query.q : "";
      const ctx = await buildLessonTutorContext(lib, safe.rel, videoNode, courseNode, cfg, false, query);
      res.json({
        ok: true,
        courseTitle: ctx.courseTitle,
        lessonTitle: ctx.lessonTitle,
        breadcrumb: ctx.breadcrumb,
        hasTranscription: ctx.hasTranscription,
        transcriptionLength: ctx.transcriptionLength,
        materialsCount: ctx.materialsCount,
        materials: ctx.materials,
        tutorEnabled: cfg.tutor.enabled,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: sanitizeTestError(err.message || "context error") });
    }
  });

  app.get("/api/tutor/video/verify", async (req, res) => {
    const urlOrId = typeof req.query.url === "string" ? req.query.url : (typeof req.query.id === "string" ? req.query.id : "");
    if (!urlOrId) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'url' ou 'id' ausente." });
    }
    const result = await verifyYouTubeVideo(urlOrId);
    if (!result.valid) {
      return res.status(404).json({ ok: false, error: result.error || "Vídeo indisponível." });
    }
    return res.json({ ok: true, video: result });
  });

  app.get("/api/tutor/video/search", async (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
    const excludeId = typeof req.query.excludeId === "string" ? req.query.excludeId.trim() : "";
    const lessonPath = typeof req.query.lessonPath === "string" ? req.query.lessonPath.trim() : "";
    const lib = requestLibrary(req);

    let fullQuery = query;
    if (!fullQuery && lessonPath && lib) {
      const safe = resolveLibraryRel(lib, lessonPath);
      if (safe) {
        fullQuery = path.basename(safe.rel, path.extname(safe.rel));
      }
    }

    if (!fullQuery) {
      return res.status(400).json({ ok: false, error: "Parâmetro 'query' ausente." });
    }

    const results = await searchVerifiedVideos(fullQuery, 3, excludeId ? [excludeId] : []);
    return res.json({ ok: true, videos: results });
  });

  app.post("/api/tutor/chat", async (req, res) => {
    const body = objOr(req.body, {});
    const rel = typeof body.path === "string" ? body.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    if (isAppDirRel(safe, lib)) return res.status(400).json({ error: "invalid path" });
    if (!(await fileWithinLibrary(lib, safe.abs))) {
      return res.status(400).json({ error: "invalid path" });
    }
    const ext = path.extname(safe.abs).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return res.status(400).json({ error: "not a video" });

    try {
      const cfg = await loadAiConfig();
      if (!cfg.tutor.enabled) {
        return res.status(403).json({ error: "Tutor IA está desativado nas configurações." });
      }

      const providerId = cfg.tutor.providerId || (cfg.llm.providers[0] ? cfg.llm.providers[0].id : "");
      const provider = cfg.llm.providers.find((p) => p.id === providerId);
      if (!provider || !provider.baseUrl) {
        return res.status(400).json({
          error: "Nenhum provedor de IA configurado. Acesse Configurações > Inteligência Artificial > Provedores LLM para configurar.",
        });
      }

      const model = cfg.tutor.model || provider.defaultModel || "gpt-3.5-turbo";
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (!messages.length) {
        return res.status(400).json({ error: "Nenhuma mensagem enviada." });
      }

      const scannedLib = state.treeCaches.get(lib.id) || (await scanLibrary(lib));
      const tree = (scannedLib && scannedLib.tree) ? scannedLib.tree : scannedLib;
      const videoNode = findNodeByPath(tree, safe.rel);
      const parentFolder = findParentFolder(tree, safe.rel);
      const courseRel = safe.rel.split("/")[0];
      const courseNode = findNodeByPath(tree, courseRel) || parentFolder;

      const lastUserMsg = messages
        .filter((m) => m && m.role === "user" && typeof m.content === "string")
        .map((m) => m.content)
        .pop() || "";

      const isWebSearchEnabled = cfg.tutor.webSearch?.enabled !== false;
      const searchIntent = isWebSearchEnabled ? detectWebSearchIntent(lastUserMsg) : { needsSearch: false };

      let webSourcesResult = { query: "", sources: [], content: "" };

      if (searchIntent.needsSearch) {
        if (body.stream !== false && !res.headersSent) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders?.();
        }

        if (searchIntent.isVideo) {
          if (body.stream !== false && res.headersSent) {
            res.write(`data: ${JSON.stringify({ status: "searching_video", query: searchIntent.query })}\n\n`);
          }
          let vidQuery = searchIntent.query || "";
          const lessonName = videoNode?.name ? path.basename(videoNode.name, path.extname(videoNode.name)) : "";
          if (lessonName && !vidQuery.toLowerCase().includes(lessonName.toLowerCase())) {
            vidQuery = `${vidQuery} ${lessonName}`.trim();
          }
          const verifiedVideos = await searchVerifiedVideos(
            vidQuery,
            3,
            [],
            (ev) => {
              if (body.stream !== false && res.headersSent) {
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
              }
            }
          );

          if (verifiedVideos.length > 0) {
            const videoBlocks = verifiedVideos
              .map(
                (v, i) =>
                  `[Vídeo ${i + 1}]: "${v.title}"\nCanal: ${v.author}\nLink: ${v.url}\nEmbed: ${v.embedUrl}`
              )
              .join("\n\n");

            webSourcesResult = {
              query: vidQuery,
              sources: verifiedVideos.map((v) => ({ title: v.title, url: v.url })),
              content:
                `### VÍDEOS RECOMENDADOS VERIFICADOS (DISPONÍVEIS E TESTADOS PARA REPRODUÇÃO):\n\n${videoBlocks}\n\n` +
                `DIRETRIZ CRÍTICA DE VÍDEOS: Quando o aluno solicitar vídeos ou recomendações audiovisuais, utilize EXCLUSIVAMENTE os vídeos verificados listados acima. NUNCA invente links, URLs ou IDs fictícios de vídeos do YouTube. Apresente os vídeos indicados com seus títulos e links em formato Markdown padrão: [Título do Vídeo](URL). Nosso sistema incorporará automaticamente o player de vídeo na interface para que o aluno possa assistir diretamente aqui.`,
            };
          } else {
            webSourcesResult = {
              query: vidQuery,
              sources: [],
              content: `AVISO DE VÍDEOS: Não foram encontrados vídeos verificados e disponíveis para o tema "${vidQuery}" no momento. Informe ao aluno de forma clara e amigável que não há vídeos verificados disponíveis no momento, e NUNCA invente links ou URLs de vídeos fictícios.`,
            };
          }
        } else if (searchIntent.isUrl && searchIntent.targetUrl) {
          if (body.stream !== false && res.headersSent) {
            res.write(`data: ${JSON.stringify({ status: "reading", url: searchIntent.targetUrl, title: searchIntent.targetUrl })}\n\n`);
          }
          const pageRes = await fetchSafeWebPage(searchIntent.targetUrl, 1024 * 1024, 7000);
          if (pageRes.ok && pageRes.html) {
            const cleanMd = htmlToCleanMarkdown(pageRes.html, searchIntent.targetUrl);
            webSourcesResult = {
              query: searchIntent.targetUrl,
              sources: [{ title: searchIntent.targetUrl, url: searchIntent.targetUrl }],
              content: `### FONTE DA PÁGINA: ${searchIntent.targetUrl}\nURL: ${searchIntent.targetUrl}\n\n${cleanMd.slice(0, 12000)}`,
            };
          }
        } else {
          webSourcesResult = await fetchAndSummarizeWebSources(
            searchIntent.query,
            2,
            cfg.tutor.webSearch?.maxResults || 3,
            (ev) => {
              if (body.stream !== false && res.headersSent) {
                res.write(`data: ${JSON.stringify(ev)}\n\n`);
              }
            }
          );
        }
      }

      if (webSourcesResult.content) {
        if (cfg?.skills?.rtk?.enabled && cfg?.skills?.rtk?.applyToMaterials !== false) {
          webSourcesResult.content = applyRtkMaterialFiltering(webSourcesResult.content, ".md", cfg.skills.rtk);
        }
        if (cfg?.skills?.headroom?.enabled && cfg?.skills?.headroom?.applyToContext !== false) {
          webSourcesResult.content = applyHeadroomContextCompression(webSourcesResult.content, ".md", cfg.skills.headroom);
        }
      }

      const ctx = await buildLessonTutorContext(lib, safe.rel, videoNode, courseNode, cfg, false, lastUserMsg);
      const systemPrompt = buildTutorSystemPrompt(ctx.contextText, cfg.tutor.systemPrompt, cfg.skills, webSourcesResult.content);

      if (body.stream === false) {
        const type =
          AI_LLM_PROVIDER_TYPES.find((t) => t.id === provider.type) ||
          AI_LLM_PROVIDER_TYPES[0];
        const url = provider.baseUrl.replace(/\/+$/, "") + type.chatEndpoint;
        const timeoutMs = (cfg.advanced?.llmTimeoutMs || 15000) * 3;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        let resp;
        try {
          resp = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {}),
            },
            body: JSON.stringify({
              model,
              messages: [
                { role: "system", content: systemPrompt },
                ...messages
                  .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
                  .map((m) => ({ role: m.role, content: m.content.slice(0, 16000) })),
              ],
              temperature: cfg.tutor.temperature,
              stream: false,
            }),
            signal: ctrl.signal,
          });
        } catch (err) {
          clearTimeout(timer);
          const why = err && err.name === "AbortError" ? "Tempo limite de resposta do modelo esgotado." : (err && err.message) || "Erro de conexão com o provedor LLM.";
          return res.status(504).json({ error: sanitizeTestError(why) });
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) {
          return res.status(resp.status).json({ error: "Falha na chamada ao LLM." });
        }
        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content || "";
        return res.json({ ok: true, content, model, sources: webSourcesResult.sources });
      }

      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.flushHeaders?.();
      }

      await streamLlmChat({
        provider,
        model,
        temperature: cfg.tutor.temperature,
        messages,
        systemPrompt,
        res,
        req,
        timeoutMs: (cfg.advanced.llmTimeoutMs || 15000) * 3,
      });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: sanitizeTestError(err.message || "tutor chat error") });
      } else {
        res.write(`data: ${JSON.stringify({ error: sanitizeTestError(err.message || "tutor error") })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
    }
  });

  app.post("/api/study/quiz", async (req, res) => {
    const body = objOr(req.body, {});
    const rel = typeof body.path === "string" ? body.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ ok: false, error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ ok: false, error: "invalid path" });
    if (isAppDirRel(safe, lib)) return res.status(400).json({ ok: false, error: "invalid path" });
    if (!(await fileWithinLibrary(lib, safe.abs))) {
      return res.status(400).json({ ok: false, error: "invalid path" });
    }
    const ext = path.extname(safe.abs).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return res.status(400).json({ ok: false, error: "not a video" });

    try {
      const cfg = await loadAiConfig();
      const providerId = cfg.tutor?.providerId || (cfg.llm.providers[0] ? cfg.llm.providers[0].id : "");
      const provider = cfg.llm.providers.find((p) => p.id === providerId);
      if (!provider || !provider.baseUrl) {
        return res.status(400).json({
          ok: false,
          error: "Nenhum provedor de IA configurado. Acesse Configurações > Inteligência Artificial > Provedores LLM para configurar.",
        });
      }

      const model = cfg.tutor?.model || provider.defaultModel || "gpt-3.5-turbo";
      const count = Math.max(1, Math.min(15, Number(body.count) || 5));

      const scannedLib = state.treeCaches.get(lib.id) || (await scanLibrary(lib));
      const tree = (scannedLib && scannedLib.tree) ? scannedLib.tree : scannedLib;
      const videoNode = findNodeByPath(tree, safe.rel);
      const parentFolder = findParentFolder(tree, safe.rel);
      const courseRel = safe.rel.split("/")[0];
      const courseNode = findNodeByPath(tree, courseRel) || parentFolder;
      const topicQuery = typeof body.topic === "string" ? body.topic : "";
      const ctx = await buildLessonTutorContext(lib, safe.rel, videoNode, courseNode, cfg, false, topicQuery);

      const systemPrompt = buildQuizPrompt(ctx.contextText, count, cfg.skills);

      const type =
        AI_LLM_PROVIDER_TYPES.find((t) => t.id === provider.type) ||
        AI_LLM_PROVIDER_TYPES[0];
      const url = provider.baseUrl.replace(/\/+$/, "") + type.chatEndpoint;
      const timeoutMs = (cfg.advanced?.llmTimeoutMs || 15000) * 3;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `Gere o quiz com exatamente ${count} questões com base no conteúdo da aula "${ctx.lessonTitle}".` },
            ],
            temperature: 0.2,
            stream: false,
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const why = err && err.name === "AbortError" ? "Tempo limite para geração do quiz esgotado." : (err && err.message) || "Falha na chamada ao LLM.";
        return res.status(504).json({ ok: false, error: sanitizeTestError(why) });
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        let errMsg = `Falha na chamada ao LLM (HTTP ${resp.status})`;
        try {
          const errJson = await resp.json();
          if (errJson?.error) errMsg = typeof errJson.error === "string" ? errJson.error : errJson.error.message || errMsg;
        } catch {}
        return res.status(resp.status).json({ ok: false, error: errMsg });
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || "";
      const parsed = extractAndParseJson(content);
      const quiz = sanitizeQuizResult(parsed, count);

      if (!quiz) {
        return res.status(500).json({
          ok: false,
          error: "O modelo retornou uma estrutura de quiz incompatível. Tente gerar novamente.",
          raw: content.slice(0, 500),
        });
      }

      res.json({
        ok: true,
        quiz,
        lessonTitle: ctx.lessonTitle,
        hasTranscription: ctx.hasTranscription,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: sanitizeTestError(err.message || "quiz error") });
    }
  });

  app.post("/api/study/flashcards", async (req, res) => {
    const body = objOr(req.body, {});
    const rel = typeof body.path === "string" ? body.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ ok: false, error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ ok: false, error: "invalid path" });
    if (isAppDirRel(safe, lib)) return res.status(400).json({ ok: false, error: "invalid path" });
    if (!(await fileWithinLibrary(lib, safe.abs))) {
      return res.status(400).json({ ok: false, error: "invalid path" });
    }
    const ext = path.extname(safe.abs).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return res.status(400).json({ ok: false, error: "not a video" });

    try {
      const cfg = await loadAiConfig();
      const providerId = cfg.tutor?.providerId || (cfg.llm.providers[0] ? cfg.llm.providers[0].id : "");
      const provider = cfg.llm.providers.find((p) => p.id === providerId);
      if (!provider || !provider.baseUrl) {
        return res.status(400).json({
          ok: false,
          error: "Nenhum provedor de IA configurado. Acesse Configurações > Inteligência Artificial > Provedores LLM para configurar.",
        });
      }

      const model = cfg.tutor?.model || provider.defaultModel || "gpt-3.5-turbo";
      const count = Math.max(1, Math.min(20, Number(body.count) || 8));

      const scannedLib = state.treeCaches.get(lib.id) || (await scanLibrary(lib));
      const tree = (scannedLib && scannedLib.tree) ? scannedLib.tree : scannedLib;
      const videoNode = findNodeByPath(tree, safe.rel);
      const parentFolder = findParentFolder(tree, safe.rel);
      const courseRel = safe.rel.split("/")[0];
      const courseNode = findNodeByPath(tree, courseRel) || parentFolder;
      const topicQuery = typeof body.topic === "string" ? body.topic : "";
      const ctx = await buildLessonTutorContext(lib, safe.rel, videoNode, courseNode, cfg, false, topicQuery);

      const systemPrompt = buildFlashcardsPrompt(ctx.contextText, count, cfg.skills);

      const type =
        AI_LLM_PROVIDER_TYPES.find((t) => t.id === provider.type) ||
        AI_LLM_PROVIDER_TYPES[0];
      const url = provider.baseUrl.replace(/\/+$/, "") + type.chatEndpoint;
      const timeoutMs = (cfg.advanced?.llmTimeoutMs || 15000) * 3;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(provider.apiKey ? { Authorization: "Bearer " + provider.apiKey } : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: `Gere os flashcards com exatamente ${count} cartões com base no conteúdo da aula "${ctx.lessonTitle}".` },
            ],
            temperature: 0.2,
            stream: false,
          }),
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const why = err && err.name === "AbortError" ? "Tempo limite para geração de flashcards esgotado." : (err && err.message) || "Falha na chamada ao LLM.";
        return res.status(504).json({ ok: false, error: sanitizeTestError(why) });
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        let errMsg = `Falha na chamada ao LLM (HTTP ${resp.status})`;
        try {
          const errJson = await resp.json();
          if (errJson?.error) errMsg = typeof errJson.error === "string" ? errJson.error : errJson.error.message || errMsg;
        } catch {}
        return res.status(resp.status).json({ ok: false, error: errMsg });
      }

      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || "";
      const parsed = extractAndParseJson(content);
      const flashcards = sanitizeFlashcardsResult(parsed, count);

      if (!flashcards) {
        return res.status(500).json({
          ok: false,
          error: "O modelo retornou uma estrutura de flashcards incompatível. Tente gerar novamente.",
          raw: content.slice(0, 500),
        });
      }

      res.json({
        ok: true,
        flashcards,
        lessonTitle: ctx.lessonTitle,
        hasTranscription: ctx.hasTranscription,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: sanitizeTestError(err.message || "flashcards error") });
    }
  });
}

module.exports = {
  registerTutorRoutes,
};
