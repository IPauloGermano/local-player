// Testes de consistência de ícones SVG, tipografia e contraste da Fatia 1 (UX/Taste Audit).
//
// Valida:
// 1. Ausência de glifos unicode crus/emojis em botões de ação e alertas principais
//    (substituição por SVGs padronizados com stroke, viewBox e aria-hidden).
// 2. Tipografia com font stack moderna (system-ui) e suavização ativada.
// 3. Regra de contraste na sidebar para módulos concluídos sem opacidade excessivamente baixa.
//
// Rodar: node --test test/ui-icons-contrast.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const INDEX_HTML = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
const APP_JS = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const PLAYER_JS = fs.readFileSync(path.join(ROOT, "public", "js", "player.js"), "utf8");
const STUDY_JS = fs.readFileSync(path.join(ROOT, "public", "js", "study.js"), "utf8");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");

test("Fatia 1: index.html usa SVG acessível no botão de atualizar (sem '⟳' cru)", () => {
  assert.doesNotMatch(
    INDEX_HTML,
    /<span class="rescan-icon"[^>]*>⟳<\/span>/,
    "index.html não deve ter caractere unicode '⟳' cru"
  );
  assert.match(
    INDEX_HTML,
    /<button[^>]*id="rescan-btn"[^>]*>[\s\S]*?<svg[\s\S]*?<\/button>/,
    "index.html deve conter <svg> dentro de #rescan-btn"
  );
});

test("Fatia 1: app.js atualiza #rescan-btn com SVG sem glifos crus '⟳' ou '✓'", () => {
  assert.doesNotMatch(
    APP_JS,
    /btn\.innerHTML\s*=\s*`[^`]*⟳[^`]*`/,
    "app.js não deve injetar '⟳' em btn.innerHTML"
  );
  assert.doesNotMatch(
    APP_JS,
    /btn\.innerHTML\s*=\s*`[^`]*>✓<[^`]*`/,
    "app.js não deve injetar '✓' isolado em btn.innerHTML"
  );
});

test("Fatia 1: app.js renderiza chevrons de pastas com SVG e sem '▶' cru", () => {
  assert.doesNotMatch(
    APP_JS,
    /<span class="chev">▶<\/span>/,
    "app.js não deve usar caractere unicode '▶' cru no chevron de pasta"
  );
  assert.match(
    APP_JS,
    /<svg[^>]*class="chev"/,
    "app.js deve renderizar <svg class=\"chev\">"
  );
});

test("Fatia 1: player.js e app.js usam SVG em botões de conclusão (sem '✓'/'○' cru em texto)", () => {
  assert.doesNotMatch(
    PLAYER_JS,
    /\$\{isDone \? "✓" : "○"\}/,
    "player.js não deve alternar strings cruas '✓'/'○' no botão de conclusão"
  );
  assert.doesNotMatch(
    APP_JS,
    /icon\.textContent\s*=\s*isDone \? "✓" : "○"/,
    "app.js não deve injetar textContent '✓'/'○' no ícone de conclusão"
  );
});

test("Fatia 1: study.js usa SVG em vez de emoji '⚠️' cru no alerta de erro", () => {
  assert.doesNotMatch(
    STUDY_JS,
    /<span>⚠️<\/span>/,
    "study.js não deve usar emoji '⚠️' cru"
  );
});

test("Fatia 1: styles.css usa system-ui e suavização de fonte antialiased", () => {
  assert.match(
    STYLES_CSS,
    /font-family:[^;]*system-ui/,
    "styles.css deve incluir system-ui no font-family de body/html"
  );
  assert.match(
    STYLES_CSS,
    /-webkit-font-smoothing:\s*antialiased/,
    "styles.css deve conter -webkit-font-smoothing: antialiased"
  );
});

test("Fatia 1: styles.css não esmaece excessivamente módulos concluídos (contraste acessível)", () => {
  // A regra antiga aplicava opacity: 0.55 em .tree-folder.completed
  assert.doesNotMatch(
    STYLES_CSS,
    /\.tree-folder\.completed\s*>\s*\.tree-folder-head[^{]*\{[^}]*opacity:\s*0\.55/,
    "styles.css não deve reduzir a opacidade de módulos concluídos para 0.55"
  );
});
