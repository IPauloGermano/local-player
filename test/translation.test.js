"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const {
  SUPPORTED_TARGET_LANGS,
  TARGET_LANG_LABELS,
  buildTranslatePrompt,
  sanitizeTranslationResult,
  subtitleCacheName,
  parseRetryAfter,
} = require("../server.js");

// ---------------------------------------------------------------------------
// 1. Testes Unitários de Tradução (Prompt, Sanitização, Idiomas)
// ---------------------------------------------------------------------------

test("Tradução: SUPPORTED_TARGET_LANGS contém exatamente os 11 idiomas suportados", () => {
  const expected = ["pt", "en", "es", "fr", "de", "it", "nl", "ja", "ko", "zh", "ru"];
  assert.deepEqual(SUPPORTED_TARGET_LANGS, expected);
  for (const lang of expected) {
    assert.ok(TARGET_LANG_LABELS[lang], `Label ausente para idioma: ${lang}`);
  }
});

test("Tradução: buildTranslatePrompt gera instruções estritas de formato JSON 1:1 sem tempos", () => {
  const segments = [
    { id: "s1", start: 0, end: 2.5, text: "Bem-vindos ao curso de Node.js." },
    { id: "s2", start: 2.5, end: 5.0, text: "Hoje vamos aprender Express e APIs REST." },
  ];

  const prompt = buildTranslatePrompt("pt", "en", segments);
  assert.ok(prompt.includes("Inglês"));
  assert.ok(prompt.includes("2 segmentos"));
  assert.ok(prompt.includes('[{"id": "s1", "text": "texto traduzido"}]'));
  assert.ok(prompt.includes("NÃO altere tempos"));
  assert.ok(prompt.includes("Preserve nomes próprios"));
  assert.ok(prompt.includes("<segments_to_translate>"));
  assert.ok(prompt.includes("s1"));
  assert.ok(prompt.includes("s2"));
  // Não envia start/end para economizar tokens e evitar alteração de tempos pelo LLM
  assert.ok(!prompt.includes('"start":'));
  assert.ok(!prompt.includes('"end":'));
});

test("Tradução: sanitizeTranslationResult preserva tempos, alinha 1:1 e faz fallback seguro", () => {
  const sourceSegments = [
    { id: "s1", start: 1.0, end: 3.5, text: "Olá mundo" },
    { id: "s2", start: 3.5, end: 6.0, text: "Segunda frase" },
    { id: "s3", start: 6.0, end: 8.5, text: "Terceira frase" },
  ];

  // Caso 1: Array direto válido
  const raw1 = [
    { id: "s1", text: "Hello world" },
    { id: "s2", text: "Second sentence" },
    { id: "s3", text: "Third sentence" },
  ];
  const res1 = sanitizeTranslationResult(raw1, sourceSegments);
  assert.equal(res1.length, 3);
  assert.equal(res1[0].text, "Hello world");
  assert.equal(res1[0].start, 1.0);
  assert.equal(res1[0].end, 3.5);
  assert.equal(res1[1].text, "Second sentence");
  assert.equal(res1[2].text, "Third sentence");

  // Caso 2: Objeto envelopado com segments e item faltando / inválido
  const raw2 = {
    segments: [
      { id: "s1", text: "Hello world" },
      { id: "s2", text: "" }, // texto vazio -> deve usar fallback original
      // s3 ausente -> deve usar fallback original
    ],
  };
  const res2 = sanitizeTranslationResult(raw2, sourceSegments);
  assert.equal(res2.length, 3);
  assert.equal(res2[0].text, "Hello world");
  assert.equal(res2[1].text, "Segunda frase"); // fallback do s2
  assert.equal(res2[1].start, 3.5);
  assert.equal(res2[1].end, 6.0);
  assert.equal(res2[2].text, "Terceira frase"); // fallback do s3
  assert.equal(res2[2].start, 6.0);
  assert.equal(res2[2].end, 8.5);

  // Caso 3: Resposta completamente nula ou inválida
  const res3 = sanitizeTranslationResult(null, sourceSegments);
  assert.equal(res3.length, 3);
  assert.equal(res3[0].text, "Olá mundo");
  assert.equal(res3[1].text, "Segunda frase");
  assert.equal(res3[2].text, "Terceira frase");

  // Caso 4: sourceSegments vazio
  assert.deepEqual(sanitizeTranslationResult(raw1, []), []);
});

