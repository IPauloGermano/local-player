// Teste para validação da Fatia 3: Responsividade da Sidebar de Aulas, Toolbar do Curso & Tutor IA sob Zoom e Telas Compactas.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");

test("styles.css: define colapso da sidebar em 1024px para acomodar telas médias e zoom", () => {
  assert.match(
    STYLES_CSS,
    /@media[^{]*\(\s*max-width:\s*1024px\s*\)[^}]*?\.course-view\s*\{[^}]*grid-template-columns:\s*1fr;/s,
    "Deve colapsar a sidebar para 1fr a partir de 1024px para evitar esmagamento do player"
  );
});

test("styles.css: gaveta do Tutor IA ajusta largura mínima para clamp(320px, 40vw, 600px) e max-width 90vw", () => {
  assert.match(
    STYLES_CSS,
    /\.tutor-drawer\s*\{[^}]*width:\s*clamp\(320px,\s*40vw,\s*600px\)/,
    "tutor-drawer deve usar largura mínima de 320px em vez de 460px rígidos"
  );
  assert.match(
    STYLES_CSS,
    /\.tutor-drawer\s*\{[^}]*max-width:\s*min\(600px,\s*90vw\)/,
    "tutor-drawer deve respeitar limite max-width de 90vw para nunca transbordar a viewport"
  );
});

test("styles.css: toolbar do curso possui regras flexíveis para fluir em zoom sem quebrar botões", () => {
  assert.match(
    STYLES_CSS,
    /\.course-toolbar-title\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1\s+1/s,
    "course-toolbar-title deve ter min-width: 0 e flex-basis adaptável"
  );
});
