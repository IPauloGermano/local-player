// Registro e executor seguro (read-only) de ferramentas do Tutor IA
const path = require("path");
const { resolveLibraryRel, isAppDirRel, fileWithinLibrary } = require("../core/paths");
const { collectLessonMaterialFiles } = require("./context");
const {
  loadOrExtractDocument,
  searchDocumentPages,
  readDocumentPagesRange,
} = require("../services/document-extractors");

const MAX_TOOL_OUTPUT_CHARS = 12000;
const MAX_READ_PAGES_PER_CALL = 5;

const TUTOR_TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "list_lesson_materials",
      description:
        "Lista todos os documentos e materiais de apoio (PDFs, slides, apostilas, textos e códigos) disponíveis para a aula atual, retornando o doc_id curto de cada arquivo, número de páginas e quais páginas são escaneadas (precisam de OCR).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_document",
      description:
        "Pesquisa palavras-chave ou conceitos dentro de um material da aula usando seu doc_id e retorna os trechos mais relevantes com o número exato da página.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: 'ID curto do documento (ex: "d1"), obtido via list_lesson_materials.',
          },
          query: {
            type: "string",
            description: "Termos ou frase a buscar dentro do documento.",
          },
          max_results: {
            type: "integer",
            description: "Máximo de trechos retornados (1 a 8, padrão 5).",
          },
        },
        required: ["doc_id", "query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document_pages",
      description:
        "Lê o conteúdo completo de um intervalo de páginas (ou slides) de um material da aula usando seu doc_id. Máximo de 5 páginas por chamada. Quando uma página escaneada exigir OCR e o OCR estiver disponível, ele será acionado sob demanda.",
      parameters: {
        type: "object",
        properties: {
          doc_id: {
            type: "string",
            description: 'ID curto do documento (ex: "d1"), obtido via list_lesson_materials.',
          },
          start_page: {
            type: "integer",
            description: "Número da página inicial (começando em 1).",
          },
          end_page: {
            type: "integer",
            description: "Número da página final (opcional; máximo 5 páginas por chamada).",
          },
        },
        required: ["doc_id", "start_page"],
      },
    },
  },
];

