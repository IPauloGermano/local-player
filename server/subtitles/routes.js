const path = require("path");
const fs = require("fs/promises");
const state = require("../state");
const { readJsonFile, writeFileAtomic } = require("../core/fs-atomic");
const { sanitizeTestError, VIDEO_EXT } = require("../core/scan");
const { isAppDirRel, fileWithinLibrary } = require("../core/paths");
const { requireAdminOrLocal } = require("../core/security");
const { getTree } = require("../core/tree-cache");
const { requestLibrary, resolveLibraryRel } = require("../libraries/registry");
const { loadAiConfig, AI_LLM_PROVIDER_TYPES, objOr } = require("../ai/config");
const { subtitleCacheName } = require("../ai/subtitles-helpers");
const { extractAndParseJson } = require("../ai/study");
const {
  SUPPORTED_TARGET_LANGS,
  TARGET_LANG_LABELS,
  buildTranslatePrompt,
  sanitizeTranslationResult,
} = require("../ai/translation");

const {
  getSubtitleDir,
  getSubtitleRawDir,
  getSubtitleProcessedDir,
  getSubtitleWorkDir,
  getSubtitleEditedDir,
  getSubtitleBackupDir,
  cleanupWorkspace,
  ensureSubtitleDirs,
} = require("./workspace");

const {
  renderVtt,
  formatSrt,
  hasFinalVtt,
  hasValidSubtitle,
  removeCourseSubtitle,
  removeCourseTranslations,
  sweepCourseSubtitles,
  resolveSubtitleVttPath,
  resolveTranslationVttPath,
  writeCourseSubtitle,
} = require("./vtt");

const {
  loadEditableDoc,
  validateEditorSegments,
  saveEditedSubtitle,
} = require("./editor");

const {
  loadSubtitleJobs,
  startSubtitleJob,
  cancelSubtitleJob,
  subtitleJobPublic,
  transcriptionAvailability,
  loadValidProcessed,
  PRIORITY_DEMAND,
  PRIORITY_BG,
  SUBTITLE_STATUS_WAITING_SOURCE,
} = require("./pipeline");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseRetryAfter(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : null;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return diff > 0 ? diff : 0;
  }
  return null;
}

function getTranslateBatchSize() {
  const envVal = Number(process.env.TRANSLATE_BATCH_SIZE);
  return !Number.isNaN(envVal) && envVal > 0 ? envVal : 100;
}

function getTranslateMinIntervalMs() {
  return process.env.TRANSLATE_MIN_INTERVAL_MS !== undefined
    ? Number(process.env.TRANSLATE_MIN_INTERVAL_MS)
    : 100;
}

function getTranslateBackoffBaseMs() {
  return process.env.TRANSLATE_BACKOFF_BASE_MS !== undefined
    ? Number(process.env.TRANSLATE_BACKOFF_BASE_MS)
    : 1000;
}

function getTranslateBackoffMaxMs() {
  return process.env.TRANSLATE_BACKOFF_MAX_MS !== undefined
    ? Number(process.env.TRANSLATE_BACKOFF_MAX_MS)
    : 15000;
}

