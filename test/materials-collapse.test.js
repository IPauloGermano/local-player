const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const playerJs = fs.readFileSync("public/js/player.js", "utf8");
const stylesCss = fs.readFileSync("public/styles.css", "utf8");

test("Item 5: Materiais da aula possui limite de exibição inicial de 4 itens e controle Mostrar mais / Mostrar menos", () => {
  // player.js deve conter a lógica de corte em 4 itens
  assert.ok(
    playerJs.includes("Mostrar mais") && playerJs.includes("Mostrar menos"),
    "player.js deve conter textos e alternância para 'Mostrar mais' e 'Mostrar menos'",
  );
  assert.ok(
    playerJs.includes("slice(0, 4)") || playerJs.includes("files.length > 4") || playerJs.includes("index < 4"),
    "player.js deve conter limite inicial de 4 materiais",
  );
  assert.ok(
    playerJs.includes("materials-toggle-btn"),
    "player.js deve criar botão com classe ou id materials-toggle-btn",
  );
});

test("Item 5: Estilização de materiais expansíveis presente em styles.css", () => {
  assert.ok(
    stylesCss.includes(".materials-toggle-btn") || stylesCss.includes("#materials-toggle-btn"),
    "styles.css deve conter estilos para o botão de expansão dos materiais",
  );
});
