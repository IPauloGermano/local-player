const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

const playerJs = fs.readFileSync("public/js/player.js", "utf8");
const subtitlesJs = fs.readFileSync("public/js/subtitles.js", "utf8");
const stylesCss = fs.readFileSync("public/styles.css", "utf8");

test("2.1: Botão de modo teatro (#pc-theater-btn) oculto em tela cheia via CSS", () => {
  assert.ok(
    stylesCss.includes("#pc-theater-btn") &&
      (stylesCss.includes(":fullscreen #pc-theater-btn") ||
       stylesCss.includes(".player-wrap:fullscreen #pc-theater-btn")),
    "Deve conter regra CSS para ocultar #pc-theater-btn no modo :fullscreen",
  );
});

test("2.2: Opção 'Aparência da legenda' presente e sempre visível em pc-more-menu (sem classe pc-more-narrow)", () => {
  // data-more="subtitle-style" deve estar presente no menu de mais opções (...)
  assert.ok(
    playerJs.includes('data-more="subtitle-style"'),
    "Menu mais opções (...) deve conter ação data-more=\"subtitle-style\"",
  );

  // Não deve conter pc-more-narrow associado ao data-more="subtitle-style"
  assert.equal(
    playerJs.includes('pc-more-narrow" data-more="subtitle-style"'),
    false,
    "Opção de estilo de legenda no menu (...) deve estar sempre visível, sem a restrição pc-more-narrow",
  );
});

test("2.2: Botão avulso #subtitle-style-btn removido da barra de ferramentas da aula (.player-tools)", () => {
  // A barra .player-tools não deve mais conter o botão avulso subtitle-style-btn
  const playerToolsIndex = playerJs.indexOf('<div class="player-tools">');
  assert.ok(playerToolsIndex !== -1, "Deve existir player-tools");
  const playerToolsSnippet = playerJs.slice(playerToolsIndex, playerToolsIndex + 600);

  assert.equal(
    playerToolsSnippet.includes('id="subtitle-style-btn"'),
    false,
    "Botão #subtitle-style-btn deve ser removido de .player-tools para despoluir a UI principal",
  );
});

test("2.2: positionSubtitleStylePanel aceita pc-more-btn como âncora de posicionamento", () => {
  assert.ok(
    subtitlesJs.includes("pc-more-btn"),
    "positionSubtitleStylePanel em subtitles.js deve suportar #pc-more-btn como âncora",
  );
});

test("Fix Bug 1: route() fecha Tutor e limpa classes tutor-open/player-idle para nunca sumir com a sidebar", () => {
  const appJs = fs.readFileSync("public/app.js", "utf8");
  const routeMatch = appJs.match(/function route\(\)\s*\{[\s\S]*?const app = document\.getElementById\("app"\)/);
  assert.ok(routeMatch, "Deve encontrar function route()");
  assert.ok(
    routeMatch[0].includes("closeTutorDrawer()"),
    "route() deve chamar closeTutorDrawer() ao trocar de tela",
  );
  assert.ok(
    routeMatch[0].includes('classList.remove("tutor-open"'),
    "route() deve remover tutor-open do body para evitar ocultar .sidebar",
  );
});

test("Fix Bug 2: abertura do player usa scroll compensado pela altura da .topbar (sem cortar o topo do vídeo)", () => {
  assert.equal(
    playerJs.includes('wrapEl.scrollIntoView({ behavior: "instant", block: "start" })'),
    false,
    "Não deve usar scrollIntoView(block: start) cru que empurra o player para trás da .topbar sticky",
  );
  assert.ok(
    playerJs.includes("window.scrollTo({ top: targetY") && playerJs.includes("topbarH"),
    "Deve posicionar o player compensando a altura real da .topbar",
  );
});

test("Fix Bug 3: botão ⋮ abre o menu com opção 'Configuração de legenda' e não dispara diretamente o painel", () => {
  assert.ok(
    playerJs.includes('data-more="subtitle-style">Configuração de legenda<'),
    "Menu ⋮ (#pc-more-menu) deve exibir a opção 'Configuração de legenda'",
  );
  const wireMatch = subtitlesJs.match(/function wireSubtitleStylePanel\([^)]*\)\s*\{[\s\S]*?renderSubtitleStyleView/);
  assert.ok(wireMatch, "Deve encontrar wireSubtitleStylePanel");
  assert.equal(
    wireMatch[0].includes('getElementById("pc-more-btn")'),
    false,
    "wireSubtitleStylePanel não deve vincular onclick em #pc-more-btn",
  );
});

test("Fix Tradução sem IA: mensagem amigável, ação 'Configurar IA' e limpeza automática do erro", () => {
  assert.ok(
    subtitlesJs.includes('setTranslationError("no_llm_provider"'),
    "Deve registrar código no_llm_provider com auto-clear quando não houver LLM configurado",
  );
  assert.ok(
    subtitlesJs.includes('actionText = "Configurar IA"') &&
      subtitlesJs.includes('actionHandler = "open-ai-settings"') &&
      subtitlesJs.includes('location.hash = "#/settings/ia"'),
    "Sem IA configurada, deve oferecer ação direta 'Configurar IA' apontando para #/settings/ia",
  );
  assert.ok(
    subtitlesJs.includes("clearTranslationError(true)"),
    "Dispensar ou expirar o badge de erro deve limpar subtitleState.translationError também na UI",
  );
  assert.equal(
    subtitlesJs.includes("Erro: ${err}. Clique em 'Tentar novamente'."),
    false,
    "Não deve concatenar 'Erro: ${err}. Clique em Tentar novamente.' gerando ponto duplo",
  );
});

test("Fix Select Traduzir para: contraste escuro explícito em .pc-cc-target-select e <option>", () => {
  assert.match(
    stylesCss,
    /\.pc-cc-target-select\s*\{[^}]*color-scheme:\s*dark;[^}]*background-color:\s*#[0-9a-f]+;[^}]*color:\s*#[0-9a-f]+;/is,
    ".pc-cc-target-select deve declarar color-scheme: dark, fundo escuro e texto claro",
  );
  assert.match(
    stylesCss,
    /\.pc-cc-target-select\s+option\s*\{[^}]*background-color:\s*#[0-9a-f]+;[^}]*color:\s*#[0-9a-f]+;/is,
    ".pc-cc-target-select option deve declarar fundo escuro e texto claro (evita branco no branco no Windows)",
  );
});

test("Fix Tópicos: 'Seu progresso' só é exibido em tópicos com mais de 1 curso", () => {
  const appJs = fs.readFileSync("public/app.js", "utf8");
  const topicMatch = appJs.match(/function renderTopic\([\s\S]*?function renderCourse\(/);
  assert.ok(topicMatch, "Deve encontrar function renderTopic");
  assert.ok(
    topicMatch[0].includes("if (scopeCourses.length > 1)"),
    "renderTopic deve exigir scopeCourses.length > 1 para renderizar 'Seu progresso'",
  );
});
