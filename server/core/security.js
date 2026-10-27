// Segurança HTTP, validação de origem e proteção anti-CSRF
const net = require("net");
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

// Anti DNS rebinding: um domínio externo que passa a resolver para 127.0.0.1
// chega com Host == Origin == "evil.com" e passaria pela checagem de origem.
// Só aceitamos Host que seja "localhost", um IP literal (loopback ou LAN —
// IP literal não é controlável por DNS) ou o HOST configurado explicitamente.
// Sem header Host (fora de navegador) não há vetor de rebinding.
function isAllowedHostHeader(host) {
  if (!host) return true;
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare === "aml-s9xx-box" || bare.endsWith(".ts.net") || net.isIP(bare) !== 0) return true;
  const configured = String(process.env.HOST || "").trim().toLowerCase();
  return !!configured && bare === configured;
}

function verifyCsrfAndSafeOrigin(req) {
  if (!isAllowedHostHeader(req.headers.host)) {
    return { ok: false, status: 403, error: "Host não autorizado." };
  }
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
  isAllowedHostHeader,
  verifyCsrfAndSafeOrigin,
  requireAdminOrLocal,
};
