// Rotas HTTP de mídia original com Range e streaming de transcode fallback

const fs = require("fs/promises");
const path = require("path");
const state = require("../state");
const { requireAdminOrLocal } = require("../core/security");
const { requestLibrary, getDefaultLibrary, getLibraryById } = require("../libraries/registry");
const { resolveLibraryRel, isAppDirRel, fileWithinLibrary } = require("../core/paths");
const { ACTIVE_EXT } = require("../core/scan");
const {
  getTranscodePlan,
  clearTranscodeCache,
  serveGrowingFile,
  TRANSCODED_NAME_RE,
} = require("../transcode/jobs");

function parseMediaRequest(req) {
  let raw = req.path.replace(/^\/media\/?/, "").replace(/^\/+/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  let lib = getDefaultLibrary();
  let rel = raw;
  const firstSlash = raw.indexOf("/");
  if (firstSlash !== -1) {
    const head = raw.slice(0, firstSlash);
    const candidate = getLibraryById(head);
    if (candidate) {
      lib = candidate;
      rel = raw.slice(firstSlash + 1);
    }
  }
  if (!lib) return null;
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return null;
  return { lib, safe };
}

function hasDotSegment(rel) {
  return rel.split("/").some((s) => s.startsWith("."));
}

function registerMediaRoutes(app) {
  // Fallback de compatibilidade: devolve o plano de reprodução
  app.get("/api/video/fallback", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, rel);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    if (isAppDirRel(safe, lib)) return res.status(404).json({ error: "invalid path" });
    try {
      const plan = await getTranscodePlan(lib, safe.rel, safe.abs);
      res.json(plan);
    } catch (err) {
      console.error("[TRANSCODE] erro ao preparar fallback:", err.message);
      res.status(500).json({ error: "failed to prepare video" });
    }
  });

  // Limpa o cache de transcoding (spec 29). NUNCA toca progress.json.
  app.post("/api/transcode/clear", requireAdminOrLocal, async (req, res) => {
    try {
      await clearTranscodeCache();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "failed to clear transcode cache" });
    }
  });

  // Middleware para normalizar e filtrar acessos a /media
  app.use("/media", (req, res, next) => {
    const parsed = parseMediaRequest(req);
    if (!parsed) return next();
    req.mediaParsed = parsed;
    if (isAppDirRel(parsed.safe, parsed.lib)) return res.status(404).end();
    if (hasDotSegment(parsed.safe.rel)) return res.status(404).end();
    next();
  });

  // Serve vídeos e materiais com suporte nativo a Range requests
  app.get("/media/*", async (req, res, next) => {
    const parsed = req.mediaParsed || parseMediaRequest(req);
    if (!parsed) return res.status(404).end();
    if (!(await fileWithinLibrary(parsed.lib, parsed.safe.abs))) {
      return res.status(404).end();
    }
    const st = await fs.stat(parsed.safe.abs).catch(() => null);
    if (!st || !st.isFile()) return res.status(404).end();
    res.set("X-Content-Type-Options", "nosniff");
    if (ACTIVE_EXT.has(path.extname(parsed.safe.abs).toLowerCase())) {
      res.set("Content-Disposition", "attachment");
    }
    return res.sendFile(parsed.safe.abs, (err) => {
      if (err && err.code !== "ECONNRESET") next(err);
    });
  });

  // Serve o cache de transcoding (.tmp progressivo ou final)
  app.get("/transcoded/*", async (req, res, next) => {
    const name = req.path.replace(/^\/transcoded\/?/, "");
    const m = TRANSCODED_NAME_RE.exec(name);
    if (!m) return next();

    const cacheName = m[1] + ".mp4";
    const finalPath = path.join(state.TRANSCODE_DIR, cacheName);
    const job = state.transcodeJobs.get(cacheName);
    const active = job && (job.status === "queued" || job.status === "processing");
    if (active) {
      return serveGrowingFile(req, res, job);
    }

    const finalStat = await fs.stat(finalPath).catch(() => null);
    if (finalStat) {
      return res.sendFile(finalPath, (err) => {
        if (err && err.code !== "ECONNRESET") next(err);
      });
    }
    return res.status(404).end();
  });
}

module.exports = {
  parseMediaRequest,
  hasDotSegment,
  registerMediaRoutes,
};
