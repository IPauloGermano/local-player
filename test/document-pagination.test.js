const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const docExtractors = require("../server/services/document-extractors");
const { buildLessonTutorContext } = require("../server/tutor/context");
const { defaultAiConfig } = require("../server/ai/config");
const { scanLibrary } = require("../server/core/scan");
const { findNodeByPath } = require("../public/scope.js");

// Constrói um PDF 1.4 válido (com xref e startxref corretos) aceito pelo pdfjs-dist e pdftotext.
// Cada entrada de `pageTexts` é uma string (ou "" para simular página escaneada sem camada de texto).
function buildValidPdf(pageTexts) {
  const escapePdf = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [];
  // 1: Catalog, 2: Pages, 3: Font Helvetica
  const pageIds = [];
  const baseObjId = 4;
  for (let i = 0; i < pageTexts.length; i++) {
    pageIds.push(baseObjId + i * 2);
  }
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>\nendobj\n`);
  objects.push(`3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  for (let i = 0; i < pageTexts.length; i++) {
    const pageObjId = baseObjId + i * 2;
    const contentObjId = pageObjId + 1;
    const txt = pageTexts[i] || "";
    const stream = txt ? `BT /F1 12 Tf 72 720 Td (${escapePdf(txt)}) Tj ET` : "";
    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjId} 0 R >>\nendobj\n`,
    );
    objects.push(
      `${contentObjId} 0 obj\n<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
  }

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += obj;
  }
  const xrefPos = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

