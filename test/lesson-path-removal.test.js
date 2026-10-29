const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const APP_JS = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const PLAYER_JS = fs.readFileSync(path.join(ROOT, "public", "js", "player.js"), "utf8");

test("Remoção de paths no cabeçalho do player: caminho do arquivo (breadcrumb abaixo do título) removido", () => {
  // 1. O bloco do título da aula no player.js não renderiza mais o caminho de arquivo/breadcrumb
  assert.doesNotMatch(
    PLAYER_JS,
    /<div class="breadcrumb"[^>]*>/,
    "player.js não deve mais renderizar .breadcrumb abaixo do título da aula",
  );
  assert.doesNotMatch(
    PLAYER_JS,
    /video\.path\.split\("\/"\)/,
    "player.js não deve calcular fragmentos de caminho para exibição visual abaixo do título",
  );

  // 2. O título da aula permanece renderizado dentro de .lesson-title-block
  assert.match(
    PLAYER_JS,
    /<div class="lesson-title-block">\s*<h2 title="\$\{escapeHtml\(lessonTitle\(video\)\)\}/,
    "player.js deve manter o h2 com o título da aula dentro de .lesson-title-block",
  );

  // 3. Estilos de h2 têm margem inferior zerada eliminando espaço em branco residual
  assert.match(
    STYLES_CSS,
    /\.lesson-header\s+h2\s*\{[^}]*?margin:\s*0;/s,
    "styles.css deve zerar a margem inferior de .lesson-header h2",
  );
});

test("Remoção de paths na sidebar: renderFolderChildren não renderiza caminhos abaixo dos títulos das aulas", () => {
  // 1. O template de .tree-lesson contém apenas botão check, título, mini-progresso e contador
  const treeLessonTemplateMatch = APP_JS.match(/<div class="tree-lesson[^"]*"[\s\S]*?<\/div>`/);
  assert.ok(treeLessonTemplateMatch, "Deve encontrar a renderização de .tree-lesson em app.js");
  const template = treeLessonTemplateMatch[0];

  // Não deve existir nenhum elemento para exibição de path ou diretório abaixo do título
  assert.doesNotMatch(template, /class="[^"]*(?:lesson-path|tree-path|file-path|folder-path)[^"]*"/i);
  assert.doesNotMatch(template, />\$\{[^}]*child\.path[^}]*\}</);

  // 2. Elementos essenciais preservados
  assert.match(template, /<button class="check"/, "Botão .check deve ser preservado");
  assert.match(template, /<span class="lesson-title"/, "Título .lesson-title deve ser preservado");
  assert.match(template, /<span class="lesson-title-inner"/, "Contêiner .lesson-title-inner deve ser preservado");
  assert.match(template, /<span class="lesson-mini-progress"/, "Mini barra de progresso deve ser preservada");
  assert.match(template, /<span class="lesson-counter"/, "Contador da aula deve ser preservado");
});

test("Remoção de paths na sidebar: dados internos e atributos data-lesson preservados para navegação", () => {
  // child.path DEVE ser preservado em data-lesson para que o clique e a navegação funcionem
  assert.match(
    APP_JS,
    /data-lesson="\$\{encodeURIComponent\(child\.path\)\}"/,
    "data-lesson com encodeURIComponent(child.path) deve ser preservado para controle interno",
  );
  // O manipulador de clique deve continuar utilizando o dataset.lesson para navegar
  assert.match(
    APP_JS,
    /navigateToLesson\(decodeURIComponent\(el\.dataset\.lesson\)\);/,
    "Navegação deve continuar usando dataset.lesson",
  );
});

test("Remoção de paths na sidebar: lessonTitle não exibe caminhos de diretórios", () => {
  // Executa o extrato de funções de título de app.js para validar o comportamento puro
  const context = {};
  const code = `
    ${APP_JS.slice(APP_JS.indexOf("function stripExt"), APP_JS.indexOf("function mediaUrl"))}
    this.lessonTitle = lessonTitle;
    this.displayTitle = displayTitle;
  `;
  const fn = new Function(code);
  fn.call(context);

  // Vídeo com path longo e título explícito: retorna apenas o título limpo
  const nodeWithTitle = {
    type: "video",
    name: "02. Introducao.mp4",
    path: "Cursos/NodeJS/Modulo 01 - Fundamentos/02. Introducao.mp4",
    title: "Introdução aos Fundamentos",
  };
  assert.strictEqual(context.lessonTitle(nodeWithTitle), "Introdução aos Fundamentos");

  // Vídeo com path longo sem título explícito: stripExt no name (sem diretórios)
  const nodeWithoutTitle = {
    type: "video",
    name: "03 - Setup do Ambiente.mp4",
    path: "Cursos/NodeJS/Modulo 01 - Fundamentos/03 - Setup do Ambiente.mp4",
  };
  assert.strictEqual(context.lessonTitle(nodeWithoutTitle), "03 - Setup do Ambiente");
  assert.doesNotMatch(context.lessonTitle(nodeWithoutTitle), /\//, "Título nunca deve conter barras de caminho");
});

test("Remoção de paths na sidebar: estilos de .tree-lesson mantêm layout horizontal limpo sem espaços vazios", () => {
  // .tree-lesson deve ser display: flex em linha com gap uniforme
  assert.match(
    STYLES_CSS,
    /\.tree-lesson\s*\{[^}]*?display:\s*flex;[^}]*?align-items:\s*center;/s,
    ".tree-lesson deve ter alinhamento flex centralizado",
  );
  // .lesson-title deve ter flex: 1 e overflow nowrap sem quebras para linhas fantasmas
  assert.match(
    STYLES_CSS,
    /\.tree-lesson\s+\.lesson-title[\s\S]*?flex:\s*1;[\s\S]*?white-space:\s*nowrap;/s,
    ".lesson-title deve ser linha única contida",
  );
  // Não devem existir seletores CSS de subtítulo ou path de aula na sidebar
  assert.doesNotMatch(
    STYLES_CSS,
    /\.tree-lesson-(?:path|subtitle|dir)/,
    "styles.css não deve conter classes residuais para paths de aula",
  );
});

test("Remoção de paths na sidebar: materiais de apoio em #materials-slot continuam exibindo seus nomes de arquivo", () => {
  // Materiais de apoio devem permanecer intactos (f.name com link para mediaUrl)
  assert.match(
    PLAYER_JS,
    /materialsSlot\.innerHTML\s*=\s*files\.length[\s\S]*?📎 \$\{escapeHtml\(f\.name\)\}/,
    "Nomes de arquivo nos materiais da aula em player.js devem ser preservados",
  );
});

test("Remoção de paths na sidebar: atualizações in-place e re-render não inserem paths dinamicamente no DOM", () => {
  const updateFnCode = APP_JS.slice(
    APP_JS.indexOf("function updateActiveLessonProgressInPlace"),
    APP_JS.indexOf("function updateProgressUI"),
  );
  // Garante que o update in place apenas manipula a barra de progresso e o ícone check
  assert.doesNotMatch(
    updateFnCode,
    /innerHTML\s*=\s*[^;]*path/i,
    "updateActiveLessonProgressInPlace não deve inserir paths via innerHTML",
  );
  assert.doesNotMatch(
    updateFnCode,
    /textContent\s*=\s*[^;]*path/i,
    "updateActiveLessonProgressInPlace não deve inserir paths via textContent",
  );
});
