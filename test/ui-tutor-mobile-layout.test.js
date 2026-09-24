const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");
const TUTOR_JS_PATH = path.join(__dirname, "..", "public", "js", "tutor.js");

test("Tutor mobile UI: styles.css garante que .tutor-btn-label é oculto em mobile no header", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  // Deve haver uma regra que esconda .tutor-btn-label dentro de .tutor-header-actions ou no mobile
  const hasLabelHideRule =
    css.includes(".tutor-header-actions .tutor-btn-label") ||
    css.includes(".tutor-icon-btn .tutor-btn-label");
  assert.ok(
    hasLabelHideRule,
    "styles.css deve ter seletor para ocultar .tutor-btn-label em botões de ação do tutor",
  );
});

test("Tutor mobile UI: styles.css previne quebra de linha em .tutor-status-badge e elipsa rótulo", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tutor-status-badge[\s\S]*?white-space:\s*nowrap/,
    ".tutor-status-badge deve conter white-space: nowrap para evitar que o texto de transcrição quebre em várias linhas",
  );
  assert.match(
    css,
    /\.tutor-context-label[\s\S]*?text-overflow:\s*ellipsis/,
    ".tutor-context-label deve elipsar o texto caso o espaço na tela seja reduzido",
  );
});

test("Tutor mobile UI: tutor.js atualiza title e aria-label acessíveis em switchTutorTab", () => {
  const code = fs.readFileSync(TUTOR_JS_PATH, "utf8");
  assert.match(
    code,
    /newChatBtn\.setAttribute\("title"/,
    "tutor.js deve atualizar title de #tutor-new-chat na troca de abas para manter clareza sem depender do label visual",
  );
  assert.match(
    code,
    /newChatBtn\.setAttribute\("aria-label"/,
    "tutor.js deve atualizar aria-label de #tutor-new-chat na troca de abas para acessibilidade",
  );
});