test("Fatia 1: extractPdfPages extrai páginas individualmente e detecta páginas escaneadas em PDF misto", async () => {
  assert.equal(typeof docExtractors.extractPdfPages, "function", "extractPdfPages deve ser exportado");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-doc-pages-"));
  try {
    const mixedPdfPath = path.join(tmpDir, "apostila_mista.pdf");
    await fs.writeFile(
      mixedPdfPath,
      buildValidPdf([
        "Capitulo 1: Introducao a Sistemas Distribuidos e Consenso",
        "", // Página 2 escaneada (sem texto)
        "Capitulo 2: Protocolo Raft e Replicacao de Logs",
      ]),
    );

    const res = await docExtractors.extractPdfPages(mixedPdfPath);
    assert.equal(res.invalid, false);
    assert.equal(res.pageCount, 3);
    assert.equal(res.pages.length, 3);
    assert.equal(res.pages[0].page, 1);
    assert.equal(res.pages[0].status, "text_ready");
    assert.match(res.pages[0].text, /Sistemas Distribuidos/);

    assert.equal(res.pages[1].page, 2);
    assert.equal(res.pages[1].status, "needs_ocr");

    assert.equal(res.pages[2].page, 3);
    assert.equal(res.pages[2].status, "text_ready");
    assert.match(res.pages[2].text, /Protocolo Raft/);

    assert.deepEqual(res.ocrNeededPages, [2]);
    assert.equal(res.scanned, false);

    // PDF 100% escaneado
    const scannedPath = path.join(tmpDir, "apenas_imagens.pdf");
    await fs.writeFile(scannedPath, buildValidPdf(["", ""]));
    const scannedRes = await docExtractors.extractPdfPages(scannedPath);
    assert.equal(scannedRes.pageCount, 2);
    assert.equal(scannedRes.scanned, true);
    assert.deepEqual(scannedRes.ocrNeededPages, [1, 2]);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 1: loadOrExtractDocument persiste cache atômico em .courseplayer/docs e invalida ao alterar arquivo", async () => {
  assert.equal(typeof docExtractors.loadOrExtractDocument, "function", "loadOrExtractDocument deve ser exportado");
  assert.equal(typeof docExtractors.courseDocCachePath, "function", "courseDocCachePath deve ser exportado");
  assert.equal(typeof docExtractors.docCacheName, "function", "docCacheName deve ser exportado");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-doc-cache-"));
  try {
    const courseDir = path.join(tmpDir, "Curso_Cache");
    await fs.mkdir(courseDir, { recursive: true });
    const pdfPath = path.join(courseDir, "manual.pdf");
    await fs.writeFile(pdfPath, buildValidPdf(["Conteudo original da pagina um do manual"]));

    const lib = { id: "lib-cache", path: tmpDir };
    const relPath = "Curso_Cache/manual.pdf";

    // 1ª chamada: extrai e grava cache atômico
    const first = await docExtractors.loadOrExtractDocument(pdfPath, ".pdf", { lib, relPath });
    assert.equal(first.fromCache, false);
    assert.equal(first.pageCount, 1);
    assert.match(first.pages[0].text, /Conteudo original/);

    const hash = docExtractors.docCacheName(lib.id, relPath);
    const cacheFile = docExtractors.courseDocCachePath(lib, relPath, hash);
    const rawCache = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    assert.equal(rawCache.version, docExtractors.DOC_CACHE_VERSION);
    assert.equal(rawCache.pageCount, 1);

    // Marca sentinela no cache para comprovar hit na 2ª leitura sem reprocessar o PDF
    rawCache.pages[0].text = "SENTINELA_DO_CACHE_HIT";
    await fs.writeFile(cacheFile, JSON.stringify(rawCache), "utf8");

    const second = await docExtractors.loadOrExtractDocument(pdfPath, ".pdf", { lib, relPath });
    assert.equal(second.fromCache, true);
    assert.equal(second.pages[0].text, "SENTINELA_DO_CACHE_HIT");

    // Modifica o PDF (tamanho/mtime diferente) -> cache deve ser invalidado automaticamente
    await fs.writeFile(
      pdfPath,
      buildValidPdf([
        "Nova versao atualizada da pagina um",
        "Segunda pagina adicionada na revisao",
      ]),
    );
    const futureTime = new Date(Date.now() + 5000);
    await fs.utimes(pdfPath, futureTime, futureTime);

    const third = await docExtractors.loadOrExtractDocument(pdfPath, ".pdf", { lib, relPath });
    assert.equal(third.fromCache, false);
    assert.equal(third.pageCount, 2);
    assert.match(third.pages[1].text, /Segunda pagina adicionada/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Fatia 1: searchDocumentPages e readDocumentPagesRange respeitam paginação e limites", () => {
  assert.equal(typeof docExtractors.searchDocumentPages, "function");
  assert.equal(typeof docExtractors.readDocumentPagesRange, "function");

  const doc = {
    name: "guia.pdf",
    pageCount: 8,
    pages: Array.from({ length: 8 }, (_, idx) => ({
      page: idx + 1,
      status: idx === 3 ? "needs_ocr" : "text_ready",
      source: idx === 3 ? null : "pdfjs",
      text: idx === 5
        ? "O algoritmo de Dijkstra calcula caminhos minimos em grafos com pesos positivos."
        : `Conteudo generico da pagina ${idx + 1}.`,
      chars: 40,
    })),
  };

  const hits = docExtractors.searchDocumentPages(doc, "algoritmo Dijkstra grafos", 3);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].page, 6);
  assert.match(hits[0].snippet, /Dijkstra/);

  // Intervalo maior que 5 páginas deve ser limitado a no máximo 5 páginas por chamada
  const range = docExtractors.readDocumentPagesRange(doc, 1, 8, { maxPages: 5, maxChars: 12000 });
  assert.equal(range.startPage, 1);
  assert.equal(range.endPage, 5);
  assert.equal(range.clampedByPageLimit, true);
  assert.equal(range.pages.length, 5);
  assert.deepEqual(range.ocrNeededPages, [4]);
});

test("Fatia 1: buildLessonTutorContext descobre PDFs em subpasta 'materiais' dentro do módulo da aula e expõe metadados paginados", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lp-mod-mat-"));
  try {
    const modDir = path.join(tmpDir, "Curso_Mod", "Modulo 02");
    const matDir = path.join(modDir, "materiais");
    await fs.mkdir(matDir, { recursive: true });

    await fs.writeFile(path.join(modDir, "Aula 01.mp4"), Buffer.alloc(64));
    await fs.writeFile(
      path.join(matDir, "slides_modulo2.pdf"),
      buildValidPdf([
        "Slide 1: Arquitetura Hexagonal e Portas e Adaptadores",
        "",
      ]),
    );

    const lib = { id: "lib-mod", name: "ModLib", path: tmpDir, enabled: true };
    const scanned = await scanLibrary(lib);
    const tree = scanned.tree || scanned;
    const videoRel = "Curso_Mod/Modulo 02/Aula 01.mp4";
    const videoNode = findNodeByPath(tree, videoRel);
    const courseNode = findNodeByPath(tree, "Curso_Mod");
    const cfg = defaultAiConfig();

    const ctx = await buildLessonTutorContext(lib, videoRel, videoNode, courseNode, cfg, true, "Arquitetura Hexagonal");
    assert.equal(ctx.materialsCount, 1);
    assert.equal(ctx.materials[0].name, "slides_modulo2.pdf");
    assert.equal(ctx.materials[0].pageCount, 2);
    assert.equal(ctx.materials[0].textPages, 1);
    assert.deepEqual(ctx.materials[0].ocrNeededPages, [2]);
    assert.match(ctx.contextText, /Arquitetura Hexagonal/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
