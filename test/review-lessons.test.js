const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  flattenVideos,
  buildReviewItems,
} = require("../public/scope.js");

const appJsPath = path.join(__dirname, "..", "public", "app.js");
const playerJsPath = path.join(__dirname, "..", "public", "js", "player.js");
const stylesPath = path.join(__dirname, "..", "public", "styles.css");

const appJs = fs.readFileSync(appJsPath, "utf8");
const playerJs = fs.readFileSync(playerJsPath, "utf8");
const stylesCss = fs.readFileSync(stylesPath, "utf8");

test("buildReviewItems: lida defensivamente com entradas inválidas ou vazias", () => {
  assert.deepEqual(buildReviewItems(null, () => true), []);
  assert.deepEqual(buildReviewItems([], () => true), []);
  assert.deepEqual(buildReviewItems([{ children: [] }], null), []);
});

test("buildReviewItems: filtra apenas as aulas marcadas para revisão e preserva metadados e progresso", () => {
  const courseA = {
    type: "folder",
    name: "Curso A",
    path: "Curso A",
    libId: "default",
    children: [
      { type: "video", name: "Aula 1", path: "Curso A/Aula 1.mp4", libId: "default" },
      { type: "video", name: "Aula 2", path: "Curso A/Aula 2.mp4", libId: "default" },
    ],
  };

  const courseB = {
    type: "folder",
    name: "Curso B",
    path: "Curso B",
    libId: "ext-lib",
    children: [
      {
        type: "folder",
        name: "Módulo 1",
        path: "Curso B/Módulo 1",
        children: [
          { type: "video", name: "Aula B1", path: "Curso B/Módulo 1/Aula B1.mp4", libId: "ext-lib" },
          { type: "video", name: "Aula B2", path: "Curso B/Módulo 1/Aula B2.mp4", libId: "ext-lib" },
        ],
      },
    ],
  };

  const markedKeys = new Set([
    "default\0Curso A/Aula 2.mp4",
    "ext-lib\0Curso B/Módulo 1/Aula B1.mp4",
  ]);

  const isReview = (vPath, libId) => markedKeys.has(`${libId}\0${vPath}`);
  const progressMap = {
    "Curso A/Aula 2.mp4": { position: 120, duration: 240, completed: false },
    "Curso B/Módulo 1/Aula B1.mp4": { position: 300, duration: 300, completed: true },
  };
  const progOf = (v) => progressMap[v.path];

  const items = buildReviewItems([courseA, courseB], isReview, progOf);

  assert.equal(items.length, 2, "Deve retornar exatamente as 2 aulas marcadas");
  assert.equal(items[0].video.path, "Curso A/Aula 2.mp4");
  assert.equal(items[0].libId, "default");
  assert.equal(items[0].progress.position, 120);

  assert.equal(items[1].video.path, "Curso B/Módulo 1/Aula B1.mp4");
  assert.equal(items[1].libId, "ext-lib");
  assert.equal(items[1].progress.completed, true);
});

test("Frontend app.js: estrutura e funções do Marcador de Aulas para Revisão", () => {
  // Funções de gerenciamento de estado e persistência
  assert.match(appJs, /function isLessonReview\(/);
  assert.match(appJs, /function toggleLessonReview\(/);
  assert.match(appJs, /localStorage\.(getItem|setItem)\(["']review-lessons["']\)/);

  // Funções de renderização da seção e dos cards
  assert.match(appJs, /function renderReviewCard\(/);
  assert.match(appJs, /function renderReviewSection\(/);
  assert.match(appJs, /class="home-section review-section"/);
  assert.match(appJs, /class="section-heading">Aulas marcadas para revisão<\/h2>/);
  assert.match(appJs, /class="review-grid"/);
  assert.match(appJs, /class="review-card"/);
  assert.match(appJs, /class="review-remove-btn"/);

  // Inclusão do botão de bandeira na sidebar
  assert.match(appJs, /class="lesson-flag-btn/);
  assert.match(appJs, /data-flag-lesson=/);
  assert.match(appJs, /function updateSidebarReviewFlags\(/);

  // Chamadas na Home e no Tópico
  assert.match(appJs, /const reviewItems = buildReviewItems\(allCourses\);/);
  assert.match(appJs, /const topicReviewItems = buildReviewItems\(scopeCourses\);/);
  assert.match(appJs, /\.review-remove-btn/);
});

test("Player js: botão de revisão nos controles do player", () => {
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

test("CSS: estilos para marcador de revisão, sidebar e cards", () => {
  // Botão de navegação do player
  assert.match(stylesCss, /\.btn-review\s*\{/);
  assert.match(stylesCss, /\.btn-review\.is-review\s*\{/);

  // Sidebar flag button
  assert.match(stylesCss, /\.tree-lesson \.lesson-flag-btn\s*\{/);
  assert.match(stylesCss, /\.tree-lesson \.lesson-flag-btn\.is-active/);

  // Seção e cards de revisão
  assert.match(stylesCss, /\.review-section\s*\{/);
  assert.match(stylesCss, /\.review-grid\s*\{/);
  assert.match(stylesCss, /\.review-card\s*\{/);
  assert.match(stylesCss, /\.review-badge\s*\{/);
  assert.match(stylesCss, /\.review-remove-btn\s*\{/);

  // Mobile layout
  assert.match(stylesCss, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.review-grid/);
});
