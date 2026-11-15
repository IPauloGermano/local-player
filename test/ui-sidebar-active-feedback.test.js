const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");
const APP_PATH = path.join(__dirname, "..", "public", "app.js");

test("Feedback de Módulo Ativo: styles.css estiliza .tree-folder-head.has-active-lesson", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-folder-head\.has-active-lesson\s*\{[^}]*?var\(--accent\)/s,
    "styles.css deve ter destaque com var(--accent) para cabeçalho de módulo que contém a aula ativa",
  );
  assert.match(
    css,
    /\.tree-folder-head\.has-active-lesson\s+\.folder-title-inner\s*\{[^}]*?font-weight/s,
    "styles.css deve dar destaque tipográfico ao título do módulo ativo",
  );
});

test("Feedback de Módulo Ativo quando fechado: styles.css destaca módulo recolhido contendo aula ativa", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-folder-head\.has-active-lesson:not\(\.open\)/s,
    "styles.css deve ter regra específica para módulo fechado contendo a aula ativa",
  );
});

test("Feedback de Aula Ativa: styles.css possui indicador de reprodução .lesson-playing-indicator", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-lesson\.active\s+\.lesson-playing-indicator\s*\{/s,
    "styles.css deve exibir .lesson-playing-indicator quando a aula estiver ativa",
  );
});

test("Feedback de Aula Ativa Concluída: styles.css garante alto contraste em .tree-lesson.active.done", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-lesson\.active\.done\s+\.lesson-title-inner\s*\{[^}]*?color:\s*#fff/s,
    "styles.css deve assegurar cor branca (#fff) no título mesmo se a aula ativa já estiver marcada como concluída",
  );
});

test("Feedback JS: app.js calcula ancestrais da aula ativa e adiciona has-active-lesson", () => {
  const app = fs.readFileSync(APP_PATH, "utf8");
  assert.match(
    app,
    /has-active-lesson/,
    "app.js deve aplicar a classe has-active-lesson nos módulos ancestrais da aula ativa",
  );
  assert.match(
    app,
    /lesson-playing-indicator/,
    "app.js deve renderizar o indicador .lesson-playing-indicator para a aula ativa",
  );
});
