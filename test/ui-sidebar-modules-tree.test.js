const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");

test("Fatia 2: styles.css implementa linha guia vertical (tree line) em tree-folder-children", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-folder-children\s*\{[^}]*?border-left:\s*1px\s+solid/s,
    "styles.css deve ter border-left sutil em .tree-folder-children como guia visual de profundidade",
  );
});

test("Fatia 2: styles.css estiliza o badge de progresso do módulo como pílula compacta", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-folder-head\s+\.folder-progress\s*\{[^}]*?border-radius/s,
    "styles.css deve formatar .folder-progress como badge com border-radius",
  );
});

test("Fatia 2: styles.css dá destaque de estado aberto para cabeçalho de módulo depth 1", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tree-folder-head\[data-depth="1"\]\.open\s*\{[^}]*?background/s,
    "styles.css deve estilizar o módulo aberto de depth 1 com fundo sutil",
  );
});