async function subtitleStatusFor(lib, rel, abs) {
  const hash = subtitleCacheName(lib.id, rel);
  const cfg = await loadAiConfig();
  const sourceStat = await fs.stat(abs).catch(() => null);
  let sourceReady = false;
  let sourceLanguage = cfg.transcription.language;
  if (sourceStat) {
    const processedPath = path.join(getSubtitleProcessedDir(), hash + ".json");
    const doc = await loadValidProcessed(processedPath, abs, sourceStat);
    if (doc) {
      sourceReady = true;
      if (doc.language) sourceLanguage = doc.language;
    }
  }
  const avail = await transcriptionAvailability(cfg);

  const activeStatus = new Set([
    "queued",
    "extracting",
    "transcribing",
    "processing",
    "formatting",
    SUBTITLE_STATUS_WAITING_SOURCE,
  ]);

  let ready = false;
  if (sourceStat) {
    const processedPath = path.join(getSubtitleProcessedDir(), hash + ".json");
    const doc = await loadValidProcessed(processedPath, abs, sourceStat);
    if (doc && (await hasFinalVtt(lib, rel, hash))) {
      ready = true;
    } else if (await hasFinalVtt(lib, rel, hash)) {
      ready = true;
      sourceReady = true;
    }
  }
  const job = state.subtitleJobs.get(hash);
  const editedDoc = await readJsonFile(path.join(getSubtitleEditedDir(), hash + ".json"));
  const edited = !!(editedDoc.ok && editedDoc.parsed && Array.isArray(editedDoc.parsed.segments));
  return {
    hash,
    ready,
    edited,
    status:
      job && activeStatus.has(job.status)
        ? job.status
        : job && (job.status === "failed" || job.status === "cancelled")
          ? job.status
          : null,
    progress: job && activeStatus.has(job.status) ? job.progress : null,
    percent: job && activeStatus.has(job.status) ? job.percent ?? null : null,
    error:
      job && (job.status === "failed" || job.status === SUBTITLE_STATUS_WAITING_SOURCE)
        ? job.error
        : null,
    canGenerate: !!avail.available,
    canGenerateSource: !!avail.available,
    generateMode: cfg.transcription.generateMode,
    language: sourceLanguage,
    sourceReady,
    pregenNextLesson: cfg.transcription.pregenNextLesson === true,
    pregenFirstLesson: cfg.transcription.pregenFirstLesson === true,
    background: cfg.transcription.background === true,
  };
}

