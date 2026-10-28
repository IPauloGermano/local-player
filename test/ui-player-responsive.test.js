// Teste para validação da Fatia 1: Responsividade dos Menus e Popovers do Player sob diferentes telas e zooms.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const PLAYER_JS = fs.readFileSync(path.join(ROOT, "public", "js", "player.js"), "utf8");

test("styles.css: player-wrap define container-type para container queries", () => {
  assert.match(
    STYLES_CSS,
    /\.player-wrap\s*\{[^}]*container-type:\s*inline-size/s,
    "player-wrap deve definir container-type: inline-size para adaptar controles ao tamanho real do vídeo"
  );
});

test("styles.css: define regras de container query para compactar controles em players estreitos", () => {
  assert.match(
    STYLES_CSS,
    /@container[^{]*\(\s*max-width:\s*680px\s*\)/,
    "Deve existir regra @container para compactar controles quando o player tiver <= 680px"
  );
});

test("styles.css: popovers possuem limite de altura dinâmico para telas baixas ou zoom vertical", () => {
  assert.match(
    STYLES_CSS,
    /\.pc-pop\s*\{[^}]*max-height:\s*min\(/s,
    "pc-pop deve usar min() com viewport/container para evitar corte vertical"
  );
  assert.doesNotMatch(
    STYLES_CSS,
    /\.pc-pop\s*\{[^}]*max-height:[^;]*100%/s,
    "pc-pop não deve usar 100% em max-height (o pai .pc-group tem 40px de altura, o que esmaga o menu)"
  );

});

test("player.js: ajusta dinamicamente a posição do popover aberto para evitar vazamento lateral", () => {
  assert.match(
    PLAYER_JS,
    /function\s+constrainPopover|constrainPopover\s*=/,
    "Deve existir função para garantir contenção dos popovers dentro do player"
  );
  assert.match(
    PLAYER_JS,
    /getBoundingClientRect/,
    "Deve calcular limites para impedir que popovers transbordem o player"
  );
  assert.doesNotMatch(
    PLAYER_JS,
    /if\s*\(\s*!willOpen\s*\)\s*\{?\s*constrainPopover/,
    "constrainPopover deve ser chamado quando willOpen for verdadeiro (ao abrir o popover)"
  );

});

test("subtitles.js e styles.css: overlay de legendas contido nos limites do player", () => {
  const SUBTITLES_JS = fs.readFileSync(path.join(ROOT, "public", "js", "subtitles.js"), "utf8");
  assert.match(
    STYLES_CSS,
    /\.subtitle-overlay\s*\{[^}]*overflow:\s*hidden/s,
    "subtitle-overlay deve ter overflow: hidden"
  );
  assert.match(
    STYLES_CSS,
    /\.subtitle-overlay\s+\.subtitle-overlay-text\s*\{[^}]*overflow-wrap:\s*break-word/s,
    "subtitle-overlay-text deve quebrar linhas longas"
  );
  assert.doesNotMatch(
    SUBTITLES_JS,
    /function\s+applySubtitleGeometry\s*\([^)]*\)\s*\{[\s\S]*?if\s*\([^)]*overlay\.hidden\)\s*return/,
    "applySubtitleGeometry não deve abortar quando overlay.hidden for true"
  );
  assert.match(
    SUBTITLES_JS,
    /function\s+updateSubtitleOverlay[\s\S]*?overlay\.hidden\s*=\s*false;\s*applySubtitleGeometry\(\)/,
    "updateSubtitleOverlay deve recalcular a geometria ao exibir novo segmento"
  );
});
