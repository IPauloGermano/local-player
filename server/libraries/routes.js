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

function cancelAllJobsForLibrary(id) {
  discardQueuedTranscodeJobsForLibrary(id);
  for (const [cacheName, job] of state.transcodeJobs) {
    if (job.libraryId === id) {
      if (job.proc && typeof job.proc.kill === "function") {
        try { job.proc.kill("SIGKILL"); } catch {}
      }
      state.transcodeJobs.delete(cacheName);
    }
  }
  let changed = 0;
  for (const [hash, job] of state.subtitleJobs) {
    if (job.libraryId === id) {
      cancelSubtitleJob(hash);
      changed += 1;
    }
  }
  if (changed) persistSubtitleJobs().catch(() => {});
  state.scanningLibraryIds.delete(id);
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
    const targetLibId =
      (req.query && typeof req.query.libraryId === "string" && req.query.libraryId.trim()) ||
      (req.query && typeof req.query.libId === "string" && req.query.libId.trim()) ||
      null;
    const tree = await getTree(force, targetLibId);
    if (force) scheduleSubtitlePregen(tree);
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.json(tree);
  });

  app.post("/api/rescan", async (req, res) => {
    const targetLibId =
      (req.query && typeof req.query.libraryId === "string" && req.query.libraryId.trim()) ||
      (req.query && typeof req.query.libId === "string" && req.query.libId.trim()) ||
      (req.body && typeof req.body.libraryId === "string" && req.body.libraryId.trim()) ||
      (req.body && typeof req.body.libId === "string" && req.body.libId.trim()) ||
      null;
    const tree = await getTree(true, targetLibId);
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
      const v = await validateLibraryPath(req.body.path, lib.id);
      if (!v.ok) return res.status(400).json({ error: v.error });
      newPath = v.path;
    }
    if (req.body && typeof req.body.name === "string") {
      lib.name = req.body.name.trim() || lib.name;
    }
    if (req.body && typeof req.body.enabled === "boolean") {
      if (req.body.enabled && !lib.enabled) {
        const targetPath = newPath || lib.path;
        if (!lib.isDefault || targetPath !== state.ROOT) {
          const v = await validateLibraryPath(targetPath, lib.id);
          if (!v.ok) return res.status(400).json({ error: v.error });
        }
      }
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

    const allLibs = getLibraries();
    const remaining = allLibs.filter((l) => l.id !== lib.id);

    // Se for a biblioteca padrão:
    if (lib.isDefault || lib.id === state.DEFAULT_LIBRARY_ID) {
      if (remaining.length === 0) {
        // Única biblioteca no sistema: reseta para a raiz padrão da instalação (ROOT)
        cancelAllJobsForLibrary(lib.id);
        state.treeCaches.delete(lib.id);
        fs.rm(libraryTreeCacheFile(lib.id), { force: true }).catch(() => {});
        lib.id = state.DEFAULT_LIBRARY_ID;
        lib.name = path.basename(state.ROOT) || "Biblioteca padrão";
        lib.path = state.ROOT;
        lib.enabled = true;
        lib.isDefault = true;
        await persistLibraries();
        console.log(`[LIBRARIES] biblioteca padrão restaurada para ${state.ROOT}`);
        return res.json({ ok: true, reset: true, library: librarySummary(lib) });
      }

      // Há outras bibliotecas: promove a próxima para default
      const nextDefault = remaining.find((l) => l.enabled !== false) || remaining[0];
      nextDefault.isDefault = true;
    }

    cancelAllJobsForLibrary(lib.id);
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
  cancelAllJobsForLibrary,
  registerLibraryRoutes,
};