function registerSubtitleRoutes(app) {
  app.get("/api/subtitles/editor", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    const ext = path.extname(safe.abs).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return res.status(400).json({ error: "not a video" });
    try {
      await loadSubtitleJobs();
      const sourceStat = await fs.stat(safe.abs).catch(() => null);
      const hash = subtitleCacheName(lib.id, safe.rel);
      const doc = await loadEditableDoc(lib, safe.rel, hash, safe.abs, sourceStat);
      if (!doc) {
        return res.json({
          hash,
          rel: safe.rel,
          source: null,
          segments: [],
          version: 0,
          edited: false,
          ready: false,
        });
      }
      const ready = !!(sourceStat && (await hasFinalVtt(lib, safe.rel, hash)));
      const cfg = await loadAiConfig();
      const avail = await transcriptionAvailability(cfg);
      res.json({
        ...doc,
        ready,
        canRegenerate: !!avail.available,
        canGenerate: !!avail.available,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "editor error") });
    }
  });

  app.post("/api/subtitles/save", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    const ext = path.extname(safe.abs).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return res.status(400).json({ error: "not a video" });
    const segments = validateEditorSegments(req.body && req.body.segments);
    if (!segments) return res.status(400).json({ error: "invalid segments" });
    const expectedVersion =
      req.body && Number.isInteger(req.body.version) ? req.body.version : null;
    try {
      await loadSubtitleJobs();
      const sourceStat = await fs.stat(safe.abs).catch(() => null);
      if (!sourceStat) return res.status(404).json({ error: "video not found" });
      const hash = subtitleCacheName(lib.id, safe.rel);
      const result = await saveEditedSubtitle(
        lib,
        safe.rel,
        hash,
        safe.abs,
        segments,
        expectedVersion,
        sourceStat,
      );
      if (result.conflict) {
        return res.status(409).json({
          error:
            "Esta legenda foi alterada em outra aba. Recarregue o editor antes de salvar.",
          serverVersion: result.serverVersion,
        });
      }
      console.log(
        `[SUBTITLE] edição salva: ${safe.rel} (${segments.length} segmentos, v${result.version})`,
      );
      res.json({ ok: true, version: result.version, updatedAt: result.updatedAt, hash });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "save error") });
    }
  });

  app.get("/api/subtitles/export", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const format = req.query.format === "srt" ? "srt" : "vtt";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    try {
      await loadSubtitleJobs();
      const sourceStat = await fs.stat(safe.abs).catch(() => null);
      const hash = subtitleCacheName(lib.id, safe.rel);
      const doc = await loadEditableDoc(lib, safe.rel, hash, safe.abs, sourceStat);
      if (!doc) return res.status(404).json({ error: "sem legenda" });
      const text = format === "srt" ? formatSrt(doc.segments) : renderVtt(doc.segments);
      res.set(
        "Content-Type",
        format === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8",
      );
      res.set("Content-Disposition", `attachment; filename="${hash}.${format}"`);
      res.send(text);
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "export error") });
    }
  });

  app.post("/api/subtitles/generate", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
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
    const priority = Number.isInteger(Number(req.query.priority))
      ? Math.min(3, Math.max(0, Number(req.query.priority)))
      : null;
    const force = req.query.force === "1" || req.query.force === "true";
    try {
      await loadSubtitleJobs();
      if (!force) {
        if (await hasValidSubtitle(lib, safe.rel, safe.abs)) {
          return res.json({ ok: true, skipped: true, alreadyRunning: false, status: "completed" });
        }
      }
      const { job, alreadyRunning, promoted } = startSubtitleJob(lib, safe.rel, safe.abs, {
        priority: priority ?? PRIORITY_DEMAND,
        force,
      });
      res.json({
        ok: true,
        hash: job.hash,
        status: job.status,
        alreadyRunning,
        promoted,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "generate error") });
    }
  });

  app.post("/api/subtitles/generate-course", async (req, res) => {
    const courseRel = typeof req.query.path === "string" ? req.query.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, courseRel);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    try {
      await loadSubtitleJobs();
      const tree = await getTree(false);
      const libEntry = (tree.libraries || []).find((l) => l.id === lib.id);
      const findCourse = (nodes) => {
        for (const c of nodes || []) {
          if (c.type === "folder" && c.path === safe.rel) return c;
          if (c.children) {
            const found = findCourse(c.children);
            if (found) return found;
          }
        }
        return null;
      };
      const course = libEntry && libEntry.tree
        ? findCourse(libEntry.tree.children)
        : null;
      if (!course) return res.status(404).json({ error: "course not found" });
      const videos = [];
      const walk = (node) => {
        for (const c of node.children || []) {
          if (c.type === "folder") walk(c);
          else if (c.type === "video") videos.push(c);
        }
      };
      walk(course);
      let enqueued = 0;
      let skipped = 0;
      for (const v of videos) {
        const vsafe = resolveLibraryRel(lib, v.path);
        if (!vsafe) continue;
        if (await hasValidSubtitle(lib, vsafe.rel, vsafe.abs)) {
          skipped += 1;
          continue;
        }
        startSubtitleJob(lib, vsafe.rel, vsafe.abs, { priority: PRIORITY_BG });
        enqueued += 1;
      }
      console.log(`[SUBTITLE] generate-course: ${enqueued} enfileirados, ${skipped} já prontos (${safe.rel})`);
      res.json({ ok: true, enqueued, skipped, total: videos.length });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "generate-course error") });
    }
  });

  app.get("/api/subtitles/status", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    try {
      await loadSubtitleJobs();
      res.json(await subtitleStatusFor(lib, safe.rel, safe.abs));
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "status error") });
    }
  });

  app.get("/api/subtitles/list", async (req, res) => {
    try {
      await loadSubtitleJobs();
      const processed = [];
      const files = await fs.readdir(getSubtitleProcessedDir()).catch(() => []);
      for (const f of files.filter((x) => x.endsWith(".json"))) {
        const read = await readJsonFile(path.join(getSubtitleProcessedDir(), f));
        if (!read.ok || !read.parsed) continue;
        const doc = read.parsed;
        const hash = f.replace(/\.json$/, "");
        const vttStat = await fs
          .stat(path.join(getSubtitleDir(), hash + ".vtt"))
          .catch(() => null);
        processed.push({
          hash,
          rel: (doc.source && doc.source.rel) || "",
          language: doc.language,
          provider: doc.provider,
          model: doc.model,
          segments: (doc.segments || []).length,
          hasVtt: !!(vttStat && vttStat.size > 0),
          createdAt: doc.createdAt || null,
        });
      }
      const jobs = await Promise.all(
        [...state.subtitleJobs.values()].map((j) => subtitleJobPublic(j.hash)),
      );
      const running = jobs.filter((j) =>
        ["extracting", "transcribing", "processing", "formatting"].includes(j.status),
      );
      res.json({
        summary: {
          processed: processed.length,
          queued: jobs.filter((j) => j.status === "queued").length,
          running: running.length,
          failed: jobs.filter((j) => j.status === "failed").length,
        },
        jobs,
        processed,
      });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "list error") });
    }
  });

  app.post("/api/subtitles/cancel", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    try {
      await loadSubtitleJobs();
      const cancelled = cancelSubtitleJob(subtitleCacheName(lib.id, safe.rel));
      res.json({ ok: true, cancelled });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "cancel error") });
    }
  });

  app.post("/api/subtitles/clear", requireAdminOrLocal, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Corpo da requisição deve ser um objeto JSON válido." });
    }
    const { path: relPath, all } = req.body;
    const hasPath = "path" in req.body;
    if (!hasPath && all !== true) {
      return res.status(400).json({
        error: "Payload ambíguo: para apagar todas as legendas envie { all: true }, ou informe { path }.",
      });
    }
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    let rel = null;
    if (relPath != null) {
      const safe = resolveLibraryRel(lib, relPath);
      if (!safe) return res.status(400).json({ error: "invalid path" });
      rel = safe.rel;
    }
    try {
      await loadSubtitleJobs();
      if (rel) {
        const hash = subtitleCacheName(lib.id, rel);
        cancelSubtitleJob(hash);
        await Promise.all([
          fs.rm(path.join(getSubtitleRawDir(), hash + ".json"), { force: true }),
          fs.rm(path.join(getSubtitleProcessedDir(), hash + ".json"), { force: true }),
          fs.rm(path.join(getSubtitleDir(), hash + ".vtt"), { force: true }),
          fs.rm(path.join(getSubtitleEditedDir(), hash + ".json"), { force: true }),
          removeCourseSubtitle(lib, rel, hash),
          removeCourseTranslations(lib, rel, hash),
        ]);
        const subFiles = await fs.readdir(getSubtitleDir()).catch(() => []);
        await Promise.all(
          subFiles
            .filter((f) => f.startsWith(hash + "-") && (f.endsWith(".vtt") || f.endsWith(".json")))
            .map((f) => fs.rm(path.join(getSubtitleDir(), f), { force: true })),
        );
        state.subtitleJobs.delete(hash);
        console.log(`[SUBTITLE] legenda excluída: ${rel} (${lib.id})`);
      } else {
        for (const hash of [...state.subtitleJobs.keys()]) cancelSubtitleJob(hash);
        await Promise.all([
          fs.rm(getSubtitleRawDir(), { recursive: true, force: true }),
          fs.rm(getSubtitleProcessedDir(), { recursive: true, force: true }),
          fs.rm(getSubtitleWorkDir(), { recursive: true, force: true }),
          fs.rm(getSubtitleEditedDir(), { recursive: true, force: true }),
          fs.rm(getSubtitleBackupDir(), { recursive: true, force: true }),
        ]);
        const allFiles = await fs.readdir(getSubtitleDir()).catch(() => []);
        await Promise.all(
          allFiles
            .filter((f) => f.endsWith(".vtt") || f.endsWith(".json"))
            .map((f) => fs.rm(path.join(getSubtitleDir(), f), { force: true })),
        );
        await sweepCourseSubtitles();
        state.subtitleJobs.clear();
        await ensureSubtitleDirs();
        try {
          await cleanupWorkspace(await loadAiConfig());
        } catch {}
        console.log("[SUBTITLE] cache de legendas limpo");
      }
      const { persistSubtitleJobs } = require("./pipeline");
      await persistSubtitleJobs();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "clear error") });
    }
  });

  app.post("/api/subtitles/workspace/cleanup", requireAdminOrLocal, async (req, res) => {
    try {
      const cfg = await loadAiConfig();
      const { removed } = await cleanupWorkspace(cfg);
      console.log(`[SUBTITLE] workspace limpo (${removed} arquivo(s) temporário(s))`);
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ error: sanitizeTestError(err.message || "cleanup error") });
    }
  });

  app.get("/api/subtitles/translations", async (req, res) => {
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
      const hash = subtitleCacheName(lib.id, safe.rel);
      const sourceStat = await fs.stat(safe.abs).catch(() => null);
      const sourceDoc = await loadEditableDoc(lib, safe.rel, hash, safe.abs, sourceStat);
      const sourceReady = !!(sourceDoc && Array.isArray(sourceDoc.segments) && sourceDoc.segments.length > 0);
      const sourceLanguage = (sourceDoc && sourceDoc.language) || null;

      const cfg = await loadAiConfig();
      const trlCfg = cfg.translation || {};
      const providerId = trlCfg.providerId || cfg.tutor?.providerId || "";
      const provider =
        (providerId && cfg.llm?.providers?.find((p) => p.id === providerId)) ||
        (cfg.llm?.providers && cfg.llm.providers[0]) ||
        null;
      const llmAvailable = !!(provider && provider.baseUrl);
      const configuredModel = trlCfg.model || (provider ? provider.defaultModel : "") || cfg.tutor?.model || "";

      const available = await Promise.all(
        SUPPORTED_TARGET_LANGS.map(async (lang) => {
          const vttPath = await resolveTranslationVttPath(lib, safe.rel, hash, lang);
          return {
            lang,
            ready: !!vttPath,
          };
        }),
      );

      res.json({
        ok: true,
        hash,
        sourceLanguage,
        ready: sourceReady,
        available,
        llmAvailable,
        configuredModel,
        defaultTargetLang: trlCfg.targetLanguage || "pt",
        enabled: trlCfg.enabled !== false,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: sanitizeTestError(err.message || "translations error") });
    }
  });

  app.post("/api/subtitles/translate", async (req, res) => {
    const body = objOr(req.body, {});
    const rel = typeof body.path === "string" ? body.path : (typeof req.query.path === "string" ? req.query.path : "");
    const targetLang = typeof body.targetLang === "string" ? body.targetLang.toLowerCase().trim() : "";
    const force = req.query.force === "1" || body.force === true;

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

    if (!targetLang || !SUPPORTED_TARGET_LANGS.includes(targetLang)) {
      return res.status(400).json({ ok: false, error: "Idioma-alvo inválido ou não suportado" });
    }

    try {
      const hash = subtitleCacheName(lib.id, safe.rel);
      const sourceStat = await fs.stat(safe.abs).catch(() => null);
      const sourceDoc = await loadEditableDoc(lib, safe.rel, hash, safe.abs, sourceStat);
      if (!sourceDoc || !Array.isArray(sourceDoc.segments) || sourceDoc.segments.length === 0) {
        return res.status(409).json({ ok: false, error: "sem legenda original" });
      }
      const sourceSegments = sourceDoc.segments;

      let sourceLang = sourceDoc.language || null;
      if (!sourceLang && sourceSegments.length > 0) {
        const sampleText = sourceSegments.slice(0, 15).map((s) => s.text).join(" ").toLowerCase();
        const enWords = (sampleText.match(/\b(the|and|is|in|to|of|you|that|it|welcome|hello|this)\b/g) || []).length;
        const ptWords = (sampleText.match(/\b(de|que|em|para|com|não|uma|os|bem-vindos|olá|este)\b/g) || []).length;
        if (enWords > ptWords) sourceLang = "en";
        else if (ptWords > enWords) sourceLang = "pt";
      }

      // Traduzir para o mesmo idioma da transcrição não faz sentido e gerava
      // um VTT "traduzido" indistinguível do original (ex.: pt→pt), que o
      // player passava a exibir no lugar da transcrição. Barra antes do
      // cache para valer também em cache-hit.
      if (sourceLang && targetLang === sourceLang) {
        const label = TARGET_LANG_LABELS[targetLang] || targetLang;
        return res.status(400).json({
          ok: false,
          error: `A legenda original já está em ${label}. Escolha outro idioma-alvo.`,
          sourceLanguage: sourceLang,
        });
      }

      const cfg = await loadAiConfig();
      const trlCfg = cfg.translation || {};
      if (trlCfg.enabled === false) {
        return res.status(400).json({
          ok: false,
          error: "A tradução de legendas está desativada na Central de IA (Configurações > Inteligência Artificial > Tradução).",
        });
      }

      const providerId = trlCfg.providerId || cfg.tutor?.providerId || "";
      const provider =
        (providerId && cfg.llm?.providers?.find((p) => p.id === providerId)) ||
        (cfg.llm?.providers && cfg.llm.providers[0]) ||
        null;
      if (!provider || !provider.baseUrl) {
        return res.status(400).json({
          ok: false,
          error: "Nenhum provedor de IA configurado. Acesse Configurações > Inteligência Artificial > Provedores LLM para configurar.",
        });
      }

      const jsonPath = path.join(getSubtitleDir(), `${hash}-${targetLang}.json`);
      if (!force) {
        const cached = await readJsonFile(jsonPath);
        if (cached.ok && cached.parsed && Array.isArray(cached.parsed.segments) && cached.parsed.segments.length > 0) {
          const vttPath = await resolveTranslationVttPath(lib, safe.rel, hash, targetLang);
          if (vttPath) {
            return res.json({
              ok: true,
              lang: targetLang,
              segments: cached.parsed.segments,
            });
          }
        }
      }

      const model = trlCfg.model || provider.defaultModel || cfg.tutor?.model || "gpt-3.5-turbo";
      const temperature = typeof trlCfg.temperature === "number" ? trlCfg.temperature : 0.3;
      const customPrompt = trlCfg.customPrompt || "";
      const type =
        AI_LLM_PROVIDER_TYPES.find((t) => t.id === provider.type) ||
        AI_LLM_PROVIDER_TYPES[0];
      const url = provider.baseUrl.replace(/\/+$/, "") + type.chatEndpoint;
      const timeoutMs = (cfg.advanced?.llmTimeoutMs || 15000) * 3;

      const partialPath = path.join(getSubtitleDir(), `${hash}-${targetLang}.partial.json`);
      if (force) {
        await fs.rm(partialPath, { force: true }).catch(() => {});
      }

      let resumeFrom = 0;
      let translatedSegments = [];

      if (!force) {
        const partial = await readJsonFile(partialPath);
        if (
          partial.ok &&
          partial.parsed &&
          partial.parsed.hash === hash &&
          partial.parsed.lang === targetLang &&
          partial.parsed.source &&
          partial.parsed.source.mtimeMs === (sourceStat ? sourceStat.mtimeMs : null) &&
          partial.parsed.source.size === (sourceStat ? sourceStat.size : null) &&
          Array.isArray(partial.parsed.segments) &&
          typeof partial.parsed.doneCount === "number" &&
          partial.parsed.doneCount === partial.parsed.segments.length &&
          partial.parsed.doneCount > 0 &&
          partial.parsed.doneCount <= sourceSegments.length
        ) {
          resumeFrom = partial.parsed.doneCount;
          translatedSegments = [...partial.parsed.segments];
        } else if (partial.ok) {
          await fs.rm(partialPath, { force: true }).catch(() => {});
        }
      }

      const BATCH_SIZE = getTranslateBatchSize();
      const minIntervalMs = getTranslateMinIntervalMs();
      const backoffBaseMs = getTranslateBackoffBaseMs();
      const backoffMaxMs = getTranslateBackoffMaxMs();
      const maxRetries = 4;
      let previousWaitMs = 0;

      for (let i = resumeFrom; i < sourceSegments.length; i += BATCH_SIZE) {
        const chunk = sourceSegments.slice(i, i + BATCH_SIZE);
        const systemPrompt = buildTranslatePrompt(sourceLang, targetLang, chunk, customPrompt);

        if (i > resumeFrom) {
          const delay = Math.max(minIntervalMs, previousWaitMs);
          if (delay > 0) await sleep(delay);
          previousWaitMs = 0;
        }

        let chunkSuccess = false;
        let lastErrorStatus = null;
        let lastErrorMessage = "";
        let lastRetryAfterMs = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), timeoutMs);
          let resp;
          let fetchError = null;
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
                  {
                    role: "user",
                    content: `Traduza os ${chunk.length} segmentos para o idioma "${targetLang}" mantendo estritamente a lista JSON [{"id":"...","text":"..."}].`,
                  },
                ],
                temperature,
                stream: false,
              }),
              signal: ctrl.signal,
            });
          } catch (err) {
            fetchError = err;
          } finally {
            clearTimeout(timer);
          }

          if (fetchError) {
            const isAbort = fetchError.name === "AbortError";
            lastErrorStatus = isAbort ? 504 : 502;
            lastErrorMessage = isAbort
              ? "Tempo limite para tradução de legendas esgotado."
              : (fetchError && fetchError.message) || "Falha na chamada ao LLM.";

            if (attempt < maxRetries) {
              const backoff = Math.min(
                backoffBaseMs * Math.pow(2, attempt - 1),
                backoffMaxMs,
              );
              if (backoff > 0) await sleep(backoff);
              continue;
            }
            break;
          }

          if (resp.ok) {
            const data = await resp.json().catch(() => null);
            const content = data?.choices?.[0]?.message?.content || "";
            const parsed = extractAndParseJson(content);
            const chunkTranslated = sanitizeTranslationResult(parsed, chunk);
            translatedSegments.push(...chunkTranslated);
            chunkSuccess = true;

            const partialDoc = {
              version: 1,
              hash,
              rel: safe.rel,
              lang: targetLang,
              sourceLanguage: sourceDoc.language || null,
              source: {
                mtimeMs: sourceStat ? sourceStat.mtimeMs : null,
                size: sourceStat ? sourceStat.size : null,
              },
              doneCount: translatedSegments.length,
              segments: translatedSegments,
              updatedAt: new Date().toISOString(),
            };
            await writeFileAtomic(partialPath, JSON.stringify(partialDoc, null, 2));
            break;
          }

          lastErrorStatus = resp.status;
          let errMsg = `Falha na chamada ao LLM (HTTP ${resp.status})`;
          try {
            const errJson = await resp.json();
            if (errJson?.error) {
              errMsg = typeof errJson.error === "string" ? errJson.error : errJson.error.message || errMsg;
            }
          } catch {}
          lastErrorMessage = errMsg;

          const retryAfterHeader = resp.headers?.get ? resp.headers.get("retry-after") : null;
          const parsedHeaderMs = parseRetryAfter(retryAfterHeader);
          if (parsedHeaderMs != null) {
            lastRetryAfterMs = parsedHeaderMs;
            previousWaitMs = Math.min(parsedHeaderMs, backoffMaxMs);
          }

          if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
            return res.status(resp.status).json({ ok: false, error: sanitizeTestError(errMsg) });
          }

          const isTransient = resp.status === 429 || resp.status >= 500;
          if (isTransient && attempt < maxRetries) {
            const exponentialMs = Math.min(
              backoffBaseMs * Math.pow(2, attempt - 1),
              backoffMaxMs,
            );
            let waitMs = parsedHeaderMs != null && parsedHeaderMs > 0 ? Math.min(parsedHeaderMs, backoffMaxMs) : exponentialMs;
            if (waitMs > 0) await sleep(waitMs);
            continue;
          }

          break;
        }

        if (!chunkSuccess) {
          if (lastErrorStatus === 429) {
            return res.status(429).json({
              ok: false,
              error: sanitizeTestError(lastErrorMessage || "Limite de taxa do provedor atingido"),
              retryAfterMs: lastRetryAfterMs || 5000,
            });
          }
          const code = lastErrorStatus && lastErrorStatus >= 500 ? lastErrorStatus : 502;
          return res.status(code).json({ ok: false, error: sanitizeTestError(lastErrorMessage) });
        }
      }

      const vttText = renderVtt(translatedSegments);
      await writeCourseSubtitle(lib, safe.rel, `${hash}-${targetLang}`, vttText);
      await writeFileAtomic(path.join(getSubtitleDir(), `${hash}-${targetLang}.vtt`), vttText);

      const jsonDoc = {
        version: 1,
        hash,
        rel: safe.rel,
        lang: targetLang,
        sourceLanguage: sourceDoc.language || null,
        source: {
          mtimeMs: sourceStat ? sourceStat.mtimeMs : null,
          size: sourceStat ? sourceStat.size : null,
        },
        segments: translatedSegments,
        createdAt: new Date().toISOString(),
      };
      await writeFileAtomic(
        path.join(getSubtitleDir(), `${hash}-${targetLang}.json`),
        JSON.stringify(jsonDoc, null, 2),
      );

      // Limpa checkpoint parcial após conclusão bem-sucedida
      await fs.rm(partialPath, { force: true }).catch(() => {});

      return res.json({
        ok: true,
        lang: targetLang,
        segments: translatedSegments,
        resumed: resumeFrom > 0,
      });
    } catch (err) {
      console.error("[SUBTITLES] Erro na tradução:", err);
      return res.status(500).json({ ok: false, error: "Erro interno na tradução de legendas" });
    }
  });

  // GET /subtitles/<hash>-<lang>.vtt
  app.get("/subtitles/:name", async (req, res, next) => {
    const name = req.params.name;
    const match = name.match(/^([0-9a-f]{24})(?:-([a-z]{2}))?\.vtt$/);
    if (!match) return res.status(404).end();
    const hash = match[1];
    const lang = match[2] || null;

    let vttPath = null;
    const relParam = req.query.rel;
    if (relParam && typeof relParam === "string") {
      const lib = requestLibrary(req);
      if (!lib) return res.status(400).end();
      const safe = resolveLibraryRel(lib, relParam);
      if (!safe) return res.status(400).end();
      if (!fileWithinLibrary(lib, safe.abs)) return res.status(400).end();

      if (lang) {
        vttPath = await resolveTranslationVttPath(lib, safe.rel, hash, lang);
      } else {
        vttPath = await resolveSubtitleVttPath(lib, safe.rel, name.replace(/\.vtt$/, ""));
      }
    } else if (lang) {
      return res.status(400).end();
    }
    if (!vttPath) {
      if (lang) {
        return res.status(404).end();
      }
      const mirror = path.join(getSubtitleDir(), name);
      const st = await fs.stat(mirror).catch(() => null);
      if (!st) return res.status(404).end();
      vttPath = mirror;
    }
    res.set("Content-Type", "text/vtt; charset=utf-8");
    res.sendFile(vttPath, (err) => {
      if (err && err.code !== "ECONNRESET") next(err);
    });
  });
}

module.exports = {
  subtitleStatusFor,
  registerSubtitleRoutes,
  parseRetryAfter,
};
