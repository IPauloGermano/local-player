// Extratores de Texto para PDFs, Documentos de Escritório (DOCX, PPTX, ODT, RTF) e Materiais de Apoio
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn, execFile } = require("child_process");
const state = require("../state");
const { readJsonFile, writeFileAtomic } = require("../core/fs-atomic");
const {
  TUTOR_TEXT_EXTS,
  applyRtkMaterialFiltering,
  applyHeadroomContextCompression,
} = require("../ai/skills");

const APP_DIR = path.resolve(__dirname, "..", "..");
const FFMPEG_BIN_DIR = path.join(APP_DIR, "bin", "ffmpeg");
const COURSE_DOCS_DIR = path.join(".courseplayer", "docs");
const DOC_CACHE_VERSION = 1;
const MAX_PDF_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_READ_MAX_PAGES = 5;
const DEFAULT_READ_MAX_CHARS = 12000;

let _pdfjsPromise = null;
function loadPdfJs() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").catch((err) => {
      _pdfjsPromise = null;
      throw err;
    });
  }
  return _pdfjsPromise;
}

function resolveToolBin(exeName, envPath) {
  if (envPath) return envPath;
  const candidates =
    process.platform === "win32" ? [exeName + ".exe", exeName] : [exeName];
  for (const n of candidates) {
    const local = path.join(FFMPEG_BIN_DIR, n);
    if (fsSync.existsSync(local)) return local;
  }
  return exeName;
}

const PDFTOTEXT_BIN_ENV = process.env.PDFTOTEXT_BIN || "";
const PDFTOTEXT_BIN = resolveToolBin("pdftotext", PDFTOTEXT_BIN_ENV);

function execFileAsync(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout, stderr });
    });
  });
}

let pdftotextAvailable = null;

function detectPdfToText() {
  if (pdftotextAvailable !== null) return Promise.resolve(pdftotextAvailable);
  return new Promise((resolve) => {
    const child = spawn(PDFTOTEXT_BIN, ["-v"], { stdio: "ignore" });
    child.on("error", () => {
      pdftotextAvailable = false;
      resolve(false);
    });
    child.on("close", (code) => {
      pdftotextAvailable = code === 0;
      resolve(pdftotextAvailable);
    });
  });
}

async function extractPdfTextWithBinary(absPath) {
  const hasTool = await detectPdfToText();
  if (!hasTool) return null;
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT_BIN, [absPath, "-"]);
    if (stdout) {
      const clean = stdout.replace(/\x0c/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (clean.length >= 10) return clean;
    }
  } catch (err) {
    // pdftotext falhou ou não-zero exit
  }
  return null;
}

function inspectPdfBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8) {
    return { isValid: false, pages: 0 };
  }
  const latinStr = buf.toString("latin1");
  if (!latinStr.includes("%PDF-")) {
    return { isValid: false, pages: 0 };
  }
  const pageMatches = latinStr.match(/\/Type\s*\/Page\b/g) || [];
  return { isValid: true, pages: pageMatches.length };
}

function cleanExtractedPdfText(text) {
  if (!text) return "";
  const lines = text.split("\n");
  const cleanedLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const alphaCount = (trimmed.match(/[a-zA-Z0-9\u00C0-\u024F]/g) || []).length;
    if (alphaCount === 0 && trimmed.length < 20) continue;
    if (alphaCount / trimmed.length < 0.2 && trimmed.length > 5) continue;
    cleanedLines.push(trimmed);
  }
  return cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 1. Parser de CMaps / ToUnicode para decodificação de fontes embutidas em PDFs
function parsePdfCMap(cmapStr) {
  const map = new Map();
  if (!cmapStr || typeof cmapStr !== "string") return map;

  const bfCharRegex = /beginbfchar[\r\n]+([\s\S]*?)endbfchar/g;
  let m;
  while ((m = bfCharRegex.exec(cmapStr)) !== null) {
    const block = m[1];
    const pairRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let pm;
    while ((pm = pairRegex.exec(block)) !== null) {
      const srcCode = parseInt(pm[1], 16);
      const dstHex = pm[2];
      let dstStr = "";
      for (let i = 0; i < dstHex.length; i += 4) {
        dstStr += String.fromCharCode(parseInt(dstHex.slice(i, i + 4), 16));
      }
      map.set(srcCode, dstStr);
    }
  }

  const bfRangeRegex = /beginbfrange[\r\n]+([\s\S]*?)endbfrange/g;
  while ((m = bfRangeRegex.exec(cmapStr)) !== null) {
    const block = m[1];
    const lines = block.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match1 = trimmed.match(/^<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>$/);
      if (match1) {
        const start = parseInt(match1[1], 16);
        const end = parseInt(match1[2], 16);
        let dest = parseInt(match1[3], 16);
        for (let code = start; code <= end; code++) {
          map.set(code, String.fromCharCode(dest));
          dest++;
        }
        continue;
      }
      const match2 = trimmed.match(/^<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]$/);
      if (match2) {
        const start = parseInt(match2[1], 16);
        const end = parseInt(match2[2], 16);
        const destHexes = match2[3].match(/<([0-9a-fA-F]+)>/g) || [];
        let idx = 0;
        for (let code = start; code <= end && idx < destHexes.length; code++, idx++) {
          const rawHex = destHexes[idx].replace(/[<>]/g, "");
          let dstStr = "";
          for (let i = 0; i < rawHex.length; i += 4) {
            dstStr += String.fromCharCode(parseInt(rawHex.slice(i, i + 4), 16));
          }
          map.set(code, dstStr);
        }
      }
    }
  }

  return map;
}

