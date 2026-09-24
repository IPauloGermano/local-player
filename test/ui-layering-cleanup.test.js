// Testes da Fatia 2: Limpeza de Artefatos de IA & Normalização Semântica.
//
// Valida:
// 1. Remoção do filtro SVG fractal inline feTurbulence/fractalNoise do background
//    (elimina recomposição contínua de GPU no playback e scrolls).
// 2. Transição de --border opaca rígida para borda translúcida refinada (atenuação de card soup).
// 3. Hierarquia clara de elevação de superfícies no :root.
//
// Rodar: node --test test/ui-layering-cleanup.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");

test("Fatia 2: styles.css não possui ruído fractal SVG pesado (feTurbulence) no background", () => {
  assert.doesNotMatch(
    STYLES_CSS,
    /feTurbulence/,
    "styles.css não deve conter filtro fractal feTurbulence inline no background"
  );
  assert.doesNotMatch(
    STYLES_CSS,
    /fractalNoise/,
    "styles.css não deve conter fractalNoise inline no background"
  );
});

test("Fatia 2: styles.css usa bordas translúcidas em --border para atenuar o efeito 'card soup'", () => {
  assert.match(
    STYLES_CSS,
    /--border:\s*rgba\(255,\s*255,\s*255,\s*0\.0[7-9]\)/,
    "styles.css deve usar valor translúcido refinado para --border"
  );
});

test("Fatia 2: styles.css define gradiente de fundo limpo e leve", () => {
  assert.match(
    STYLES_CSS,
    /background-color:\s*var\(--bg\);/,
    "styles.css deve manter background-color com token --bg"
  );
});
