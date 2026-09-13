// Rotas HTTP de persistência e gerenciamento de progresso

const { requireAdminOrLocal } = require("../core/security");
const { requestLibrary } = require("../libraries/registry");
const { resolveLibraryRel } = require("../core/paths");
const { readProgress, updateProgress } = require("./store");

function registerProgressRoutes(app) {
  app.get("/api/progress", async (req, res) => {
    res.json(await readProgress());
  });

  app.post("/api/progress", async (req, res) => {
    const { path: relPath, position, duration, completed } = req.body || {};
    const requestId =
      req.body && typeof req.body.requestId === "string" ? req.body.requestId : undefined;
    const explicitToggle = !!(req.body && req.body.explicitToggle);
    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safe = resolveLibraryRel(lib, relPath);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    if (
      typeof position !== "number" ||
      !Number.isFinite(position) ||
      typeof duration !== "number" ||
      !Number.isFinite(duration)
    ) {
      return res.status(400).json({ error: "invalid position/duration" });
    }
    const key = `${lib.id}\0${safe.rel}`;
    try {
      await updateProgress(
        (progress) => {
          const existing = progress[key];
          const finalDuration =
            duration > 0
              ? duration
              : existing && Number.isFinite(existing.duration) && existing.duration > 0
                ? existing.duration
                : Math.max(0, duration);
          progress[key] = {
            position: Math.max(0, position),
            duration: finalDuration,
            completed: !!completed,
            updatedAt: Date.now(),
          };
        },
        { requestId, allowCompletedRegression: explicitToggle },
      );
      console.log(`[PROGRESS] save: ${safe.rel}${requestId ? ` requestId=${requestId}` : ""}`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "failed to save progress" });
    }
  });

  app.post("/api/progress/clear", requireAdminOrLocal, async (req, res) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Corpo da requisição deve ser um objeto JSON válido." });
    }
    const { coursePath, all } = req.body;
    const requestId =
      typeof req.body.requestId === "string" ? req.body.requestId : undefined;

    const hasCoursePath = "coursePath" in req.body;
    if (!hasCoursePath && all !== true) {
      return res.status(400).json({
        error: "Payload ambíguo: para apagar todo o progresso envie { all: true }, ou informe { coursePath }.",
      });
    }

    if (hasCoursePath && coursePath !== null && (typeof coursePath !== "string" || !coursePath.trim())) {
      return res.status(400).json({ error: "invalid course path" });
    }

    const lib = requestLibrary(req);
    if (!lib) return res.status(400).json({ error: "unknown library" });
    const safeCourse =
      coursePath != null ? resolveLibraryRel(lib, coursePath) : null;
    if (coursePath != null && !safeCourse)
      return res.status(400).json({ error: "invalid course path" });

    const beforeKeys = Object.keys(await readProgress());
    try {
      await updateProgress(
        (progress) => {
          if (safeCourse) {
            const prefix = `${lib.id}\0${safeCourse.rel}`;
            for (const key of Object.keys(progress)) {
              if (key === prefix || key.startsWith(prefix + "/")) {
                delete progress[key];
              }
            }
          } else {
            for (const key of Object.keys(progress)) {
              delete progress[key];
            }
          }
        },
        { allowShrink: true, requestId },
      );
      const afterKeys = Object.keys(await readProgress());
      const removedKeys = beforeKeys.filter((k) => !afterKeys.includes(k));
      console.log(
        `[PROGRESS-CLEAR] ${new Date().toISOString()} escopo=${safeCourse ? safeCourse.rel : "global"} biblioteca=${lib.id} antes=${beforeKeys.length} depois=${afterKeys.length} removidas=${removedKeys.length}${requestId ? ` requestId=${requestId}` : ""}`,
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "failed to clear progress" });
    }
  });
}

module.exports = {
  registerProgressRoutes,
};