// 2. Decodificação de strings literais do PDF (...)
function decodePdfLiteralString(rawStr) {
  if (!rawStr) return "";
  let out = "";
  for (let i = 0; i < rawStr.length; i++) {
    const c = rawStr[i];
    if (c === "\\" && i + 1 < rawStr.length) {
      const next = rawStr[i + 1];
      if (next >= "0" && next <= "7") {
        let oct = next;
        let j = i + 2;
        while (j < rawStr.length && j < i + 4 && rawStr[j] >= "0" && rawStr[j] <= "7") {
          oct += rawStr[j];
          j++;
        }
        out += String.fromCharCode(parseInt(oct, 8));
        i = j - 1;
      } else if (next === "n") {
        out += "\n";
        i++;
      } else if (next === "r") {
        out += "\r";
        i++;
      } else if (next === "t") {
        out += "\t";
        i++;
      } else if (next === "b") {
        out += "\b";
        i++;
      } else if (next === "f") {
        out += "\f";
        i++;
      } else if (next === "\n" || next === "\r") {
        i++;
        if (next === "\r" && i + 1 < rawStr.length && rawStr[i + 1] === "\n") i++;
      } else {
        out += next;
        i++;
      }
    } else {
      out += c;
    }
  }

  // Detecta BOM UTF-16BE (\xFE\xFF)
  if (out.startsWith("\xFE\xFF") || out.startsWith("\u00FE\u00FF")) {
    let utf16 = "";
    for (let i = 2; i + 1 < out.length; i += 2) {
      const code = (out.charCodeAt(i) << 8) | out.charCodeAt(i + 1);
      utf16 += String.fromCharCode(code);
    }
    return utf16;
  }

  try {
    const buf = Buffer.from(out, "latin1");
    const utf8Str = buf.toString("utf8");
    if (!utf8Str.includes("\uFFFD")) {
      return utf8Str;
    }
    return out;
  } catch {
    return out;
  }
}

// 3. Decodificação de strings hexadecimais do PDF <...>
function decodePdfHexString(hexStr, cMap) {
  if (!hexStr) return "";
  const cleanHex = hexStr.replace(/\s+/g, "");
  const paddedHex = cleanHex.length % 2 !== 0 ? cleanHex + "0" : cleanHex;

  if (cMap && cMap.size > 0) {
    let result = "";
    let step = 4;
    let hasMatch = false;
    for (let i = 0; i + 3 < paddedHex.length; i += 4) {
      const code = parseInt(paddedHex.slice(i, i + 4), 16);
      if (cMap.has(code)) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) {
      step = 2;
    }
    for (let i = 0; i < paddedHex.length; i += step) {
      const chunk = paddedHex.slice(i, i + step);
      const code = parseInt(chunk, 16);
      if (cMap.has(code)) {
        result += cMap.get(code);
      } else {
        result += String.fromCharCode(code);
      }
    }
    if (result) return result;
  }

  if (paddedHex.toUpperCase().startsWith("FEFF")) {
    let utf16 = "";
    for (let i = 4; i + 3 < paddedHex.length; i += 4) {
      const code = parseInt(paddedHex.slice(i, i + 4), 16);
      utf16 += String.fromCharCode(code);
    }
    return utf16;
  }

  let is2ByteAscii = paddedHex.length >= 4;
  for (let i = 0; i < paddedHex.length; i += 4) {
    if (paddedHex.slice(i, i + 2) !== "00") {
      is2ByteAscii = false;
      break;
    }
  }
  if (is2ByteAscii) {
    let text = "";
    for (let i = 0; i + 3 < paddedHex.length; i += 4) {
      const code = parseInt(paddedHex.slice(i + 2, i + 4), 16);
      text += String.fromCharCode(code);
    }
    return text;
  }

  let text = "";
  for (let i = 0; i + 1 < paddedHex.length; i += 2) {
    const code = parseInt(paddedHex.slice(i, i + 2), 16);
    text += String.fromCharCode(code);
  }
  return text;
}

