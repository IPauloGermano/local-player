const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const stylesCss = fs.readFileSync("public/styles.css", "utf8");

test("Item 4: Sidebar possui altura adaptativa ao conteúdo (height: auto ou fit-content) com max-height limitador", () => {
  // A regra desktop base da .sidebar não deve impor height: calc(100vh - 32px) como altura fixa
  const sidebarDesktopBlock = stylesCss.match(/(?:^|\n)\.sidebar\s*\{([^}]+)\}/);
  assert.ok(sidebarDesktopBlock, "Deve encontrar o bloco de estilo base .sidebar");

  const rules = sidebarDesktopBlock[1];
  assert.ok(
    rules.includes("height: auto") || rules.includes("height: fit-content"),
    ".sidebar deve ter altura adaptável ao conteúdo (height: auto ou fit-content) para evitar vazios em cursos pequenos",
  );
  assert.equal(
    /(?:^|[^-])height:\s*calc\(100vh - 32px\)/.test(rules),
    false,
    ".sidebar não deve forçar altura fixa height: calc(100vh - 32px) na base desktop",
  );
  assert.ok(
    /max-height:\s*calc\(100d?vh\s*-/.test(rules),
    ".sidebar deve preservar max-height para limitar o crescimento quando houver muitos módulos",
  );
});

test("Item 4: #tree-slot mantém overflow-y: auto para rolagem interna quando a lista de módulos for longa", () => {
  const treeSlotBlock = stylesCss.match(/#tree-slot\s*\{([^}]+)\}/);
  assert.ok(treeSlotBlock, "Deve encontrar a regra #tree-slot");
  assert.ok(
    treeSlotBlock[1].includes("overflow-y: auto"),
    "#tree-slot deve manter overflow-y: auto para permitir rolagem interna",
  );
});
