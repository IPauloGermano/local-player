const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");

test("Fatia 3: styles.css estiliza .tree-lesson.active com destaque e borda indicadora", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-lesson\.active\s*\{[^}]*?box-shadow:[^}]*?var\(--accent\)/s,
    "styles.css deve ter barra indicadora var(--accent) para aula ativa",
  );
  assert.match(
    css,
    /\.tree-lesson\.active\s*\{[^}]*?border-color/s,
    "styles.css deve ter borda destacada para a aula ativa",
  );
});

test("Fatia 3: styles.css oferece microinteração de escala tátil no botão .check", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-lesson\s+\.check:hover\s*\{[^}]*?transform:\s*scale/s,
    "styles.css deve aplicar escala no hover do botão check para feedback tátil",
  );
  assert.match(
    css,
    /\.tree-lesson\.done\s+\.check\s*\{[^}]*?box-shadow/s,
    "styles.css deve aplicar brilho/sombra sutil de sucesso no botão check concluído",
  );
});

test("Fatia 3: styles.css destaca tipografia e contador da aula ativa", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-lesson\.active\s+\.lesson-title-inner\s*\{[^}]*?font-weight:\s*600/s,
    "styles.css deve aumentar o peso da fonte do título da aula ativa",
  );
});