// Extração robusta de texto de PDFs (puro Node.js, sem dependências externas).
function extractTextFromPdfBuffer(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8) return "";
  try {
    const textChunks = [];
    const latinStr = buf.toString("latin1");

    const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
    const decompressedStreams = [];
    const cmaps = [];

    let match;
    while ((match = streamRegex.exec(latinStr)) !== null) {
      const rawStream = Buffer.from(match[1], "latin1");
      let decompressed = null;
      try {
        decompressed = zlib.inflateSync(rawStream);
      } catch {
        try {
          decompressed = zlib.inflateRawSync(rawStream);
        } catch {
          decompressed = rawStream;
        }
      }
      if (!decompressed) continue;

      let str = "";
      try {
        str = decompressed.toString("utf8");
      } catch {
        str = decompressed.toString("latin1");
      }

      if (str.includes("beginbfchar") || str.includes("beginbfrange")) {
        const cmap = parsePdfCMap(str);
        if (cmap.size > 0) cmaps.push(cmap);
      }
      decompressedStreams.push(str);
    }

    const globalCMap = new Map();
    for (const cm of cmaps) {
      for (const [k, v] of cm.entries()) {
        globalCMap.set(k, v);
      }
    }

    for (const content of decompressedStreams) {
      const btRegex = /BT[\s\S]*?ET/g;
      let btMatch;
      while ((btMatch = btRegex.exec(content)) !== null) {
        const block = btMatch[0];
        const opRegex = /(?:(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>)\s*(Tj|'|")|\[([\s\S]*?)\]\s*TJ|([0-9.\-]+)\s+([0-9.\-]+)\s+(Td|TD)|(T\*))/g;
        let opMatch;
        let blockLines = [];
        let currentLine = [];

        while ((opMatch = opRegex.exec(block)) !== null) {
          if (opMatch[1]) {
            const strToken = opMatch[1].trim();
            const op = opMatch[2];
            let decoded = "";
            if (strToken.startsWith("(")) {
              decoded = decodePdfLiteralString(strToken.slice(1, -1));
            } else if (strToken.startsWith("<")) {
              decoded = decodePdfHexString(strToken.slice(1, -1), globalCMap);
            }
            if (decoded) {
              if (op === "'" || op === '"') {
                if (currentLine.length) blockLines.push(currentLine.join(""));
                currentLine = [decoded];
              } else {
                currentLine.push(decoded);
              }
            }
          } else if (opMatch[3]) {
            const arrayContent = opMatch[3];
            const elemRegex = /(\((?:[^()\\]|\\.)*\)|<[0-9a-fA-F\s]+>|[-+]?[0-9]*\.?[0-9]+)/g;
            let elemMatch;
            while ((elemMatch = elemRegex.exec(arrayContent)) !== null) {
              const token = elemMatch[1].trim();
              if (token.startsWith("(")) {
                const dec = decodePdfLiteralString(token.slice(1, -1));
                if (dec) currentLine.push(dec);
              } else if (token.startsWith("<")) {
                const dec = decodePdfHexString(token.slice(1, -1), globalCMap);
                if (dec) currentLine.push(dec);
              } else {
                const num = parseFloat(token);
                if (Number.isFinite(num) && num < -100) {
                  currentLine.push(" ");
                }
              }
            }
          } else if (opMatch[6] === "Td" || opMatch[6] === "TD" || opMatch[7] === "T*") {
            const dy = opMatch[5] ? parseFloat(opMatch[5]) : -1;
            if (dy !== 0 && currentLine.length > 0) {
              blockLines.push(currentLine.join(""));
              currentLine = [];
            }
          }
        }

        if (currentLine.length > 0) {
          blockLines.push(currentLine.join(""));
        }

        if (blockLines.length > 0) {
          textChunks.push(blockLines.join("\n"));
        }
      }
    }

    const fullText = textChunks.join("\n\n");
    return fullText
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/(\w)-\n(\w)/g, "$1$2")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (err) {
    return "";
  }
}

// 4. Extrator de arquivos compactados ZIP (Office: DOCX, PPTX, ODT) em puro Node.js
function extractTextFromZipBuffer(buf, xmlPaths, tagRegex, paraRegex) {
  try {
    let offset = 0;
    const extractedXmls = new Map();

    while (offset < buf.length - 30) {
      if (buf.readUInt32LE(offset) !== 0x04034b50) {
        const nextPK = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset + 1);
        if (nextPK === -1) break;
        offset = nextPK;
      }

      const compressionMethod = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraFieldLen = buf.readUInt16LE(offset + 28);

      const fileNameStart = offset + 30;
      const fileName = buf.toString("utf8", fileNameStart, fileNameStart + fileNameLen);
      const dataStart = fileNameStart + fileNameLen + extraFieldLen;
      const dataEnd = dataStart + compressedSize;

      if (xmlPaths.some((p) => typeof p === "string" ? p === fileName : p.test(fileName))) {
        const fileData = buf.subarray(dataStart, dataEnd);
        let decompressed = null;
        if (compressionMethod === 8) {
          try {
            decompressed = zlib.inflateRawSync(fileData);
          } catch {}
        } else if (compressionMethod === 0) {
          decompressed = fileData;
        }

        if (decompressed) {
          extractedXmls.set(fileName, decompressed.toString("utf8"));
        }
      }

      offset = dataEnd;
    }

    if (extractedXmls.size === 0) return "";

    const textPieces = [];
    for (const [, xml] of extractedXmls.entries()) {
      const paras = paraRegex ? xml.split(paraRegex) : [xml];
      for (const para of paras) {
        const lineParts = [];
        let tm;
        const re = new RegExp(tagRegex.source, tagRegex.flags || "g");
        while ((tm = re.exec(para)) !== null) {
          const raw = tm[1] || "";
          const txt = raw
            .replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, "&");
          if (txt) lineParts.push(txt);
        }
        if (lineParts.length > 0) {
          textPieces.push(lineParts.join("").trim());
        }
      }
    }

    return textPieces.join("\n\n").trim();
  } catch (err) {
    return "";
  }
}

function extractTextFromDocxBuffer(buf) {
  return extractTextFromZipBuffer(
    buf,
    ["word/document.xml"],
    /<w:t[^>]*>([\s\S]*?)<\/w:t>/g,
    /<\/w:p>/gi
  );
}

function extractTextFromPptxBuffer(buf) {
  return extractTextFromZipBuffer(
    buf,
    [/ppt\/slides\/slide\d+\.xml/],
    /<a:t[^>]*>([\s\S]*?)<\/a:t>/g,
    /<\/a:p>/gi
  );
}

function extractTextFromOdtBuffer(buf) {
  return extractTextFromZipBuffer(
    buf,
    ["content.xml"],
    /<text:(?:p|h)[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g,
    null
  );
}

function extractTextFromRtf(str) {
  try {
    return str
      .replace(/\\par[d]?/g, "\n")
      .replace(/\\tab/g, "\t")
      .replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\u(\d+)\??/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
      .replace(/\\[a-zA-Z]+-?\d*\s?/g, "")
      .replace(/[{}]/g, "")
      .trim();
  } catch {
    return "";
  }
}

// 5. Chunking inteligente e busca por relevância para documentos extensos (RAG leve)
function chunkDocumentText(text, maxChunkLen = 1200, overlap = 150) {
  if (!text || typeof text !== "string") return [];
  const clean = text.trim();
  if (clean.length <= maxChunkLen) {
    return [{ index: 0, text: clean, start: 0, end: clean.length }];
  }

  const chunks = [];
  const paragraphs = clean.split(/\n\s*\n/);
  let currentChunk = "";
  let chunkStart = 0;

  for (const para of paragraphs) {
    const p = para.trim();
    if (!p) continue;

    if (currentChunk.length + p.length + 2 <= maxChunkLen) {
      currentChunk += (currentChunk ? "\n\n" : "") + p;
    } else {
      if (currentChunk) {
        chunks.push({
          index: chunks.length,
          text: currentChunk,
          start: chunkStart,
          end: chunkStart + currentChunk.length,
        });
        chunkStart += currentChunk.length;
        currentChunk = "";
      }

      if (p.length > maxChunkLen) {
        let pOffset = 0;
        while (pOffset < p.length) {
          const slice = p.slice(pOffset, pOffset + maxChunkLen);
          chunks.push({
            index: chunks.length,
            text: slice,
            start: chunkStart + pOffset,
            end: chunkStart + pOffset + slice.length,
          });
          pOffset += maxChunkLen - overlap;
        }
        chunkStart += p.length;
      } else {
        currentChunk = p;
      }
    }
  }

  if (currentChunk) {
    chunks.push({
      index: chunks.length,
      text: currentChunk,
      start: chunkStart,
      end: chunkStart + currentChunk.length,
    });
  }

  return chunks;
}

function normalizeSearchTerm(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]/g, " ")
    .trim();
}