function wrapUntrustedDocument(docName, rangeLabel, body) {
  const safeName = String(docName || "documento").replace(/["<>]/g, "");
  const safeRange = String(rangeLabel || "").replace(/["<>]/g, "");
  const trimmed = String(body || "").slice(0, MAX_TOOL_OUTPUT_CHARS);
  return `<untrusted_document_content doc="${safeName}" pages="${safeRange}">\n${trimmed}\n</untrusted_document_content>`;
}

function parseToolArgs(rawArgs) {
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    return rawArgs;
  }
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return {};
}

function createLessonToolRuntime({ lib, tree, courseNode, videoRel, onOcrPages = null } = {}) {
  const rawFiles = collectLessonMaterialFiles(tree, courseNode, videoRel);
  const byId = new Map();
  const ordered = [];

  for (let i = 0; i < rawFiles.length; i++) {
    const f = rawFiles[i];
    if (!f || !f.path || !f.name) continue;
    const safe = lib ? resolveLibraryRel(lib, f.path) : null;
    if (!safe || isAppDirRel(safe, lib)) continue;
    const docId = `d${ordered.length + 1}`;
    const entry = {
      docId,
      name: f.name,
      relPath: safe.rel,
      absPath: safe.abs,
      ext: path.extname(f.name).toLowerCase(),
      size: Number(f.size) || 0,
    };
    byId.set(docId, entry);
    ordered.push(entry);
  }

  const docCacheInMemory = new Map();

  async function ensureLoaded(entry) {
    if (docCacheInMemory.has(entry.docId)) {
      return docCacheInMemory.get(entry.docId);
    }
    const within = await fileWithinLibrary(lib, entry.absPath);
    if (!within) return null;
    const doc = await loadOrExtractDocument(entry.absPath, entry.ext, {
      lib,
      relPath: entry.relPath,
    });
    if (doc) docCacheInMemory.set(entry.docId, doc);
    return doc;
  }

  function describeAction(name, rawArgs) {
    const args = parseToolArgs(rawArgs) || {};
    const entry = typeof args.doc_id === "string" ? byId.get(args.doc_id.trim()) : null;
    const docLabel = entry ? entry.name : "material da aula";
    if (name === "list_lesson_materials") {
      return "Consultando materiais da aula...";
    }
    if (name === "search_document") {
      return `Pesquisando em ${docLabel}...`;
    }
    if (name === "read_document_pages") {
      const s = Math.max(1, Math.floor(Number(args.start_page) || 1));
      const e = args.end_page ? Math.max(s, Math.floor(Number(args.end_page))) : s;
      const rangeStr = e > s ? `páginas ${s}–${e}` : `página ${s}`;
      return `Lendo ${rangeStr} de ${docLabel}...`;
    }
    return "Consultando documentos da aula...";
  }

  async function execute(name, rawArgs, execOpts = {}) {
    const args = parseToolArgs(rawArgs);
    if (args === null) {
      return { ok: false, content: JSON.stringify({ ok: false, error: "Argumentos JSON inválidos para a ferramenta." }) };
    }

    if (name === "list_lesson_materials") {
      const items = [];
      for (const entry of ordered) {
        const doc = await ensureLoaded(entry);
        items.push({
          doc_id: entry.docId,
          name: entry.name,
          ext: entry.ext,
          size_kb: Math.round((doc?.size || entry.size || 0) / 1024),
          page_count: doc ? doc.pageCount || 0 : 0,
          text_pages: doc ? doc.textPages || 0 : 0,
          ocr_needed_pages: doc && Array.isArray(doc.ocrNeededPages) ? doc.ocrNeededPages : [],
          scanned: !!(doc && doc.scanned),
        });
      }
      return {
        ok: true,
        content: JSON.stringify({ ok: true, count: items.length, materials: items }, null, 2),
        meta: { count: items.length },
      };
    }

    if (name === "search_document") {
      const docId = typeof args.doc_id === "string" ? args.doc_id.trim() : "";
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const entry = byId.get(docId);
      if (!entry) {
        return {
          ok: false,
          content: JSON.stringify({ ok: false, error: "doc_id inválido. Use list_lesson_materials para listar IDs válidos." }),
        };
      }
      if (!query) {
        return {
          ok: false,
          content: JSON.stringify({ ok: false, error: "Informe o parâmetro 'query' para buscar no documento." }),
        };
      }
      const doc = await ensureLoaded(entry);
      if (!doc || doc.invalid) {
        return {
          ok: false,
          content: JSON.stringify({ ok: false, error: `Não foi possível ler ${entry.name}.` }),
        };
      }
      const maxResults = Math.max(1, Math.min(8, Math.floor(Number(args.max_results) || 5)));
      const hits = searchDocumentPages(doc, query, maxResults);
      const payload = {
        ok: true,
        doc_id: entry.docId,
        name: entry.name,
        page_count: doc.pageCount || 0,
        hits,
        ocr_needed_pages: doc.ocrNeededPages || [],
        note:
          hits.length === 0 && doc.ocrNeededPages && doc.ocrNeededPages.length > 0
            ? "Nenhum termo encontrado nas páginas de texto; há páginas escaneadas que requerem OCR e podem ser lidas com read_document_pages."
            : undefined,
      };
      return {
        ok: true,
        content: wrapUntrustedDocument(entry.name, `busca:${query.slice(0, 40)}`, JSON.stringify(payload, null, 2)),
        meta: { docId, hits: hits.length },
      };
    }

    if (name === "read_document_pages") {
      const docId = typeof args.doc_id === "string" ? args.doc_id.trim() : "";
      const entry = byId.get(docId);
      if (!entry) {
        return {
          ok: false,
          content: JSON.stringify({ ok: false, error: "doc_id inválido. Use list_lesson_materials para listar IDs válidos." }),
        };
      }
      let doc = await ensureLoaded(entry);
      if (!doc || doc.invalid) {
        return {
          ok: false,
          content: JSON.stringify({ ok: false, error: `Não foi possível ler ${entry.name}.` }),
        };
      }
      const startPage = Math.max(1, Math.floor(Number(args.start_page) || 1));
      const endPage = args.end_page !== undefined && args.end_page !== null
        ? Math.max(startPage, Math.floor(Number(args.end_page) || startPage))
        : startPage;

      let range = readDocumentPagesRange(doc, startPage, endPage, {
        maxPages: MAX_READ_PAGES_PER_CALL,
        maxChars: MAX_TOOL_OUTPUT_CHARS - 600,
      });

      // Hook pronto para Fatia 3 (OCR sob demanda apenas das páginas escaneadas no intervalo pedido)
      if (range.ocrNeededPages.length > 0 && typeof onOcrPages === "function") {
        const updatedDoc = await onOcrPages(entry, doc, range.ocrNeededPages, {
          signal: execOpts.signal,
          onStatus: execOpts.onStatus,
        });
        if (updatedDoc) {
          doc = updatedDoc;
          docCacheInMemory.set(entry.docId, doc);
          range = readDocumentPagesRange(doc, startPage, endPage, {
            maxPages: MAX_READ_PAGES_PER_CALL,
            maxChars: MAX_TOOL_OUTPUT_CHARS - 600,
          });
        }
      }

      const blocks = range.pages.map((p) => {
        if (p.status === "needs_ocr") {
          return `[Página ${p.page}] (status: needs_ocr — página escaneada sem camada de texto legível; requer OCR)`;
        }
        return `[Página ${p.page}]\n${p.text}`;
      });

      const headerNote = [
        `Documento: ${entry.name} (${entry.docId}) — páginas ${range.startPage} a ${range.endPage} de ${range.pageCount}`,
        range.clampedByPageLimit ? `(Nota: intervalo limitado a ${MAX_READ_PAGES_PER_CALL} páginas por chamada)` : "",
        range.truncatedByChars ? "(Nota: saída truncada pelo limite de contexto)" : "",
      ].filter(Boolean).join(" ");

      return {
        ok: true,
        content: wrapUntrustedDocument(
          entry.name,
          `${range.startPage}-${range.endPage}/${range.pageCount}`,
          `${headerNote}\n\n${blocks.join("\n\n")}`,
        ),
        meta: {
          docId,
          startPage: range.startPage,
          endPage: range.endPage,
          ocrNeededPages: range.ocrNeededPages,
        },
      };
    }

    return {
      ok: false,
      content: JSON.stringify({
        ok: false,
        error: `Ferramenta desconhecida: "${String(name || "")}". Ferramentas válidas: list_lesson_materials, search_document, read_document_pages.`,
      }),
    };
  }

  return {
    hasMaterials: ordered.length > 0,
    materialsIndex: ordered.map((e) => ({ doc_id: e.docId, name: e.name, ext: e.ext })),
    toolSpecs: TUTOR_TOOL_SPECS,
    describeAction,
    execute,
  };
}

module.exports = {
  TUTOR_TOOL_SPECS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_READ_PAGES_PER_CALL,
  createLessonToolRuntime,
};
