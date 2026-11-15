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

test("Player: botão 'Revisar' removido da barra do player, mantendo marcador e calor na sidebar", () => {
  assert.equal(playerJs.includes('id="toggle-lesson-review-btn"'), false, "Player não deve conter toggle-lesson-review-btn");
  assert.equal(playerJs.includes('btn-review'), false, "Player não deve conter btn-review");
  assert.match(appJs, /class="lesson-flag-btn/);
  assert.match(appJs, /data-flag-lesson=/);
});

test("Sem colisões de identificadores no escopo global entre scripts", () => {
  const appConsts = new Set(appJs.match(/^(?:const|let)\s+([a-zA-Z0-9_]+)/gm)?.map(s => s.replace(/^(?:const|let)\s+/, "")));
  const playerConsts = new Set(playerJs.match(/^(?:const|let)\s+([a-zA-Z0-9_]+)/gm)?.map(s => s.replace(/^(?:const|let)\s+/, "")));
  const dups = [...appConsts].filter(id => playerConsts.has(id));
  assert.deepEqual(dups, [], "Não deve haver colisões de identificadores no escopo léxico global");
});

test("CSS: estilos para bandeira na sidebar", () => {
  // Botão de bandeira na sidebar mantido
  assert.match(stylesCss, /\.tree-lesson \.lesson-flag-btn\s*\{/);
  assert.match(stylesCss, /\.tree-lesson \.lesson-flag-btn\.is-active/);

  // Botão btn-review do player removido
  assert.equal(stylesCss.includes(".btn-review {"), false, "CSS não deve conter .btn-review");
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