function retrieveRelevantDocumentChunks(chunks, query, topK = 5) {
  if (!Array.isArray(chunks) || chunks.length === 0) return [];
  if (!query || typeof query !== "string" || !query.trim()) {
    return chunks.slice(0, topK);
  }

  const stopWords = new Set(["de", "da", "do", "em", "para", "com", "que", "como", "qual", "uma", "uns", "por", "sobre", "o", "a", "os", "as", "no", "na", "nos", "nas", "ao", "aos"]);
  const queryTerms = normalizeSearchTerm(query)
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stopWords.has(t));

  if (queryTerms.length === 0) {
    return chunks.slice(0, topK);
  }

  const scored = chunks.map((chunk) => {
    const normText = normalizeSearchTerm(chunk.text);
    let score = 0;

    const fullNormQuery = normalizeSearchTerm(query);
    if (fullNormQuery.length > 5 && normText.includes(fullNormQuery)) {
      score += 100;
    }

    for (const term of queryTerms) {
      let count = 0;
      let pos = 0;
      while ((pos = normText.indexOf(term, pos)) !== -1) {
        count++;
        pos += term.length;
      }
      if (count > 0) {
        score += count * Math.min(term.length, 10);
      }
    }

    return { ...chunk, score };
  });

  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const top = scored.slice(0, topK).filter((c) => c.score > 0);
  if (top.length === 0) {
    return chunks.slice(0, topK);
  }
  top.sort((a, b) => a.index - b.index);
  return top;
}

function formatDocumentForTutor(baseName, ext, rawText, query = "") {
  if (!rawText) return "";
  const clean = rawText.trim();
  const docTypeLabel =
    ext === ".pdf" ? "Documento PDF" :
    ext === ".docx" ? "Documento Word (.docx)" :
    ext === ".pptx" ? "Slides PowerPoint (.pptx)" :
    ext === ".odt" ? "Documento OpenDocument (.odt)" :
    ext === ".rtf" ? "Documento RTF" : "Arquivo";

  if (clean.length <= 16000) {
    return `[${docTypeLabel}: ${baseName}]\n${clean}`;
  }

  const chunks = chunkDocumentText(clean, 1200, 150);
  const overview = clean.slice(0, 1500).replace(/\n{3,}/g, "\n\n");

  if (query && query.trim()) {
    const relevant = retrieveRelevantDocumentChunks(chunks, query, 5);
    const sectionsText = relevant
      .map((c) => `--- [Seção ${c.index + 1} de ${chunks.length}] ---\n${c.text}`)
      .join("\n\n");

    return (
      `[${docTypeLabel}: ${baseName} (~${Math.round(clean.length / 1000)}k caracteres, ${chunks.length} seções)]\n` +
      `Visão Geral / Início:\n${overview}\n\n` +
      `Trechos Relevantes para a Consulta ("${query.slice(0, 60)}..."):\n${sectionsText}`
    );
  }

  const initialSections = chunks
    .slice(0, 4)
    .map((c) => `--- [Seção ${c.index + 1} de ${chunks.length}] ---\n${c.text}`)
    .join("\n\n");

  return (
    `[${docTypeLabel}: ${baseName} (~${Math.round(clean.length / 1000)}k caracteres, ${chunks.length} seções indexadas)]\n` +
    `Conteúdo Principal / Inicial:\n${initialSections}\n\n` +
    `[... ${chunks.length - 4} seções adicionais indexadas para consulta pelo chat ...]`
  );
}

