// Teste para validação da Fatia 2: Responsividade da Topbar & Busca sob diferentes telas e zooms.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");

test("styles.css: esconde o rótulo de texto do botão de atualizar a partir de 768px", () => {
  assert.match(
    STYLES_CSS,
    /@media[^{]*\(\s*max-width:\s*768px\s*\)[^}]*?\.topbar-rescan-btn\s+\.rescan-label\s*\{[^}]*display:\s*none;/s,
    "Deve esconder o texto .rescan-label a partir de 768px para liberar espaço para a busca"
  );
});

test("styles.css: dropdown de busca tem altura máxima dinâmica proporcional ao viewport", () => {
  assert.match(
    STYLES_CSS,
    /\.topbar-search-dropdown\s*\{[^}]*max-height:\s*min\(420px,\s*calc\(100(?:dvh|vh)\s*-\s*80px\)\)/,
    "topbar-search-dropdown deve usar min(420px, calc(100dvh - 80px)) para nunca vazar a janela em zoom"
  );
});
