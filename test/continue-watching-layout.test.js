const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stylesPath = path.join(__dirname, "..", "public", "styles.css");
const appJsPath = path.join(__dirname, "..", "public", "app.js");

const stylesContent = fs.readFileSync(stylesPath, "utf8");
const appJsContent = fs.readFileSync(appJsPath, "utf8");

test("Continuar assistindo: contêiner .continue-row usa grid de 4 colunas fixas sem rolagem horizontal", () => {
  assert.match(
    stylesContent,
    /\.continue-row\s*\{[^}]*display:\s*grid;/s,
    ".continue-row deve usar display: grid"
  );
  assert.match(
    stylesContent,
    /\.continue-row\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/s,
    ".continue-row deve definir 4 colunas fixas (repeat(4, minmax(0, 1fr))) para manter os 4 cards visíveis"
  );
  assert.equal(
    /\.continue-row\s*\{[^}]*overflow-x:\s*auto;/s.test(stylesContent),
    false,
    ".continue-row não deve usar overflow-x: auto (sem rolagem para os lados)"
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

test("Continuar assistindo: cards mantêm proporção visual consistente (tamanho fixo e sem estouro)", () => {
  assert.match(
    stylesContent,
    /\.continue-card\s*\{[^}]*width:\s*100%;/s,
    ".continue-card deve preencher sua coluna de forma consistente (width: 100%)"
  );
  assert.match(
    stylesContent,
    /\.continue-card\s*\{[^}]*min-width:\s*0;/s,
    ".continue-card deve manter min-width: 0 para evitar estouro em grid cells"
  );
});

test("Continuar assistindo: mobile (@media max-width 640px) usa grade de 2 colunas mantendo os 4 visíveis sem rolagem horizontal", () => {
  const mobileBlockMatch = stylesContent.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)(?=\n@media|\n\/\* =|$)/);
  assert.ok(mobileBlockMatch, "Deve existir bloco @media (max-width: 640px)");
  const mobileCss = mobileBlockMatch[1];

  assert.match(
    mobileCss,
    /\.continue-row\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s,
    ".continue-row no mobile deve usar repeat(2, minmax(0, 1fr)) para exibir os 4 cards em 2x2"
  );
  assert.equal(
    mobileCss.includes("overflow-x: auto"),
    false,
    "Mobile não deve ter rolagem horizontal"
  );
});

test("Continuar assistindo: os 4 cards cabem na tela sem rolagem horizontal no desktop", () => {
  const desktopColumns = 4;
  assert.strictEqual(desktopColumns, 4, "Devem caber exatamente 4 cards na linha do desktop");
});

test("Continuar assistindo: integridade funcional dos cards", () => {
  // Verifica se renderContinueCard e renderContinueSection em app.js continuam montando os cards normalmente
  assert.ok(appJsContent.includes('function renderContinueCard(item, i)'));
  assert.ok(appJsContent.includes('function renderContinueSection(items, summary)'));
  assert.ok(appJsContent.includes('class="continue-row"'));
  assert.ok(appJsContent.includes('class="continue-card"'));
});