function normalizePageWhitespace(text) {
  if (!text) return "";
  return String(text)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function classifyPageText(rawText, source) {
  const clean = normalizePageWhitespace(rawText);
  const alphaCount = (clean.match(/[a-zA-Z0-9\u00C0-\u024F]/g) || []).length;
  const isReadable = clean.length >= 10 && alphaCount >= 6;
  return {
    text: isReadable ? clean : "",
    status: isReadable ? "text_ready" : "needs_ocr",
    source: isReadable ? source : null,
    chars: isReadable ? clean.length : 0,
  };
}

function finalizePagesResult(pages, engine, extra = {}) {
  const ocrNeededPages = pages.filter((p) => p.status === "needs_ocr").map((p) => p.page);
  const textPages = pages.filter((p) => p.status === "text_ready").length;
  return {
    invalid: false,
    tooLarge: false,
    engine,
    pageCount: pages.length,
    textPages,
    ocrNeededPages,
    scanned: pages.length > 0 && textPages === 0,
    pages,
    ...extra,
  };
}

async function extractPdfPagesWithBinary(absPath) {
  const hasTool = await detectPdfToText();
  if (!hasTool) return null;
  try {
    const { stdout } = await execFileAsync(PDFTOTEXT_BIN, [absPath, "-"]);
    if (typeof stdout === "string" && stdout.length > 0) {
      const rawPages = stdout.split("\x0c");
      if (rawPages.length > 1 && rawPages[rawPages.length - 1].trim() === "") {
        rawPages.pop();
      }
      if (rawPages.length > 0) {
        const pages = rawPages.map((raw, idx) => ({
          page: idx + 1,
          ...classifyPageText(raw, "pdftotext"),
        }));
        return finalizePagesResult(pages, "pdftotext");
      }
    }
  } catch {
    // pdftotext falhou ou retornou código não-zero
  }
  return null;
}

async function extractPdfPagesWithPdfJs(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8) return null;
  let doc = null;
  try {
    const pdfjs = await loadPdfJs();
    const loadingTask = pdfjs.getDocument({
      data: Uint8Array.from(buf),
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0,
    });
    doc = await loadingTask.promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const lines = [];
      let curLine = "";
      let prevY = null;
      for (const item of tc.items || []) {
        if (!item || typeof item.str !== "string") continue;
        const y = Array.isArray(item.transform) ? item.transform[5] : null;
        if (prevY !== null && y !== null && Math.abs(y - prevY) > 3 && curLine.trim()) {
          lines.push(curLine.trim());
          curLine = "";
        }
        if (item.str) {
          curLine += (curLine && !curLine.endsWith(" ") && !item.str.startsWith(" ") ? " " : "") + item.str;
        }
        if (item.hasEOL) {
          if (curLine.trim()) lines.push(curLine.trim());
          curLine = "";
          prevY = null;
        } else if (y !== null) {
          prevY = y;
        }
      }
      if (curLine.trim()) lines.push(curLine.trim());
      pages.push({
        page: p,
        ...classifyPageText(lines.join("\n"), "pdfjs"),
      });
    }
    return finalizePagesResult(pages, "pdfjs");
  } catch {
    return null;
  } finally {
    if (doc && typeof doc.destroy === "function") {
      try { await doc.destroy(); } catch {}
    }
  }
}

async function extractPdfPages(absPath, opts = {}) {
  const st = await fs.stat(absPath).catch(() => null);
  if (!st || !st.isFile()) return null;
  if (st.size > MAX_PDF_SIZE_BYTES) {
    return {
      invalid: false,
      tooLarge: true,
      size: st.size,
      engine: null,
      pageCount: 0,
      textPages: 0,
      ocrNeededPages: [],
      scanned: false,
      pages: [],
    };
  }

  if (!opts.skipBinary) {
    const binRes = await extractPdfPagesWithBinary(absPath);
    if (binRes && binRes.pageCount > 0) return binRes;
  }

  const buf = await fs.readFile(absPath).catch(() => null);
  if (!buf) {
    return { invalid: true, tooLarge: false, engine: null, pageCount: 0, textPages: 0, ocrNeededPages: [], scanned: false, pages: [] };
  }

  if (!opts.skipPdfJs) {
    const pdfJsRes = await extractPdfPagesWithPdfJs(buf);
    if (pdfJsRes && pdfJsRes.pageCount > 0) return pdfJsRes;
  }

  // Fallback puro Node.js para PDFs truncados ou sintéticos sem tabela xref completa
  const info = inspectPdfBuffer(buf);
  const rawJsText = extractTextFromPdfBuffer(buf);
  const cleanedJsText = cleanExtractedPdfText(rawJsText);
  if (cleanedJsText && cleanedJsText.length >= 10) {
    const total = Math.max(1, info.pages || 1);
    const pages = [{ page: 1, ...classifyPageText(cleanedJsText, "pdf-fallback") }];
    for (let p = 2; p <= total; p++) {
      pages.push({ page: p, text: "", status: "needs_ocr", source: null, chars: 0 });
    }
    return finalizePagesResult(pages, "pdf-fallback");
  }

  if (info.isValid) {
    const total = Math.max(1, info.pages || 1);
    const pages = Array.from({ length: total }, (_, idx) => ({
      page: idx + 1,
      text: "",
      status: "needs_ocr",
      source: null,
      chars: 0,
    }));
    return finalizePagesResult(pages, "pdf-inspect");
  }

  return { invalid: true, tooLarge: false, engine: null, pageCount: 0, textPages: 0, ocrNeededPages: [], scanned: false, pages: [] };
}

function docCacheName(libId, relPath) {
  return crypto
    .createHash("sha1")
    .update(`${libId || ""}\0${relPath || ""}`)
    .digest("hex")
    .slice(0, 24);
}

function courseDocCachePath(lib, relPath, hash) {
  if (!lib || !lib.path || !relPath) return null;
  const idx = relPath.indexOf("/");
  if (idx <= 0) return null;
  const courseName = relPath.slice(0, idx);
  return path.join(lib.path, courseName, COURSE_DOCS_DIR, hash + ".json");
}

function mirrorDocCachePath(hash) {
  return path.join(state.DATA_DIR, "docs", hash + ".json");
}

async function saveDocumentCache(cachePath, doc) {
  if (!cachePath || !doc) return false;
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  const toPersist = {
    version: DOC_CACHE_VERSION,
    name: doc.name,
    ext: doc.ext,
    size: doc.size,
    mtimeMs: doc.mtimeMs,
    engine: doc.engine || null,
    pageCount: doc.pageCount || 0,
    textPages: doc.textPages || 0,
    ocrNeededPages: Array.isArray(doc.ocrNeededPages) ? doc.ocrNeededPages : [],
    scanned: !!doc.scanned,
    pages: Array.isArray(doc.pages) ? doc.pages : [],
  };
  await writeFileAtomic(cachePath, JSON.stringify(toPersist, null, 2));
  return true;
}

