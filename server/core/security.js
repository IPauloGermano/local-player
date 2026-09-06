// Segurança HTTP, validação de origem e proteção anti-CSRF
const { URL } = require("url");

function isLocalRequest(req) {
  const ip = req.socket?.remoteAddress || req.ip || "";
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.endsWith("127.0.0.1")
  );
}

function verifyCsrfAndSafeOrigin(req) {
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    return { ok: false, status: 403, error: "Requisição cross-site bloqueada por segurança." };
  }
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (origin && host) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) {
        return { ok: false, status: 403, error: "Origem não autorizada (CSRF)." };
      }
    } catch {
      return { ok: false, status: 403, error: "Origem inválida." };
    }
  }
  const referer = req.headers.referer;
  if (referer && host) {
    try {
      const refererHost = new URL(referer).host;
      if (refererHost !== host) {
        return { ok: false, status: 403, error: "Referer não autorizado (CSRF)." };
      }
    } catch {
      return { ok: false, status: 403, error: "Referer inválido." };
    }
  }
  return { ok: true };
}

function requireAdminOrLocal(req, res, next) {
  const csrf = verifyCsrfAndSafeOrigin(req);
  if (!csrf.ok) {
    return res.status(csrf.status).json({ error: csrf.error });
  }
  if (process.env.LP_REMOTE_ADMIN !== "1" && !isLocalRequest(req)) {
    return res.status(403).json({ error: "Acesso administrativo restrito à máquina local (localhost)." });
  }
  next();
}

module.exports = {
  isLocalRequest,
  verifyCsrfAndSafeOrigin,
  requireAdminOrLocal,
};
