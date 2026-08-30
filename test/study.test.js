const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const {
  extractAndParseJson,
  buildQuizPrompt,
  buildFlashcardsPrompt,
  sanitizeQuizResult,
  sanitizeFlashcardsResult,
} = require("../server.js");

test("Study: extractAndParseJson extrai JSON puro, em blocos markdown ou embutido em texto", () => {
  // 1. JSON puro
  const pure = '{"title": "Quiz", "questions": [{"id": 1}]}';
  assert.deepEqual(extractAndParseJson(pure), { title: "Quiz", questions: [{ id: 1 }] });

  // 2. Fenced markdown ```json
  const fenced = '```json\n{"cards": [{"front": "Q", "back": "A"}]}\n```';
  assert.deepEqual(extractAndParseJson(fenced), { cards: [{ front: "Q", back: "A" }] });

  // 3. Fenced markdown sem linguagem
  const fencedPlain = '```\n[1, 2, 3]\n```';
  assert.deepEqual(extractAndParseJson(fencedPlain), [1, 2, 3]);

  // 4. Texto antes e depois do JSON
  const withProse = 'Aqui está o seu quiz:\n{"title": "Aula 1", "questions": []}\nEspero que ajude!';
  assert.deepEqual(extractAndParseJson(withProse), { title: "Aula 1", questions: [] });

  // 5. JSON inválido ou vazio
  assert.equal(extractAndParseJson(""), null);
  assert.equal(extractAndParseJson(null), null);
  assert.equal(extractAndParseJson("Não há JSON aqui {incompleto"), null);
});

test("Study: buildQuizPrompt gera instruções estruturadas e aplica diretivas", () => {
  const prompt1 = buildQuizPrompt("Contexto da aula sobre Express e Node", 5);
  assert.ok(prompt1.includes("exatamente 5 questões"));
  assert.ok(prompt1.includes("<untrusted_lesson_context>"));
  assert.ok(prompt1.includes("correctIndex"));

  // Clamping de count (1 a 15)
  const promptMin = buildQuizPrompt("Contexto", 0);
  assert.ok(promptMin.includes("exatamente 1 questões"));

  const promptMax = buildQuizPrompt("Contexto", 50);
  assert.ok(promptMax.includes("exatamente 15 questões"));

  // Com skill Caveman ativa
  const promptCaveman = buildQuizPrompt("Contexto", 3, {
    caveman: { enabled: true, applyToTutor: true },
  });
  assert.ok(promptCaveman.includes("DIRETIVA CAVEMAN"));
});

test("Study: buildFlashcardsPrompt gera instruções estruturadas e aplica diretivas", () => {
  const prompt1 = buildFlashcardsPrompt("Contexto da aula sobre React Hooks", 8);
  assert.ok(prompt1.includes("exatamente 8 flashcards"));
  assert.ok(prompt1.includes("<untrusted_lesson_context>"));
  assert.ok(prompt1.includes("front"));
  assert.ok(prompt1.includes("back"));

  // Clamping de count (1 a 20)
  const promptMax = buildFlashcardsPrompt("Contexto", 100);
  assert.ok(promptMax.includes("exatamente 20 flashcards"));

  // Com skill Caveman ativa
  const promptCaveman = buildFlashcardsPrompt("Contexto", 4, {
    caveman: { enabled: true, applyToTutor: true },
  });
  assert.ok(promptCaveman.includes("DIRETIVA CAVEMAN"));
});

test("Study: sanitizeQuizResult valida, corrige índices e filtra opções inválidas", () => {
  const rawData = {
    title: "Quiz Teste",
    questions: [
      {
        id: 1,
        question: "O que é Node.js?",
        options: ["Runtime JS", "Linguagem", "Framework", "Banco"],
        correctIndex: 0,
        explanation: "Node.js é um runtime construído sobre a V8.",
      },
      {
        // correctIndex fora do range -> deve ser corrigido para 0
        id: 2,
        question: "Qual o gerenciador padrão?",
        options: ["npm", "yarn"],
        correctIndex: 99,
        explanation: "",
      },
      {
        // Pergunta sem texto -> deve ser ignorada
        question: "",
        options: ["A", "B"],
      },
      {
        // Menos de 2 opções -> deve ser ignorada
        question: "Pergunta descartada",
        options: ["Apenas uma"],
      },
    ],
  };

  const sanitized = sanitizeQuizResult(rawData, 10);
  assert.ok(sanitized);
  assert.equal(sanitized.title, "Quiz Teste");
  assert.equal(sanitized.questions.length, 2);

  // Questão 1
  assert.equal(sanitized.questions[0].id, 1);
  assert.equal(sanitized.questions[0].correctIndex, 0);
  assert.equal(sanitized.questions[0].options.length, 4);

  // Questão 2
  assert.equal(sanitized.questions[1].id, 2);
  assert.equal(sanitized.questions[1].correctIndex, 0); // corrigido
  assert.ok(sanitized.questions[1].explanation.length > 0);

  // Objeto inválido
  assert.equal(sanitizeQuizResult(null), null);
  assert.equal(sanitizeQuizResult({ questions: [] }), null);
});

