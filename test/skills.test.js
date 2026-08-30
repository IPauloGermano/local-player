const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");

const {
  defaultAiConfig,
  sanitizeAiConfig,
  applyAiPatch,
  maskAiConfig,
  applyCavemanDirectives,
  applyRtkMaterialFiltering,
  applyHeadroomContextCompression,
  buildTutorSystemPrompt,
} = require("../server.js");

test("Skills: defaultAiConfig contém estrutura válida para Caveman, RTK e Headroom", () => {
  const cfg = defaultAiConfig();
  assert.ok(cfg.skills, "skills deve estar presente");
  assert.equal(typeof cfg.skills, "object");

  // Caveman
  assert.equal(cfg.skills.caveman.enabled, false);
  assert.equal(cfg.skills.caveman.mode, "caveman");
  assert.equal(cfg.skills.caveman.preserveCode, true);
  assert.equal(cfg.skills.caveman.applyToTutor, true);

  // RTK
  assert.equal(cfg.skills.rtk.enabled, false);
  assert.equal(cfg.skills.rtk.stripBoilerplate, true);
  assert.equal(cfg.skills.rtk.filterLogs, true);
  assert.equal(cfg.skills.rtk.maxLinesPerSnippet, 60);
  assert.equal(cfg.skills.rtk.applyToMaterials, true);

  // Headroom
  assert.equal(cfg.skills.headroom.enabled, false);
  assert.equal(cfg.skills.headroom.compressCode, true);
  assert.equal(cfg.skills.headroom.compressJson, true);
  assert.equal(cfg.skills.headroom.alignCache, true);
  assert.equal(cfg.skills.headroom.applyToContext, true);
});

test("Skills: sanitizeAiConfig valida e corrige entradas de skills", () => {
  const sanitized = sanitizeAiConfig({
    skills: {
      caveman: {
        enabled: true,
        mode: "invalid_mode",
        preserveCode: false,
        customInstructions: "A".repeat(5000), // Deve ser truncado para 2000
      },
      rtk: {
        enabled: true,
        maxLinesPerSnippet: 9999, // Deve ser limitado a 500
      },
      headroom: {
        enabled: true,
        compressJson: false,
      },
    },
  });

  assert.equal(sanitized.skills.caveman.enabled, true);
  assert.equal(sanitized.skills.caveman.mode, "caveman"); // fallback para valor válido
  assert.equal(sanitized.skills.caveman.preserveCode, false);
  assert.equal(sanitized.skills.caveman.customInstructions.length, 2000);

  assert.equal(sanitized.skills.rtk.enabled, true);
  assert.equal(sanitized.skills.rtk.maxLinesPerSnippet, 500);

  assert.equal(sanitized.skills.headroom.enabled, true);
  assert.equal(sanitized.skills.headroom.compressJson, false);
});

test("Skills: applyAiPatch aplica merges parciais com segurança", () => {
  const base = defaultAiConfig();
  const patched = applyAiPatch(base, {
    skills: {
      caveman: { enabled: true, mode: "concise" },
      rtk: { enabled: true, maxLinesPerSnippet: 40 },
      headroom: { enabled: true },
    },
  });

  assert.equal(patched.skills.caveman.enabled, true);
  assert.equal(patched.skills.caveman.mode, "concise");
  assert.equal(patched.skills.caveman.preserveCode, true); // manteve o padrão

  assert.equal(patched.skills.rtk.enabled, true);
  assert.equal(patched.skills.rtk.maxLinesPerSnippet, 40);
  assert.equal(patched.skills.rtk.filterLogs, true); // manteve o padrão

  assert.equal(patched.skills.headroom.enabled, true);
  assert.equal(patched.skills.headroom.compressCode, true); // manteve o padrão
});

