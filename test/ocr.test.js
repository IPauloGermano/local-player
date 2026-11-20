const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const zlib = require("node:zlib");
const http = require("node:http");

const { defaultAiConfig, sanitizeAiConfig, applyAiPatch } = require("../server/ai/config");
const { createLessonToolRuntime } = require("../server/tutor/tools");
const { scanLibrary } = require("../server/core/scan");
const { findNodeByPath } = require("../public/scope.js");
const { loadOrExtractDocument, docCacheName, courseDocCachePath } = require("../server/services/document-extractors");

// Constrói um PDF 1.4 válido contendo uma página escaneada com uma imagem bitmap embutida (XObject /Im0)
// sem nenhuma camada de texto (BT/ET), simulando fielmente um PDF escaneado real.
function buildScannedImagePdf(width = 80, height = 40) {
  const rgb = Buffer.alloc(width * height * 3, 255); // fundo branco
  // Desenha uma faixa preta no meio para não ser um retângulo vazio
  for (let y = 12; y < 28; y++) {
    for (let x = 10; x < 70; x++) {
      const idx = (y * width + x) * 3;
      rgb[idx] = 20;
      rgb[idx + 1] = 20;
      rgb[idx + 2] = 20;
    }
  }
  const compressedImg = zlib.deflateSync(rgb);
  const contentStream = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;

  const header = Buffer.from("%PDF-1.4\n", "latin1");
  const objs = [
    Buffer.from("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n", "latin1"),
    Buffer.from("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n", "latin1"),
    Buffer.from(
      `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
      "latin1",
    ),
    Buffer.concat([
      Buffer.from(
        `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressedImg.length} >>\nstream\n`,
        "latin1",
      ),
      compressedImg,
      Buffer.from("\nendstream\nendobj\n", "latin1"),
    ]),
    Buffer.from(
      `5 0 obj\n<< /Length ${Buffer.byteLength(contentStream, "latin1")} >>\nstream\n${contentStream}\nendstream\nendobj\n`,
      "latin1",
    ),
  ];

  const parts = [header];
  const offsets = [0];
  let cursor = header.length;
  for (const buf of objs) {
    offsets.push(cursor);
    parts.push(buf);
    cursor += buf.length;
  }
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

test("Fatia 3: encodeRawToPng gera PNG válido (assinatura + IHDR + IDAT + IEND) sem dependências nativas", () => {
  const ocr = require("../server/services/ocr");
  const rawRgb = Buffer.alloc(16 * 8 * 3, 200);
  const png = ocr.encodeRawToPng({ width: 16, height: 8, data: rawRgb, channels: 3 });
  assert.ok(Buffer.isBuffer(png));
  // Assinatura PNG mágica: 89 50 4E 47 0D 0A 1A 0A
  assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), 16);
  assert.equal(png.readUInt32BE(20), 8);
  assert.ok(png.includes(Buffer.from("IEND", "ascii")));
});

test("Fatia 3: extractPdfPageImage extrai imagem embutida de página escaneada via pdfjs-dist em PNG", async () => {
  const ocr = require("../server/services/ocr");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-ocr-img-"));
  try {
    const pdfPath = path.join(tmpDir, "escaneado.pdf");
    await fs.writeFile(pdfPath, buildScannedImagePdf(80, 40));

    const rendered = await ocr.extractPdfPageImage(pdfPath, 1, { skipPdftoppm: true });
    assert.ok(rendered && Buffer.isBuffer(rendered.buffer), "deve extrair buffer PNG da página escaneada");
    assert.equal(rendered.mime, "image/png");
    assert.equal(rendered.width, 80);
    assert.equal(rendered.height, 40);
    assert.deepEqual(Array.from(rendered.buffer.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 3: sanitizeOcrLanguage bloqueia flags/caracteres maliciosos e detectOcrCapabilities reporta estrutura", async () => {
  const ocr = require("../server/services/ocr");
  assert.equal(ocr.sanitizeOcrLanguage("por+eng"), "por+eng");
  assert.equal(ocr.sanitizeOcrLanguage("POR + ENG"), "por+eng");
  assert.equal(ocr.sanitizeOcrLanguage("por; rm -rf /"), "por+eng");
  assert.equal(ocr.sanitizeOcrLanguage("--psm 0"), "por+eng");

  const caps = await ocr.detectOcrCapabilities();
  assert.equal(typeof caps.tesseractCliAvailable, "boolean");
  assert.equal(typeof caps.tesseractJsAvailable, "boolean");
  assert.equal(typeof caps.pdftoppmAvailable, "boolean");
  assert.ok(Array.isArray(caps.installedLanguages));
  assert.equal(typeof caps.modelsDir, "string");
});

test("Fatia 3: ocrPdfPages executa OCR sob demanda com fila serializada, emite SSE, salva cache incremental e integra com read_document_pages", async () => {
  const ocr = require("../server/services/ocr");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-ocr-flow-"));
  try {
    const courseDir = path.join(tmpDir, "Curso_OCR");
    await fs.mkdir(courseDir, { recursive: true });
    await fs.writeFile(path.join(courseDir, "Aula01.mp4"), Buffer.alloc(32));
    const pdfPath = path.join(courseDir, "folha_escaneada.pdf");
    await fs.writeFile(pdfPath, buildScannedImagePdf(80, 40));

    const lib = { id: "lib-ocr", path: tmpDir };
    const scanned = await scanLibrary(lib);
    const tree = scanned.tree || scanned;
    const videoRel = "Curso_OCR/Aula01.mp4";
    const courseNode = findNodeByPath(tree, "Curso_OCR");

    // 1. Inicialmente detecta página 1 como needs_ocr
    const relDoc = "Curso_OCR/folha_escaneada.pdf";
    const initialDoc = await loadOrExtractDocument(pdfPath, ".pdf", { lib, relPath: relDoc });
    assert.equal(initialDoc.scanned, true);
    assert.deepEqual(initialDoc.ocrNeededPages, [1]);

    // 2. Executa via tool read_document_pages com hook onOcrPages conectado ao ocrPdfPages (runner injetado)
    let ocrCalls = 0;
    const statusEvents = [];
    const customOcrRunner = async (imageBuffer) => {
      ocrCalls++;
      assert.ok(Buffer.isBuffer(imageBuffer) && imageBuffer.length > 20);
      return { text: "Teorema de Bayes e Codigo OCR_TOKEN_31415.", engine: "mock-ocr" };
    };

    const cfg = defaultAiConfig();
    const runtime = createLessonToolRuntime({
      lib,
      tree,
      courseNode,
      videoRel,
      onOcrPages: (entry, doc, pages, opts) =>
        ocr.ocrPdfPages(entry, doc, pages, cfg, {
          ...opts,
          skipPdftoppm: true,
          customOcrRunner,
        }),
    });

    const readRes = await runtime.execute(
      "read_document_pages",
      { doc_id: "d1", start_page: 1, end_page: 1 },
      { onStatus: (ev) => statusEvents.push(ev) },
    );

    assert.equal(readRes.ok, true);
    assert.equal(ocrCalls, 1);
    assert.match(readRes.content, /OCR_TOKEN_31415/);
    assert.ok(statusEvents.some((e) => e.status === "ocr_page" && e.page === 1));

    // 3. Cache em disco foi atualizado — nova leitura não roda OCR novamente!
    const hash = docCacheName(lib.id, relDoc);
    const cacheFile = courseDocCachePath(lib, relDoc, hash);
    const persisted = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    assert.equal(persisted.pages[0].status, "text_ready");
    assert.match(persisted.pages[0].text, /OCR_TOKEN_31415/);
    assert.deepEqual(persisted.ocrNeededPages, []);

    const reloaded = await loadOrExtractDocument(pdfPath, ".pdf", { lib, relPath: relDoc });
    assert.equal(reloaded.fromCache, true);
    assert.equal(reloaded.scanned, false);
    assert.match(reloaded.pages[0].text, /OCR_TOKEN_31415/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 3: ocrImageBuffer respeita fila de concorrência=1 e cancelamento por AbortSignal", async () => {
  const ocr = require("../server/services/ocr");
  let active = 0;
  let maxActive = 0;
  const slowRunner = async (_buf, opts) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 60);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        const e = new Error("Aborted");
        e.name = "AbortError";
        reject(e);
      }, { once: true });
    });
    active--;
    return { text: "Texto OCR", engine: "mock" };
  };

  const img = ocr.encodeRawToPng({ width: 8, height: 8, data: Buffer.alloc(8 * 8 * 3, 255), channels: 3 });
  const ctrl = new AbortController();

  const p1 = ocr.ocrImageBuffer(img, { customOcrRunner: slowRunner });
  const p2 = ocr.ocrImageBuffer(img, { customOcrRunner: slowRunner, signal: ctrl.signal });
  ctrl.abort();

  const [r1, r2] = await Promise.allSettled([p1, p2]);
  assert.equal(r1.status, "fulfilled");
  assert.equal(r1.value.text, "Texto OCR");
  assert.equal(r2.status, "rejected");
  assert.equal(r2.reason.name, "AbortError");
  assert.equal(maxActive, 1, "fila OCR deve limitar concorrência a 1");
});

test("Fatia 3: config sanitiza e aplica patch para ocr.* e tutor.toolMode", () => {
  const def = defaultAiConfig();
  assert.equal(def.ocr.enabled, true);
  assert.equal(def.ocr.engine, "auto");
  assert.equal(def.ocr.language, "por+eng");

  const san = sanitizeAiConfig({
    ocr: { enabled: true, engine: "tesseract-js", language: "eng", maxPagesPerCall: 99, dpi: 50 },
  });
  assert.equal(san.ocr.engine, "tesseract-js");
  assert.equal(san.ocr.language, "eng");
  assert.equal(san.ocr.maxPagesPerCall, 5);
  assert.equal(san.ocr.dpi, 100);

  const patched = applyAiPatch(def, {
    tutor: { toolMode: "prompt" },
    ocr: { enabled: false, engine: "tesseract-cli", language: "por" },
  });
  assert.equal(patched.tutor.toolMode, "prompt");
  assert.equal(patched.ocr.enabled, false);
  assert.equal(patched.ocr.engine, "tesseract-cli");
  assert.equal(patched.ocr.language, "por");
});

function startMockHttp(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => handler(req, res, Buffer.concat(chunks)));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("Fatia 4: OCR via VLM envia imagem PNG em base64 para /chat/completions multimodal e extrai Markdown/LaTeX", async () => {
  const ocr = require("../server/services/ocr");
  let receivedBody = null;
  let receivedAuth = "";
  const mockVlm = await startMockHttp((req, res, buf) => {
    receivedAuth = req.headers.authorization || "";
    receivedBody = JSON.parse(buf.toString("utf8"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "Equação extraída: $$E = mc^2$$\n\n| Col A | Col B |\n|---|---|\n| 1 | 2 |" } }],
    }));
  });

  try {
    const cfg = defaultAiConfig();
    cfg.llm.providers = [
      { id: "vlm-local", type: "openai-compatible", name: "Ollama Vision", baseUrl: `${mockVlm.baseUrl}/v1`, apiKey: "secret-vlm", defaultModel: "qwen2.5vl" },
    ];
    cfg.ocr.engine = "vlm";
    cfg.ocr.vlmProviderId = "vlm-local";
    cfg.ocr.vlmModel = "qwen2.5vl";

    const img = ocr.encodeRawToPng({ width: 12, height: 12, data: Buffer.alloc(12 * 12 * 3, 240), channels: 3 });
    const res = await ocr.ocrImageBuffer(img, { engine: "vlm", mime: "image/png", cfg });

    assert.equal(res.engine, "vlm");
    assert.match(res.text, /E = mc\^2/);
    assert.equal(receivedAuth, "Bearer secret-vlm");
    assert.equal(receivedBody.model, "qwen2.5vl");
    const userMsg = receivedBody.messages.find((m) => m.role === "user");
    const imgPart = Array.isArray(userMsg?.content) && userMsg.content.find((p) => p.type === "image_url");
    assert.ok(imgPart && imgPart.image_url.url.startsWith("data:image/png;base64,"));

    const st = await ocr.getOcrStatus(cfg);
    assert.equal(st.vlmConfigured, true);
  } finally {
    mockVlm.server.close();
  }
});

test("Fatia 4: OCR via IBM Docling envia multipart para /v1/convert/file, extrai md_content e bloqueia URLs inseguras", async () => {
  const ocr = require("../server/services/ocr");
  let reqUrl = "";
  let reqContentType = "";
  let bodyLen = 0;
  const mockDocling = await startMockHttp((req, res, buf) => {
    reqUrl = req.url;
    reqContentType = req.headers["content-type"] || "";
    bodyLen = buf.length;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      document: { md_content: "# Relatório Docling\n\nTexto extraído com tabela preservada." },
    }));
  });

  try {
    const cfg = defaultAiConfig();
    cfg.ocr.engine = "docling";
    cfg.ocr.doclingUrl = mockDocling.baseUrl;

    const img = ocr.encodeRawToPng({ width: 12, height: 12, data: Buffer.alloc(12 * 12 * 3, 240), channels: 3 });
    const res = await ocr.ocrImageBuffer(img, { engine: "docling", mime: "image/png", cfg });

    assert.equal(res.engine, "docling");
    assert.equal(reqUrl, "/v1/convert/file");
    assert.match(reqContentType, /multipart\/form-data/i);
    assert.ok(bodyLen > img.length);
    assert.match(res.text, /Relatório Docling/);

    const st = await ocr.getOcrStatus(cfg);
    assert.equal(st.doclingConfigured, true);

    // Segurança: bloqueia protocolo inválido e IP de metadata cloud (169.254.169.254)
    const badCfg1 = { ...cfg, ocr: { ...cfg.ocr, doclingUrl: "file:///etc/passwd" } };
    await assert.rejects(() => ocr.ocrImageBuffer(img, { engine: "docling", cfg: badCfg1 }), /não permitido|inválida/i);

    const badCfg2 = { ...cfg, ocr: { ...cfg.ocr, doclingUrl: "http://169.254.169.254/latest/meta-data" } };
    await assert.rejects(() => ocr.ocrImageBuffer(img, { engine: "docling", cfg: badCfg2 }), /bloqueado|metadata|não permitido/i);
  } finally {
    mockDocling.server.close();
  }
});

test("Fatia 5: maskAiConfig preserva ocr, testDoclingConnection valida/testa e downloadTrainedData respeita whitelist", async () => {
  const { maskAiConfig } = require("../server/ai/config");
  const ocr = require("../server/services/ocr");

  const cfg = defaultAiConfig();
  cfg.ocr.engine = "vlm";
  cfg.ocr.language = "por";
  cfg.ocr.vlmModel = "qwen2.5vl";
  const masked = maskAiConfig(cfg);
  assert.ok(masked.ocr, "maskAiConfig deve expor bloco ocr");
  assert.equal(masked.ocr.engine, "vlm");
  assert.equal(masked.ocr.language, "por");
  assert.equal(masked.ocr.vlmModel, "qwen2.5vl");

  // Mock Docling (/health 404 -> fallback /docs 200) e mock tessdata_fast
  const mockSrv = await startMockHttp((req, res) => {
    if (req.url === "/health") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (req.url === "/docs") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>Docling Docs</html>");
      return;
    }
    if (req.url === "/por.traineddata") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.alloc(2048, 0x42));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-ocr-dl-"));
  try {
    const okConn = await ocr.testDoclingConnection(mockSrv.baseUrl);
    assert.equal(okConn.ok, true);
    assert.equal(okConn.status, 200);
    assert.ok(typeof okConn.latencyMs === "number");

    const badConn = await ocr.testDoclingConnection("http://169.254.169.254/latest");
    assert.equal(badConn.ok, false);
    assert.equal(badConn.invalidUrl, true);

    const dl = await ocr.downloadTrainedData("por", { baseUrl: mockSrv.baseUrl, modelsDir: tmpDir });
    assert.equal(dl.ok, true);
    assert.equal(dl.lang, "por");
    assert.equal(dl.sizeBytes, 2048);
    assert.ok(dl.installedLanguages.includes("por"));
    const saved = await fs.readFile(path.join(tmpDir, "por.traineddata"));
    assert.equal(saved.length, 2048);

    // Segurança: bloqueia idioma fora da whitelist / path traversal
    await assert.rejects(() => ocr.downloadTrainedData("../etc/passwd", { baseUrl: mockSrv.baseUrl, modelsDir: tmpDir }), /não suportado|inválido/i);
    await assert.rejects(() => ocr.downloadTrainedData("xyz", { baseUrl: mockSrv.baseUrl, modelsDir: tmpDir }), /não suportado|inválido/i);
  } finally {
    mockSrv.server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 5: rotas HTTP /api/ai/ocr/test-docling e /api/ai/ocr/download-lang validam entrada e /api/ai/config persiste toolMode e ocr", async () => {
  const express = require("express");
  const state = require("../server/state");
  const { registerAiRoutes } = require("../server/ai/routes");

  const origConfigFile = state.AI_CONFIG_FILE;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-ai-routes-"));
  state.AI_CONFIG_FILE = path.join(tmpDir, "ai-config.json");

  const mockDocling = await startMockHttp((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const app = express();
  app.use(express.json());
  registerAiRoutes(app);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const postCfg = await fetch(`${baseUrl}/api/ai/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({
        tutor: { toolMode: "prompt" },
        ocr: { enabled: true, engine: "docling", language: "por", doclingUrl: mockDocling.baseUrl },
      }),
    });
    assert.equal(postCfg.status, 200);
    const saved = await postCfg.json();
    assert.equal(saved.tutor.toolMode, "prompt");
    assert.equal(saved.ocr.engine, "docling");
    assert.equal(saved.ocr.doclingUrl, mockDocling.baseUrl);

    const getCfg = await fetch(`${baseUrl}/api/ai/config`);
    const loaded = await getCfg.json();
    assert.equal(loaded.tutor.toolMode, "prompt");
    assert.equal(loaded.ocr.engine, "docling");

    const okDoc = await fetch(`${baseUrl}/api/ai/ocr/test-docling`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ doclingUrl: mockDocling.baseUrl }),
    });
    assert.equal(okDoc.status, 200);
    const okDocData = await okDoc.json();
    assert.equal(okDocData.ok, true);

    const badDoc = await fetch(`${baseUrl}/api/ai/ocr/test-docling`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ doclingUrl: "http://169.254.169.254/latest" }),
    });
    assert.equal(badDoc.status, 400);

    const badLang = await fetch(`${baseUrl}/api/ai/ocr/download-lang`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ lang: "../../bad" }),
    });
    assert.equal(badLang.status, 400);
  } finally {
    server.close();
    mockDocling.server.close();
    state.AI_CONFIG_FILE = origConfigFile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
