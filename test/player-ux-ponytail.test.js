// Testes automatizados para validação das quatro melhorias de UX/Performance via metodologia Ponytail.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const APP_JS = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const PLAYER_JS = fs.readFileSync(path.join(ROOT, "public", "js", "player.js"), "utf8");
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, "public", "js", "settings.js"), "utf8");
const TUTOR_JS = fs.readFileSync(path.join(ROOT, "public", "js", "tutor.js"), "utf8");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");

test("Problema 1: Terminologia correta na navegação das aulas", () => {
  // 1. O botão no menu do player não usa mais o termo incorreto "Resumo da aula"
  assert.doesNotMatch(
    PLAYER_JS,
    /data-more="summary">Resumo da aula</,
    "player.js não deve conter 'Resumo da aula'",
  );
  assert.match(
    PLAYER_JS,
    /data-more="summary"[^>]*>Lista de aulas</,
    "player.js deve apresentar 'Lista de aulas'",
  );

  // 2. app.js alterna entre 'Lista de aulas' e 'Fechar lista de aulas'
  assert.doesNotMatch(
    APP_JS,
    /"Resumo da aula"/,
    "app.js não deve conter a string 'Resumo da aula'",
  );
  assert.doesNotMatch(
    APP_JS,
    /"Fechar sumário"/,
    "app.js não deve conter a string 'Fechar sumário'",
  );
  assert.match(
    APP_JS,
    /summaryItem\.textContent\s*=\s*open\s*\?\s*"Fechar lista de aulas"\s*:\s*"Lista de aulas"/,
    "app.js deve alternar rótulo para 'Fechar lista de aulas' / 'Lista de aulas'",
  );
});

test("Problema 2: Tutor IA não-bloqueante no Desktop", () => {
  // 1. CSS define experiência não bloqueante no desktop sem cortina opaca sobre o vídeo
  assert.match(
    STYLES_CSS,
    /@media\s*\(min-width:\s*1025px\)[\s\S]*?\.tutor-backdrop\s*\{[^}]*display:\s*none\s*!important/s,
    "styles.css deve desativar .tutor-backdrop no desktop para manter vídeo visível",
  );

  // 2. .course-view adapta layout para docking suave da gaveta do tutor e previne encolhimento excessivo do player
  assert.match(
    STYLES_CSS,
    /body\.tutor-open\s+\.course-view\s*\{[^}]*padding-right:/s,
    "styles.css deve reservar espaço lateral para o Tutor IA sem sobrepor o vídeo no desktop",
  );
  assert.match(
    STYLES_CSS,
    /body\.tutor-open\s+\.course-view\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*0px\s*!important/s,
    "styles.css deve colapsar o trilho da sidebar para 0px ao abrir o tutor para manter o player amplo",
  );
  assert.match(
    STYLES_CSS,
    /body\.tutor-open\s+\.tutor-drawer\s*\{[^}]*max-width:\s*480px/s,
    "styles.css deve calibrar a largura da gaveta do tutor para até 480px no desktop evitando esmagar texto e cards",
  );

  // 3. tutor.js oculta backdrop no desktop e fecha com tecla Escape
  assert.match(
    TUTOR_JS,
    /window\.matchMedia\("\s*\(min-width:\s*1025px\)\s*"\)/,
    "tutor.js deve identificar desktop para não exibir backdrop",
  );
  assert.match(
    TUTOR_JS,
    /e\.key\s*===\s*"Escape"/,
    "tutor.js deve permitir fechar com a tecla Escape",
  );
});

