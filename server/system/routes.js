// Rotas HTTP de sistema, atalhos, ociosidade e logs

const state = require("../state");
const { requireAdminOrLocal } = require("../core/security");
const { requestDesktopIpc } = require("../core/desktop-ipc");
const { getSystemStatus } = require("./status");
const {
  checkDesktopShortcuts,
  createDesktopShortcuts,
  removeDesktopShortcuts,
} = require("./shortcuts");
const {
  recordActivity,
  getIdleTimeoutMs,
  isSystemBusy,
  saveSystemConfig,
} = require("./lifecycle");

function registerSystemRoutes(app) {
  // Estado do sistema: biblioteca/dispositivo/aplicação
  app.get("/api/system/status", async (req, res) => {
    const st = await getSystemStatus().catch(() => null);
    if (!st) {
      return res.status(503).json({ server: "online", ready: false, reason: "unexpected" });
    }
    res.set("Cache-Control", "no-store").json(st);
  });

  // Diálogo nativo de seleção de pasta (Desktop / Electron)
  app.post("/api/system/select-folder", requireAdminOrLocal, async (req, res) => {
    if (typeof process.send !== "function") {
      return res.json({ supported: false });
    }
    const result = await requestDesktopIpc("select-folder");
    res.json(result);
  });

  // Atalhos de sistema (Linux)
  app.get("/api/system/shortcut", async (req, res) => {
    try {
      const status = await checkDesktopShortcuts();
      res.json(status);
    } catch (err) {
      res.status(500).json({ ok: false, error: err && err.message });
    }
  });

  app.post("/api/system/shortcut", requireAdminOrLocal, async (req, res) => {
    try {
      const result = await createDesktopShortcuts();
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err && err.message });
    }
  });

  app.delete("/api/system/shortcut", requireAdminOrLocal, async (req, res) => {
    try {
      const result = await removeDesktopShortcuts();
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err && err.message });
    }
  });

  // Monitoramento de atividade e economia de energia
  app.post("/api/system/heartbeat", (req, res) => {
    recordActivity();
    const timeoutMs = getIdleTimeoutMs();
    res.json({
      ok: true,
      lastActivityAt: state.lastActivityAt,
      idleTimeoutMinutes: state.idleTimeoutMinutes,
      enabled: timeoutMs > 0,
    });
  });

  app.get("/api/system/idle", (req, res) => {
    const timeoutMs = getIdleTimeoutMs();
    const elapsedMs = Date.now() - state.lastActivityAt;
    const remainingMs = timeoutMs > 0 ? Math.max(0, timeoutMs - elapsedMs) : null;
    res.json({
      ok: true,
      idleTimeoutMinutes: state.idleTimeoutMinutes,
      enabled: timeoutMs > 0,
      lastActivityAt: state.lastActivityAt,
      idleSecondsRemaining: remainingMs !== null ? Math.round(remainingMs / 1000) : null,
      busy: isSystemBusy(),
    });
  });

  app.post("/api/system/idle", requireAdminOrLocal, async (req, res) => {
    const minutes = parseInt(req.body && req.body.minutes, 10);
    if (isNaN(minutes) || minutes < 0 || minutes > 1440) {
      return res.status(400).json({ ok: false, error: "Tempo de inatividade inválido (deve ser entre 0 e 1440 minutos)." });
    }
    state.idleTimeoutMinutes = minutes;
    await saveSystemConfig();
    recordActivity();
    res.json({
      ok: true,
      idleTimeoutMinutes: state.idleTimeoutMinutes,
      enabled: state.idleTimeoutMinutes > 0,
      message: minutes === 0
        ? "Desligamento automático por inatividade desativado."
        : `Desligamento automático configurado para ${minutes} minutos.`,
    });
  });

  // Logs técnicos em memória (anel)
  app.get("/api/logs", (req, res) => {
    const level = (typeof req.query.level === "string" ? req.query.level : "").toUpperCase();
    const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
    let entries = state.logBuffer;
    if (level && level !== "ALL") {
      if (level === "DEVICE") entries = entries.filter((e) => e.msg.includes("[DEVICE]"));
      else if (level === "PROCESS") entries = entries.filter((e) => e.msg.includes("[PROCESS]"));
      else entries = entries.filter((e) => e.level === level);
    }
    if (q) entries = entries.filter((e) => e.msg.toLowerCase().includes(q));
    res.json({ entries: entries.slice(-400), max: state.MAX_LOG_ENTRIES });
  });
}

module.exports = {
  registerSystemRoutes,
};