test("Tradução: parseRetryAfter interpreta segundos inteiros, decimais, datas HTTP e entradas inválidas", () => {
  assert.equal(parseRetryAfter("120"), 120000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter("1.5"), 1500);
  assert.equal(parseRetryAfter("  5  "), 5000);
  assert.equal(parseRetryAfter("-10"), null);
  assert.equal(parseRetryAfter("invalid"), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);

  // HTTP-Date no futuro (~5000ms a partir de agora)
  const future = new Date(Date.now() + 5000).toUTCString();
  const diffFuture = parseRetryAfter(future);
  assert.ok(diffFuture >= 3000 && diffFuture <= 6000, `diffFuture esperado ~5000ms, obteve ${diffFuture}`);

  // HTTP-Date no passado
  const past = new Date(Date.now() - 5000).toUTCString();
  assert.equal(parseRetryAfter(past), 0);
});

// ---------------------------------------------------------------------------
// 2. Testes de Integração com Servidor Real e Mock LLM
// ---------------------------------------------------------------------------

function extractSegmentsFromRequestBody(body) {
  try {
    const parsed = JSON.parse(body);
    const sys = parsed.messages?.find((msg) => msg.role === "system")?.content || "";
    const m = sys.match(/<segments_to_translate>\s*([\s\S]*?)\s*<\/segments_to_translate>/);
    if (m) return JSON.parse(m[1]);
  } catch {}
  return [];
}

