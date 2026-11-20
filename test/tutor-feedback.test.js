const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");

const tutorJs = fs.readFileSync("public/js/tutor.js", "utf8");
const routesJs = fs.readFileSync("server/tutor/routes.js", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");

// Extrai classifyTutorError isolada para testar o comportamento real.
function loadClassifier() {
  const m = tutorJs.match(/const TUTOR_SETTINGS_ACTION[\s\S]*?function classifyTutorError[\s\S]*?\r?\n\}\r?\n/);
  assert.ok(m, "classifyTutorError deve existir em tutor.js");
  const ctx = {};
  vm.runInNewContext(m[0] + "\nthis.fn = classifyTutorError;", ctx);
  return ctx.fn;
}

test("Tutor erros: sem provedor -> aviso amigável com ação para configurações", () => {
  const c = loadClassifier();
  const e = new Error("Nenhum provedor de IA configurado. Acesse Configurações > ...");
  e.code = "no_provider";
  const info = c(e);
  assert.strictEqual(info.kind, "warning");
  assert.strictEqual(info.title, "Tutor AI indisponível");
  assert.ok(!/Provedores LLM|Acesse Configurações/.test(info.text), "sem detalhes internos");
  assert.strictEqual(info.action.href, "#/settings/ia");
  assert.strictEqual(info.action.label, "Configurar Tutor AI");
});

test("Tutor erros: falha de rede, timeout e erro genérico não expõem detalhes técnicos", () => {
  const c = loadClassifier();
  const net = c(new TypeError("Failed to fetch"));
  assert.strictEqual(net.kind, "error");
  assert.ok(!/fetch/i.test(net.text));
  const http = c(new Error("Erro HTTP 500"));
  assert.ok(!/HTTP|500/.test(http.text));
  assert.ok(http.title && http.text);
  const auth = c(new Error("401 Unauthorized: invalid api key sk-123"));
  assert.ok(!/sk-123|401/.test(auth.text));
  assert.ok(auth.action, "chave inválida oferece ação de revisar provedor");
});

test("Tutor erros: servidor envia code no_provider e UI renderiza cartão tipado", () => {
  assert.strictEqual((routesJs.match(/code: "no_provider"/g) || []).length, 3);
  assert.ok(tutorJs.includes("tutor-feedback"), "cartão .tutor-feedback renderizado");
  assert.ok(!tutorJs.includes("Não foi possível obter a resposta:"), "mensagem antiga removida");
  for (const k of ["error", "warning", "success", "loading"]) {
    assert.ok(css.includes(`.tutor-feedback--${k}`), `estilo ${k}`);
  }
});