test("Study: sanitizeFlashcardsResult valida e formata cartões", () => {
  const rawData = {
    title: "Flashcards Teste",
    cards: [
      {
        id: 1,
        front: "O que é useState?",
        back: "Hook para gerenciar estado local em componentes funcionais.",
        tag: "React",
        hint: "Permite reatividade",
      },
      {
        // Sem tag nem hint -> preenche valores padrão
        id: 2,
        front: "O que é useEffect?",
        back: "Hook para executar efeitos colaterais.",
      },
      {
        // Cartão vazio -> ignorado
        front: "",
        back: "",
      },
    ],
  };

  const sanitized = sanitizeFlashcardsResult(rawData, 10);
  assert.ok(sanitized);
  assert.equal(sanitized.title, "Flashcards Teste");
  assert.equal(sanitized.cards.length, 2);

  assert.equal(sanitized.cards[0].tag, "React");
  assert.equal(sanitized.cards[0].hint, "Permite reatividade");

  assert.equal(sanitized.cards[1].tag, "Estudo");
  assert.equal(sanitized.cards[1].hint, "");

  // Inválido
  assert.equal(sanitizeFlashcardsResult(null), null);
  assert.equal(sanitizeFlashcardsResult({ cards: [] }), null);
});

async function startTestServer(dataDir) {
  const port = 38000 + Math.floor(Math.random() * 8000);
  const proc = spawn("node", ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      LP_DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  while (Date.now() - started < 5000) {
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

test("Study: rotas HTTP /api/study/quiz e /api/study/flashcards com Mock LLM", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-study-test-data-"));
  const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-study-test-lib-"));

  // Mock server OpenAI-compatible para responder às requisições do quiz e flashcards
  let mockMode = "quiz";
  const mockLlmPort = 44000 + Math.floor(Math.random() * 5000);
  const mockLlmServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (mockMode === "quiz") {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Quiz da Aula",
                    questions: [
                      {
                        id: 1,
                        question: "O que o comando console.log faz?",
                        options: ["Imprime no terminal", "Cria um arquivo", "Deleta o banco", "Abre o navegador"],
                        correctIndex: 0,
                        explanation: "console.log imprime a saída padrão no console/terminal.",
                      },
                    ],
                  }),
                },
              },
            ],
          })
        );
      } else {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    title: "Flashcards da Aula",
                    cards: [
                      {
                        id: 1,
                        front: "console.log",
                        back: "Função para exibir mensagens no console.",
                        tag: "JavaScript",
                        hint: "Usado para debugging",
                      },
                    ],
                  }),
                },
              },
            ],
          })
        );
      }
    });
  });

  await new Promise((resolve) => mockLlmServer.listen(mockLlmPort, "127.0.0.1", resolve));
  const mockLlmUrl = `http://127.0.0.1:${mockLlmPort}/v1`;

  const srv = await startTestServer(dataDir);

  try {
    // 1. Cria mock de módulo com vídeo
    const mockCourseDir = path.join(libDir, "Modulo Estudo");
    await fs.mkdir(mockCourseDir, { recursive: true });
    const videoAbs = path.join(mockCourseDir, "01 - Aula Pratica.mp4");
    await fs.writeFile(videoAbs, "fake-video");

    // 2. Registra biblioteca
    const postLib = await fetch(`${srv.base}/api/libraries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: libDir }),
    });
    assert.strictEqual(postLib.status, 201);
    const libObj = await postLib.json();
    const libId = libObj.id;

    // 3. Configura Provedor LLM Mock
    const patchRes = await fetch(`${srv.base}/api/ai/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          providers: [
            {
              id: "mock-prov",
              name: "Mock Provider",
              type: "openai",
              baseUrl: mockLlmUrl,
              apiKey: "mock-key",
              defaultModel: "mock-model",
            },
          ],
        },
        tutor: {
          enabled: true,
          providerId: "mock-prov",
          model: "mock-model",
        },
      }),
    });
    assert.strictEqual(patchRes.status, 200);

    // 4. Testa POST /api/study/quiz
    mockMode = "quiz";
    const quizRes = await fetch(`${srv.base}/api/study/quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "Modulo Estudo/01 - Aula Pratica.mp4",
        libraryId: libId,
        count: 3,
      }),
    });
    assert.strictEqual(quizRes.status, 200);
    const quizData = await quizRes.json();
    assert.strictEqual(quizData.ok, true);
    assert.ok(quizData.quiz);
    assert.equal(quizData.quiz.questions.length, 1);
    assert.equal(quizData.quiz.questions[0].question, "O que o comando console.log faz?");

    // 5. Testa POST /api/study/flashcards
    mockMode = "flashcards";
    const fcRes = await fetch(`${srv.base}/api/study/flashcards`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "Modulo Estudo/01 - Aula Pratica.mp4",
        libraryId: libId,
        count: 5,
      }),
    });
    assert.strictEqual(fcRes.status, 200);
    const fcData = await fcRes.json();
    assert.strictEqual(fcData.ok, true);
    assert.ok(fcData.flashcards);
    assert.equal(fcData.flashcards.cards.length, 1);
    assert.equal(fcData.flashcards.cards[0].front, "console.log");
    assert.equal(fcData.flashcards.cards[0].tag, "JavaScript");
  } finally {
    await srv.stop();
    mockLlmServer.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(libDir, { recursive: true, force: true });
  }
});
