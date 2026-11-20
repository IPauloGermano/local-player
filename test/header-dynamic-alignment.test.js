const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const appJs = fs.readFileSync("public/app.js", "utf8");
const playerJs = fs.readFileSync("public/js/player.js", "utf8");
const settingsJs = fs.readFileSync("public/js/settings.js", "utf8");
const stylesCss = fs.readFileSync("public/styles.css", "utf8");

test("2.3 & 3: Estrutura HTML - course-toolbar posicionada acima do grid course-view para alinhamento entre player e sidebar", () => {
  // course-toolbar deve estar fora/acima de course-view
  const toolbarPos = appJs.indexOf('class="course-toolbar"');
  const courseViewPos = appJs.indexOf('class="course-view');
  assert.ok(toolbarPos !== -1, "Deve conter .course-toolbar");
  assert.ok(courseViewPos !== -1, "Deve conter .course-view");
  assert.ok(
    toolbarPos < courseViewPos,
    ".course-toolbar deve vir antes de .course-view para que player e sidebar iniciem na mesma altura",
  );

  // player-col deve iniciar diretamente com o player-wrap
  const playerColIndex = appJs.indexOf('<div class="player-col">');
  const playerWrapIndex = appJs.indexOf('<div class="player-wrap"');
  assert.ok(playerColIndex !== -1 && playerWrapIndex !== -1);
  const snippetBetween = appJs.slice(playerColIndex, playerWrapIndex);
  assert.equal(
    snippetBetween.includes("course-toolbar"),
    false,
    "player-col não deve conter course-toolbar internamente",
  );
});

test("2.3 & 3: Configurações - opção de ocultação dinâmica do cabeçalho do player presente em settings.js", () => {
  assert.ok(
    settingsJs.includes("course-player-dynamic-header"),
    "settings.js deve registrar e gerenciar a chave de preferência course-player-dynamic-header",
  );
  assert.ok(
    settingsJs.includes("toggle-dynamic-header"),
    "settings.js deve conter o switch #toggle-dynamic-header",
  );
});

test("2.3 & 3: CSS - transição suave de ocultação dinâmica do header durante player-idle", () => {
  assert.ok(
    stylesCss.includes("body.has-dynamic-header.player-idle .course-toolbar") ||
    stylesCss.includes(".player-idle .course-toolbar"),
    "styles.css deve conter regra para ocultar .course-toolbar suavemente no estado idle",
  );
  assert.ok(
    stylesCss.includes("transition: opacity") || stylesCss.includes("transition: all"),
    "Deve conter transição suave de opacidade",
  );
});

test("2.3 & 3: player.js - sincroniza classe de idle do cabeçalho e posiciona player ao abrir", () => {
  assert.ok(
    playerJs.includes("player-idle"),
    "player.js deve emitir/remover classe player-idle ao alternar controles",
  );
  assert.ok(
    playerJs.includes("scrollIntoView") || appJs.includes("scrollIntoView"),
    "Deve conter posicionamento do player na abertura para que a toolbar fique acessível via rolagem para cima",
  );
});