test("Skills: maskAiConfig serializa skills perfeitamente", () => {
  const cfg = defaultAiConfig();
  cfg.skills.caveman.enabled = true;
  cfg.skills.caveman.mode = "custom";
  cfg.skills.caveman.customInstructions = "Responda em poucas palavras.";

  const masked = maskAiConfig(cfg);
  assert.ok(masked.skills);
  assert.equal(masked.skills.caveman.enabled, true);
  assert.equal(masked.skills.caveman.mode, "custom");
  assert.equal(masked.skills.caveman.customInstructions, "Responda em poucas palavras.");
});

test("Skill Caveman: applyCavemanDirectives injeta regras de redução de tokens", () => {
  const initialPrompt = "Você é um tutor.";

  // Desabilitado -> retorna inalterado
  assert.equal(applyCavemanDirectives(initialPrompt, { enabled: false }), initialPrompt);

  // Modo caveman
  const cv1 = applyCavemanDirectives(initialPrompt, { enabled: true, mode: "caveman", preserveCode: true });
  assert.ok(cv1.includes("DIRETIVA SKILL CAVEMAN ATIVA"));
  assert.ok(cv1.includes("ultra-conciso"));
  assert.ok(cv1.includes("CÓDIGOS, COMANDOS E TERMOS TÉCNICOS"));

  // Modo concise
  const cv2 = applyCavemanDirectives(initialPrompt, { enabled: true, mode: "concise", preserveCode: false });
  assert.ok(cv2.includes("MODO CONCISO ATIVA"));
  assert.ok(!cv2.includes("CÓDIGOS, COMANDOS"));

  // Modo custom
  const cv3 = applyCavemanDirectives(initialPrompt, { enabled: true, mode: "custom", customInstructions: "Apenas JSON." });
  assert.ok(cv3.includes("Apenas JSON."));

  // Integração com buildTutorSystemPrompt
  const fullPrompt = buildTutorSystemPrompt("Contexto de teste", "", {
    caveman: { enabled: true, mode: "caveman", preserveCode: true, applyToTutor: true },
  });
  assert.ok(fullPrompt.includes("DIRETIVA SKILL CAVEMAN ATIVA"));
  assert.ok(fullPrompt.includes("<untrusted_lesson_context>"));
});

test("Skill RTK: applyRtkMaterialFiltering remove divisores, logs ruidosos e trunca trechos excessivos", () => {
  // 1. Divisores repetitivos
  const rawText = [
    "Título",
    "====================",
    "====================",
    "====================",
    "Conteúdo importante",
    "--------------------",
    "--------------------",
    "Fim",
  ].join("\n");

  const cleaned = applyRtkMaterialFiltering(rawText, ".txt", {
    enabled: true,
    stripBoilerplate: true,
    filterLogs: false,
    maxLinesPerSnippet: 60,
  });

  const lines = cleaned.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("===")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("---")).length, 1);

  // 2. Logs ruidosos
  const logText = [
    "Iniciando build...",
    "npm info downloading pkg-1",
    "npm info downloading pkg-2",
    "npm info downloading pkg-3",
    "npm info downloading pkg-4",
    "npm info downloading pkg-5",
    "npm info downloading pkg-6",
    "Build concluído com sucesso.",
  ].join("\n");

  const filteredLog = applyRtkMaterialFiltering(logText, ".log", {
    enabled: true,
    stripBoilerplate: true,
    filterLogs: true,
    maxLinesPerSnippet: 60,
  });

  assert.ok(filteredLog.includes("[RTK: logs repetitivos suprimidos]"));
  assert.ok(filteredLog.includes("Build concluído com sucesso."));

  // 3. Limite de linhas
  const longText = Array.from({ length: 100 }, (_, i) => `Linha ${i + 1}`).join("\n");
  const truncated = applyRtkMaterialFiltering(longText, ".txt", {
    enabled: true,
    stripBoilerplate: false,
    filterLogs: false,
    maxLinesPerSnippet: 20,
  });

  assert.ok(truncated.includes("[RTK: 80 linhas intermediárias suprimidas para economia de tokens]"));
  assert.ok(truncated.includes("Linha 1"));
  assert.ok(truncated.includes("Linha 100"));
});

