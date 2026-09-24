const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");
const APP_JS_PATH = path.join(__dirname, "..", "public", "app.js");

test("Fatia 1: app.js usa cabeçalho limpo 'Conteúdo do curso' com badge de progresso na sidebar", () => {
  const appJs = fs.readFileSync(APP_JS_PATH, "utf8");
  assert.ok(
    appJs.includes("sidebar-heading-text") || appJs.includes("Conteúdo do curso"),
    "app.js deve exibir 'Conteúdo do curso' como título claro da sidebar",
  );
  assert.ok(
    appJs.includes("sidebar-progress-badge") || appJs.includes("pct"),
    "app.js deve conter o badge de porcentagem do curso",
  );
});

test("Fatia 1: styles.css estiliza o badge de progresso da sidebar como pílula estilizada", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.sidebar-progress-badge[\s\S]*?border-radius/,
    "styles.css deve estilizar .sidebar-progress-badge com bordas arredondadas e formato de pílula",
  );
});

test("Fatia 1: styles.css exibe metadados de progresso em linha horizontal unificada", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.sidebar-progress-meta[\s\S]*?display:\s*flex/,
    "styles.css deve usar display: flex e justify-content: space-between para exibir contagem e tempo assistido em linha única",
  );
});
