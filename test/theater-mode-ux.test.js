const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const PLAYER_JS = fs.readFileSync(path.join(ROOT, "public", "js", "player.js"), "utf8");
const APP_JS = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");

test("Fatia 1: player.js inclui botão primário dedicado para Modo Teatro na barra de controles", () => {
  // Deve conter o botão #pc-theater-btn na barra de controles do player
  assert.match(
    PLAYER_JS,
    /id="pc-theater-btn"/,
    "player.js deve incluir botão dedicado #pc-theater-btn para Modo Teatro"
  );
  assert.match(
    PLAYER_JS,
    /toggleTheaterMode/,
    "player.js deve acionar toggleTheaterMode ao clicar em #pc-theater-btn"
  );
  // Não deve duplicar dentro do menu ⋮ (mais opções)
  assert.doesNotMatch(
    PLAYER_JS,
    /<button[^>]*data-more="theater"/,
    "Menu ⋮ não deve duplicar o botão de Modo Teatro, pois agora é controle primário"
  );
});

test("Fatia 1: app.js sincroniza estado e acessibilidade do botão #pc-theater-btn em applyViewModeToDOM", () => {
  assert.match(
    APP_JS,
    /pc-theater-btn/,
    "applyViewModeToDOM deve referenciar #pc-theater-btn para atualizar estado ativo e acessibilidade"
  );
  assert.match(
    APP_JS,
    /theaterBtn\.classList\.toggle\(\s*["']is-active["']/,
    "applyViewModeToDOM deve alternar a classe .is-active no botão do modo teatro"
  );
  assert.match(
    APP_JS,
    /theaterBtn\.setAttribute\(\s*["']aria-pressed["']/,
    "applyViewModeToDOM deve atualizar aria-pressed no botão do modo teatro"
  );
});

test("Fatia 2: styles.css expande o player para largura total no Modo Teatro sem travas artificiais de 73vh", () => {
  // Não deve mais conter a restrição que forçava max-width: min(100%, calc((73vh) * 16 / 9))
  // que causava o encolhimento e 354px de espaço vazio em laptops 1366x768
  assert.doesNotMatch(
    STYLES_CSS,
    /\.course-view\.theater\s+\.player-wrap\s*\{[^}]*max-width:\s*min\(100%,\s*calc\(\(73vh\)\s*\*\s*16\s*\/\s*9\)\)/s,
    "styles.css não deve restringir a largura do player a 73vh * 16/9 no modo teatro"
  );

  // No modo teatro desktop, o player-wrap deve ocupar 100% da largura útil do palco
  assert.match(
    STYLES_CSS,
    /\.course-view\.theater\s+\.player-wrap\s*\{[^}]*max-width:\s*100%/s,
    ".course-view.theater .player-wrap deve ter max-width: 100% para ocupar toda a largura"
  );
});

test("Fatia 2: styles.css permite layout de palco com player no topo ocupando a largura total da grade", () => {
  // O player-col no modo teatro deve permitir que o player expanda por toda a largura da grid (grid-column: 1 / -1)
  assert.match(
    STYLES_CSS,
    /\.course-view\.theater[\s\S]*?\.player-wrap\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
    "No modo teatro, o player-wrap deve abranger todas as colunas da grade (grid-column: 1 / -1)"
  );
});