test("Skill Headroom: applyHeadroomContextCompression minifica JSON e comprime código", () => {
  // 1. SmartCrusher para JSON
  const rawJson = JSON.stringify({ a: 1, b: [1, 2, 3], c: { d: "texto com espaços" } }, null, 4);
  const minified = applyHeadroomContextCompression(rawJson, ".json", {
    enabled: true,
    compressJson: true,
    compressCode: false,
  });
  assert.equal(minified, '{"a":1,"b":[1,2,3],"c":{"d":"texto com espaços"}}');

  // 2. CodeCompressor para código
  const rawCode = "function test() {\n\n\n\n  console.log('hi');   \n\n\n}\n";
  const compressed = applyHeadroomContextCompression(rawCode, ".js", {
    enabled: true,
    compressJson: false,
    compressCode: true,
  });
  assert.ok(!compressed.includes("\n\n\n"));
  assert.ok(!compressed.includes(";   \n"));
});

async function startTestServer(dataDir) {
  const port = 39000 + Math.floor(Math.random() * 8000);
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

test("Tutor IA: funciona com modelo local (Ollama/LM Studio sem chave de API)", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-local-llm-data-"));
  const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-local-llm-lib-"));

  // Mock server local (simulando Ollama em http://127.0.0.1:11434/v1 sem Authorization)
  let receivedAuth = null;
  let receivedMessages = null;
  const mockLocalServer = http.createServer((req, res) => {
    receivedAuth = req.headers["authorization"] || null;
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        receivedMessages = j.messages;
      } catch {}

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Resposta do modelo local Ollama." } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  const localPort = 45000 + Math.floor(Math.random() * 4000);
  await new Promise((resolve) => mockLocalServer.listen(localPort, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${localPort}/v1`;

  const srv = await startTestServer(dataDir);

  try {
    // Cria pasta e vídeo na biblioteca
    const mockModDir = path.join(libDir, "Modulo Local");
    await fs.mkdir(mockModDir, { recursive: true });
    const videoAbs = path.join(mockModDir, "01 - Aula Local.mp4");
    await fs.writeFile(videoAbs, "fake-video");

    // Cadastra biblioteca
    const postLib = await fetch(`${srv.base}/api/libraries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: libDir }),
    });
    const libObj = await postLib.json();
    const libId = libObj.id;

    // Configura provedor local Ollama SEM chave de API e habilita a skill Caveman
    const patchRes = await fetch(`${srv.base}/api/ai/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        llm: {
          providers: [
            {
              id: "ollama-local",
              name: "Ollama Local",
              type: "openai-compatible",
              baseUrl: localUrl,
              apiKey: "", // sem chave de API
              defaultModel: "llama3.2",
            },
          ],
        },
        tutor: {
          enabled: true,
          providerId: "ollama-local",
          model: "llama3.2",
        },
        skills: {
          caveman: {
            enabled: true,
            mode: "caveman",
            applyToTutor: true,
          },
        },
      }),
    });
    assert.strictEqual(patchRes.status, 200);

    // Envia mensagem no Tutor IA
    const chatRes = await fetch(`${srv.base}/api/tutor/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "Modulo Local/01 - Aula Local.mp4",
        libraryId: libId,
        messages: [{ role: "user", content: "Explique como rodar modelos locais." }],
        stream: true,
      }),
    });

    assert.strictEqual(chatRes.status, 200);
    const text = await chatRes.text();
    assert.ok(text.includes("Resposta do modelo local Ollama."));

    // Verifica que não foi enviado header de autorização inválido
    assert.strictEqual(receivedAuth, null);

    // Verifica que a skill Caveman foi aplicada ao system prompt enviado ao modelo local
    const systemMsg = receivedMessages?.find((m) => m.role === "system");
    assert.ok(systemMsg);
    assert.ok(systemMsg.content.includes("DIRETIVA SKILL CAVEMAN ATIVA"));
  } finally {
    await srv.stop();
    mockLocalServer.close();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(libDir, { recursive: true, force: true });
  }
});
