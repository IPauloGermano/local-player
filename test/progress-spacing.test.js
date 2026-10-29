const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stylesPath = path.join(__dirname, "..", "public", "styles.css");
const stylesContent = fs.readFileSync(stylesPath, "utf8");

test("Espaçamento de 'Seu progresso' compactado: margem inferior reduzida", () => {
  // Quando compactado, a margem inferior da seção não deve ser 52px (clamp de home-section padrão),
  // e sim um valor compacto proporcional de até 24px (clamp(16px, 2.5vw, 24px)).
  assert.ok(
    stylesContent.includes('.progress-section[data-progress-mode="compact"] {\n  margin-bottom: clamp(16px, 2.5vw, 24px);\n}'),
    "progress-section[data-progress-mode='compact'] deve definir margin-bottom: clamp(16px, 2.5vw, 24px)"
  );
});

test("Espaçamento de 'Seu progresso' compactado: respiro do cabeçalho reduzido", () => {
  // O section-head em modo compacto deve ter espaçamento enxuto de 14px
  assert.ok(
    stylesContent.includes('.progress-section[data-progress-mode="compact"] .section-head {\n  margin-bottom: 14px;\n}'),
    "section-head em modo compacto deve ter margin-bottom: 14px"
  );
});

test("Espaçamento de 'Seu progresso' compactado: painel expandido tem colapso total sem vazamento de altura", () => {
  // progress-panel-wrap deve ter overflow: hidden
  assert.ok(
    stylesContent.includes(".progress-panel-wrap {\n  display: grid;\n  grid-template-rows: 1fr;\n  opacity: 1;\n  overflow: hidden;"),
    "progress-panel-wrap deve ter overflow: hidden"
  );

  // No modo compacto, o panel-wrap deve ser ocultado com visibility: hidden e sem box-shadow
  assert.ok(
    stylesContent.includes('.progress-section[data-progress-mode="compact"] .progress-panel-wrap {\n  grid-template-rows: 0fr;\n  opacity: 0;\n  visibility: hidden;\n  box-shadow: none;\n}'),
    "panel-wrap compacto deve zerar grid rows, opacity, box-shadow e ter visibility: hidden"
  );

  // No modo compacto, o padding e bordas do panel interno devem ser zerados para altura estritamente zero
  assert.ok(
    stylesContent.includes('.progress-section[data-progress-mode="compact"] .progress-panel {\n  padding-top: 0;\n  padding-bottom: 0;\n  border-top-width: 0;\n  border-bottom-width: 0;\n}'),
    "progress-panel interno deve zerar padding vertical e bordas no modo compacto"
  );
});

test("Espaçamento de 'Seu progresso' expandido: resumo compacto recolhe sem vazamento", () => {
  assert.ok(
    stylesContent.includes(".progress-summary {\n  display: grid;\n  grid-template-rows: 0fr;\n  opacity: 0;\n  overflow: hidden;"),
    "progress-summary deve ter overflow: hidden"
  );
  assert.ok(
    stylesContent.includes('.progress-section[data-progress-mode="expanded"] .progress-summary {\n  visibility: hidden;\n}'),
    "progress-summary em modo expandido deve ter visibility: hidden"
  );
  assert.ok(
    stylesContent.includes('.progress-section[data-progress-mode="expanded"] .progress-summary-inner {\n  padding-top: 0;\n  padding-bottom: 0;\n  border-top-width: 0;\n  border-bottom-width: 0;\n}'),
    "progress-summary-inner deve zerar padding vertical e bordas quando expandido"
  );
});
