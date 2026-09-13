// Rotas HTTP de gerenciamento de bibliotecas e árvore de conteúdo

const fs = require("fs/promises");
const path = require("path");
const state = require("../state");
const { requireAdminOrLocal } = require("../core/security");
const {
  getLibraries,
  getLibraryById,
  addLibrary,
  removeLibrary,
  persistLibraries,
  validateLibraryPath,
  ensureLibraryDiskId,
  loadLibraries,
} = require("./registry");
const {
  getTree,
  rescanLibrary,
  librarySummary,
  libraryTreeCacheFile,
} = require("../core/tree-cache");
const {
  transcodeHasActiveJobs,
  discardQueuedTranscodeJobsForLibrary,
} = require("../transcode/jobs");
const {
  cancelSubtitleJob,
  persistSubtitleJobs,
  scheduleSubtitlePregen,
} = require("../subtitles/pipeline");

function libraryHasActiveJobs(id) {
  if (transcodeHasActiveJobs(id)) return true;
  const activeSub = new Set([
    "extracting", "transcribing", "processing", "formatting",
  ]);
  for (const job of state.subtitleJobs.values()) {
    if (job.libraryId === id && activeSub.has(job.status)) return true;
  }
  if (state.scanningLibraryIds.has(id)) return true;
  return false;
}

function discardQueuedJobsForLibrary(id) {
  discardQueuedTranscodeJobsForLibrary(id);
  let discarded = 0;
  for (const [hash, job] of state.subtitleJobs) {
    if (job.libraryId === id && job.status === "queued") {
      cancelSubtitleJob(hash);
      discarded += 1;
    }
  }
  if (discarded) persistSubtitleJobs().catch(() => {});
}

function registerLibraryRoutes(app) {
  app.get("/api/tree", async (req, res) => {
    const force = req.query.rescan === "1";
    const tree = await getTree(force);
    if (force) scheduleSubtitlePregen(tree);
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json(tree);
  });

  app.post("/api/rescan", async (req, res) => {
    const tree = await getTree(true);
    scheduleSubtitlePregen(tree);
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json(tree);
  });

  app.get("/api/libraries", async (req, res) => {
    await loadLibraries();
    res.json({ libraries: getLibraries().map((l) => librarySummary(l)) });
  });

  app.post("/api/libraries", requireAdminOrLocal, async (req, res) => {
    await loadLibraries();
    const proposed = req.body && typeof req.body.path === "string" ? req.body.path : "";
    const v = await validateLibraryPath(proposed);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const name =
      req.body && typeof req.body.name === "string" && req.body.name.trim()
        ? req.body.name.trim()
        : path.basename(v.path) || v.path;
    const libraryId = await ensureLibraryDiskId(v.path, null, name);
    const entry = {
      id: libraryId,
      name,
      path: v.path,
      enabled: true,
      isDefault: false,
      createdAt: Date.now(),
    };
    addLibrary(entry);
    await persistLibraries();
    console.log(`[LIBRARIES] criada: ${name} (${entry.id}) → ${v.path}`);
    res.status(201).json(librarySummary(entry));
  });

  app.patch("/api/libraries/:id", requireAdminOrLocal, async (req, res) => {
    await loadLibraries();
    const lib = getLibraryById(req.params.id);
    if (!lib) return res.status(404).json({ error: "library not found" });
    let newPath = null;
    if (req.body && typeof req.body.path === "string" && req.body.path.trim()) {
      if (lib.isDefault) {
        return res.status(403).json({ error: "o caminho da biblioteca padrão é fixo e não pode ser alterado" });
      }
      const v = await validateLibraryPath(req.body.path, lib.id);
      if (!v.ok) return res.status(400).json({ error: v.error });
      newPath = v.path;
    }
    if (req.body && typeof req.body.name === "string") {
      lib.name = req.body.name.trim() || lib.name;
    }
    if (req.body && typeof req.body.enabled === "boolean") {
      lib.enabled = req.body.enabled;
      if (!lib.enabled) {
        state.treeCaches.delete(lib.id);
      }
    }
    if (newPath) {
      state.treeCaches.delete(lib.id);
      fs.rm(libraryTreeCacheFile(lib.id), { force: true }).catch(() => {});
      lib.path = newPath;
    }
    await persistLibraries();
    res.json(librarySummary(lib));
  });

  app.delete("/api/libraries/:id", requireAdminOrLocal, async (req, res) => {
    if (
      (req.query && req.query.path !== undefined) ||
      (req.body && typeof req.body.path === "string")
    ) {
      return res.status(400).json({ error: "remoção é por id; não aceita path" });
    }
    await loadLibraries();
    const lib = getLibraryById(req.params.id);
    if (!lib) return res.status(404).json({ error: "library not found" });
    if (lib.isDefault || lib.id === state.DEFAULT_LIBRARY_ID) {
      return res.status(403).json({ error: "a biblioteca padrão não pode ser removida" });
    }
    if (libraryHasActiveJobs(lib.id)) {
      return res.status(409).json({ error: "há jobs ativos para esta biblioteca" });
    }
    discardQueuedJobsForLibrary(lib.id);
    state.treeCaches.delete(lib.id);
    fs.rm(libraryTreeCacheFile(lib.id), { force: true }).catch(() => {});
    state.scanningLibraryIds.delete(lib.id);
    removeLibrary(lib.id);
    await persistLibraries();
    console.log(`[LIBRARIES] removida da configuração: ${lib.name} (${lib.id})`);
    res.json({ ok: true });
  });

  app.post("/api/libraries/:id/rescan", async (req, res) => {
    await loadLibraries();
    const lib = getLibraryById(req.params.id);
    if (!lib) return res.status(404).json({ error: "library not found" });
    if (state.scanningLibraryIds.has(lib.id)) {
      return res.status(409).json({ error: "scan já em andamento para esta biblioteca" });
    }
    res.json(await rescanLibrary(lib));
  });
}

module.exports = {
  libraryHasActiveJobs,
  discardQueuedJobsForLibrary,
  registerLibraryRoutes,
};
