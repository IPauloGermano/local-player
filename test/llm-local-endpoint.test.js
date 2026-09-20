"use strict";

// Regressão: o botão "Testar" da Central de IA deve aceitar endpoints LLM
// locais (loopback + portas próprias como Ollama 11434, LM Studio 1234).
// Antes, /api/ai/llm/test usava o validador anti-SSRF da pesquisa web e
// rejeitava todos os presets locais com "bloqueado por segurança (SSRF)".

const test = require("node:test");
const assert = require("node:assert");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const { validateLlmEndpointUrl, validateSafeUrl } = require("../server");

const SERVER = path.join(__dirname, "..", "server.js");

function tmpDir(prefix) {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer(dataDir) {
  const basePort = 36000 + Math.floor(Math.random() * 10000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = basePort + attempt * 11;
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, LP_DATA_DIR: dataDir, PORT: String(p), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    const ready = await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        if (proc.exitCode !== null) return resolve(false);
        if (out.includes("Local Player rodando em")) return resolve(true);
        if (Date.now() - t0 > 4000) return resolve(false);
        setTimeout(poll, 40);
      };
      poll();
    });
    if (ready) {
      return {
        base: `http://127.0.0.1:${p}`,
        stop: async () => {
          proc.kill("SIGTERM");
          await new Promise((r) => proc.on("exit", r));
        },
      };
    }
    try { proc.kill("SIGKILL"); } catch {}
  }
  throw new Error("Falha ao subir servidor de teste para llm-local-endpoint");
}

// Stub mínimo de servidor OpenAI-compatible em loopback.
async function startStubLlm() {
  const srv = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return { port, stop: () => new Promise((r) => srv.close(r)) };
}

test("validateLlmEndpointUrl: aceita loopback/portas locais, rejeita o resto", async () => {
  for (const url of [
    "http://127.0.0.1:11434/v1/chat/completions",
    "http://localhost:11434/v1/chat/completions",
    "http://127.0.0.1:1234/v1/chat/completions",
    "http://192.168.1.10:8080/v1/chat/completions",
    "https://api.openai.com/v1/chat/completions",
  ]) {
    const r = await validateLlmEndpointUrl(url);
    assert.ok(r.ok, `${url} deveria ser aceito: ${r.error || ""}`);
  }
  const badScheme = await validateLlmEndpointUrl("ftp://127.0.0.1:11434/v1");
  assert.ok(!badScheme.ok, "ftp deveria ser rejeitado");
  const onion = await validateLlmEndpointUrl("http://abc.onion/v1/chat/completions");
  assert.ok(!onion.ok, ".onion deveria ser rejeitado");
  const empty = await validateLlmEndpointUrl("");
  assert.ok(!empty.ok, "URL vazia deveria ser rejeitada");
});

test("validateSafeUrl da pesquisa web continua bloqueando loopback", async () => {
  const r = await validateSafeUrl("http://localhost:11434/v1/chat/completions");
  assert.ok(!r.ok, "pesquisa web deve continuar bloqueando localhost");
  assert.match(r.error, /SSRF/);
});

test("POST /api/ai/llm/test aprova LLM local em loopback", async (t) => {
  const dataDir = tmpDir("lp-llm-test-");
  const srv = await startServer(dataDir);
  t.after(() => srv.stop());
  const stub = await startStubLlm();
  t.after(() => stub.stop());

  const res = await fetch(`${srv.base}/api/ai/llm/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${stub.port}/v1`,
      model: "stub-model",
    }),
  });
  assert.strictEqual(res.status, 200);
  const json = await res.json();
  assert.ok(json.ok, `teste contra stub local deveria passar: ${JSON.stringify(json)}`);
  assert.strictEqual(json.model, "stub-model");
});

test("POST /api/ai/llm/test rejeita esquema inválido com 400", async (t) => {
  const dataDir = tmpDir("lp-llm-test-");
  const srv = await startServer(dataDir);
  t.after(() => srv.stop());

  const res = await fetch(`${srv.base}/api/ai/llm/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
    body: JSON.stringify({ baseUrl: "ftp://127.0.0.1:11434/v1", model: "x" }),
  });
  assert.strictEqual(res.status, 400);
  const json = await res.json();
  assert.ok(json.error, "deve conter mensagem de erro");
});
