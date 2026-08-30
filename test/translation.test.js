// Testes da feature de TRADUÇÃO DE LEGENDAS (LLM, sob demanda).
// node:test + node:assert (stdlib) — nenhuma dependência nova.
//
// Cobre os contratos de backend da tradução:
//   - translationCacheName / translationDocPath (chave derivada hash-lang)
//   - defaultAiConfig/sanitizeAiConfig/applyAiPatch/maskAiConfig (bloco
//     `translation` e reuso do LLM da correção)
//   - applyLlmTranslationGuardrail (ids + limites de tamanho para idioma)
//
// O boot real do servidor (porta + data/) é pulado pelo guard
// require.main === module; estes testes são puros.
const test = require("node:test");
const assert = require("node:assert");

const {
  subtitleCacheName,
  translationCacheName,
  translationDocPath,
  defaultAiConfig,
  sanitizeAiConfig,
  applyAiPatch,
  maskAiConfig,
  applyLlmTranslationGuardrail,
} = require("../server.js");

// --- Chaves de cache derivadas -------------------------------------------------

test("translationCacheName: chave derivada baseHash-lang, nunca colide com a original", () => {
  const base = subtitleCacheName("libA", "Curso/Aula.mp4");
  assert.match(base, /^[0-9a-f]{24}$/);
  assert.strictEqual(translationCacheName(base, "pt"), base + "-pt");
  assert.strictEqual(translationCacheName(base, "en"), base + "-en");
  // Lang é clampado (nunca nome de arquivo arbitrário em URLs).
  assert.strictEqual(translationCacheName(base, "verylonglanguage"), base + "-verylongla");
});

test("translationCacheName: determinístico e escopado por biblioteca", () => {
  const a = subtitleCacheName("libA", "Curso/Aula.mp4");
  const b = subtitleCacheName("libB", "Curso/Aula.mp4");
  assert.notStrictEqual(a, b);
  assert.strictEqual(
    translationCacheName(a, "pt"),
    translationCacheName(a, "pt"),
  );
  assert.notStrictEqual(
    translationCacheName(a, "pt"),
    translationCacheName(b, "pt"),
  );
});

test("translationDocPath: aponta para translations/ com o sufixo", () => {
  const base = subtitleCacheName("libA", "Curso/Aula.mp4");
  const p = translationDocPath(base, "pt");
  assert.ok(p.includes("translations"));
  assert.ok(p.endsWith(base + "-pt.json"));
});

// --- Config (bloco translation) -------------------------------------------------

test("defaultAiConfig: translation com padrões", () => {
  const c = defaultAiConfig();
  assert.deepStrictEqual(c.translation, {
    enabled: false,
    targetLanguage: "pt",
    keepTerms: true,
  });
});

test("sanitizeAiConfig: valida o bloco translation contra o registry", () => {
  const base = defaultAiConfig();
  const c = sanitizeAiConfig({
    ...base,
    translation: { enabled: true, targetLanguage: "en", keepTerms: false },
  });
  assert.strictEqual(c.translation.enabled, true);
  assert.strictEqual(c.translation.targetLanguage, "en");
  assert.strictEqual(c.translation.keepTerms, false);
});

test("sanitizeAiConfig: idioma-alvo inválido cai para pt", () => {
  const base = defaultAiConfig();
  const c = sanitizeAiConfig({
    ...base,
    translation: { enabled: true, targetLanguage: "xx", keepTerms: true },
  });
  assert.strictEqual(c.translation.targetLanguage, "pt");
});

test("applyAiPatch: tradução aplica/enabled/targetLanguage/keepTerms", () => {
  const base = defaultAiConfig();
  const patched = applyAiPatch(base, {
    translation: { enabled: true, targetLanguage: "es", keepTerms: false },
  });
  assert.strictEqual(patched.translation.enabled, true);
  assert.strictEqual(patched.translation.targetLanguage, "es");
  assert.strictEqual(patched.translation.keepTerms, false);
});

test("applyAiPatch: idioma-alvo inválido lança erro", () => {
  const base = defaultAiConfig();
  assert.throws(() => applyAiPatch(base, { translation: { targetLanguage: "zz" } }));
});

test("maskAiConfig: expõe translation sem segredos", () => {
  const base = defaultAiConfig();
  const masked = maskAiConfig(base);
  assert.deepStrictEqual(masked.translation, base.translation);
  assert.ok(!("apiKey" in masked.translation));
});

// --- Guardrail de tradução ----------------------------------------------------

test("applyLlmTranslationGuardrail: aceita tradução válida e preserva ids/tempos", () => {
  const original = [
    { id: "1", text: "Hello world", start: 0, end: 1 },
    { id: "2", text: "SQL injection", start: 1, end: 2 },
  ];
  const translated = [
    { id: "1", text: "Olá mundo" },
    { id: "2", text: "SQL injection" },
  ];
  const out = applyLlmTranslationGuardrail(original, translated);
  assert.ok(out);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].id, "1");
  assert.strictEqual(out[0].text, "Olá mundo");
  assert.strictEqual(out[0].start, 0);
  assert.strictEqual(out[1].text, "SQL injection"); // termo técnico preservado
});

test("applyLlmTranslationGuardrail: id faltando/duplicado/inventado → null", () => {
  const original = [
    { id: "1", text: "a", start: 0, end: 1 },
    { id: "2", text: "b", start: 1, end: 2 },
  ];
  assert.strictEqual(
    applyLlmTranslationGuardrail(original, [{ id: "1", text: "x" }]),
    null,
  );
  assert.strictEqual(
    applyLlmTranslationGuardrail(original, [
      { id: "1", text: "x" },
      { id: "1", text: "y" },
    ]),
    null,
  );
  assert.strictEqual(
    applyLlmTranslationGuardrail(original, [
      { id: "1", text: "x" },
      { id: "9", text: "y" },
    ]),
    null,
  );
});

test("applyLlmTranslationGuardrail: resumo exagerado / explodido → null", () => {
  const original = [
    { id: "1", text: "This is a fairly long english sentence about software", start: 0, end: 1 },
  ];
  // Resumo (cai abaixo de 25% do tamanho).
  assert.strictEqual(
    applyLlmTranslationGuardrail(original, [{ id: "1", text: "ok" }]),
    null,
  );
  // Explosão acima de 6x.
  assert.strictEqual(
    applyLlmTranslationGuardrail(original, [{ id: "1", text: "x".repeat(500) }]),
    null,
  );
});

test("applyLlmTranslationGuardrail: ordem reordenada é corrigida pelo app", () => {
  const original = [
    { id: "1", text: "aaa", start: 0, end: 1 },
    { id: "2", text: "bbb", start: 1, end: 2 },
    { id: "3", text: "ccc", start: 2, end: 3 },
  ];
  const out = applyLlmTranslationGuardrail(original, [
    { id: "3", text: "três" },
    { id: "1", text: "um" },
    { id: "2", text: "dois" },
  ]);
  assert.ok(out);
  assert.deepStrictEqual(out.map((s) => s.id), ["1", "2", "3"]);
  assert.deepStrictEqual(out.map((s) => s.text), ["um", "dois", "três"]);
});