function extractPptxSlidesBuffer(buf) {
  try {
    let offset = 0;
    const slides = [];
    const slideRe = /^ppt\/slides\/slide(\d+)\.xml$/;
    while (offset < buf.length - 30) {
      if (buf.readUInt32LE(offset) !== 0x04034b50) {
        const nextPK = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset + 1);
        if (nextPK === -1) break;
        offset = nextPK;
      }
      const compressionMethod = buf.readUInt16LE(offset + 8);
      const compressedSize = buf.readUInt32LE(offset + 18);
      const fileNameLen = buf.readUInt16LE(offset + 26);
      const extraFieldLen = buf.readUInt16LE(offset + 28);
      const fileNameStart = offset + 30;
      const fileName = buf.toString("utf8", fileNameStart, fileNameStart + fileNameLen);
      const dataStart = fileNameStart + fileNameLen + extraFieldLen;
      const dataEnd = dataStart + compressedSize;

      const m = slideRe.exec(fileName);
      if (m) {
        const fileData = buf.subarray(dataStart, dataEnd);
        let decompressed = null;
        if (compressionMethod === 8) {
          try { decompressed = zlib.inflateRawSync(fileData); } catch {}
        } else if (compressionMethod === 0) {
          decompressed = fileData;
        }
        if (decompressed) {
          const xml = decompressed.toString("utf8");
          const paras = xml.split(/<\/a:p>/gi);
          const pieces = [];
          for (const para of paras) {
            const parts = [];
            const re = /<a:t[^>]*>([\s\S]*?)<\/a:t>/g;
            let tm;
            while ((tm = re.exec(para)) !== null) {
              const txt = (tm[1] || "")
                .replace(/<[^>]+>/g, "")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&amp;/g, "&");
              if (txt) parts.push(txt);
            }
            if (parts.length) pieces.push(parts.join("").trim());
          }
          slides.push({ num: parseInt(m[1], 10), text: normalizePageWhitespace(pieces.join("\n\n")) });
        }
      }
      offset = dataEnd;
    }
    slides.sort((a, b) => a.num - b.num);
    return slides.map((s, idx) => ({
      page: idx + 1,
      text: s.text,
      status: s.text.length >= 2 ? "text_ready" : "needs_ocr",
      source: s.text.length >= 2 ? "pptx-xml" : null,
      chars: s.text.length,
    }));
  } catch {
    return [];
  }
}

async function loadOrExtractDocument(absPath, ext, cacheOpts = null) {
  const st = await fs.stat(absPath).catch(() => null);
  if (!st || !st.isFile()) return null;
  const baseName = path.basename(absPath);
  const normExt = (ext || path.extname(absPath) || "").toLowerCase();

  let primaryCache = null;
  let mirrorCache = null;
  if (cacheOpts && cacheOpts.cacheDirOverride && cacheOpts.relPath) {
    const hash = docCacheName(cacheOpts.lib?.id || "default", cacheOpts.relPath);
    primaryCache = path.join(cacheOpts.cacheDirOverride, hash + ".json");
  } else if (cacheOpts && cacheOpts.lib && cacheOpts.relPath) {
    const hash = docCacheName(cacheOpts.lib.id, cacheOpts.relPath);
    primaryCache = courseDocCachePath(cacheOpts.lib, cacheOpts.relPath, hash);
    mirrorCache = mirrorDocCachePath(hash);
  }

  // Tenta leitura de cache válido (invalidação automática por versão, mtimeMs e size)
  if (!cacheOpts?.forceFresh) {
    for (const candidate of [primaryCache, mirrorCache].filter(Boolean)) {
      const r = await readJsonFile(candidate).catch(() => ({ ok: false }));
      if (
        r.ok &&
        r.parsed &&
        r.parsed.version === DOC_CACHE_VERSION &&
        r.parsed.mtimeMs === st.mtimeMs &&
        r.parsed.size === st.size &&
        Array.isArray(r.parsed.pages)
      ) {
        return {
          ...r.parsed,
          invalid: false,
          tooLarge: false,
          fromCache: true,
          cachePath: candidate,
        };
      }
    }
  }

  let doc = null;
  if (normExt === ".pdf") {
    const pdfRes = await extractPdfPages(absPath, cacheOpts || {});
    if (!pdfRes) return null;
    doc = {
      version: DOC_CACHE_VERSION,
      name: baseName,
      ext: normExt,
      size: st.size,
      mtimeMs: st.mtimeMs,
      ...pdfRes,
    };
  } else if (normExt === ".pptx") {
    if (st.size > MAX_PDF_SIZE_BYTES) {
      doc = { version: DOC_CACHE_VERSION, name: baseName, ext: normExt, size: st.size, mtimeMs: st.mtimeMs, invalid: false, tooLarge: true, engine: null, pageCount: 0, textPages: 0, ocrNeededPages: [], scanned: false, pages: [] };
    } else {
      const buf = await fs.readFile(absPath);
      const slidePages = extractPptxSlidesBuffer(buf);
      doc = { version: DOC_CACHE_VERSION, name: baseName, ext: normExt, size: st.size, mtimeMs: st.mtimeMs, ...finalizePagesResult(slidePages, "pptx-xml") };
    }
  } else if (normExt === ".docx" || normExt === ".odt" || normExt === ".rtf") {
    const limit = normExt === ".rtf" ? 20 * 1024 * 1024 : MAX_PDF_SIZE_BYTES;
    if (st.size > limit) {
      doc = { version: DOC_CACHE_VERSION, name: baseName, ext: normExt, size: st.size, mtimeMs: st.mtimeMs, invalid: false, tooLarge: true, engine: null, pageCount: 0, textPages: 0, ocrNeededPages: [], scanned: false, pages: [] };
    } else {
      let text = "";
      if (normExt === ".docx") text = extractTextFromDocxBuffer(await fs.readFile(absPath));
      else if (normExt === ".odt") text = extractTextFromOdtBuffer(await fs.readFile(absPath));
      else text = extractTextFromRtf(await fs.readFile(absPath, "latin1"));
      const clean = normalizePageWhitespace(text);
      const pages = clean.length >= 10
        ? [{ page: 1, text: clean, status: "text_ready", source: normExt.slice(1), chars: clean.length }]
        : [];
      doc = { version: DOC_CACHE_VERSION, name: baseName, ext: normExt, size: st.size, mtimeMs: st.mtimeMs, ...finalizePagesResult(pages, normExt.slice(1)) };
    }
  } else if (TUTOR_TEXT_EXTS.has(normExt)) {
    let text = "";
    if (st.size > 512 * 1024) {
      const fd = await fs.open(absPath, "r");
      try {
        const buf = Buffer.alloc(65536);
        const { bytesRead } = await fd.read(buf, 0, 65536, 0);
        text = buf.toString("utf8", 0, bytesRead);
      } finally {
        await fd.close();
      }
    } else {
      text = await fs.readFile(absPath, "utf8");
    }
    const clean = text.trim();
    const pages = clean ? [{ page: 1, text: clean, status: "text_ready", source: "utf8", chars: clean.length }] : [];
    doc = { version: DOC_CACHE_VERSION, name: baseName, ext: normExt, size: st.size, mtimeMs: st.mtimeMs, ...finalizePagesResult(pages, "utf8") };
  } else {
    doc = { version: DOC_CACHE_VERSION, name: baseName, ext: normExt, size: st.size, mtimeMs: st.mtimeMs, invalid: false, tooLarge: false, unsupported: true, engine: null, pageCount: 0, textPages: 0, ocrNeededPages: [], scanned: false, pages: [] };
  }

  let savedPath = null;
  if (!doc.tooLarge && !doc.invalid && !doc.unsupported && (primaryCache || mirrorCache)) {
    for (const target of [primaryCache, mirrorCache].filter(Boolean)) {
      try {
        await saveDocumentCache(target, doc);
        savedPath = target;
        break;
      } catch {
        // Biblioteca pode ser somente-leitura; tenta fallback em data/docs
      }
    }
  }

  return { ...doc, fromCache: false, cachePath: savedPath };
}

