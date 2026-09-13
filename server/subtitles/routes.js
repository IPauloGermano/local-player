const path = require("path");
const fs = require("fs/promises");
const state = require("../state");
const { readJsonFile } = require("../core/fs-atomic");
const { sanitizeTestError, VIDEO_EXT } = require("../core/scan");
const { isAppDirRel, fileWithinLibrary } = require("../core/paths");
const { requireAdminOrLocal } = require("../core/security");
const { getTree } = require("../core/tree-cache");
const { requestLibrary, resolveLibraryRel } = require("../libraries/registry");
const { loadAiConfig } = require("../ai/config");
const { subtitleCacheName } = require("../ai/subtitles-helpers");

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
  sweepCourseSubtitles,
  resolveSubtitleVttPath,
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
        ]);
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
            .filter((f) => f.endsWith(".vtt"))
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

  app.get("/subtitles/*", async (req, res, next) => {
    const name = req.path.replace(/^\/subtitles\/?/, "");
    const m = /^([0-9a-f]{24})(?:-([a-z]{2,10}))?\.vtt$/.exec(name);
    if (!m) return next();
    const hash = m[1];
    let vttPath = null;
    const relParam = typeof req.query.rel === "string" ? req.query.rel : "";
    if (relParam) {
      const lib = requestLibrary(req);
      const safe = lib ? resolveLibraryRel(lib, relParam) : null;
      if (safe && subtitleCacheName(lib.id, safe.rel) === hash) {
        vttPath = await resolveSubtitleVttPath(lib, safe.rel, name.replace(/\.vtt$/, ""));
      }
    }
    if (!vttPath) {
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
};
