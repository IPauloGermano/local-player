const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appJsPath = path.join(__dirname, "..", "public", "app.js");
const playerJsPath = path.join(__dirname, "..", "public", "js", "player.js");
const stylesPath = path.join(__dirname, "..", "public", "styles.css");

const appJs = fs.readFileSync(appJsPath, "utf8");
const playerJs = fs.readFileSync(playerJsPath, "utf8");
const stylesCss = fs.readFileSync(stylesPath, "utf8");

test("Frontend app.js: persistência e funções do marcador de revisão de aulas", () => {
  // Funções de gerenciamento de estado e persistência
  assert.match(appJs, /function isLessonReview\(/);
  assert.match(appJs, /function toggleLessonReview\(/);
  assert.match(appJs, /localStorage\.(getItem|setItem)\(["']review-lessons["']\)/);

  // Inclusão do botão de bandeira na sidebar do curso
  assert.match(appJs, /class="lesson-flag-btn/);
  assert.match(appJs, /data-flag-lesson=/);
  assert.match(appJs, /function updateSidebarReviewFlags\(/);
});

test("Home e Tópico: NÃO possuem seção de cards de revisão", () => {
  assert.equal(appJs.includes("renderReviewSection"), false, "renderReviewSection não deve existir");
  assert.equal(appJs.includes("renderReviewCard"), false, "renderReviewCard não deve existir");
  assert.equal(appJs.includes('class="review-card"'), false, "review-card não deve existir");
  assert.equal(appJs.includes('class="review-grid"'), false, "review-grid não deve existir");
  assert.equal(appJs.includes('class="home-section review-section"'), false, "review-section não deve existir");
  assert.equal(stylesCss.includes(".review-section"), false, "CSS não deve conter .review-section");
  assert.equal(stylesCss.includes(".review-card"), false, "CSS não deve conter .review-card");
  assert.equal(stylesCss.includes(".review-grid"), false, "CSS não deve conter .review-grid");
});

test("Player: controles do player e da sidebar mantêm o marcador de revisão", () => {
  assert.match(playerJs, /id="toggle-lesson-review-btn"/);
  assert.match(playerJs, /btn-review/);
  assert.match(playerJs, /toggleLessonReview\(/);
});

test("Sem colisões de identificadores no escopo global entre scripts", () => {
  const appConsts = new Set(appJs.match(/^(?:const|let)\s+([a-zA-Z0-9_]+)/gm)?.map(s => s.replace(/^(?:const|let)\s+/, "")));
  const playerConsts = new Set(playerJs.match(/^(?:const|let)\s+([a-zA-Z0-9_]+)/gm)?.map(s => s.replace(/^(?:const|let)\s+/, "")));
  const dups = [...appConsts].filter(id => playerConsts.has(id));
  assert.deepEqual(dups, [], "Não deve haver colisões de identificadores no escopo léxico global");
});

test("CSS: estilos para bandeira na sidebar e botão do player", () => {
  // Botão de navegação do player
  assert.match(stylesCss, /\.btn-review\s*\{/);
  assert.match(stylesCss, /\.btn-review\.is-review\s*\{/);

  // Botão de bandeira na sidebar
  assert.match(stylesCss, /\.tree-lesson \.lesson-flag-btn\s*\{/);
  assert.match(stylesCss, /\.tree-lesson \.lesson-flag-btn\.is-active/);
});

test("Sidebar: indicador de calor / intensidade para módulos com aulas marcadas para revisão", () => {
  // Contagem de aulas em revisão nas estatísticas
  assert.match(appJs, /review:\s*rev/);
  assert.match(appJs, /function calculateReviewHeat\(/);

  // Renderização inicial com classes e CSS vars de calor
  assert.match(appJs, /has-review-heat/);
  assert.match(appJs, /--rev-heat/);
  assert.match(appJs, /data-review-count/);

  // Atualização dinâmica em tempo real no updateSidebarReviewFlags
  assert.match(appJs, /head\.classList\.toggle\(["']has-review-heat["'],\s*revStats\.hasHeat\)/);
  assert.match(appJs, /head\.style\.setProperty\(["']--rev-heat["']/);

  // CSS de calor / intensidade
  assert.match(stylesCss, /\.tree-folder-head\.has-review-heat\s*\{/);
  assert.match(stylesCss, /var\(--rev-heat/);
  assert.match(stylesCss, /\.tree-folder-head\.has-review-heat\.open/);
});
