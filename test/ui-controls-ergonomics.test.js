// Testes da Fatia 3: Ergonomia de Toque & Estabilidade de Controles.
//
// Valida:
// 1. Alvos de toque acessíveis (mínimo 44x44px) para botões em telas compactas.
// 2. Ancoramento preciso do caret do popover de volume (.pc-vol-pop::after).
// 3. Acessibilidade de leitura em títulos longos da sidebar (atributo title nos nós da árvore).
//
// Rodar: node --test test/ui-controls-ergonomics.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const APP_JS = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

test("Fatia 3: styles.css garante alvo de toque de 44px no rescan em mobile", () => {
  assert.match(
    STYLES_CSS,
    /\.topbar-rescan-btn\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px;/,
    "topbar-rescan-btn deve ter dimensões de 44x44px em breakpoint móvel"
  );
});

test("Fatia 3: styles.css ancora o caret do popover de volume no botão disparador", () => {
  assert.match(
    STYLES_CSS,
    /\.pc-vol-pop::after\s*\{[^}]*right:\s*22px;/,
    "pc-vol-pop::after deve usar right: 22px para alinhar com o botão de volume"
  );
  assert.doesNotMatch(
    STYLES_CSS,
    /\.pc-vol-pop::after\s*\{[^}]*left:\s*50%;/,
    "pc-vol-pop::after não deve usar left: 50% (que desalinha do disparador)"
  );
});

test("Fatia 3: app.js inclui title nos títulos da sidebar para visualização imediata", () => {
  assert.match(
    APP_JS,
    /<span class="folder-title"[^>]*title="/,
    "folder-title deve incluir atributo title"
  );
  assert.match(
    APP_JS,
    /<span class="lesson-title"[^>]*title="/,
    "lesson-title deve incluir atributo title"
  );
});
