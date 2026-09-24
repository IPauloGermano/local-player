const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");
const TUTOR_JS_PATH = path.join(__dirname, "..", "public", "js", "tutor.js");

test("Tutor mobile input: styles.css oculta footer no mobile para liberar espaço vertical", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.tutor-input-footer\s*\{[^}]*display:\s*none\s*!important/,
    "styles.css deve ocultar .tutor-input-footer no mobile para não poluir a tela com instruções de teclado físico",
  );
});

test("Tutor mobile input: styles.css garante centralização de #tutor-send-icon e alinhamento do botão", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /#tutor-send-icon\s*\{[\s\S]*?display:\s*flex/,
    "#tutor-send-icon deve ter display: flex para centralizar perfeitamente o ícone SVG no botão",
  );
});

test("Tutor mobile input: tutor.js usa SVG de 17px para manter proporção e nitidez no envio", () => {
  const code = fs.readFileSync(TUTOR_JS_PATH, "utf8");
  assert.match(
    code,
    /<svg[^>]*width="17"[^>]*height="17"/,
    "tutor.js deve utilizar ícone de 17px para boa proporção no botão de envio",
  );
});