test("Problema 3: Avanço automático previsível, cancelável e configurável", () => {
  // 1. Configurações possui opção de autoplay
  assert.match(
    SETTINGS_JS,
    /id="toggle-autoplay"/,
    "settings.js deve renderizar interruptor de autoplay",
  );
  assert.match(
    SETTINGS_JS,
    /course-player-autoplay/,
    "settings.js deve persistir preferência course-player-autoplay",
  );

  // 2. Player HTML inclui componente de contagem regressiva
  assert.match(
    PLAYER_JS,
    /id="player-auto-advance"/,
    "player.js deve conter o container #player-auto-advance",
  );
  assert.match(
    PLAYER_JS,
    /id="paa-countdown"/,
    "player.js deve conter contador numérico #paa-countdown",
  );
  assert.match(
    PLAYER_JS,
    /id="paa-cancel-btn"/,
    "player.js deve conter botão de cancelamento #paa-cancel-btn",
  );
  assert.match(
    PLAYER_JS,
    /id="paa-now-btn"/,
    "player.js deve conter botão imediato #paa-now-btn",
  );

  // 3. Lógica de timer e cancelamento no player.js
  assert.match(
    PLAYER_JS,
    /function startAutoAdvance\(/,
    "player.js deve implementar função startAutoAdvance",
  );
  assert.match(
    PLAYER_JS,
    /function cancelAutoAdvance\(/,
    "player.js deve implementar função cancelAutoAdvance",
  );
  assert.match(
    PLAYER_JS,
    /function isAutoplayEnabled\(/,
    "player.js deve implementar checagem isAutoplayEnabled",
  );

  // 4. Integração no app.js ao término do vídeo
  assert.match(
    APP_JS,
    /startAutoAdvance\(next\)/,
    "app.js deve disparar startAutoAdvance ao término do vídeo se houver próxima aula",
  );
  assert.match(
    APP_JS,
    /if\s*\(\s*typeof cancelAutoAdvance\s*===\s*"function"\s*\)\s*cancelAutoAdvance\(\)/,
    "app.js deve cancelar auto-advance ao mudar de rota",
  );
});

test("Problema 4: Reconstrução incremental da sidebar sem destruição de DOM a cada 5s", () => {
  // 1. app.js possui funções de atualização in-place
  assert.match(
    APP_JS,
    /function updateActiveLessonProgressInPlace\(/,
    "app.js deve implementar updateActiveLessonProgressInPlace",
  );
  assert.match(
    APP_JS,
    /function updateFolderStatsInPlace\(/,
    "app.js deve implementar updateFolderStatsInPlace",
  );

  // 2. updateProgressUI não executa mais renderTree
  assert.doesNotMatch(
    APP_JS,
    /function updateProgressUI\(\)\s*\{[\s\S]*?renderTree\(state\.currentCourseNode,\s*false\)/,
    "updateProgressUI não deve mais chamar renderTree periodicamente",
  );

  // 3. renderTree original permanece disponível para inicialização e re-scan
  assert.match(
    APP_JS,
    /function renderTree\(course,\s*resetExpanded\)/,
    "renderTree deve continuar existindo para montagem inicial e re-scan",
  );
});

test("Botão Tutor IA no mobile: sem quebra de linha ou texto vazando da caixa", () => {
  // 1. .tutor-btn possui white-space: nowrap para que 'Tutor IA' nunca quebre em duas linhas
  assert.match(
    STYLES_CSS,
    /\.tutor-btn\s*\{[^}]*white-space:\s*nowrap/s,
    ".tutor-btn deve ter white-space: nowrap para evitar quebra de linha",
  );

  // 2. Não deve haver regra limitando .tutor-btn a 30px no landscape
  assert.doesNotMatch(
    STYLES_CSS,
    /\.tutor-btn\s*\{[^}]*width:\s*30px/s,
    "styles.css não deve limitar o botão principal .tutor-btn a 30px",
  );

  // 3. Em telas pequenas (<= 520px), .player-tools .tutor-btn mantém white-space: nowrap
  assert.match(
    STYLES_CSS,
    /\.player-tools\s+\.tutor-btn\s*\{[^}]*white-space:\s*nowrap/s,
    ".player-tools .tutor-btn deve garantir white-space: nowrap em mobile",
  );
});
