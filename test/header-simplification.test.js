const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJsPath = path.join(__dirname, "..", "public", "app.js");
const stylesPath = path.join(__dirname, "..", "public", "styles.css");

const appJsContent = fs.readFileSync(appJsPath, "utf8");
const stylesContent = fs.readFileSync(stylesPath, "utf8");

test("Cabeçalho do player: botão '← Voltar aos cursos' foi removido do DOM do player", () => {
  // Não deve renderizar a div ou id back-link no template do curso
  assert.equal(
    appJsContent.includes('<div class="back-link" id="back-link">'),
    false,
    "app.js não deve renderizar .back-link no player"
  );
  assert.equal(
    appJsContent.includes("← Voltar aos cursos"),
    false,
    "app.js não deve renderizar o texto '← Voltar aos cursos'"
  );
  // Não deve tentar adicionar addEventListener em getElementById('back-link')
  assert.equal(
    appJsContent.includes('document.getElementById("back-link").addEventListener'),
    false,
    "app.js não deve ter listener síncrono para o elemento removido back-link"
  );
});

test("Cabeçalho do player: nome do curso (.course-toolbar-title) foi removido do canto superior esquerdo", () => {
  // Não deve renderizar .course-toolbar-title na toolbar do player
  assert.equal(
    appJsContent.includes('<div class="course-toolbar-title">'),
    false,
    "app.js não deve renderizar .course-toolbar-title na course-toolbar"
  );
});

test("Cabeçalho do player: controles restantes (.course-toolbar-actions) preservados e alinhados", () => {
  // Os controles utilitários essenciais do curso devem continuar no template
  assert.ok(
    appJsContent.includes('id="toggle-fav-course"'),
    "Botão de favoritar curso deve ser preservado"
  );
  assert.ok(
    appJsContent.includes('id="clear-course-progress"'),
    "Botão de limpar progresso do curso deve ser preservado"
  );
  assert.ok(
    appJsContent.includes('courseSubtitleBtn'),
    "Controle condicional de gerar legendas do curso deve ser preservado"
  );

  // A toolbar deve usar justify-content: flex-end para alinhar os botões à direita com elegância
  assert.ok(
    stylesContent.includes(".course-toolbar {\n  display: flex;\n  justify-content: flex-end;"),
    "course-toolbar deve usar justify-content: flex-end"
  );
});

test("Cabeçalho do player: breadcrumb e navegação da aula preservados", () => {
  // A folha de breadcrumb continua identificando o curso e aula logo abaixo do player
  assert.ok(
    stylesContent.includes(".lesson-header .breadcrumb"),
    "Estilo para breadcrumb do lesson-header deve ser preservado"
  );
  assert.ok(
    appJsContent.includes('id="lesson-header"'),
    "lesson-header deve ser preservado no template do player"
  );
});