async function startTestServer(dataDir, extraEnv = {}) {
  const port = 37000 + Math.floor(Math.random() * 8000);
  const proc = spawn("node", ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      LP_DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      TRANSLATE_BATCH_SIZE: "50",
      TRANSLATE_MIN_INTERVAL_MS: "5",
      TRANSLATE_BACKOFF_BASE_MS: "10",
      TRANSLATE_BACKOFF_MAX_MS: "50",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 8000) {
    try {
      const res = await fetch(`${base}/api/tree`);
      if (res.ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    proc,
    stop: async () => {
      proc.kill("SIGTERM");
      await new Promise((r) => proc.on("close", r));
    },
  };
}

test("Tradução: fluxo integrado HTTP de traduções com Mock LLM, rotas, VTT e clear", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-trans-test-data-"));
  const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-trans-test-lib-"));

  // Cria estrutura de curso e vídeo na biblioteca
  const courseRel = "Curso Traducao";
  const lessonRel = `${courseRel}/Aula 01.mp4`;
  const courseAbs = path.join(libDir, courseRel);
  await fs.mkdir(courseAbs, { recursive: true });
  await fs.writeFile(path.join(libDir, lessonRel), Buffer.from("fake video content"));

  // Mock LLM Server OpenAI-compatible
  let mockCallCount = 0;
  let mockTranslateText = "Hello world translated";
  const mockLlmPort = 43000 + Math.floor(Math.random() * 5000);
  const mockLlmServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      mockCallCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { id: "s1", text: mockTranslateText },
                  { id: "s2", text: "Second segment in English" },
                ]),
              },
            },
          ],
        }),
      );
    });
  });

  await new Promise((r) => mockLlmServer.listen(mockLlmPort, "127.0.0.1", r));

  const srv = await startTestServer(dataDir);

  try {
    // 1. Cadastra a biblioteca externa
    const libRes = await fetch(`${srv.base}/api/libraries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: libDir }),
    });
    assert.strictEqual(libRes.status, 201);
    const libData = await libRes.json();
    const libId = libData.id;

    // 2. Validações de segurança e path traversal
    // 2.1 Traversal em /api/subtitles/translations
    const tTrav = await fetch(`${srv.base}/api/subtitles/translations?path=../../etc/passwd&libId=${libId}`);
    assert.strictEqual(tTrav.status, 400);

    // 2.2 Traversal em /api/subtitles/translate
    const trTrav = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../../etc/passwd", targetLang: "pt", libId }),
    });
    assert.strictEqual(trTrav.status, 400);

    // 2.3 targetLang inválido -> 400
    const trBadLang = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "klingon", libId }),
    });
    assert.strictEqual(trBadLang.status, 400);

    // 2.4 Tradução sem legenda original pronta -> 409
    const trNoOrig = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "en", libId }),
    });
    assert.strictEqual(trNoOrig.status, 409);
    const trNoOrigData = await trNoOrig.json();
    assert.strictEqual(trNoOrigData.error, "sem legenda original");

    // 3. Status de traduções antes de ter legenda original
    const stBefore = await fetch(`${srv.base}/api/subtitles/translations?path=${encodeURIComponent(lessonRel)}&libId=${libId}`);
    assert.strictEqual(stBefore.status, 200);
    const stBeforeData = await stBefore.json();
    assert.strictEqual(stBeforeData.ok, true);
    assert.strictEqual(stBeforeData.ready, false);
    assert.strictEqual(stBeforeData.llmAvailable, false);

    // 4. Cria legenda original válida para a aula (processed + canônico)
    const hash = subtitleCacheName(libId, lessonRel);
    const sourceStat = await fs.stat(path.join(libDir, lessonRel));
    const processedDir = path.join(dataDir, "subtitles", "processed");
    await fs.mkdir(processedDir, { recursive: true });
    const originalSegments = [
      { id: "s1", start: 0.0, end: 3.0, text: "Olá mundo original" },
      { id: "s2", start: 3.0, end: 6.0, text: "Segunda frase original" },
    ];
    await fs.writeFile(
      path.join(processedDir, `${hash}.json`),
      JSON.stringify({
        version: 1,
        source: { mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
        segments: originalSegments,
        language: "pt",
      }),
    );
    // VTT canônico do curso
    const courseSubDir = path.join(courseAbs, ".courseplayer", "subtitles");
    await fs.mkdir(courseSubDir, { recursive: true });
    const originalVtt = "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nOlá mundo original\n\n00:00:03.000 --> 00:00:06.000\nSegunda frase original\n";
    await fs.writeFile(path.join(courseSubDir, `${hash}.vtt`), originalVtt);

    // 5. Tentativa de traduzir com legenda original mas SEM LLM configurado -> 400
    const trNoLlm = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "en", libId }),
    });
    assert.strictEqual(trNoLlm.status, 400);
    const trNoLlmData = await trNoLlm.json();
    assert.ok(trNoLlmData.error.includes("Nenhum provedor de IA configurado"));

    // 6. Configura o LLM mock no servidor
    const patchRes = await fetch(`${srv.base}/api/ai/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          providers: [
            {
              id: "mock-llm",
              name: "Mock Provider",
              type: "openai",
              baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
              apiKey: "test-token",
              defaultModel: "mock-model",
            },
          ],
        },
        tutor: {
          providerId: "mock-llm",
          model: "mock-model",
        },
      }),
    });
    assert.strictEqual(patchRes.status, 200);

    // 7. GET /api/subtitles/translations agora deve informar ready: true e llmAvailable: true
    const stReady = await fetch(`${srv.base}/api/subtitles/translations?path=${encodeURIComponent(lessonRel)}&libId=${libId}`);
    assert.strictEqual(stReady.status, 200);
    const stReadyData = await stReady.json();
    assert.strictEqual(stReadyData.ok, true);
    assert.strictEqual(stReadyData.ready, true);
    assert.strictEqual(stReadyData.llmAvailable, true);
    const enBefore = stReadyData.available.find((a) => a.lang === "en");
    assert.ok(enBefore);
    assert.strictEqual(enBefore.ready, false);

    // 8. Dispara tradução para inglês (POST /api/subtitles/translate)
    const initialMockCalls = mockCallCount;
    const trOk = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "en", libId }),
    });
    assert.strictEqual(trOk.status, 200);
    const trOkData = await trOk.json();
    assert.strictEqual(trOkData.ok, true);
    assert.strictEqual(trOkData.lang, "en");
    assert.strictEqual(trOkData.segments.length, 2);
    assert.strictEqual(trOkData.segments[0].text, "Hello world translated");
    assert.strictEqual(trOkData.segments[0].start, 0.0);
    assert.strictEqual(trOkData.segments[0].end, 3.0);
    assert.strictEqual(mockCallCount, initialMockCalls + 1);

    // 9. Verifica artefatos gerados em disco
    // 9.1 Canônico no curso
    const courseTransVtt = path.join(courseSubDir, `${hash}-en.vtt`);
    const stCourseVtt = await fs.stat(courseTransVtt).catch(() => null);
    assert.ok(stCourseVtt && stCourseVtt.size > 0, "VTT canônico traduzido deve existir");

    // 9.2 Espelho no data/subtitles/
    const mirrorTransVtt = path.join(dataDir, "subtitles", `${hash}-en.vtt`);
    const stMirrorVtt = await fs.stat(mirrorTransVtt).catch(() => null);
    assert.ok(stMirrorVtt && stMirrorVtt.size > 0, "VTT espelho traduzido deve existir");

    // 9.3 JSON da tradução no data/subtitles/
    const jsonTrans = path.join(dataDir, "subtitles", `${hash}-en.json`);
    const stJson = await fs.stat(jsonTrans).catch(() => null);
    assert.ok(stJson && stJson.size > 0, "JSON da tradução deve existir");

    // 10. Chamada repetida sem force reusa cache sem chamar LLM novamente
    const callsBeforeCache = mockCallCount;
    const trCached = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "en", libId }),
    });
    assert.strictEqual(trCached.status, 200);
    assert.strictEqual(mockCallCount, callsBeforeCache, "Não deve chamar LLM se já está em cache");

    // 11. Chamada com force=1 regenera chamando LLM
    mockTranslateText = "Hello world force regenerated";
    const trForce = await fetch(`${srv.base}/api/subtitles/translate?force=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "en", libId }),
    });
    assert.strictEqual(trForce.status, 200);
    const trForceData = await trForce.json();
    assert.strictEqual(trForceData.segments[0].text, "Hello world force regenerated");
    assert.strictEqual(mockCallCount, callsBeforeCache + 1, "force=1 deve chamar o LLM novamente");

    // 12. Rota de serviço GET /subtitles/<hash>-<lang>.vtt
    // 12.1 Chamada válida com rel e libId
    const vttRes = await fetch(`${srv.base}/subtitles/${hash}-en.vtt?rel=${encodeURIComponent(lessonRel)}&libId=${libId}`);
    assert.strictEqual(vttRes.status, 200);
    assert.ok(vttRes.headers.get("content-type").includes("text/vtt"));
    const vttBody = await vttRes.text();
    assert.ok(vttBody.includes("WEBVTT"));
    assert.ok(vttBody.includes("Hello world force regenerated"));

    // 12.2 Traversal em rel deve ser rejeitado (400)
    const vttTrav = await fetch(`${srv.base}/subtitles/${hash}-en.vtt?rel=../../etc/passwd&libId=${libId}`);
    assert.strictEqual(vttTrav.status, 400);

    // 12.3 Chamada sem rel para arquivo com lang deve ser rejeitada (400)
    const vttNoRel = await fetch(`${srv.base}/subtitles/${hash}-en.vtt`);
    assert.strictEqual(vttNoRel.status, 400);

    // 12.4 Idioma inexistente retorna 404
    const vtt404 = await fetch(`${srv.base}/subtitles/${hash}-ja.vtt?rel=${encodeURIComponent(lessonRel)}&libId=${libId}`);
    assert.strictEqual(vtt404.status, 404);

    // 13. GET /api/subtitles/translations agora relata "en" como ready: true
    const stAfter = await fetch(`${srv.base}/api/subtitles/translations?path=${encodeURIComponent(lessonRel)}&libId=${libId}`);
    const stAfterData = await stAfter.json();
    const enAfter = stAfterData.available.find((a) => a.lang === "en");
    assert.strictEqual(enAfter.ready, true);

    // 14. Limpeza via POST /api/subtitles/clear por path apaga arquivos originais E traduzidos
    const clearRes = await fetch(`${srv.base}/api/subtitles/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, libId }),
    });
    assert.strictEqual(clearRes.status, 200);

    // Confere que os arquivos de tradução e original sumiram do espelho e do canônico
    assert.strictEqual(await fs.stat(courseTransVtt).catch(() => null), null);
    assert.strictEqual(await fs.stat(mirrorTransVtt).catch(() => null), null);
    assert.strictEqual(await fs.stat(jsonTrans).catch(() => null), null);

    // GET /subtitles agora deve dar 404
    const vttAfterClear = await fetch(`${srv.base}/subtitles/${hash}-en.vtt?rel=${encodeURIComponent(lessonRel)}&libId=${libId}`);
    assert.strictEqual(vttAfterClear.status, 404);
  } finally {
    await srv.stop();
    await new Promise((r) => mockLlmServer.close(r));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(libDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Tradução: retentativas automáticas em erro transitório 429 e propagação de HTTP 429 ao esgotar", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-trans-retry-data-"));
  const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-trans-retry-lib-"));

  const courseRel = "Curso RateLimit";
  const lessonRel = `${courseRel}/Aula 01.mp4`;
  const courseAbs = path.join(libDir, courseRel);
  await fs.mkdir(courseAbs, { recursive: true });
  await fs.writeFile(path.join(libDir, lessonRel), Buffer.from("video"));

  let mockHandler = null;
  const mockCalls = [];
  const mockLlmPort = 44000 + Math.floor(Math.random() * 5000);
  const mockLlmServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      mockCalls.push({ url: req.url, body, headers: req.headers });
      if (mockHandler) {
        mockHandler(req, res, body);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }));
      }
    });
  });

  await new Promise((r) => mockLlmServer.listen(mockLlmPort, "127.0.0.1", r));
  const srv = await startTestServer(dataDir);

  try {
    const libRes = await fetch(`${srv.base}/api/libraries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: libDir }),
    });
    const libData = await libRes.json();
    const libId = libData.id;

    // Configura o mock LLM
    await fetch(`${srv.base}/api/ai/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          providers: [
            {
              id: "mock-retry",
              name: "Mock Retry",
              type: "openai",
              baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
              apiKey: "token",
              defaultModel: "mock-model",
            },
          ],
        },
        tutor: { providerId: "mock-retry", model: "mock-model" },
      }),
    });

    // Cria legenda original com 5 segmentos
    const hash = subtitleCacheName(libId, lessonRel);
    const sourceStat = await fs.stat(path.join(libDir, lessonRel));
    const processedDir = path.join(dataDir, "subtitles", "processed");
    await fs.mkdir(processedDir, { recursive: true });
    const originalSegments = [
      { id: "s1", start: 0, end: 1, text: "Seg 1" },
      { id: "s2", start: 1, end: 2, text: "Seg 2" },
      { id: "s3", start: 2, end: 3, text: "Seg 3" },
      { id: "s4", start: 3, end: 4, text: "Seg 4" },
      { id: "s5", start: 4, end: 5, text: "Seg 5" },
    ];
    await fs.writeFile(
      path.join(processedDir, `${hash}.json`),
      JSON.stringify({
        version: 1,
        source: { mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
        segments: originalSegments,
        language: "pt",
      }),
    );

    // 1. Cenário: 429 transitório (retorna 429 duas vezes com Retry-After e depois 200)
    let callIdx = 0;
    mockHandler = (req, res, body) => {
      callIdx++;
      if (callIdx <= 2) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "0.02",
        });
        return res.end(JSON.stringify({ error: { message: "Rate limit temporário" } }));
      }
      const segs = extractSegmentsFromRequestBody(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(segs.map((s) => ({ id: s.id, text: `Trans: ${s.text}` }))),
              },
            },
          ],
        }),
      );
    };

    const transRes1 = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "en", libId }),
    });
    assert.strictEqual(transRes1.status, 200, "Deve ter sucesso após retentativas");
    const transData1 = await transRes1.json();
    assert.strictEqual(transData1.ok, true);
    assert.strictEqual(transData1.segments.length, 5);
    assert.strictEqual(transData1.segments[0].text, "Trans: Seg 1");
    assert.strictEqual(callIdx, 3, "Deve ter realizado 3 chamadas (2 com 429 e 1 com 200)");

    // 2. Cenário: 429 persistente (esgota as 4 tentativas e retorna status HTTP 429 com retryAfterMs)
    mockCalls.length = 0;
    let persistCalls = 0;
    mockHandler = (req, res) => {
      persistCalls++;
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "2",
      });
      res.end(JSON.stringify({ error: { message: "Quota excedida permanentemente" } }));
    };

    const transRes2 = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "fr", libId }),
    });
    assert.strictEqual(transRes2.status, 429, "Ao esgotar 429, deve propagar HTTP 429 em vez de 502");
    const transData2 = await transRes2.json();
    assert.strictEqual(transData2.ok, false);
    assert.strictEqual(transData2.retryAfterMs, 2000, "Deve propagar o Retry-After convertido para milissegundos");
    assert.strictEqual(persistCalls, 4, "Deve ter tentado até o maxRetries (4 tentativas)");
  } finally {
    await srv.stop();
    await new Promise((r) => mockLlmServer.close(r));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(libDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("Tradução: checkpoint incremental (.partial.json), retomada sem duplicação de chamadas, force=1 e mtime divergente", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-trans-ckpt-data-"));
  const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-trans-ckpt-lib-"));

  const courseRel = "Curso Checkpoint";
  const lessonRel = `${courseRel}/Aula 01.mp4`;
  const courseAbs = path.join(libDir, courseRel);
  await fs.mkdir(courseAbs, { recursive: true });
  await fs.writeFile(path.join(libDir, lessonRel), Buffer.from("video"));

  let mockHandler = null;
  const mockCalls = [];
  const mockLlmPort = 45000 + Math.floor(Math.random() * 5000);
  const mockLlmServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      mockCalls.push({ url: req.url, body });
      if (mockHandler) {
        mockHandler(req, res, body);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "[]" } }] }));
      }
    });
  });

  await new Promise((r) => mockLlmServer.listen(mockLlmPort, "127.0.0.1", r));
  const srv = await startTestServer(dataDir);

  try {
    const libRes = await fetch(`${srv.base}/api/libraries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: libDir }),
    });
    const libData = await libRes.json();
    const libId = libData.id;

    // Configura o mock LLM
    await fetch(`${srv.base}/api/ai/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          providers: [
            {
              id: "mock-ckpt",
              name: "Mock Ckpt",
              type: "openai",
              baseUrl: `http://127.0.0.1:${mockLlmPort}/v1`,
              apiKey: "token",
              defaultModel: "mock-model",
            },
          ],
        },
        tutor: { providerId: "mock-ckpt", model: "mock-model" },
      }),
    });

    // Cria legenda original com 110 segmentos (3 lotes: 50 + 50 + 10)
    const hash = subtitleCacheName(libId, lessonRel);
    const sourceStat = await fs.stat(path.join(libDir, lessonRel));
    const processedDir = path.join(dataDir, "subtitles", "processed");
    await fs.mkdir(processedDir, { recursive: true });
    const originalSegments = [];
    for (let i = 0; i < 110; i++) {
      originalSegments.push({
        id: `s${i}`,
        start: i * 2,
        end: i * 2 + 1.8,
        text: `Texto original ${i}`,
      });
    }
    await fs.writeFile(
      path.join(processedDir, `${hash}.json`),
      JSON.stringify({
        version: 1,
        source: { mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
        segments: originalSegments,
        language: "pt",
      }),
    );

    // 1. Cenário: Falha no 3º lote. Lotes 1 e 2 concluem com sucesso, lote 3 falha persistentemente (500).
    mockCalls.length = 0;
    mockHandler = (req, res, body) => {
      const segs = extractSegmentsFromRequestBody(body);
      // Se for o lote 3 (iniciando em s100), falha com 500
      if (segs.length > 0 && segs[0].id === "s100") {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Internal LLM error on batch 3" } }));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(segs.map((s) => ({ id: s.id, text: `Traduzido: ${s.text}` }))),
              },
            },
          ],
        }),
      );
    };

    const failRes = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "es", libId }),
    });
    assert.strictEqual(failRes.status, 500, "Deve retornar erro 500 ao falhar no 3º lote");

    // Verifica que o arquivo .partial.json existe e possui os 100 segmentos dos 2 primeiros lotes
    const partialPath = path.join(dataDir, "subtitles", `${hash}-es.partial.json`);
    const partialStat = await fs.stat(partialPath).catch(() => null);
    assert.ok(partialStat && partialStat.size > 0, "Arquivo .partial.json deve existir após falha");
    const partialContent = JSON.parse(await fs.readFile(partialPath, "utf-8"));
    assert.strictEqual(partialContent.doneCount, 100);
    assert.strictEqual(partialContent.segments.length, 100);
    assert.strictEqual(partialContent.segments[0].id, "s0");
    assert.strictEqual(partialContent.segments[99].id, "s99");

    // Verifica que o arquivo final ainda NÃO existe
    const finalPath = path.join(dataDir, "subtitles", `${hash}-es.json`);
    assert.strictEqual(await fs.stat(finalPath).catch(() => null), null);

    // 2. Cenário: Segunda chamada SEM force retoma do 3º lote
    // Mock agora responde sucesso no lote 3
    mockCalls.length = 0;
    mockHandler = (req, res, body) => {
      const segs = extractSegmentsFromRequestBody(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(segs.map((s) => ({ id: s.id, text: `Traduzido: ${s.text}` }))),
              },
            },
          ],
        }),
      );
    };

    const resumeRes = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "es", libId }),
    });
    assert.strictEqual(resumeRes.status, 200, "Deve retornar 200 na retomada");
    const resumeData = await resumeRes.json();
    assert.strictEqual(resumeData.ok, true);
    assert.strictEqual(resumeData.resumed, true, "Deve reportar resumed: true");
    assert.strictEqual(resumeData.segments.length, 110, "Deve conter todos os 110 segmentos");

    // O mock deve ter recebido EXATAMENTE 1 chamada (para o lote 3, sem reenviar lotes 1 e 2!)
    assert.strictEqual(mockCalls.length, 1, "Não deve duplicar chamadas dos lotes 1 e 2 já traduzidos");

    // O arquivo .partial.json deve ter sido removido
    assert.strictEqual(await fs.stat(partialPath).catch(() => null), null);
    // E o arquivo final agora existe
    const finalDoc = JSON.parse(await fs.readFile(finalPath, "utf-8"));
    assert.strictEqual(finalDoc.segments.length, 110);

    // 3. Cenário: force=1 ignora/remove checkpoint existente e traduz todos os lotes do zero
    const itPartialPath = path.join(dataDir, "subtitles", `${hash}-it.partial.json`);
    await fs.writeFile(
      itPartialPath,
      JSON.stringify({
        version: 1,
        hash,
        rel: lessonRel,
        lang: "it",
        source: { mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
        doneCount: 50,
        segments: originalSegments.slice(0, 50).map((s) => ({ id: s.id, text: "Antigo" })),
        updatedAt: new Date().toISOString(),
      }),
    );

    mockCalls.length = 0;
    const forceRes = await fetch(`${srv.base}/api/subtitles/translate?force=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "it", libId }),
    });
    assert.strictEqual(forceRes.status, 200);
    // Deve ter chamado todos os 3 lotes do zero (3 chamadas)
    assert.strictEqual(mockCalls.length, 3, "force=1 deve traduzir do zero todos os 3 lotes");
    assert.strictEqual(await fs.stat(itPartialPath).catch(() => null), null);

    // 4. Cenário: Checkpoint com source.mtimeMs divergente é descartado e a tradução reinicia do zero
    const dePartialPath = path.join(dataDir, "subtitles", `${hash}-de.partial.json`);
    await fs.writeFile(
      dePartialPath,
      JSON.stringify({
        version: 1,
        hash,
        rel: lessonRel,
        lang: "de",
        source: { mtimeMs: 999999999, size: 8888 }, // divergente do sourceStat atual
        doneCount: 100,
        segments: originalSegments.slice(0, 100).map((s) => ({ id: s.id, text: "Obsoleto" })),
        updatedAt: new Date().toISOString(),
      }),
    );

    mockCalls.length = 0;
    const mtimeRes = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "de", libId }),
    });
    assert.strictEqual(mtimeRes.status, 200);
    // Deve ter recomeçado do zero e chamado os 3 lotes (3 chamadas)
    assert.strictEqual(mockCalls.length, 3, "mtime divergente deve descartar checkpoint e traduzir do zero");
    const deFinal = JSON.parse(await fs.readFile(path.join(dataDir, "subtitles", `${hash}-de.json`), "utf-8"));
    assert.strictEqual(deFinal.segments.length, 110);
  } finally {
    await srv.stop();
    await new Promise((r) => mockLlmServer.close(r));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(libDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// 5. Testes de Configuração Personalizada de Tradução (Modelo, Lote, Prompt, etc.)
// ---------------------------------------------------------------------------

test("Tradução: buildTranslatePrompt inclui diretivas adicionais quando customPrompt é fornecido", () => {
  const segments = [{ id: "s1", start: 0, end: 2.0, text: "Execute o SELECT no SQLite." }];
  const custom = "Não traduza 'SELECT' nem 'SQLite'. Mantenha jargões em inglês.";
  const prompt = buildTranslatePrompt("pt", "en", segments, custom);

  assert.ok(prompt.includes("DIRETIVAS ADICIONAIS DO USUÁRIO:"));
  assert.ok(prompt.includes("Não traduza 'SELECT' nem 'SQLite'"));
  assert.ok(prompt.includes("<segments_to_translate>"));
});

test("Tradução: sanitizeAiConfig e applyAiPatch gerenciam configuração de translation", () => {
  const {
    sanitizeAiConfig,
    applyAiPatch,
    maskAiConfig,
    defaultAiConfig,
  } = require("../server/ai/config");

  const dflt = defaultAiConfig();
  assert.ok(dflt.translation, "defaultAiConfig deve conter translation");
  assert.strictEqual(dflt.translation.enabled, true);
  assert.strictEqual(dflt.translation.batchSize, 100);
  assert.strictEqual(dflt.translation.temperature, 0.3);

  // Sanitização de valores inválidos / extremos
  const sanitized = sanitizeAiConfig({
    translation: {
      enabled: false,
      batchSize: 9999, // deve clampar para 200
      temperature: 5.0, // deve clampar para 2.0
      targetLanguage: "invalido", // deve fallback para 'pt'
      customPrompt: "x".repeat(3000), // deve clampar para 2000
    },
  });

  assert.strictEqual(sanitized.translation.enabled, false);
  assert.strictEqual(sanitized.translation.batchSize, 200);
  assert.strictEqual(sanitized.translation.temperature, 2.0);
  assert.strictEqual(sanitized.translation.targetLanguage, "pt");
  assert.strictEqual(sanitized.translation.customPrompt.length, 2000);

  // Patching com provider válido e campos customizados
  const configWithProvider = {
    ...dflt,
    llm: {
      providers: [
        { id: "custom-ai", type: "openai-compatible", name: "Custom AI", baseUrl: "http://127.0.0.1:9999/v1", apiKey: "", defaultModel: "base-model" },
      ],
    },
  };

  const patched = applyAiPatch(configWithProvider, {
    translation: {
      enabled: true,
      providerId: "custom-ai",
      model: "gemma-2-9b-it",
      batchSize: 50,
      temperature: 0.1,
      targetLanguage: "es",
      customPrompt: "Glossário técnico estrito",
    },
  });

  assert.strictEqual(patched.translation.enabled, true);
  assert.strictEqual(patched.translation.providerId, "custom-ai");
  assert.strictEqual(patched.translation.model, "gemma-2-9b-it");
  assert.strictEqual(patched.translation.batchSize, 50);
  assert.strictEqual(patched.translation.temperature, 0.1);
  assert.strictEqual(patched.translation.targetLanguage, "es");
  assert.strictEqual(patched.translation.customPrompt, "Glossário técnico estrito");

  // Provedor inexistente deve disparar erro
  assert.throws(() => {
    applyAiPatch(configWithProvider, {
      translation: { providerId: "inexistente" },
    });
  }, /Provedor de Tradução inválido/);

  // maskAiConfig deve expor translation
  const masked = maskAiConfig(patched);
  assert.ok(masked.translation);
  assert.strictEqual(masked.translation.model, "gemma-2-9b-it");
});

test("Tradução: /api/subtitles/translate honra modelo, temperatura e customPrompt configurados", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-test-trl-cfg-data-"));
  const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-test-trl-cfg-lib-"));

  const lessonRel = "Curso AI/Aula Config.mp4";
  const courseDir = path.join(libDir, "Curso AI");
  await fs.mkdir(courseDir, { recursive: true });
  await fs.writeFile(path.join(libDir, lessonRel), "dummy video");

  const originalSegments = [
    { id: "s1", start: 0, end: 3.0, text: "Utilize o framework Node.js." },
    { id: "s2", start: 3.0, end: 6.0, text: "Configure as rotas do Express." },
  ];

  const receivedBodies = [];
  const mockPort = 30000 + Math.floor(Math.random() * 15000);
  const mockLlmServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        receivedBodies.push(parsed);
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify([
                  { id: "s1", text: "Use the Node.js framework." },
                  { id: "s2", text: "Configure Express routes." },
                ]),
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise((r) => mockLlmServer.listen(mockPort, "127.0.0.1", r));

  const srv = await startTestServer(dataDir);

  try {
    const libRes = await fetch(`${srv.base}/api/libraries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: libDir }),
    });
    const libData = await libRes.json();
    const libId = libData.id;

    // Configura Provedor LLM e parâmetros de tradução customizados via POST /api/ai/config
    const cfgRes = await fetch(`${srv.base}/api/ai/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          providers: [
            {
              id: "test-custom-llm",
              type: "openai-compatible",
              name: "Test Custom LLM",
              baseUrl: `http://127.0.0.1:${mockPort}/v1`,
              defaultModel: "default-llm",
            },
          ],
        },
        translation: {
          enabled: true,
          providerId: "test-custom-llm",
          model: "my-custom-translator-model:latest",
          temperature: 0.15,
          targetLanguage: "en",
          customPrompt: "Glossário: Mantenha 'Node.js' e 'Express' com maiúsculas.",
        },
      }),
    });
    assert.strictEqual(cfgRes.status, 200);

    // Cria documento original
    const hash = subtitleCacheName(libId, lessonRel);
    const sourceStat = await fs.stat(path.join(libDir, lessonRel));
    await fs.mkdir(path.join(dataDir, "subtitles", "processed"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "subtitles", "processed", `${hash}.json`),
      JSON.stringify({
        version: 1,
        source: { mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
        language: "pt",
        segments: originalSegments,
      }),
    );

    // Consulta status de traduções
    const infoRes = await fetch(
      `${srv.base}/api/subtitles/translations?path=${encodeURIComponent(lessonRel)}&libId=${libId}`,
    );
    const info = await infoRes.json();
    assert.strictEqual(info.ok, true);
    assert.strictEqual(info.configuredModel, "my-custom-translator-model:latest");
    assert.strictEqual(info.defaultTargetLang, "en");
    assert.strictEqual(info.enabled, true);

    // Executa tradução
    const trRes = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "en", libId }),
    });
    assert.strictEqual(trRes.status, 200);

    // Valida que o LLM recebeu exatamente o modelo customizado, temperatura customizada e o prompt customizado!
    assert.strictEqual(receivedBodies.length, 1);
    const reqBody = receivedBodies[0];
    assert.strictEqual(reqBody.model, "my-custom-translator-model:latest", "LLM deve receber o modelo customizado");
    assert.strictEqual(reqBody.temperature, 0.15, "LLM deve receber a temperatura customizada");
    assert.ok(
      reqBody.messages[0].content.includes("Glossário: Mantenha 'Node.js' e 'Express'"),
      "LLM deve receber as diretivas customizadas no prompt",
    );

    // Testa desativação da tradução via Central de IA
    await fetch(`${srv.base}/api/ai/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        translation: {
          enabled: false,
        },
      }),
    });

    const disabledRes = await fetch(`${srv.base}/api/subtitles/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: lessonRel, targetLang: "es", libId, force: true }),
    });
    assert.strictEqual(disabledRes.status, 400, "Tradução desativada deve responder 400");
    const disabledJson = await disabledRes.json();
    assert.ok(disabledJson.error.includes("desativada"));
  } finally {
    await srv.stop();
    await new Promise((r) => mockLlmServer.close(r));
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(libDir, { recursive: true, force: true }).catch(() => {});
  }
});


