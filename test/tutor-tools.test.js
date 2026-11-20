const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");

const { scanLibrary } = require("../server/core/scan");
const { findNodeByPath } = require("../public/scope.js");
const { sanitizeAiConfig, defaultAiConfig } = require("../server/ai/config");

function buildValidPdf(pageTexts) {
  const escapePdf = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [];
  const pageIds = pageTexts.map((_, i) => 4 + i * 2);
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  for (let i = 0; i < pageTexts.length; i++) {
    const pageObjId = 4 + i * 2;
    const contentObjId = pageObjId + 1;
    const txt = pageTexts[i] || "";
    const stream = txt ? `BT /F1 12 Tf 72 720 Td (${escapePdf(txt)}) Tj ET` : "";
    objects.push(`${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`);
    objects.push(`${contentObjId} 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function createMockSseRes() {
  const chunks = [];
  let ended = false;
  return {
    headersSent: true,
    write(chunk) { chunks.push(String(chunk)); },
    end() { ended = true; },
    get ended() { return ended; },
    get raw() { return chunks.join(""); },
    events() {
      return chunks
        .join("")
        .split("\n\n")
        .map((b) => b.trim())
        .filter((b) => b.startsWith("data:"))
        .map((b) => b.slice(5).trim())
        .filter((s) => s && s !== "[DONE]")
        .map((s) => JSON.parse(s));
    },
  };
}

function startMockLlm(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(body || "{}"); } catch {}
        handler(req, res, parsed);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      });
    });
  });
}

test("Fatia 2: createLessonToolRuntime lista materiais com doc_id opaco, busca/lê páginas e bloqueia path traversal", async () => {
  const { createLessonToolRuntime } = require("../server/tutor/tools");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-tools-"));
  try {
    const courseDir = path.join(tmpDir, "Curso_Tools");
    await fs.mkdir(courseDir, { recursive: true });
    await fs.writeFile(path.join(courseDir, "Aula01.mp4"), Buffer.alloc(32));
    await fs.writeFile(
      path.join(courseDir, "apostila.pdf"),
      buildValidPdf([
        "Pagina 1: Visao geral do curso de compiladores.",
        "Pagina 2: Analise sintatica descendente recursiva e codigo COMP-9042.",
        "",
      ]),
    );

    const lib = { id: "lib-tools", path: tmpDir };
    const scanned = await scanLibrary(lib);
    const tree = scanned.tree || scanned;
    const videoRel = "Curso_Tools/Aula01.mp4";
    const courseNode = findNodeByPath(tree, "Curso_Tools");

    const runtime = createLessonToolRuntime({ lib, tree, courseNode, videoRel });
    assert.equal(runtime.hasMaterials, true);

    const listRes = await runtime.execute("list_lesson_materials", {});
    assert.equal(listRes.ok, true);
    assert.match(listRes.content, /"doc_id":\s*"d1"/);
    assert.match(listRes.content, /apostila\.pdf/);
    assert.doesNotMatch(listRes.content, new RegExp(tmpDir.replace(/\\/g, "\\\\")), "nunca expõe path absoluto no retorno da tool");

    const searchRes = await runtime.execute("search_document", { doc_id: "d1", query: "COMP-9042" });
    assert.equal(searchRes.ok, true);
    assert.match(searchRes.content, /"page":\s*2/);
    assert.match(searchRes.content, /COMP-9042/);

    const readRes = await runtime.execute("read_document_pages", { doc_id: "d1", start_page: 2, end_page: 3 });
    assert.equal(readRes.ok, true);
    assert.match(readRes.content, /<untrusted_document_content/);
    assert.match(readRes.content, /COMP-9042/);
    assert.match(readRes.content, /needs_ocr|requer OCR/i);

    // Tentativas de path traversal / doc_id inválido são bloqueadas
    for (const badId of ["../package.json", "/etc/passwd", "C:\\Windows\\win.ini", "d99", ""]) {
      const bad = await runtime.execute("read_document_pages", { doc_id: badId, start_page: 1 });
      assert.equal(bad.ok, false, `deve rejeitar doc_id inválido: ${badId}`);
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 2: extractPromptToolCall e createPromptStreamFilter parseiam <lp_tool_call> sem vazar JSON no stream", () => {
  const { extractPromptToolCall, createPromptStreamFilter } = require("../server/tutor/agent-loop");

  const parsed1 = extractPromptToolCall(
    'Vou verificar o documento.\n<lp_tool_call>{"name":"read_document_pages","arguments":{"doc_id":"d1","start_page":2,"end_page":4}}</lp_tool_call>',
  );
  assert.deepEqual(parsed1, {
    name: "read_document_pages",
    arguments: { doc_id: "d1", start_page: 2, end_page: 4 },
  });

  // Sem tag de fechamento (cortada por stop sequence)
  const parsed2 = extractPromptToolCall(
    '<lp_tool_call>{"name":"list_lesson_materials","arguments":{}}',
  );
  assert.deepEqual(parsed2, { name: "list_lesson_materials", arguments: {} });

  // Filtro de stream: não vaza <lp_tool_call> para o usuário
  let emitted = "";
  const filter = createPromptStreamFilter((txt) => { emitted += txt; });
  for (const ch of ["Ol", "á! ", "<lp_", "tool_call>", '{"name":"list_lesson_materials","arguments":{}}', "</lp_tool_call>"]) {
    filter.push(ch);
  }
  const rest = filter.finish();
  assert.equal(emitted, "Olá! ");
  assert.equal(filter.detectedToolTag, true);
  assert.match(rest, /list_lesson_materials/);

  // Texto normal sem tool flui integralmente
  let plain = "";
  const filter2 = createPromptStreamFilter((txt) => { plain += txt; });
  filter2.push("A resposta é 2 < 3 e pronto.");
  filter2.finish();
  assert.equal(plain, "A resposta é 2 < 3 e pronto.");
  assert.equal(filter2.detectedToolTag, false);
});

test("Fatia 2: agent-loop executa tool calling NATIVO (streaming delta.tool_calls) e retorna resposta final", async () => {
  const { createLessonToolRuntime } = require("../server/tutor/tools");
  const { runTutorAgentLoop } = require("../server/tutor/agent-loop");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-agent-native-"));
  const requests = [];
  const mockLlm = await startMockLlm((req, res, body) => {
    requests.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (requests.length === 1) {
      // Turno 1: emite tool_call fragmentado em SSE
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_document_pages", arguments: '{"doc_id":"d1",' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"start_page":2,"end_page":2}' } }] }, finish_reason: "tool_calls" }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    // Turno 2: verifica que recebeu o resultado da tool e responde
    const toolMsg = body.messages.find((m) => m.role === "tool");
    const hasToken = toolMsg && toolMsg.content.includes("TOKEN_NATIVO_777");
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: hasToken ? "O código na página 2 é TOKEN_NATIVO_777." : "Não encontrei." } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });

  try {
    const courseDir = path.join(tmpDir, "Curso_Nat");
    await fs.mkdir(courseDir, { recursive: true });
    await fs.writeFile(path.join(courseDir, "Aula.mp4"), Buffer.alloc(32));
    await fs.writeFile(path.join(courseDir, "doc.pdf"), buildValidPdf(["Capa da apostila", "Conteudo secreto: TOKEN_NATIVO_777"]));

    const lib = { id: "lib-nat", path: tmpDir };
    const scanned = await scanLibrary(lib);
    const tree = scanned.tree || scanned;
    const runtime = createLessonToolRuntime({ lib, tree, courseNode: findNodeByPath(tree, "Curso_Nat"), videoRel: "Curso_Nat/Aula.mp4" });

    const sseRes = createMockSseRes();
    await runTutorAgentLoop({
      provider: { id: "mock-native", type: "openai-compatible", baseUrl: mockLlm.baseUrl, apiKey: "" },
      model: "gpt-4o-mini",
      temperature: 0.2,
      systemPrompt: "Você é o tutor.",
      messages: [{ role: "user", content: "Qual é o código da página 2?" }],
      toolRuntime: runtime,
      toolMode: "native",
      stream: true,
      res: sseRes,
      timeoutMs: 10000,
    });

    assert.equal(requests.length, 2);
    assert.ok(Array.isArray(requests[0].tools) && requests[0].tools.length >= 3);
    const events = sseRes.events();
    assert.ok(events.some((e) => e.status === "tool_call" && e.tool === "read_document_pages"));
    const finalText = events.filter((e) => e.content).map((e) => e.content).join("");
    assert.match(finalText, /TOKEN_NATIVO_777/);
  } finally {
    mockLlm.server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 2: agent-loop em modo AUTO faz fallback automático para PROMPT quando modelo rejeita tools e guarda em cache", async () => {
  const { createLessonToolRuntime } = require("../server/tutor/tools");
  const { runTutorAgentLoop, modelToolSupportCache } = require("../server/tutor/agent-loop");
  modelToolSupportCache.clear();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-agent-fallback-"));
  const requests = [];
  const mockLlm = await startMockLlm((req, res, body) => {
    requests.push(body);
    // Simula Ollama/LM Studio com modelo sem suporte nativo a tools
    if (body.tools) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "registry.ollama.ai/library/llama3:8b does not support tools" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const hasToolResult = body.messages.some((m) => typeof m.content === "string" && m.content.includes("TOKEN_FALLBACK_555"));
    if (!hasToolResult) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '<lp_tool_call>{"name":"read_document_pages","arguments":{"doc_id":"d1","start_page":2,"end_page":2}}</lp_tool_call>' } }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Encontrei no PDF: TOKEN_FALLBACK_555." } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });

  try {
    const courseDir = path.join(tmpDir, "Curso_Fb");
    await fs.mkdir(courseDir, { recursive: true });
    await fs.writeFile(path.join(courseDir, "Aula.mp4"), Buffer.alloc(32));
    await fs.writeFile(path.join(courseDir, "guia.pdf"), buildValidPdf(["Pagina inicial do guia", "Valor importante: TOKEN_FALLBACK_555"]));

    const lib = { id: "lib-fb", path: tmpDir };
    const scanned = await scanLibrary(lib);
    const tree = scanned.tree || scanned;
    const runtime = createLessonToolRuntime({ lib, tree, courseNode: findNodeByPath(tree, "Curso_Fb"), videoRel: "Curso_Fb/Aula.mp4" });

    const provider = { id: "ollama-local", type: "openai-compatible", baseUrl: mockLlm.baseUrl, apiKey: "" };
    const sseRes = createMockSseRes();
    const out1 = await runTutorAgentLoop({
      provider,
      model: "llama3:8b",
      temperature: 0.2,
      systemPrompt: "Você é o tutor.",
      messages: [{ role: "user", content: "Qual o valor da página 2?" }],
      toolRuntime: runtime,
      toolMode: "auto",
      stream: true,
      res: sseRes,
      timeoutMs: 10000,
    });

    assert.equal(out1.effectiveMode, "prompt");
    // 1ª req (native 400) + 2ª req (prompt emite tool) + 3ª req (prompt responde com resultado)
    assert.equal(requests.length, 3);
    const finalText = sseRes.events().filter((e) => e.content).map((e) => e.content).join("");
    assert.match(finalText, /TOKEN_FALLBACK_555/);
    assert.doesNotMatch(finalText, /<lp_tool_call>/, "nunca deve vazar tag de tool no stream final");

    // 2ª chamada com mesmo provider+model deve usar cache e ir direto em modo prompt (sem tentar native 400!)
    const prevCount = requests.length;
    const sseRes2 = createMockSseRes();
    await runTutorAgentLoop({
      provider,
      model: "llama3:8b",
      temperature: 0.2,
      systemPrompt: "Você é o tutor.",
      messages: [{ role: "user", content: "Leia de novo a página 2" }],
      toolRuntime: runtime,
      toolMode: "auto",
      stream: true,
      res: sseRes2,
      timeoutMs: 10000,
    });
    const newReqs = requests.slice(prevCount);
    assert.ok(newReqs.every((r) => !r.tools), "cache deve evitar nova tentativa nativa que falha");
  } finally {
    mockLlm.server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 2: agent-loop limita maxSteps e evita loop infinito de tool calling", async () => {
  const { createLessonToolRuntime } = require("../server/tutor/tools");
  const { runTutorAgentLoop } = require("../server/tutor/agent-loop");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-agent-cap-"));
  let calls = 0;
  const mockLlm = await startMockLlm((req, res, body) => {
    calls++;
    res.writeHead(200, { "Content-Type": "application/json" });
    if (body.tools) {
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{ id: `c_${calls}`, type: "function", function: { name: "list_lesson_materials", arguments: "{}" } }],
          },
          finish_reason: "tool_calls",
        }],
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Resposta final forcada no ultimo passo." }, finish_reason: "stop" }],
    }));
  });

  try {
    const courseDir = path.join(tmpDir, "Curso_Cap");
    await fs.mkdir(courseDir, { recursive: true });
    await fs.writeFile(path.join(courseDir, "Aula.mp4"), Buffer.alloc(32));
    await fs.writeFile(path.join(courseDir, "nota.txt"), "Conteudo simples da aula.");

    const lib = { id: "lib-cap", path: tmpDir };
    const scanned = await scanLibrary(lib);
    const tree = scanned.tree || scanned;
    const runtime = createLessonToolRuntime({ lib, tree, courseNode: findNodeByPath(tree, "Curso_Cap"), videoRel: "Curso_Cap/Aula.mp4" });

    const out = await runTutorAgentLoop({
      provider: { id: "mock-loop", type: "openai-compatible", baseUrl: mockLlm.baseUrl, apiKey: "" },
      model: "gpt-test",
      temperature: 0.2,
      systemPrompt: "Tutor",
      messages: [{ role: "user", content: "Explique" }],
      toolRuntime: runtime,
      toolMode: "native",
      maxSteps: 2,
      stream: false,
      timeoutMs: 10000,
    });

    assert.equal(calls, 3, "2 passos com tool + 1 passo final sem tools");
    assert.match(out.content, /Resposta final forcada/);
  } finally {
    mockLlm.server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 2: config sanitiza tutor.toolMode e frontend trata eventos SSE tool_call e ocr_page", () => {
  const def = defaultAiConfig();
  assert.equal(def.tutor.toolMode, "auto");
  assert.equal(sanitizeAiConfig({ tutor: { toolMode: "prompt" } }).tutor.toolMode, "prompt");
  assert.equal(sanitizeAiConfig({ tutor: { toolMode: "invalid" } }).tutor.toolMode, "auto");

  const frontendTutor = fsSync.readFileSync(path.join(__dirname, "..", "public", "js", "tutor.js"), "utf8");
  assert.match(frontendTutor, /parsed\.status\s*===\s*["']tool_call["']/);
  assert.match(frontendTutor, /parsed\.status\s*===\s*["']ocr_page["']/);
});
