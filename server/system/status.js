// Estado do sistema (biblioteca/dispositivo) e página de indisponibilidade

const fs = require("fs/promises");
const path = require("path");
const state = require("../state");
const { isDeviceUnavailableCode, ensureRemovableDrivesMounted } = require("../core/device");
const { getDefaultLibrary } = require("../libraries/registry");

// Página de indisponibilidade — self-contained, servida DE MEMÓRIA. Vive como
// string no servidor de propósito: quando o pendrive é desmontado, public/ (e
// qualquer HTML em disco) some junto — a única página que ainda dá para servir
// é esta, que não depende da SPA, de assets externos nem do disco. Mesmos
// tokens de cor/fonte/radius do tema (public/styles.css). O JS interno usa
// aspas simples + concatenação (sem template literals nem backticks) porque o
// contêiner abaixo é um template literal.
const UNAVAILABLE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Local Player — indisponível</title>
<style>
  :root{
    --bg:#0a0c12; --bg-card:#141a26; --bg-card-2:#192132; --bg-hover:#20293b;
    --border:#263144; --text:#f1f5fb; --text-mid:#c3cfe0; --text-dim:#9aa8bf;
    --accent:#ff8a3d; --accent-dark:#e66d22; --radius:16px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    background-color:var(--bg);
    background-image:
      radial-gradient(ellipse 90% 70% at 12% -15%, rgba(255,138,61,.1), rgba(255,138,61,.05) 25%, rgba(255,138,61,.02) 45%, transparent 65%),
      radial-gradient(ellipse 70% 60% at 100% -10%, rgba(58,87,140,.12), rgba(58,87,140,.05) 30%, rgba(58,87,140,.02) 50%, transparent 70%),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    background-repeat:no-repeat,no-repeat,repeat;
    background-size:auto,auto,140px 140px;
    background-attachment:fixed;
    color:var(--text);
    font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;min-height:100dvh;padding:20px;
  }
  .card{
    width:min(460px,100%);
    background:var(--bg-card);
    border:1px solid var(--border);
    border-radius:var(--radius);
    box-shadow:0 20px 40px rgba(0,0,0,.28);
    padding:38px 30px 28px;
    text-align:center;
  }
  .logo{
    width:56px;height:56px;border-radius:50%;
    background:linear-gradient(135deg,var(--accent),#ffd5b7);
    box-shadow:0 0 26px rgba(255,138,61,.45);
    margin:0 auto 18px;
    display:flex;align-items:center;justify-content:center;
    color:#0a0c12;
  }
  h1{font-size:21px;font-weight:700;line-height:1.25;margin-bottom:10px}
  .msg{color:var(--text-mid);font-size:14px;line-height:1.55;min-height:44px;max-width:34ch;margin:0 auto}
  .actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:24px}
  .btn{
    display:inline-flex;align-items:center;justify-content:center;
    min-height:38px;padding:0 20px;border-radius:999px;
    border:1px solid transparent;
    font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;
    transition:background .15s ease,border-color .15s ease,filter .15s ease;
  }
  .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .btn--primary{background:linear-gradient(135deg,var(--accent),var(--accent-dark));color:#fff}
  .btn--primary:hover{filter:brightness(1.06)}
  .btn--secondary{background:var(--bg-card-2);border-color:var(--border);color:var(--text)}
  .btn--secondary:hover{background:var(--bg-hover)}
  .context{
    margin-top:26px;padding-top:18px;border-top:1px solid var(--border);
    text-align:left;font-size:12.5px;color:var(--text-dim);
  }
  .ctx-row{display:flex;justify-content:space-between;gap:14px;padding:3px 0}
  .ctx-row dt{font-weight:600;color:var(--text-mid)}
  .ctx-row dd{font-variant-numeric:tabular-nums;white-space:nowrap}
  .diag{
    margin-top:14px;padding-top:12px;border-top:1px solid var(--border);
    text-align:left;font-size:12.5px;color:var(--text-dim);
  }
  .diag-line{word-break:break-word;color:var(--text-mid)}
  .diag-hint{margin-top:6px;line-height:1.5}
  @media (max-width:480px){
    .card{padding:30px 20px 24px}
    h1{font-size:19px}
    .btn{width:100%}
  }
</style>
</head>
<body>
  <main class="card">
    <div class="logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2.5" y="7" width="19" height="10" rx="2"></rect>
        <circle cx="6.5" cy="12" r=".6" fill="currentColor"></circle>
        <circle cx="10" cy="12" r=".6" fill="currentColor"></circle>
        <line x1="17" y1="12" x2="19" y2="12"></line>
      </svg>
    </div>
    <h1 id="state-title" role="status" aria-live="polite">Verificando…</h1>
    <p class="msg" id="state-msg">Verificando o estado da aplicação.</p>
    <div class="actions">
      <button class="btn btn--primary" id="retry-btn" type="button">Tentar novamente</button>
      <button class="btn btn--secondary" id="diag-btn" type="button" aria-expanded="false" aria-controls="diag">Ver diagnóstico</button>
      <button class="btn btn--secondary" id="settings-btn" type="button" onclick="window.location.href='/#/settings'">Configurações</button>
    </div>
    <dl class="context" id="context">
      <div class="ctx-row"><dt>Servidor</dt><dd id="ctx-server">—</dd></div>
      <div class="ctx-row"><dt>Biblioteca</dt><dd id="ctx-library">—</dd></div>
      <div class="ctx-row"><dt>Aplicação</dt><dd id="ctx-spa">—</dd></div>
      <div class="ctx-row"><dt>Última verificação</dt><dd id="ctx-last">—</dd></div>
    </dl>
    <div class="diag" id="diag" hidden>
      <p class="diag-line" id="diag-reason">—</p>
      <p class="diag-hint">Dica: confira se o dispositivo de armazenamento está conectado e montado e clique em “Tentar novamente”.</p>
    </div>
  </main>
  <script>
  (function () {
    'use strict';
    var TITLES = {
      'library-missing': 'Biblioteca indisponível',
      'device-unavailable': 'Dispositivo desconectado',
      'spa-missing': 'Aplicação ainda não está pronta',
      'unexpected': 'Não foi possível carregar o Local Player'
    };
    var MSGS = {
      'library-missing': 'O dispositivo onde seus cursos estão armazenados não está disponível no momento. Conecte ou remonte o dispositivo e tente novamente.',
      'device-unavailable': 'O dispositivo foi desconectado ou desmontado durante o uso. Reconecte-o e tente novamente.',
      'spa-missing': 'Os arquivos da aplicação ainda não puderam ser carregados. Tente novamente em instantes.',
      'unexpected': 'Ocorreu um erro ao carregar a aplicação. Tente novamente.'
    };
    var retryable = { 'library-missing': true, 'device-unavailable': true, 'spa-missing': true };
    var titleEl = document.getElementById('state-title');
    var msgEl = document.getElementById('state-msg');
    var ctxLib = document.getElementById('ctx-library');
    var ctxSpa = document.getElementById('ctx-spa');
    var ctxServer = document.getElementById('ctx-server');
    var ctxTime = document.getElementById('ctx-last');
    var diagEl = document.getElementById('diag');
    var diagBtn = document.getElementById('diag-btn');
    var diagReason = document.getElementById('diag-reason');

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function fmtTime(ts) {
      var d = new Date(ts);
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function applyStatus(s) {
      var reason = s && s.reason;
      if (!reason || !TITLES[reason]) reason = 'unexpected';
      titleEl.textContent = TITLES[reason];
      msgEl.textContent = MSGS[reason];
      ctxServer.textContent = 'Online';
      ctxLib.textContent = s && s.library === 'available' ? 'Disponível' : 'Indisponível';
      ctxSpa.textContent = s && s.spa === 'available' ? 'Disponível' : 'Indisponível';
      ctxTime.textContent = s && s.lastCheck ? fmtTime(s.lastCheck) : '—';
      diagReason.textContent = (s && s.reason ? s.reason : 'offline') + (s && s.code ? ' (' + s.code + ')' : '');
      return retryable[reason] === true;
    }

    function check() {
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, 3000);
      return fetch('/api/system/status', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          clearTimeout(to);
          if (s && s.ready) { location.reload(); return { reloaded: true }; }
          return { reloaded: false, retry: applyStatus(s) };
        })
        .catch(function () {
          clearTimeout(to);
          applyStatus(null);
          return { reloaded: false, retry: true };
        });
    }

    document.getElementById('retry-btn').addEventListener('click', function () {
      var btn = document.getElementById('retry-btn');
      btn.disabled = true;
      titleEl.textContent = 'Verificando…';
      check().then(function (r) {
        btn.disabled = false;
        if (!r.reloaded) location.reload();
      });
    });
    diagBtn.addEventListener('click', function () {
      if (diagEl.hasAttribute('hidden')) {
        diagEl.removeAttribute('hidden');
        diagBtn.setAttribute('aria-expanded', 'true');
      } else {
        diagEl.setAttribute('hidden', '');
        diagBtn.setAttribute('aria-expanded', 'false');
      }
    });

    var delays = [1000, 2000, 5000, 10000, 15000, 30000, 60000];
    check().then(function (r) {
      if (r.reloaded || !r.retry) return;
      (function loop() {
        if (!delays.length) return;
        setTimeout(function () {
          check().then(function (r2) {
            if (r2.reloaded || !r2.retry) return;
            delays.shift();
            loop();
          });
        }, delays[0]);
      })();
    });
  })();
  </script>
