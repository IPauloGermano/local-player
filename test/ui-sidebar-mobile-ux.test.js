const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");
const APP_JS_PATH = path.join(__dirname, "..", "public", "app.js");

test("Mobile UX: styles.css implementa cantos arredondados no drawer mobile e safe-area", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.course-view\.drawer-host\s+\.sidebar[\s\S]*?border-top-left-radius/s,
    "styles.css deve usar border-top-left-radius no drawer mobile para harmonizar com o design system",
  );
  assert.match(
    css,
    /#tree-slot[\s\S]*?env\(safe-area-inset-bottom\)/s,
    "styles.css deve conter safe-area-inset-bottom para respiro no scroll inferior do mobile",
  );
});

test("Mobile UX: styles.css garante alvo de toque mínimo de 44px nos itens de aula e pastas", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-lesson[\s\S]*?min-height:\s*44px/s,
    "styles.css deve ter min-height: 44px para .tree-lesson no mobile",
  );
  assert.match(
    css,
    /\.tree-folder-head[\s\S]*?min-height:\s*44px/s,
    "styles.css deve ter min-height: 44px para .tree-folder-head no mobile",
  );
});

test("Mobile UX: app.js realiza auto-scroll suave para a aula ativa ao abrir o drawer", () => {
  const appJs = fs.readFileSync(APP_JS_PATH, "utf8");
  assert.match(
    appJs,
    /function\s+setDrawerOpen[\s\S]*?scrollIntoView/s,
    "app.js deve acionar scrollIntoView para a aula ativa ao abrir o drawer mobile",
  );
});
