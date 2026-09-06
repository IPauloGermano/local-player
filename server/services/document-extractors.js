// Extratores de Texto para PDFs, Documentos de Escritório (DOCX, PPTX, ODT, RTF) e Materiais de Apoio
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const zlib = require("zlib");
const { spawn, execFile } = require("child_process");
const {
  TUTOR_TEXT_EXTS,
  applyRtkMaterialFiltering,
  applyHeadroomContextCompression,
} = require("../ai/skills");

const APP_DIR = path.resolve(__dirname, "..", "..");
const FFMPEG_BIN_DIR = path.join(APP_DIR, "bin", "ffmpeg");

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

async function extractTextFromMaterial(absPath, ext, cfg = null, query = "") {
  try {
    const st = await fs.stat(absPath).catch(() => null);
    if (!st || !st.isFile()) return null;
    const baseName = path.basename(absPath);
    let extractedText = null;

    if (ext === ".pdf") {
      if (st.size > 50 * 1024 * 1024) {
        return `[Documento PDF: ${baseName} (${Math.round(st.size / 1024)} KB) - arquivo muito grande para leitura completa]`;
      }
      extractedText = await extractPdfTextWithBinary(absPath);
      if (!extractedText || extractedText.length < 10) {
        const buf = await fs.readFile(absPath).catch(() => null);
        if (buf) {
          const rawJsText = extractTextFromPdfBuffer(buf);
          const cleanedJsText = cleanExtractedPdfText(rawJsText);
          if (cleanedJsText && cleanedJsText.length >= 10) {
            extractedText = cleanedJsText;
          }
        }
      }

      if (!extractedText || extractedText.length < 10) {
        const buf = await fs.readFile(absPath).catch(() => null);
        const info = inspectPdfBuffer(buf);
        if (info.isValid) {
          const pageLabel = info.pages > 0 ? `, ${info.pages} página${info.pages > 1 ? "s" : ""}` : "";
          return `[Documento PDF escaneado (sem camada de texto legível, requer OCR): ${baseName} (${Math.round(st.size / 1024)} KB${pageLabel})]`;
        } else {
          return `[Documento PDF inválido ou inacessível: ${baseName}]`;
        }
      }
    } else if (ext === ".docx") {
      if (st.size > 50 * 1024 * 1024) {
        return `[Documento Word: ${baseName} (${Math.round(st.size / 1024)} KB) - arquivo muito grande]`;
      }
      const buf = await fs.readFile(absPath);
      const docxText = extractTextFromDocxBuffer(buf);
      if (docxText && docxText.length >= 10) {
        extractedText = docxText;
      } else {
        return `[Documento Word: ${baseName} (${Math.round(st.size / 1024)} KB)]`;
      }
    } else if (ext === ".pptx") {
      if (st.size > 50 * 1024 * 1024) {
        return `[Slides PowerPoint: ${baseName} (${Math.round(st.size / 1024)} KB) - arquivo muito grande]`;
      }
      const buf = await fs.readFile(absPath);
      const pptxText = extractTextFromPptxBuffer(buf);
      if (pptxText && pptxText.length >= 10) {
        extractedText = pptxText;
      } else {
        return `[Slides PowerPoint: ${baseName} (${Math.round(st.size / 1024)} KB)]`;
      }
    } else if (ext === ".odt") {
      if (st.size > 50 * 1024 * 1024) {
        return `[Documento OpenDocument: ${baseName} (${Math.round(st.size / 1024)} KB) - arquivo muito grande]`;
      }
      const buf = await fs.readFile(absPath);
      const odtText = extractTextFromOdtBuffer(buf);
      if (odtText && odtText.length >= 10) {
        extractedText = odtText;
      } else {
        return `[Documento OpenDocument: ${baseName} (${Math.round(st.size / 1024)} KB)]`;
      }
    } else if (ext === ".rtf") {
      if (st.size > 20 * 1024 * 1024) {
        return `[Documento RTF: ${baseName} (${Math.round(st.size / 1024)} KB) - arquivo muito grande]`;
      }
      const rawRtf = await fs.readFile(absPath, "latin1");
      const rtfText = extractTextFromRtf(rawRtf);
      if (rtfText && rtfText.length >= 10) {
        extractedText = rtfText;
      } else {
        return `[Documento RTF: ${baseName} (${Math.round(st.size / 1024)} KB)]`;
      }
    } else if (TUTOR_TEXT_EXTS.has(ext)) {
      if (st.size > 512 * 1024) {
        const fd = await fs.open(absPath, "r");
        try {
          const buf = Buffer.alloc(65536);
          const { bytesRead } = await fd.read(buf, 0, 65536, 0);
          extractedText = buf.toString("utf8", 0, bytesRead);
        } finally {
          await fd.close();
        }
      } else {
        extractedText = await fs.readFile(absPath, "utf8");
      }
    } else {
      return `[Arquivo de apoio anexado: ${baseName} (${Math.round(st.size / 1024)} KB)]`;
    }

    if (!extractedText) return null;

    if (cfg?.skills?.rtk?.enabled && cfg?.skills?.rtk?.applyToMaterials !== false) {
      extractedText = applyRtkMaterialFiltering(extractedText, ext, cfg.skills.rtk);
    }
    if (cfg?.skills?.headroom?.enabled && cfg?.skills?.headroom?.applyToContext !== false) {
      extractedText = applyHeadroomContextCompression(extractedText, ext, cfg.skills.headroom);
    }

    return formatDocumentForTutor(baseName, ext, extractedText, query);
  } catch (err) {
    return null;
  }
}

module.exports = {
  detectPdfToText,
  extractPdfTextWithBinary,
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
