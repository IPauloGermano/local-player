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

test("Modo Teatro no Desktop: sidebar e botão 'Aulas' não aparecem na UI desktop", () => {
  // Botão Aulas não deve ter display: inline-flex no escopo desktop
  const desktopBlock = STYLES_CSS.match(/@media\s*\(\s*min-width:\s*1025px\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(desktopBlock, "Deve existir @media (min-width: 1025px)");
  assert.doesNotMatch(
    desktopBlock[1],
    /\.lesson-sidebar-toggle\s*\{[^}]*display:\s*inline-flex/s,
    "No desktop, .lesson-sidebar-toggle não deve ter display: inline-flex"
  );
  // Sidebar deve estar oculta no modo teatro desktop
  assert.match(
    desktopBlock[1],
    /\.course-view\.theater\s+\.sidebar\s*\{[^}]*display:\s*none/s,
    "No desktop, a sidebar deve estar com display: none no modo teatro"
  );
});

test("Modo Teatro com Tutor IA aberto: fecha o Tutor IA e ativa o Modo Teatro em qualquer modo prévio", () => {
  const vm = require("node:vm");
  const tutorJs = fs.readFileSync(path.join(ROOT, "public", "js", "tutor.js"), "utf8");

  // Extrai applyViewModeToDOM e toggleTheaterMode do app.js para teste comportamental isolado
  const fnMatch = APP_JS.match(
    /function applyViewModeToDOM\(\)[\s\S]*?function toggleTheaterMode\(\)[\s\S]*?\r?\n\}/,
  );
  assert.ok(fnMatch, "applyViewModeToDOM e toggleTheaterMode devem existir em app.js");

  let viewMode = "normal";
  let closeCalls = 0;
  const viewClasses = new Set();
  const btnClasses = new Set();
  const btnAttrs = new Map();
  const makeClassList = (set) => ({
    toggle: (cls, force) => {
      if (force === undefined) {
        if (set.has(cls)) { set.delete(cls); return false; }
        set.add(cls); return true;
      }
      if (force) set.add(cls); else set.delete(cls);
      return !!force;
    },
    remove: (cls) => set.delete(cls),
    contains: (cls) => set.has(cls),
  });

  const courseView = { classList: makeClassList(viewClasses) };
  const theaterBtn = {
    title: "",
    classList: makeClassList(btnClasses),
    setAttribute: (k, v) => btnAttrs.set(k, String(v)),
  };

  const sandbox = {
    getViewMode: () => viewMode,
    setViewMode: (m) => { viewMode = m === "normal" ? "normal" : "theater"; },
    isMobileDrawer: () => false,
    window: { tutorState: { open: true } },
    closeTutorDrawer: () => {
      closeCalls++;
      sandbox.window.tutorState.open = false;
    },
    document: {
      querySelector: (sel) => (sel === ".course-view" ? courseView : null),
      getElementById: (id) => (id === "pc-theater-btn" ? theaterBtn : null),
    },
  };
  vm.runInNewContext(fnMatch[0], sandbox);

  // Enquanto Tutor IA está aberto (mesmo com viewMode === "theater"), botão exibe estado inativo "Modo teatro (t)"
  viewMode = "theater";
  sandbox.applyViewModeToDOM();
  assert.equal(btnClasses.has("is-active"), false);
  assert.equal(btnAttrs.get("aria-pressed"), "false");
  assert.equal(theaterBtn.title, "Modo teatro (t)");

  // Caso 1: Tutor IA aberto + viewMode === "theater" -> fecha Tutor IA e MANTÉM Modo Teatro ativo (não alterna para normal)
  sandbox.toggleTheaterMode();
  assert.equal(closeCalls, 1);
  assert.equal(sandbox.window.tutorState.open, false);
  assert.equal(viewMode, "theater");
  assert.equal(viewClasses.has("theater"), true);
  assert.equal(btnClasses.has("is-active"), true);
  assert.equal(btnAttrs.get("aria-pressed"), "true");

  // Caso 2: Tutor IA fechado -> alterna normalmente para "normal"
  sandbox.toggleTheaterMode();
  assert.equal(closeCalls, 1);
  assert.equal(viewMode, "normal");
  assert.equal(viewClasses.has("theater"), false);
  assert.equal(btnClasses.has("is-active"), false);

  // Caso 3: Tutor IA aberto + viewMode === "normal" -> fecha Tutor IA e ATIVA Modo Teatro
  sandbox.window.tutorState.open = true;
  sandbox.toggleTheaterMode();
  assert.equal(closeCalls, 2);
  assert.equal(sandbox.window.tutorState.open, false);
  assert.equal(viewMode, "theater");
  assert.equal(viewClasses.has("theater"), true);
  assert.equal(btnClasses.has("is-active"), true);
  assert.equal(btnAttrs.get("aria-pressed"), "true");

  // tutor.js sincroniza o botão do modo teatro ao abrir/fechar o drawer
  assert.match(
    tutorJs,
    /function openTutorDrawer[\s\S]*?applyViewModeToDOM/,
    "openTutorDrawer deve chamar applyViewModeToDOM para atualizar o botão de modo teatro",
  );
  assert.match(
    tutorJs,
    /function closeTutorDrawer[\s\S]*?applyViewModeToDOM/,
    "closeTutorDrawer deve chamar applyViewModeToDOM para restaurar o estado do botão de modo teatro",
  );
});
