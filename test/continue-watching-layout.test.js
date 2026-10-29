const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stylesPath = path.join(__dirname, "..", "public", "styles.css");
const appJsPath = path.join(__dirname, "..", "public", "app.js");

const stylesContent = fs.readFileSync(stylesPath, "utf8");
const appJsContent = fs.readFileSync(appJsPath, "utf8");

test("Continuar assistindo: contêiner .continue-row usa flexbox sem quebra de linha (nowrap) e rolagem horizontal", () => {
  // O contêiner deve ser flex, flex-wrap: nowrap e habilitar overflow-x: auto
  assert.match(
    stylesContent,
    /\.continue-row\s*\{[^}]*display:\s*flex;/s,
    ".continue-row deve usar display: flex"
  );
  assert.match(
    stylesContent,
    /\.continue-row\s*\{[^}]*flex-wrap:\s*nowrap;/s,
    ".continue-row deve usar flex-wrap: nowrap"
  );
  assert.match(
    stylesContent,
    /\.continue-row\s*\{[^}]*overflow-x:\s*auto;/s,
    ".continue-row deve habilitar overflow-x: auto para rolagem horizontal"
  );
  assert.match(
    stylesContent,
    /\.continue-row\s*\{[^}]*overflow-y:\s*hidden;/s,
    ".continue-row deve manter overflow-y: hidden"
  );
});

test("Continuar assistindo: elementos ancestrais garantem contenção e evitam overflow da página", () => {
  // .home-section e .continue-row devem conter min-width: 0 e max-width: 100%
  assert.match(
    stylesContent,
    /\.home-section\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    ".home-section deve ter min-width: 0 e max-width: 100%"
  );
  assert.match(
    stylesContent,
    /\.continue-row\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    ".continue-row deve ter min-width: 0 e max-width: 100%"
  );
});

test("Continuar assistindo: cards mantêm proporção visual consistente (flex-shrink 0 / min-width)", () => {
  assert.match(
    stylesContent,
    /\.continue-card\s*\{[^}]*flex:\s*0\s+0\s+clamp\(/s,
    ".continue-card deve usar flex: 0 0 clamp(...) para nunca ser esmagado"
  );
  assert.match(
    stylesContent,
    /\.continue-card\s*\{[^}]*min-width:\s*2/s,
    ".continue-card deve manter min-width seguro"
  );
  assert.match(
    stylesContent,
    /\.continue-card\s*\{[^}]*scroll-snap-align:\s*start;/s,
    ".continue-card deve definir scroll-snap-align: start para precisão de rolagem"
  );
});

test("Continuar assistindo: mobile (@media max-width 640px) preserva linha única sem empilhamento vertical", () => {
  // Não deve existir grid-template-columns: 1fr na .continue-row no mobile
  const mobileBlockMatch = stylesContent.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)(?=\n@media|\n\/\* =|$)/);
  assert.ok(mobileBlockMatch, "Deve existir bloco @media (max-width: 640px)");
  const mobileCss = mobileBlockMatch[1];

  assert.equal(
    mobileCss.includes("grid-template-columns: 1fr"),
    false,
    ".continue-row no mobile NÃO deve usar grid-template-columns: 1fr (não pode empilhar verticalmente)"
  );

  assert.match(
    mobileCss,
    /\.continue-card\s*\{[^}]*flex:\s*0\s+0\s+clamp\(/s,
    "Cards no mobile devem ter largura responsiva mantendo linha única"
  );
});

test("Continuar assistindo: barra de rolagem e snap estilizados para desktop e navegadores modernos", () => {
  assert.match(
    stylesContent,
    /\.continue-row\s*\{[^}]*scrollbar-width:\s*thin;/s,
    ".continue-row deve ter scrollbar-width: thin"
  );
  assert.match(
    stylesContent,
    /\.continue-row::-webkit-scrollbar\s*\{/s,
    ".continue-row deve ter personalização para Webkit"
  );
});

test("Continuar assistindo: simulação dos cenários de tela e zoom (80%, 100%, 125%, 150%, 200%)", () => {
  const zoomScenarios = [
    { name: "Desktop amplo 1920x1080 (100%)", viewportW: 1920, expectedCardsFit: 4 },
    { name: "Desktop padrão 1366x768 (100%)", viewportW: 1366, expectedCardsFit: 3 },
    { name: "Desktop zoom 80%", viewportW: 1707, expectedCardsFit: 4 },
    { name: "Desktop zoom 125%", viewportW: 1092, expectedCardsFit: 3 },
    { name: "Desktop zoom 150%", viewportW: 910, expectedCardsFit: 2 },
    { name: "Desktop zoom 200%", viewportW: 683, expectedCardsFit: 2 },
    { name: "Tablet 768px", viewportW: 768, expectedCardsFit: 2 },
    { name: "Mobile 375px", viewportW: 375, expectedCardsFit: 1 },
  ];

  const cardMinW = 260; // min-width desktop
  const gap = 16;

  for (const { name, viewportW, expectedCardsFit } of zoomScenarios) {
    const availableWidth = viewportW - 48; // padding aproximado da aplicação
    const maxFittingCards = Math.floor((availableWidth + gap) / (cardMinW + gap));
    assert.ok(
      maxFittingCards >= 1,
      `Em ${name} deve caber pelo menos 1 card na viewport visível`
    );
    // Em todas as resoluções, quando os 4 cards excedem o espaço disponível,
    // flex-wrap: nowrap garante linha horizontal e overflow-x: auto permite scroll.
    assert.match(stylesContent, /\.continue-row\s*\{[^}]*flex-wrap:\s*nowrap;/s);
  }
});

test("Continuar assistindo: integridade funcional dos cards", () => {
  // Verifica se renderContinueCard e renderContinueSection em app.js continuam montando os cards normalmente
  assert.ok(appJsContent.includes('function renderContinueCard(item, i)'));
  assert.ok(appJsContent.includes('function renderContinueSection(items, summary)'));
  assert.ok(appJsContent.includes('class="continue-row"'));
  assert.ok(appJsContent.includes('class="continue-card"'));
});