</body>
</html>`;

// Sonda a disponibilidade real da biblioteca (ROOT), do diretório do app
// (__dirname) e do arquivo que a SPA precisa (public/index.html).
async function getSystemStatus() {
  const now = Date.now();
  const probe = (p) => {
    const check = fs.access(p).then(
      () => ({ state: "ok", code: null }),
      (err) => {
        const c = err && err.code;
        return {
          state: !c ? "unexpected" : c === "ENOENT" ? "missing" : isDeviceUnavailableCode(c) ? "device" : "unexpected",
          code: c || null,
        };
      },
    );
    return Promise.race([
      check,
      new Promise((r) => {
        const t = setTimeout(() => r({ state: "timeout", code: null }), 4000);
        if (t && t.unref) t.unref();
      }),
    ]);
  };

  let [lib, self, spa] = await Promise.all([
    probe(state.ROOT),
    probe(state.APP_DIR),
    probe(state.SPA_INDEX_PATH),
  ]);

  if (lib.state !== "ok" || self.state !== "ok" || spa.state !== "ok") {
    const mounted = await ensureRemovableDrivesMounted().catch(() => false);
    if (mounted) {
      [lib, self, spa] = await Promise.all([
        probe(state.ROOT),
        probe(state.APP_DIR),
        probe(state.SPA_INDEX_PATH),
      ]);
    }
  }

  const defaultLib = typeof getDefaultLibrary === "function" ? getDefaultLibrary() : null;
  const defaultEnabled = !defaultLib || defaultLib.enabled !== false;
  const spaReady = spa.state === "ok" && self.state === "ok";

  const states = [lib.state, self.state, spa.state];
  const codes = [lib.code, self.code, spa.code].filter(Boolean);

  let reason = null;
  if (!states.every((s) => s === "ok")) {
    if (states.includes("unexpected")) reason = "unexpected";
    else if (states.includes("timeout")) reason = "device-unavailable";
    else if (states.includes("device")) reason = "device-unavailable";
    else if (self.state === "missing" || (defaultEnabled && lib.state === "missing")) reason = "library-missing";
    else if (spa.state === "missing") reason = "spa-missing";
    else reason = "unexpected";
  }

  const isReady = spaReady && (!defaultEnabled || lib.state === "ok");

  return {
    server: "online",
    library: lib.state === "ok" ? "available" : "unavailable",
    spa: spa.state === "ok" ? "available" : "unavailable",
    ready: isReady,
    reason: isReady ? null : reason,
    code: isReady ? null : (codes[0] || null),
    lastCheck: now,
  };
}

module.exports = {
  UNAVAILABLE_HTML,
  getSystemStatus,
};