function buildSnippetAroundMatch(text, terms, maxLen = 320) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  const norm = normalizeSearchTerm(text);
  let bestPos = -1;
  for (const term of terms) {
    const idx = norm.indexOf(term);
    if (idx !== -1 && (bestPos === -1 || idx < bestPos)) {
      bestPos = idx;
    }
  }
  if (bestPos <= 40) return text.slice(0, maxLen).trim() + "…";
  const start = Math.max(0, bestPos - 60);
  const end = Math.min(text.length, start + maxLen);
  return (start > 0 ? "…" : "") + text.slice(start, end).trim() + (end < text.length ? "…" : "");
}

function searchDocumentPages(doc, query, maxResults = 5) {
  if (!doc || !Array.isArray(doc.pages) || doc.pages.length === 0) return [];
  const limit = Math.max(1, Math.min(10, Math.floor(Number(maxResults) || 5)));
  const stopWords = new Set(["de", "da", "do", "em", "para", "com", "que", "como", "qual", "uma", "uns", "por", "sobre", "o", "a", "os", "as", "no", "na", "nos", "nas", "ao", "aos"]);
  const fullNormQuery = normalizeSearchTerm(query);
  const terms = fullNormQuery.split(/\s+/).filter((t) => t.length >= 2 && !stopWords.has(t));
  if (terms.length === 0) return [];

  const scored = [];
  for (const p of doc.pages) {
    if (!p || p.status !== "text_ready" || !p.text) continue;
    const normText = normalizeSearchTerm(p.text);
    let score = 0;
    if (fullNormQuery.length > 5 && normText.includes(fullNormQuery)) {
      score += 100;
    }
    for (const term of terms) {
      let count = 0;
      let pos = 0;
      while ((pos = normText.indexOf(term, pos)) !== -1) {
        count++;
        pos += term.length;
      }
      if (count > 0) score += count * Math.min(term.length, 10);
    }
    if (score > 0) {
      scored.push({
        page: p.page,
        score,
        source: p.source || "text",
        snippet: buildSnippetAroundMatch(p.text, terms),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.page - b.page);
  return scored.slice(0, limit);
}

function readDocumentPagesRange(doc, startPage = 1, endPage = null, opts = {}) {
  if (!doc || !Array.isArray(doc.pages) || doc.pages.length === 0) {
    return { startPage: 0, endPage: 0, pageCount: 0, pages: [], ocrNeededPages: [], clampedByPageLimit: false, truncatedByChars: false };
  }
  const maxPages = Math.max(1, Math.min(10, Number(opts.maxPages) || DEFAULT_READ_MAX_PAGES));
  const maxChars = Math.max(500, Math.min(40000, Number(opts.maxChars) || DEFAULT_READ_MAX_CHARS));
  const total = doc.pageCount || doc.pages.length;

  const reqStart = Math.max(1, Math.min(total, Math.floor(Number(startPage) || 1)));
  const reqEndRaw = endPage === null || endPage === undefined ? reqStart : Math.floor(Number(endPage) || reqStart);
  const reqEnd = Math.max(reqStart, Math.min(total, reqEndRaw));
  const clampedEnd = Math.min(reqEnd, reqStart + maxPages - 1);
  const clampedByPageLimit = clampedEnd < reqEnd;

  const selected = [];
  const ocrNeededPages = [];
  let charTotal = 0;
  let truncatedByChars = false;

  for (let pNum = reqStart; pNum <= clampedEnd; pNum++) {
    const pObj = doc.pages.find((x) => x.page === pNum) || { page: pNum, text: "", status: "needs_ocr", source: null, chars: 0 };
    if (pObj.status === "needs_ocr") {
      ocrNeededPages.push(pNum);
      selected.push({ page: pNum, status: "needs_ocr", source: null, text: "" });
      continue;
    }
    let text = pObj.text || "";
    if (charTotal + text.length > maxChars) {
      const remaining = Math.max(0, maxChars - charTotal);
      text = remaining > 0 ? text.slice(0, remaining) + "\n[... trecho truncado pelo limite de contexto ...]" : "";
      truncatedByChars = true;
    }
    charTotal += text.length;
    selected.push({ page: pNum, status: "text_ready", source: pObj.source || "text", text });
    if (truncatedByChars) break;
  }

  return {
    startPage: reqStart,
    endPage: clampedEnd,
    pageCount: total,
    pages: selected,
    ocrNeededPages,
    clampedByPageLimit,
    truncatedByChars,
  };
}

function formatDocumentStructureForTutor(doc, cfg = null, query = "") {
  if (!doc) return null;
  const baseName = doc.name;
  const ext = doc.ext;
  const sizeKb = Math.round((doc.size || 0) / 1024);

  if (doc.tooLarge) {
    const label =
      ext === ".pdf" ? `Documento PDF: ${baseName} (${sizeKb} KB) - arquivo muito grande para leitura completa` :
      ext === ".docx" ? `Documento Word: ${baseName} (${sizeKb} KB) - arquivo muito grande` :
      ext === ".pptx" ? `Slides PowerPoint: ${baseName} (${sizeKb} KB) - arquivo muito grande` :
      ext === ".odt" ? `Documento OpenDocument: ${baseName} (${sizeKb} KB) - arquivo muito grande` :
      ext === ".rtf" ? `Documento RTF: ${baseName} (${sizeKb} KB) - arquivo muito grande` :
      `Arquivo de apoio anexado: ${baseName} (${sizeKb} KB)`;
    return `[${label}]`;
  }

  if (doc.unsupported) {
    return `[Arquivo de apoio anexado: ${baseName} (${sizeKb} KB)]`;
  }

  if (ext === ".pdf") {
    if (doc.invalid) return `[Documento PDF inválido ou inacessível: ${baseName}]`;
    if (doc.scanned || doc.textPages === 0) {
      const pageLabel = doc.pageCount > 0 ? `, ${doc.pageCount} página${doc.pageCount > 1 ? "s" : ""}` : "";
      return `[Documento PDF escaneado (sem camada de texto legível, requer OCR): ${baseName} (${sizeKb} KB${pageLabel})]`;
    }
  } else if (doc.textPages === 0) {
    if (ext === ".docx") return `[Documento Word: ${baseName} (${sizeKb} KB)]`;
    if (ext === ".pptx") return `[Slides PowerPoint: ${baseName} (${sizeKb} KB)]`;
    if (ext === ".odt") return `[Documento OpenDocument: ${baseName} (${sizeKb} KB)]`;
    if (ext === ".rtf") return `[Documento RTF: ${baseName} (${sizeKb} KB)]`;
    return null;
  }

  const readyPages = doc.pages.filter((p) => p.status === "text_ready" && p.text);
  let extractedText;
  if ((ext === ".pdf" || ext === ".pptx") && doc.pageCount > 1) {
    const unit = ext === ".pptx" ? "Slide" : "Página";
    extractedText = readyPages.map((p) => `[${unit} ${p.page}]\n${p.text}`).join("\n\n");
    if (doc.ocrNeededPages && doc.ocrNeededPages.length > 0) {
      const listed = doc.ocrNeededPages.slice(0, 15).join(", ") + (doc.ocrNeededPages.length > 15 ? "..." : "");
      extractedText += `\n\n[Nota: ${unit.toLowerCase()}(s) ${listed} sem camada de texto legível — requerem OCR]`;
    }
  } else {
    extractedText = readyPages.map((p) => p.text).join("\n\n");
  }

  if (!extractedText) return null;

  if (cfg?.skills?.rtk?.enabled && cfg?.skills?.rtk?.applyToMaterials !== false) {
    extractedText = applyRtkMaterialFiltering(extractedText, ext, cfg.skills.rtk);
  }
  if (cfg?.skills?.headroom?.enabled && cfg?.skills?.headroom?.applyToContext !== false) {
    extractedText = applyHeadroomContextCompression(extractedText, ext, cfg.skills.headroom);
  }

  return formatDocumentForTutor(baseName, ext, extractedText, query);
}

async function extractTextFromMaterial(absPath, ext, cfg = null, query = "", cacheOpts = null) {
  try {
    const doc = await loadOrExtractDocument(absPath, ext, cacheOpts);
    if (!doc) return null;
    return formatDocumentStructureForTutor(doc, cfg, query);
  } catch {
    return null;
  }
}

module.exports = {
  DOC_CACHE_VERSION,
  COURSE_DOCS_DIR,
  detectPdfToText,
  extractPdfTextWithBinary,
  extractPdfPagesWithBinary,
  extractPdfPagesWithPdfJs,
  extractPdfPages,
  docCacheName,
  courseDocCachePath,
  mirrorDocCachePath,
  saveDocumentCache,
  loadOrExtractDocument,
  searchDocumentPages,
  readDocumentPagesRange,
  formatDocumentStructureForTutor,
  inspectPdfBuffer,
  cleanExtractedPdfText,
  parsePdfCMap,
  decodePdfLiteralString,
  decodePdfHexString,
  extractTextFromPdfBuffer,
  extractTextFromZipBuffer,
  extractTextFromDocxBuffer,
  extractTextFromPptxBuffer,
  extractTextFromOdtBuffer,
  extractTextFromRtf,
  chunkDocumentText,
  normalizeSearchTerm,
  retrieveRelevantDocumentChunks,
  formatDocumentForTutor,
  extractTextFromMaterial,
  PDFTOTEXT_BIN,
};
