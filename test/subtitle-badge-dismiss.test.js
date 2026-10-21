// Teste de regressão para o badge de erro de legendas (#player-substatus).
// Garante que o aviso de "Whisper não instalado" suma automaticamente (timeout)
// ou por clique, e não fique fixo permanentemente na tela do player.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SUBTITLES_JS = fs.readFileSync(path.join(ROOT, "public", "js", "subtitles.js"), "utf8");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");

test("subtitles.js: badge de erro implementa auto-dismiss com timer", () => {
  assert.match(
    SUBTITLES_JS,
    /subtitleBadgeDismissTimer/,
    "Deve existir variável de controle de timer de dismiss do badge de legenda"
  );
  assert.match(
    SUBTITLES_JS,
    /setTimeout[\s\S]*?badge\.hidden\s*=\s*true/,
    "Deve ocultar o badge automaticamente via timeout quando em estado de erro"
  );
});

test("subtitles.js: badge de erro permite fechar por clique e previne reexibição passiva", () => {
  assert.match(
    SUBTITLES_JS,
    /badge\.addEventListener\s*\(\s*["']click["']/,
    "Badge deve responder a clique para fechamento imediato pelo usuário"
  );
  assert.match(
    SUBTITLES_JS,
    /subtitleBadgeDismissedMsg/,
    "Deve controlar mensagem dispensada para não reabrir o aviso em re-renders passivos"
  );
});

test("styles.css: player-substatus em erro é clicável e possui suporte a fade-out", () => {
  assert.match(
    STYLES_CSS,
    /\.player-substatus\.is-error\s*\{[^}]*pointer-events:\s*auto;/,
    "player-substatus.is-error deve ter pointer-events: auto para permitir clique"
  );
  assert.match(
    STYLES_CSS,
    /\.player-substatus\.fade-out\s*\{[^}]*opacity:\s*0;/,
    "player-substatus.fade-out deve ter opacity: 0 para transição suave"
  );
});
