// Servidor local do "Local Player": escaneia o conteúdo de mídia em disco
// (cursos, treinamentos, bibliotecas de vídeo etc.), expõe uma API de árvore
// de conteúdo, serve os vídeos/materiais com suporte a range requests
// (necessário para o <video>) e persiste o progresso do usuário.
// Os arquivos são servidos SEMPRE no formato original, direto do disco — sem
// transcodificação, conversão ou processamento (player local, como VLC).
const express = require("express");
const fs = require("fs/promises");
const fsSync = require("fs"); // API síncrona — usada só no shutdown (persistir antes do exit)
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, ".."); // pasta-pai do app (raiz da biblioteca)
const APP_DIR_NAME = path.basename(__dirname); // "_LocalPlayer" - ignorado no scan
// Override de dados (testes em sandbox): aponta progresso/caches/registry para
// um diretório temporário, sem tocar o data/ real. Uso normal não define a env.
const DATA_DIR = process.env.LP_DATA_DIR
  ? path.resolve(process.env.LP_DATA_DIR)
  : path.join(__dirname, "data");
const PROGRESS_FILE = path.join(DATA_DIR, "progress.json");
const PROGRESS_BACKUP_FILE = path.join(DATA_DIR, "progress.json.bak");
// Segunda geração de backup (rotação): escrito em momento diferente do bak,
// então uma remoção brusca do pendrive raramente o atinge junto dos demais.
const PROGRESS_BACKUP2_FILE = path.join(DATA_DIR, "progress.json.bak.1");
// Registry de bibliotecas: ÚNICA fonte das raízes permitidas (config confiável).
// Semeada com a biblioteca padrão (ROOT) na primeira execução — o usuário atual
// não configura nada. Mesmo contrato de durabilidade do progresso (atômico +
// .bak + .corrupt-<ts>).
const LIBRARIES_FILE = path.join(DATA_DIR, "libraries.json");
const DEFAULT_LIBRARY_ID = "default";
const PORT = process.env.PORT || 4173;
// Interface de escuta. Por padrão o servidor escuta em todas as interfaces
// (documentado no README: acesso pela rede local é comportamento atual).
// Para restringir à máquina local, defina HOST=127.0.0.1.
const HOST = process.env.HOST || undefined;
// Arquivo que express.static precisa servir para a SPA funcionar. Também é o
// sinal de presença do dispositivo: como vive dentro de __dirname (que está
// dentro de ROOT), ele some quando o pendrive é desmontado — é a sonda mais
// confiável de "dispositivo presente" (um fs.access(ROOT) isolado pode passar
// com o mount point vazio após um umount).
const SPA_INDEX_PATH = path.join(__dirname, "public", "index.html");

// --- Logs técnicos em memória (anel) ---
// Logs marcados [SUBTITLE]/[TRANSCODE]/[AI]/[SHUTDOWN]/[DEVICE]/[PROCESS] são
// espelhados num anel em memória para a Central de Diagnóstico (GET /api/logs).
// NUNCA são gravados em arquivo — invariante do projeto (log só em stdout).
const MAX_LOG_ENTRIES = 800;
const logBuffer = []; // { ts, level, tag, msg }
function logTagOf(msg) {
  const m = /^\[([A-Za-z]+)\]/.exec(String(msg || ""));
  return m ? m[1].toUpperCase() : "LOG";
}
function pushLogBuffer(level, msg) {
  logBuffer.push({ ts: Date.now(), level, tag: logTagOf(msg), msg: String(msg) });
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  }
}
// Espelha console.* marcado para o anel; o resto passa direto (o comportamento
// atual de stdout é preservado). Os call sites já sanitizam chaves/prompts.
const _lpConsoleLog = console.log;
const _lpConsoleError = console.error;
const _lpConsoleWarn = console.warn;
function lpLogLevelFromMsg(first, fallback) {
  if (first.includes("[ERROR]")) return "ERROR";
  if (first.includes("[WARN]")) return "WARN";
  if (first.includes("[INFO]")) return "INFO";
  return fallback;
}
function lpMirrorConsole(method, args, fallbackLevel) {
  const first = typeof args[0] === "string" ? args[0] : "";
  if (/^\[(SUBTITLE|TRANSCODE|AI|SHUTDOWN|PROCESS|DEVICE)\]/.test(first)) {
    pushLogBuffer(lpLogLevelFromMsg(first, fallbackLevel), args.map(String).join(" "));
  }
  return method.apply(console, args);
}
console.log = (...a) => lpMirrorConsole(_lpConsoleLog, a, "INFO");
console.warn = (...a) => lpMirrorConsole(_lpConsoleWarn, a, "WARN");
console.error = (...a) => lpMirrorConsole(_lpConsoleError, a, "ERROR");

// Transcoding de fallback (configurável por variável de ambiente — spec 22).
const TRANSCODE_DIR = path.join(DATA_DIR, "transcoded");
const MAX_CONCURRENT_TRANSCODES = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_TRANSCODES || "1", 10),
);
const FFMPEG_BIN_ENV = process.env.FFMPEG_BIN || "";
const FFPROBE_BIN_ENV = process.env.FFPROBE_BIN || "";
// Resolve o binário do ffmpeg/ffprobe: env > bin/ffmpeg/ (local ao app) > PATH.
// O fallback local torna extração de áudio e transcoding independentes do PATH
// do terminal (mesma filosofia do whisper em bin/) — ex.: o app num pendrive
// cujo terminal não tem ffmpeg instalado ainda funciona. Nunca toca o caminho
// do usuário.
const FFMPEG_BIN_DIR = path.join(__dirname, "bin", "ffmpeg");
function resolveToolBin(exeName, envPath) {
  if (envPath) return envPath;
  const candidates =
    process.platform === "win32" ? [exeName + ".exe", exeName] : [exeName];
  for (const n of candidates) {
    const local = path.join(FFMPEG_BIN_DIR, n);
    if (fsSync.existsSync(local)) return local;
  }
  return exeName; // cai para o PATH
}
const FFMPEG_BIN = resolveToolBin("ffmpeg", FFMPEG_BIN_ENV);
const FFPROBE_BIN = resolveToolBin("ffprobe", FFPROBE_BIN_ENV);
// Espera máxima por um seek que ainda não foi transcodificado.
const TRANSCODE_SEEK_WAIT_MS = 60000;
// Tempo máximo que o shutdown aguarda a fila de progresso drenar antes de
// encerrar (BUG-002): uma gravação pendente não pode ser descartada pelo exit,
// mas o shutdown nunca fica preso num disco irresponsivo.
const SHUTDOWN_PROGRESS_FLUSH_MS = 2000;

// Portão global de jobs pesados (transcode ffmpeg + whisper compartilham o
// MESMO semáforo, então nunca rodam simultaneamente por padrão — spec 38.5).
// LLM (rede, não CPU pesada) NÃO consome slot. O valor pode ser ajustado em
// tempo de execução pela config (advanced.maxConcurrentAiJobs) via refresh.
const MAX_CONCURRENT_AI_JOBS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_AI_JOBS || "1", 10),
);
let heavyMax = MAX_CONCURRENT_AI_JOBS;
const heavySlots = { used: 0, waiters: [] };
function acquireHeavySlot() {
  return new Promise((resolve) => {
    if (heavySlots.used < heavyMax) {
      heavySlots.used++;
      resolve(releaseHeavySlot);
    } else {
      heavySlots.waiters.push(resolve);
    }
  });
}
function releaseHeavySlot() {
  heavySlots.used = Math.max(0, heavySlots.used - 1);
  const next = heavySlots.waiters.shift();
  if (next) {
    heavySlots.used++;
    next(releaseHeavySlot);
  }
}
function refreshHeavyMax(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 1) heavyMax = Math.min(8, Math.floor(n));
}

const VIDEO_EXT = new Set([
  ".mp4",
  ".mkv",
  ".webm",
  ".mov",
  ".avi",
  ".m4v",
  ".wmv",
]);
const IMAGE_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
]);
// Tipos com CONTEÚDO ATIVO que o navegador pode executar quando renderizados no
// top-level (HTML/SVG/XML/JS/JSON). Materiais desses tipos são servidos como
// download (Content-Disposition: attachment) para nunca rodarem no origin da
// app; `X-Content-Type-Options: nosniff` cobre o restante (anti MIME-sniff).
const ACTIVE_EXT = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".svg",
  ".xml",
  ".js",
  ".mjs",
  ".json",
]);
const IGNORED_EXT = new Set([".ini", ".db", ".lnk"]);
const COVER_NAME_HINTS = [
  "cover",
  "thumbnail",
  "poster",
  "banner",
  "image",
  "img",
];

// Cache de árvore POR biblioteca (multi-biblioteca). Uma biblioteca indisponível
// não corrompe o cache das demais; `POST /api/libraries/:id/rescan` força só a
// dela. A árvore padrão (ROOT) vive aqui com o mesmo id de antes.
const treeCaches = new Map(); // libraryId -> { status, error, tree, lastScanAt }

function naturalSort(a, b) {
  return a.name.localeCompare(b.name, "pt-BR", {
    numeric: true,
    sensitivity: "base",
  });
}

// ──────────────────────────────────────────────────────────────────────
// Normalização de títulos de exibição (cursos, módulos e aulas)
//
// O objetivo é que todo título pareça escrito para a plataforma, e não
// importado de arquivos/Telegram. Regras:
//   • remove extensões de vídeo e sufixos de autoria (" - By @canal");
//   • remove prefixos simbólicos ("== ", "### ", "-- ", "** ", "> ", "_", "=");
//   • remove rótulos ("Aula 03 - ", "Módulo 1 - ") quando sobra título;
//     o rótulo só é removido se vier SEGUIDO DE NÚMERO — assim títulos
//     legítimos como "Aula Magna", "Parte Diversa", "Módulo Python" ou
//     "Vídeo Aulas de Física" não são mutilados (BUG-004);
//   • remove numeração do início — a interface não exibe números, então
//     nenhum título começa com número, símbolo ou separador;
//   • remove truncamentos ("Arq..." -> "Arq") e separadores soltos;
//   • capitalização de sentença em português, preservando siglas e nomes
//     próprios de tecnologia (SQL, Python, PostgreSQL, …).
// O nome original (`name`) nunca é alterado: ele continua guiando a
// ordenação (naturalSort) e é indexado pela busca.
// ──────────────────────────────────────────────────────────────────────

const VIDEO_EXT_STRIP_RE =
  /(?:\.(?:mp4|mkv|webm|avi|mov|m4v|ts|flv|wmv|mpg|mpeg))+$/i;
const LEADING_JUNK_RE = /^[^\wÀ-ÿ]+/; // "==", "###", "--", "**", ">", "_", "=", emojis…
// BUG-004: o rótulo só é considerado prefixo quando seguido de número
// (`\d{1,3}`) — e esse número não pode ser parte de um composto ("1.1"),
// senão "Aula 1.1 - X" seria mutilado como antes.
const LEADING_LABEL_RE =
  /^\s*(?:aula|lesson|m[oó]dulo|parte|cap[ií]tulo|v[ií]deo|video)\s*[:\-–—]?\s*\d{1,3}(?![\d.])\s*[-:–—]?\s*/i;
// Sufixo de autoria (" - By @canal", " - por Telegram"). Exige separador
// antes de "by"/"por" e não considera frases como "Por que…" / "Por
// exemplo…", que são início de conteúdo e não atribuição.
const AUTHOR_SUFFIX_RE =
  /\s+[-–—|•·]\s*\b(?:by|por)\b(?!\s+(?:que|quê|quando|exemplo|isso)\b)\s+\S.*$/i;
const TRAILING_DOTS_RE = /\.{2,}$|…+$/;

// Siglas e nomes próprios preservados na capitalização (aplicados por
// ordem de tamanho decrescente para evitar colisões tipo "node" em "node.js").
const TITLE_KEEP_CASE = {
  "node.js": "Node.js",
  "scikit-learn": "scikit-learn",
  "postgresql": "PostgreSQL",
  "javascript": "JavaScript",
  "typescript": "TypeScript",
  "kubernetes": "Kubernetes",
  "matplotlib": "Matplotlib",
  "tensorflow": "TensorFlow",
  "mongodb": "MongoDB",
  "powerpoint": "PowerPoint",
  "github": "GitHub",
  "gitlab": "GitLab",
  "sqlite": "SQLite",
  "airflow": "Airflow",
  "jupyter": "Jupyter",
  "leetcode": "LeetCode",
  "pgadmin": "pgAdmin",
  "postman": "Postman",
  "mysql": "MySQL",
  "pandas": "Pandas",
  "seaborn": "Seaborn",
  "numpy": "NumPy",
  "android": "Android",
  "telegram": "Telegram",
  "asimov": "Asimov",
  "galego": "Galego",
  "juniors": "Juniors",
  "nocode": "NoCode",
  "startup": "StartUp",
  "ti": "TI",
  "python": "Python",
  "docker": "Docker",
  "linux": "Linux",
  "windows": "Windows",
  "macos": "macOS",
  "redis": "Redis",
  "react": "React",
  "angular": "Angular",
  "azure": "Azure",
  "https": "HTTPS",
  "html": "HTML",
  "http": "HTTP",
  "json": "JSON",
  "apis": "APIs",
  "css": "CSS",
  "xml": "XML",
  "pdf": "PDF",
  "csv": "CSV",
  "url": "URL",
  "uri": "URI",
  "oop": "OOP",
  "svg": "SVG",
  "etl": "ETL",
  "s.o.": "S.O.",
  "3d": "3D",
  "2d": "2D",
  "4k": "4K",
  "hd": "HD",
  "api": "API",
  "sql": "SQL",
  "php": "PHP",
  "vue": "Vue",
  "git": "Git",
  "node": "Node",
  "ide": "IDE",
  "cli": "CLI",
  "dom": "DOM",
  "db": "DB",
  "ui": "UI",
  "ux": "UX",
  "js": "JS",
  "ai": "AI",
  "excel": "Excel",
  "n8n": "n8n",
  "claude": "Claude",
  "dags": "DAGs",
  "dag": "DAG",
  "jwt": "JWT",
  "acl": "ACL",
  "rbac": "RBAC",
  "mvc": "MVC",
  "rclone": "RClone",
  "cron": "Cron",
  "compose": "Compose",
  "schiphol": "Schiphol",
  "hostinger": "Hostinger",
  "whatsapp": "WhatsApp",
  "openai": "OpenAI",
  "jetbrains": "JetBrains",
  "dockerhub": "Docker Hub",
};

const TITLE_CASE_ENTRIES = Object.entries(TITLE_KEEP_CASE).sort(
  (a, b) => b[0].length - a[0].length,
);

// Remove numeração/índices do início do título, repetidamente:
//   "01 - 1.1 - Título"        -> "Título"
//   "04 - 08 ETL básico"       -> "ETL básico"
//   "03_3 Construindo caminhos"-> "Construindo caminhos"
//   "2.1 - Extras"             -> "Extras"
//   "1.2 Claude Chat"          -> "Claude Chat"
//   "1 Arquivos e caminhos"    -> "Arquivos e caminhos"
//   "10 - 1 Copiando arquivos" -> "Copiando arquivos"
// Números que fazem parte do conteúdo são preservados: "3D Modelagem",
// "4K Vídeos", "9.5 título" (decimal seguido de minúscula).
function removeLeadingNumbering(t) {
  let sawNumbering = false;
  for (let guard = 0; guard < 6; guard++) {
    // "1.1 - Título": decimal/seção seguido de separador
    const decimalSep = t.match(
      /^\s*\d{1,3}\.\d{1,3}(?!\d)\s*[-–—_.:)\]][-\s]*/,
    );
    if (decimalSep) {
      sawNumbering = true;
      t = t.slice(decimalSep[0].length);
      continue;
    }
    // "1.2 Claude Chat": decimal seguido de início de título
    const decimalCap = t.match(/^\s*\d{1,3}\.\d{1,3}(?!\d)\s+(?=[A-ZÀ-Ú])/);
    if (decimalCap) {
      sawNumbering = true;
      t = t.slice(decimalCap[0].length);
      continue;
    }
    // "9.5 título": decimal sem separador seguido de minúscula é conteúdo
    if (/^\s*\d{1,3}\.\d{1,3}(?!\d)\s+(?=[a-zà-ú0-9("])/.test(t)) break;
    // "03 - Título", "03. Título", "03_Título", "2) Título"
    const simpleSep = t.match(/^\s*\d{1,3}(?!\d)\s*(?:[-–—_.:)\]][-\s]*|_\s*)/);
    if (simpleSep) {
      sawNumbering = true;
      t = t.slice(simpleSep[0].length);
      continue;
    }
    // "08 ETL básico" — zero à esquerda + espaço (numeração sem separador)
    const padded = t.match(/^\s*(0\d{1,2})\s+(?=\S)/);
    if (padded) {
      sawNumbering = true;
      t = t.slice(padded[0].length);
      continue;
    }
    // "1 Arquivos e caminhos" / "11 [PROJETO] X" — número + título.
    // Quando já houve numeração, um número solto seguinte é sempre
    // numeração duplicada ("10 - 1 Copiando", "12 - 7 quiz") — mesmo
    // que o título venha em minúscula.
    const plain =
      t.match(/^\s*\d{1,3}(?!\d)\s+(?=[A-ZÀ-Ú[(])/) ||
      (sawNumbering && t.match(/^\s*\d{1,3}(?!\d)\s+(?=\S)/));
    if (plain) {
      sawNumbering = true;
      t = t.slice(plain[0].length);
      continue;
    }
    break;
  }
  return t.trim();
}

// Capitalização de sentença (padrão de títulos em português): primeira
// letra maiúscula, resto minúsculo, exceto siglas/nomes preservados.
//   "blocos de código e operadores" -> "Blocos de código e operadores"
//   "FUNÇÕES LAMBDA"                -> "Funções lambda"
function toDisplayCase(t) {
  let s = String(t || "").toLowerCase();
  for (const [key, canon] of TITLE_CASE_ENTRIES) {
    s = s.replace(
      new RegExp(`(?<![A-Za-zÀ-ÿ0-9])${key}(?![A-Za-zÀ-ÿ0-9])`, "g"),
      canon,
    );
  }
  // Primeira palavra preservada em minúsculas ("n8n", "macOS", "pgAdmin",
  // "scikit-learn") mantém a forma oficial da marca — sem forçar maiúscula.
  const firstWord = s.match(/^\S+/);
  if (
    firstWord &&
    TITLE_KEEP_CASE[firstWord[0].toLowerCase()] === firstWord[0]
  ) {
    return s;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Captura o número do módulo/tópico ANTES da normalização, para ser
// mantido na exibição ("01 - Introdução à Lógica" -> número "01",
// "1.2 Claude Chat" -> "1.2"). Deve ser chamado após remover o prefixo
// simbólico inicial ("== " etc.).
function captureModuleNumber(t) {
  const m = t.match(
    /^\s*(\d{1,3}(?:\.\d{1,3})?)(?![\d.])\s*(?:[-–—_.:)\]][-\s]*|_\s*|\s+)/,
  );
  return m ? m[1] : null;
}

// Pipeline única de normalização do título de exibição (cursos, módulos
// e aulas). O nome original do arquivo/pasta permanece intacto.
// `keepNumber`: módulos/tópicos mantêm o número do início ("01 - Título")
// para o usuário saber em qual está; o restante continua sendo normalizado.
function normalizeDisplayTitle(rawName, opts = {}) {
  const { isVideo = false, keepNumber = false } = opts;
  let t = String(rawName || "").trim();
  if (isVideo) t = t.replace(VIDEO_EXT_STRIP_RE, "");
  // Sufixo explícito de tópico "(TP)" no final do nome real da pasta:
  // removido SÓ do título de exibição (o `name` original permanece intacto —
  // a classificação de tipo acontece no scan). Vídeos não são afetados.
  if (!isVideo) t = t.replace(/\(TP\)\s*$/i, "").trim();
  // truncamento: "Lendo e Escrevendo Arq..." -> "Lendo e Escrevendo Arq"
  t = t.replace(TRAILING_DOTS_RE, "");
  let moduleNumber = null;
  if (keepNumber) {
    moduleNumber = captureModuleNumber(t.replace(LEADING_JUNK_RE, ""));
  }
  for (let guard = 0; guard < 8 && t; guard++) {
    const before = t;
    t = t.replace(LEADING_JUNK_RE, "");
    const label = t.match(LEADING_LABEL_RE);
    if (label) {
      const remainder = t.slice(label[0].length);
      // proteção: "Aula 1.1" (número composto) ou rótulo isolado
      // ("Parte 2") não são prefixos removíveis — seriam o próprio título.
      if (remainder && !/^[.\d]/.test(remainder)) t = remainder;
    }
    t = t.replace(AUTHOR_SUFFIX_RE, "");
    // Numeração inicial removida para todos os tipos (cursos, módulos e
    // tópicos): "1. Language" -> "Language".
    t = removeLeadingNumbering(t);
    // "01 - 1AULA~1.mp4": sufixo de nome curto 8.3 do Windows (artefato)
    t = t.replace(/\s*~\d+\s*$/, "");
    // "[PROJETO] X", "[ATUALIZADO] X": tags em colchetes no início
    t = t.replace(/^\s*\[[^\]]{1,40}\]\s*/, "");
    // "_" entre palavras era separador no título original (sanitização de
    // nomes de arquivo no Windows/Telegram): "Python_ Conceitos" ->
    // "Python Conceitos", "scripts_de_aulas" -> "scripts de aulas"
    t = t.replace(/_/g, " ");
    t = t.replace(/\s{2,}/g, " ");
    t = t.replace(/^\s*[-–—_.:)\]|•·]+\s*|\s*[-–—_.:)\]|•·]+\s*$/g, " ");
    t = t.trim();
    if (t === before) break;
  }
  if (!t) return String(rawName || "").trim();
  t = toDisplayCase(t);
  if (moduleNumber) {
    const num = moduleNumber.includes(".")
      ? moduleNumber
      : moduleNumber.padStart(2, "0");
    return t ? `${num} - ${t}` : num;
  }
  // "01 - 1.mp4": aula sem conteúdo — mostra só a numeração, sem duplicar
  if (/^\d{1,3}$/.test(t)) return t.padStart(2, "0");
  return t;
}

function pickCoverImage(entries, relDir) {
  const candidates = [];
  for (const entry of entries) {
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    const lowerName = entry.name.toLowerCase();
    const hintScore = COVER_NAME_HINTS.some((hint) => lowerName.includes(hint))
      ? 100
      : 0;
    candidates.push({ relPath, score: hintScore, name: lowerName });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates[0].relPath;
}

function chooseCoverImage(currentCover, childCovers) {
  const candidates = [];
  if (currentCover) {
    candidates.push({ relPath: currentCover, score: 200, name: currentCover });
  }
  for (const childCover of childCovers) {
    if (!childCover) continue;
    candidates.push({
      relPath: childCover.relPath,
      score: childCover.score,
      name: childCover.name,
    });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates[0].relPath;
}

// BUG-005: stats do scan com concorrência limitada. Em bibliotecas grandes o
// fs.stat sequencial é o gargalo do scan (medido: ~5x mais lento que um pool
// pequeno neste pendrive), mas disparar tudo de uma vez explode o número de
// file descriptors abertos. Este pool executa `fn` sobre `items` com no
// máximo `limit` chamadas simultâneas e preserva a ordem por índice.
const SCAN_STAT_CONCURRENCY = 16;
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const count = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function scanDir(absDir, relDir) {
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return { children: [], videoCount: 0, coverImage: null, type: "folder" };
  }

  const dirs = [];
  const files = [];
  // Marcador explícito `.topic` (arquivo vazio) dentro da pasta declara que
  // ela é um TÓPICO. É dotfile: ignorado pelo scan (nunca vira material nem
  // resultado de busca) e pelo static — não pode ser confundido com
  // `.courseplayer` (pasta de artefatos de legenda, propósito diferente).
  let hasTopicMarker = false;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      if (entry.name === ".topic" && !entry.isDirectory()) hasTopicMarker = true;
      continue;
    }
    if (relDir === "" && entry.name === APP_DIR_NAME) continue;
    // Sem suporte a symlinks/junctions (invariante multiplataforma): um link
    // dentro da biblioteca pode apontar para FORA dela. Não indexar diretórios
    // linkados (evita recursão fora da raiz) nem arquivos linkados (não podem
    // ser servidos/processados). O realpath containment no serve/processo é a
    // segunda barreira para paths vindos do frontend.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) dirs.push(entry);
    else files.push(entry);
  }
  dirs.sort(naturalSort);
  files.sort(naturalSort);

  const children = [];
  let videoCount = 0;
  const childCoverCandidates = [];

  for (const entry of dirs) {
    const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const entryAbs = path.join(absDir, entry.name);
    const sub = await scanDir(entryAbs, entryRel);
    videoCount += sub.videoCount;
    children.push({
      // Classificação explícita: "topic" (marcador `.topic` ou nome com "(TP)")
      // ou "folder" (curso/module — comportamento normal). Sem heurística.
      type: sub.type,
      name: entry.name,
      path: entryRel,
      // Tópicos: título normalizado sem prefixo de módulo e sem numeração
      // inicial ("1. Language" -> "Language", "(TP)" removido); a primeira
      // letra vem sempre maiúscula (toDisplayCase). Módulos/cursos mantêm a
      // numeração.
      title: normalizeDisplayTitle(
        entry.name,
        sub.type === "topic"
          ? { keepNumber: false }
          : { keepNumber: true },
      ),
      children: sub.children,
      videoCount: sub.videoCount,
      coverImage: sub.coverImage,
    });
    if (sub.coverImage) {
      childCoverCandidates.push({
        relPath: sub.coverImage,
        score: 50,
        name: sub.coverImage.toLowerCase(),
      });
    }
  }

  const directCover = pickCoverImage(files, relDir);

  // Filtra antes de estat: ignora extensões e a capa direta (mesma lógica
  // sequencial anterior), montando a lista de candidatos com os dados fixos.
  const candidates = [];
  for (const entry of files) {
    const ext = path.extname(entry.name).toLowerCase();
    if (IGNORED_EXT.has(ext)) continue;
    const entryRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    // A imagem de capa/banner é usada como thumbnail do card, não deve
    // aparecer como material na sidebar nem nos resultados de busca.
    if (entryRel === directCover) continue;
    candidates.push({ entry, ext, entryRel });
  }

  // BUG-005: os stats rodam em paralelo com limite de concorrência; a ordem
  // é preservada (mapLimit preenche por índice), então os filhos continuam
  // na mesma ordem de `files.sort(naturalSort)`. Arquivo que some/ilegível
  // no meio do scan vira size === null e é pulado — como o `continue` antes.
  const sizes = await mapLimit(candidates, SCAN_STAT_CONCURRENCY, async (c) => {
    try {
      return (await fs.stat(path.join(absDir, c.entry.name))).size;
    } catch {
      return null;
    }
  });

  for (let i = 0; i < candidates.length; i++) {
    const { entry, ext, entryRel } = candidates[i];
    const size = sizes[i];
    if (size === null) continue;
    if (VIDEO_EXT.has(ext)) {
      videoCount += 1;
      children.push({
        type: "video",
        name: entry.name,
        path: entryRel,
        ext,
        size,
        // Título de exibição já normalizado (prefixos, numeração e
        // capitalização padronizados), calculado na camada de dados — vale
        // para todos os cursos, atuais e futuros, e evita duplicar a
        // lógica em cada ponto de renderização.
        title: normalizeDisplayTitle(entry.name, { isVideo: true }),
      });
    } else {
      children.push({
        type: "file",
        name: entry.name,
        path: entryRel,
        ext,
        size,
      });
    }
  }

  // Classificação explícita e previsível (sem inferência estrutural):
  //   - arquivo `.topic` dentro da pasta  ⇒ TÓPICO
  //   - nome real terminando em "(TP)"    ⇒ TÓPICO
  //   - senão                             ⇒ folder (curso/módulo normal)
  // Todo o restante (conteúdo direto, subpastas, profundidade, contagens de
  // vídeo/aula) NÃO influencia. O `name` real nunca muda; "(TP)" é removido
  // só do título de exibição em normalizeDisplayTitle.
  const isTopicBySuffix = /\(TP\)\s*$/i.test(path.basename(absDir));
  const type = hasTopicMarker || isTopicBySuffix ? "topic" : "folder";

  const coverImage = chooseCoverImage(directCover, childCoverCandidates);

  return { children, videoCount, coverImage, type };
}

// Scan de UMA biblioteca com try/catch próprio: uma biblioteca indisponível
// retorna { status:"unavailable", error } sem lançar e não derruba as demais.
async function scanLibrary(lib) {
  try {
    // Caminho inexistente/inacessível ⇒ unavailable. O scanDir sozinho
    // engoliria ENOENT e devolveria árvore vazia com status "ok", mascarando
    // um drive desmontado como biblioteca válida sem cursos.
    const st = await fs.stat(lib.path);
    if (!st.isDirectory()) {
      return { status: "unavailable", error: "not a directory", tree: null };
    }
    const result = await scanDir(lib.path, "");
    return {
      status: "ok",
      error: null,
      tree: {
        children: result.children,
        videoCount: result.videoCount,
        scannedAt: Date.now(),
      },
    };
  } catch (err) {
    return {
      status: "unavailable",
      error: sanitizeTestError(err.message || "scan error"),
      tree: null,
    };
  }
}

// Re-escaneia UMA biblioteca (deduplicado por id) e atualiza o cache dela.
// Retorna o summary com status/lastScanAt/error atuais.
async function rescanLibrary(lib) {
  if (scanningLibraryIds.has(lib.id)) {
    // Scan já em andamento: devolve o estado atual sem duplicar.
    return librarySummary(lib, treeCaches.get(lib.id) || {});
  }
  scanningLibraryIds.add(lib.id);
  try {
    const scanned = await scanLibrary(lib);
    scanned.lastScanAt = Date.now();
    treeCaches.set(lib.id, scanned);
    return librarySummary(lib, scanned);
  } finally {
    scanningLibraryIds.delete(lib.id);
  }
}

// Árvore consolidada (opção A da auditoria): lista de { library, tree }.
// Scan SEQUENCIAL das bibliotecas habilitadas (pendrive/disco externo: paralelo
// martela o barramento/USB). `force` re-escaneia tudo; desativadas não escaneiam.
async function getTree(force) {
  await loadLibraries();
  const libraries = getLibraries().filter((l) => l.enabled !== false);
  const results = [];
  for (const lib of libraries) {
    const cached = treeCaches.get(lib.id);
    if (!cached || force) {
      results.push(await rescanLibrary(lib));
    } else {
      results.push(librarySummary(lib, cached));
    }
  }
  return { libraries: results };
}

// Garante que um caminho relativo pedido pelo cliente não escapa da raiz da
// biblioteca. `base` opcional ancorra a resolução no path canônico de uma
// biblioteca (default: ROOT — caso particular da biblioteca padrão).
function resolveSafeRelPath(relPath, base) {
  if (typeof relPath !== "string" || !relPath) return null;
  const normalized = path.normalize(relPath).replace(/^([/\\])+/, "");
  const rootBase = base || ROOT;
  const abs = path.resolve(rootBase, normalized);
  if (abs !== rootBase && !abs.startsWith(rootBase + path.sep)) return null;
  // `rel` é SEMPRE canônico com "/" — mesmo formato da árvore do scan e das
  // URLs (multiplataforma). No Windows, `path.normalize` devolveria "\" e as
  // chaves de progresso deixariam de bater com os paths vindos do scan. O
  // `abs` mantém o separador nativo porque é o que o filesystem consome.
  return { abs, rel: normalized.split(path.sep).join("/") };
}

// Análogo ao resolveSafeRelPath, ancorado no path CANÔNICO de uma biblioteca
// (config confiável) — nunca num path enviado pelo navegador. O rel volta com
// "/" (mesmo contrato); `abs` com o separador nativo do filesystem.
function resolveLibraryRel(lib, rel) {
  if (!lib || typeof lib.path !== "string" || !lib.path) return null;
  return resolveSafeRelPath(rel, lib.path);
}

// Requer que o arquivo esteja DENTRO do path canônico da biblioteca depois de
// resolver symlinks/junctions (realpath). `resolveSafeRelPath` é puramente
// lexical: um symlink DENTRO da biblioteca apontando para fora (ex.:
// link → /etc/passwd, link → o data/ de outra biblioteca) passaria por ele e o
// sendFile/ffmpeg/whisper seguiria o link. Este check fecha a brecha em todos
// os pontos que ABREM o arquivo — nunca servir/processar um alvo que escapa da
// biblioteca autorizada. Sem dependência de suporte a symlink (multiplataforma).
async function fileWithinLibrary(lib, abs) {
  if (!lib || typeof lib.path !== "string" || !lib.path || !abs) return false;
  let realDir;
  try {
    realDir = await fs.realpath(lib.path);
  } catch {
    return false;
  }
  let realFile;
  try {
    realFile = await fs.realpath(abs);
  } catch {
    return false;
  }
  const sep = path.sep;
  const normEnd = (p) => (p.endsWith(sep) ? p.slice(0, -1) : p);
  const rd = normEnd(realDir);
  return realFile === rd || realFile.startsWith(rd + sep);
}

// BUG-001: o primeiro segmento do rel canônico é a pasta do app? O app vive
// DENTRO de ROOT, então `resolveSafeRelPath` deixa passar `_LocalPlayer/*`;
// este check fecha essa brecha em qualquer rota que resolva path de cliente.
// Só se aplica à biblioteca PADRÃO (a única que contém a pasta do app): numa
// biblioteca externa, uma pasta literalmente chamada "_LocalPlayer" não é o
// app e não deve ser bloqueada. Case-exato no Linux, case-insensitive no
// Windows (filesystem nativo).
function isAppDirRel(safe, lib) {
  if (!safe || !safe.abs) return false;
  const appPath = path.resolve(__dirname);
  const safeAbs = path.resolve(safe.abs);
  return safeAbs === appPath || safeAbs.startsWith(appPath + path.sep);
}

// Lê um arquivo JSON e valida a forma esperada (objeto não-vazio). `raw` é
// preservado para distinguir "arquivo inexistente" de "arquivo corrompido".
async function readJsonFile(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false, raw: null, parsed: null };
  }
  try {
    const parsed = JSON.parse(raw);
    const ok = parsed && typeof parsed === "object" && !Array.isArray(parsed);
    return { ok, raw, parsed: ok ? parsed : null };
  } catch {
    // JSON inválido: o arquivo existe mas está corrompido.
    return { ok: false, raw, parsed: null };
  }
}

// Lê o progresso com recuperação automática. O bug crítico anterior: um
// arquivo corrompido (desligamento brusco, pendrive desmontado no meio de
// uma escrita) era interpretado como progresso vazio, e a próxima escrita
// "desmarcava" todas as aulas. Agora o arquivo danificado é preservado e o
// estado é restaurado do backup.
async function readProgress() {
  const main = await readJsonFile(PROGRESS_FILE);
  if (main.ok) return main.parsed;

  if (main.raw !== null) {
    console.error(
      "progress.json corrompido; preservando o arquivo e recuperando do backup…",
    );
    await fs
      .rename(PROGRESS_FILE, `${PROGRESS_FILE}.corrupt-${Date.now()}`)
      .catch(() => {});
  }

  // Cadeia de backups: bak é o estado anterior ao save mais recente; bak.1 o
  // anterior a esse. Escritos em momentos distintos — numa remoção brusca do
  // pendrive vfat é raro que main, bak e bak.1 sejam zerados juntos, então a
  // recuperação sempre tenta o backup mais novo que ainda estiver íntegro.
  for (const backupFile of [PROGRESS_BACKUP_FILE, PROGRESS_BACKUP2_FILE]) {
    const backup = await readJsonFile(backupFile);
    if (backup.ok) return backup.parsed;

    if (backup.raw !== null) {
      console.error(
        `${path.basename(backupFile)} corrompido; preservando e tentando o próximo…`,
      );
      await fs
        .rename(backupFile, `${backupFile}.corrupt-${Date.now()}`)
        .catch(() => {});
    }
  }
  return {};
}

// Restaura o arquivo PRINCIPAL de progresso a partir do melhor backup válido
// quando o principal está ausente/corrompido. Regra de negócio (caso B do
// recovery): "progress.json ausente + backup válido → restaurar backup". O
// arquivo corrompido é preservado como `.corrupt-<ts>` (evidência para
// diagnóstico — nunca apagado). Só é chamado no boot (initPersistence), antes
// de o servidor aceitar saves, então não há corrida com a fila de escrita.
// Retorna true quando restaurou. Nunca sobrescreve um principal VÁLIDO.
async function restoreProgressFromBackup() {
  const main = await readJsonFile(PROGRESS_FILE);
  if (main.ok) return false; // principal válido — nada a fazer

  if (main.raw !== null) {
    // Corrompido (existe mas não é JSON válido): preserva a evidência.
    console.error(
      "progress.json corrompido; preservando o arquivo e restaurando do backup…",
    );
    await fs
      .rename(PROGRESS_FILE, `${PROGRESS_FILE}.corrupt-${Date.now()}`)
      .catch(() => {});
  }

  for (const backupFile of [PROGRESS_BACKUP_FILE, PROGRESS_BACKUP2_FILE]) {
    const backup = await readJsonFile(backupFile);
    if (backup.ok) {
      console.log(
        `[PROGRESS] recovery: restaurando progresso de ${path.basename(backupFile)}`,
      );
      await writeFileAtomic(PROGRESS_FILE, backup.raw);
      return true;
    }
    // Backup corrompido: preserva a evidência (.corrupt-<ts>) e tenta o
    // próximo na cadeia — nunca apaga arquivo danificado (diagnóstico).
    if (backup.raw !== null) {
      console.error(
        `${path.basename(backupFile)} corrompido; preservando e tentando o próximo…`,
      );
      await fs
        .rename(backupFile, `${backupFile}.corrupt-${Date.now()}`)
        .catch(() => {});
    }
  }
  return false;
}

// Escrita atômica e durável: o conteúdo vai para um arquivo temporário
// exclusivo, é sincronizado no disco (fsync) e só então renomeado sobre o
// destino. O fsync antes do rename garante que os dados sobrevivam a um
// desligamento brusco (restart do sistema, queda de energia, desmontagem do
// pendrive) — sem ele, o kernel pode descartar o buffer não sincronizado e
// o arquivo final fica truncado/corrompido.
async function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  try {
    const dirFh = await fs.open(dir, "r");
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close();
    }
  } catch {
    // fsync de diretório não é suportado em todos os sistemas/filesystems;
    // sem ele a escrita atômica continua funcionando.
  }
}

// Versão SÍNCRONA da escrita atômica, usada apenas no shutdown (o processo
// está sendo encerrado e não pode esperar I/O async). Mesmo contrato:
// temporário exclusivo → fsync → rename sobre o destino. Se a energia cair no
// meio, o jobs.json original permanece íntegro (nunca fica truncado).
function writeFileAtomicSync(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fsSync.openSync(tmp, "w", 0o644);
    fsSync.writeSync(fd, content, null, "utf8");
    fsSync.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd); } catch {}
    }
  }
  fsSync.renameSync(tmp, file);
}

// Durabilidade no vfat: fsync+rename da writeFileAtomic não garantem que a
// tabela FAT/entrada de diretório chegou ao dispositivo físico — numa remoção
// brusca o progress.json e o backup podem ser zerados juntos. `sync -f`
// (syncfs do Linux, coreutils) força o flush de TODA a filesystem que contém
// o arquivo, fechando essa janela. Fire-and-forget coalescido (um sync por
// vez): não atrasa a resposta do save nem bloqueia durante transcodes ativos
// gravando no mesmo volume; no momento em que o usuário puxa o pendrive
// (segundos após parar), o flush em background (15ms–~500ms) já completou.
let volumeSyncRunning = false;
function requestVolumeSync(file) {
  if (process.platform !== "linux" || volumeSyncRunning) return;
  volumeSyncRunning = true;
  try {
    const child = spawn("sync", ["-f", file], { stdio: "ignore" });
    const done = () => {
      volumeSyncRunning = false;
    };
    child.on("exit", done);
    child.on("error", done);
  } catch {
    volumeSyncRunning = false;
  }
}

// Escritas serializadas (fila): o corpo da task SÓ roda depois da anterior
// terminar (execução deferida), tornando o read-modify-write atômico e
// evitando colisão no arquivo temporário. `opts.allowShrink` habilita a única
// operação que pode REMOVER chaves (o clear explícito). `opts.
// allowCompletedRegression` habilita o toggle manual de conclusão (o ✓ da
// sidebar). Todo o resto é protegido contra escrita regressiva POR CONTEÚDO.
let progressWriteQueue = Promise.resolve();

// sha256 curto do estado serializado — identifica exatamente quando o arquivo
// muda entre duas escritas (forense).
function progressHash(obj) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex")
    .slice(0, 16);
}

// Diferença entre dois estados de progresso (forense + guarda regressiva).
// Devolve os grupos de mudança; não imprime valores além das chaves.
function progressDiff(before, after) {
  const bKeys = new Set(Object.keys(before));
  const aKeys = new Set(Object.keys(after));
  const removed = [];
  const added = [];
  const changed = [];
  const completedRegressions = []; // completed true → não-true
  const durationLost = []; // duration válida (>0) → ausente/0
  const positionAbsent = []; // position válida → ausência
  for (const k of bKeys) {
    if (!aKeys.has(k)) { removed.push(k); continue; }
    const b = before[k];
    const a = after[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changed.push(k);
      if (b && a && typeof b === "object" && typeof a === "object") {
        if (b.completed === true && a.completed !== true) completedRegressions.push(k);
        if (Number.isFinite(b.duration) && b.duration > 0 && !(Number.isFinite(a.duration) && a.duration > 0)) durationLost.push(k);
        if (Number.isFinite(b.position) && b.position >= 0 && (a.position === undefined || a.position === null || !Number.isFinite(a.position))) positionAbsent.push(k);
      }
    }
  }
  for (const k of aKeys) if (!bKeys.has(k)) added.push(k);
  return { removed, added, changed, completedRegressions, durationLost, positionAbsent };
}

// Modo forense (env LP_PROGRESS_FORENSIC=1): cada escrita registra hash/diff/
// stack e grava snapshot antes, para descobrir QUEM/QUANDO/POR QUE o estado
// muda. Nunca ativo em uso normal.
const progressForensic = process.env.LP_PROGRESS_FORENSIC === "1" || process.env.LP_PROGRESS_FORENSIC === "true";

function updateProgress(mutator, opts = {}) {
  // BUG-002: no shutdown, novos saves são rejeitados — a fila em andamento
  // é drenada com timeout pelo shutdownNow antes do exit.
  if (shuttingDown) {
    return Promise.reject(new Error("servidor em desligamento"));
  }
  const allowShrink = opts.allowShrink === true;
  const allowCompletedRegression = opts.allowCompletedRegression === true;
  const requestId = opts.requestId || crypto.randomUUID();
  const run = progressWriteQueue.then(async () => {
    const state = await readProgress();
    // Snapshot do estado ANTES da mutação (para hash/diff/guarda).
    const beforeState = JSON.parse(JSON.stringify(state));
    const beforeHash = progressHash(state);
    await mutator(state);
    const afterHash = progressHash(state);
    const diff = progressDiff(beforeState, state);
    const entryCountBefore = Object.keys(beforeState).length;
    const entryCountAfter = Object.keys(state).length;

    // Guarda anti-perda POR CONTEÚDO: um save NORMAL nunca pode
    //   - remover chaves;
    //   - virar um estado vazio a partir de um não-vazio;
    //   - regredir completed de true para false (exceto toggle manual);
    //   - perder uma duration válida;
    //   - perder uma position válida (virar ausência).
    // A redução de POSIÇÃO é permitida (reassistir/voltar e pausar é regra
    // atual do player — a proteção de reassistir concluído vive no frontend).
    if (!allowShrink) {
      const regressionReasons = [];
      if (diff.removed.length) regressionReasons.push(`removedKeys=${JSON.stringify(diff.removed)}`);
      if (entryCountBefore > 0 && entryCountAfter === 0) regressionReasons.push("estado vazio a partir de não-vazio");
      if (!allowCompletedRegression && diff.completedRegressions.length) regressionReasons.push(`completedRegressions=${JSON.stringify(diff.completedRegressions)}`);
      if (diff.durationLost.length) regressionReasons.push(`durationLost=${JSON.stringify(diff.durationLost)}`);
      if (diff.positionAbsent.length) regressionReasons.push(`positionAbsent=${JSON.stringify(diff.positionAbsent)}`);
      if (regressionReasons.length) {
        console.error(
          `[PROGRESS] rejected invalid state (${entryCountBefore} → ${entryCountAfter} entradas, requestId=${requestId}): ${regressionReasons.join("; ")}; estado persistido preservado`,
        );
        throw new Error("refusing regressive progress write");
      }
    }

    // Forense: registra a tentativa de escrita (hash antes/depois, diff, stack)
    // e grava snapshot em disco — só com LP_PROGRESS_FORENSIC=1.
    if (progressForensic) {
      console.log(
        `[PROGRESS-WRITE] ${new Date().toISOString()} reason=save requestId=${requestId} isClear=${allowShrink} entryCountBefore=${entryCountBefore} entryCountAfter=${entryCountAfter} added=${diff.added.length} removed=${diff.removed.length} changed=${diff.changed.length} beforeHash=${beforeHash} afterHash=${afterHash}`,
      );
      if (diff.removed.length) console.log(`[PROGRESS-WRITE] removedKeys=${JSON.stringify(diff.removed)}`);
      if (diff.changed.length) console.log(`[PROGRESS-WRITE] changedKeys=${JSON.stringify(diff.changed)}`);
      if (diff.completedRegressions.length) console.log(`[PROGRESS-WRITE] completedRegressions=${JSON.stringify(diff.completedRegressions)}`);
      console.log(`[PROGRESS-WRITE] stack:\n${new Error().stack.split("\n").slice(0, 7).join("\n")}`);
      try {
        const snap = path.join(DATA_DIR, `progress.snapshot.${Date.now()}.${requestId}.json`);
        await fs.writeFile(
          snap,
          JSON.stringify({ ts: Date.now(), requestId, isClear: allowShrink, beforeHash, afterHash, before: beforeState, after: state }, null, 2),
        );
      } catch {}
    }

    const serialized = JSON.stringify(state, null, 2);
    // Antes de sobrescrever, mantém o último estado válido como backup —
    // é dele que a recuperação automática parte após uma corrupção.
    const current = await readJsonFile(PROGRESS_FILE);
    if (current.ok && current.raw !== serialized) {
      // Rotaciona: bak.1 recebe o bak atual antes de o bak ser sobrescrito —
      // segunda camada de recuperação, escrita em momento diferente do main.
      await fs
        .copyFile(PROGRESS_BACKUP_FILE, PROGRESS_BACKUP2_FILE)
        .catch(() => {});
      await writeFileAtomic(PROGRESS_BACKUP_FILE, current.raw);
    } else if (!current.ok && current.raw === null) {
      // BUG-003: primeiro save (main inexistente — instalação nova, ou main já
      // renomeado por corrupção). Não há estado anterior para rotacionar; semeia
      // o backup com o próprio estado para que uma corrupção futura do main
      // tenha ponto de recuperação coerente. Não sobrescreve um backup válido
      // que já exista (preserva a cadeia de recuperação mais antiga).
      const backup = await readJsonFile(PROGRESS_BACKUP_FILE);
      if (!backup.ok) {
        await writeFileAtomic(PROGRESS_BACKUP_FILE, serialized);
      }
    }
    await writeFileAtomic(PROGRESS_FILE, serialized);
    // Força o flush do volume (vfat) para a escrita sobreviver à remoção.
    requestVolumeSync(PROGRESS_FILE);
  });
  // Erro não para a fila; quem chama (a rota) trata e responde 500.
  progressWriteQueue = run.catch(() => {});
  return run;
}

async function initPersistence() {
  // Multi-biblioteca: carrega o registry ANTES de reconciliar jobs de legenda
  // (que resolvem `rel` → `abs` pelo libraryId persistido no job).
  await initLibraries();
  // Remove temporários órfãos de escritas interrompidas em execuções anteriores.
  try {
    const files = await fs.readdir(DATA_DIR);
    await Promise.all(
      files
        .filter((f) => f.endsWith(".tmp"))
        .map((f) => fs.unlink(path.join(DATA_DIR, f)).catch(() => {})),
    );
  } catch {}

  // Cache de transcoding: garante a pasta e remove .tmp órfãos de transcodes
  // interrompidos (o .tmp nunca é o cache final; o final só existe após rename).
  try {
    await fs.mkdir(TRANSCODE_DIR, { recursive: true });
    const files = await fs.readdir(TRANSCODE_DIR);
    await Promise.all(
      files
        .filter((f) => f.endsWith(".tmp"))
        .map((f) => fs.unlink(path.join(TRANSCODE_DIR, f)).catch(() => {})),
    );
  } catch {}

  // Restaura o progresso do melhor backup quando o principal está
  // ausente/corrompido (preservando o arquivo danificado como .corrupt-<ts>).
  // Antes do servidor aceitar saves — sem corrida com a fila de escrita.
  await restoreProgressFromBackup();

  // Semeia o backup com o estado atual na primeira execução após a correção,
  // para que a recuperação automática já tenha um ponto de partida.
  const [main, backup, backup2] = await Promise.all([
    readJsonFile(PROGRESS_FILE),
    readJsonFile(PROGRESS_BACKUP_FILE),
    readJsonFile(PROGRESS_BACKUP2_FILE),
  ]);
  if (main.ok && !backup.ok) {
    await writeFileAtomic(PROGRESS_BACKUP_FILE, main.raw).catch(() => {});
  }
  if (backup.ok && !backup2.ok) {
    await writeFileAtomic(PROGRESS_BACKUP2_FILE, backup.raw).catch(() => {});
  }
  requestVolumeSync(PROGRESS_FILE);

  // Legendas: garante pastas e reconcilia jobs.json (retomada após restart).
  await loadSubtitleJobs();
  // Depois da reconciliação, varre artefatos derivados órfãos (WAV / saída do
  // whisper) deixados por um crash — libera espaço e não interfere em jobs vivos.
  await cleanupSubtitleOrphans();

  // Multi-biblioteca: migra as chaves de progresso legadas (sem `\0`) para o
  // namespace da biblioteca padrão. Idempotente.
  await migrateProgressKeys();
}

// ==========================================================================
// Registry de bibliotecas (multi-biblioteca)
// --------------------------------------------------------------------------
// data/libraries.json é a ÚNICA fonte das raízes permitidas (config confiável).
// A biblioteca padrão (id "default") aponta para ROOT e é semeada na primeira
// execução — quem só tem ROOT não configura nada. Paths propostos pelo frontend
// são validados/canonicalizados UMA vez na criação e nunca reutilizados como
// confiáveis em operações de mídia (que sempre recebem libraryId + rel).
// ==========================================================================

let librariesCache = null; // [{ id, name, path, enabled, isDefault, createdAt }]
let scanningLibraryIds = new Set(); // bibliotecas com scan em andamento

function defaultLibraryEntry() {
  return {
    id: DEFAULT_LIBRARY_ID,
    name: path.basename(ROOT) || "Biblioteca padrão",
    path: ROOT,
    enabled: true,
    isDefault: true,
    createdAt: Date.now(),
  };
}

function getLibraries() {
  return librariesCache || [];
}

function getLibraryById(id) {
  if (typeof id !== "string") return null;
  return getLibraries().find((l) => l.id === id) || null;
}

function getDefaultLibrary() {
  const libs = getLibraries();
  return libs.find((l) => l.isDefault) || libs[0] || null;
}

// Resolve a biblioteca de uma requisição: `libraryId` explícito (query/body) ou
// a biblioteca padrão quando ausente. Id desconhecido → null (o caller responde
// 400 — nunca degrada silenciosamente para a padrão num id digitado errado).
function requestLibrary(req) {
  const id =
    (req.query && typeof req.query.libraryId === "string" && req.query.libraryId) ||
    (req.body && typeof req.body.libraryId === "string" && req.body.libraryId) ||
    "";
  if (!id) return getDefaultLibrary();
  return getLibraryById(id);
}

async function persistLibraries() {
  const data = { libraries: getLibraries(), updatedAt: Date.now() };
  const serialized = JSON.stringify(data, null, 2);
  const current = await readJsonFile(LIBRARIES_FILE);
  if (current.ok && current.raw === serialized) return;
  await writeFileAtomic(LIBRARIES_FILE, serialized);
}

// Carrega o registry (lazy, memoizado). Arquivo ausente → semeia a biblioteca
// padrão; corrompido → preserva o original como .corrupt-<ts> e re-semeia.
async function loadLibraries() {
  if (librariesCache) return librariesCache;
  const read = await readJsonFile(LIBRARIES_FILE);
  let entries = null;
  if (read.ok && read.parsed && Array.isArray(read.parsed.libraries)) {
    entries = read.parsed.libraries.filter(
      (l) => l && typeof l.id === "string" && typeof l.path === "string",
    );
  } else if (read.raw !== null) {
    console.log(
      `[LIBRARIES] ${path.basename(LIBRARIES_FILE)} ilegível; renomeado para .corrupt-<ts> e re-semeado`,
    );
    await fs
      .rename(LIBRARIES_FILE, `${LIBRARIES_FILE}.corrupt-${Date.now()}`)
      .catch(() => {});
  }
  if (entries === null) {
    // Arquivo não existia ou estava corrompido: semeia a biblioteca padrão inicial
    entries = [defaultLibraryEntry()];
  }
  librariesCache = entries;
  await persistLibraries();
  return librariesCache;
}

async function initLibraries() {
  await loadLibraries();
  return getLibraries();
}

// Valida e canonicaliza um path proposto de biblioteca. NUNCA toca o filesystem
// além do realpath (resolve symlinks/junctions). Regras da auditoria §6/§13:
// absoluto obrigatório, sem NUL/traversal, dir proibido (app/data/public/
// node_modules) e sem aninhamento com bibliotecas existentes.
async function validateLibraryPath(inputPath) {
  if (typeof inputPath !== "string") {
    return { ok: false, error: "path deve ser uma string" };
  }
  const p = inputPath.trim();
  if (!p) return { ok: false, error: "path vazio" };
  if (p.includes("\0")) return { ok: false, error: "path inválido" };
  if (!path.isAbsolute(p)) return { ok: false, error: "path deve ser absoluto" };
  let abs = path.resolve(p);
  try {
    abs = await fs.realpath(abs); // resolve symlinks/junctions → canônico
  } catch {}
  const sep = path.sep;
  const norm = (x) => (x.endsWith(sep) ? x.slice(0, -1) : x);
  const absN = norm(abs);
  // Diretórios proibidos: a pasta do app (e subdirs) e a pasta de dados.
  const forbidden = [
    __dirname,
    path.join(__dirname, "public"),
    path.join(__dirname, "node_modules"),
    DATA_DIR,
  ];
  for (const dir of forbidden) {
    let canon;
    try {
      canon = await fs.realpath(dir);
    } catch {
      canon = path.resolve(dir);
    }
    const c = norm(canon);
    if (c === absN || absN.startsWith(c + sep)) {
      return { ok: false, error: "diretório proibido (pasta do app/data)" };
    }
  }
  // Aninhamento com bibliotecas existentes (ancestral/descendente) — evita
  // raízes ambíguas e double-scan.
  for (const lib of getLibraries()) {
    const c = norm(lib.path);
    if (c === absN || absN.startsWith(c + sep) || c.startsWith(absN + sep)) {
      return {
        ok: false,
        error: "path conflita com biblioteca existente (aninhado ou igual)",
      };
    }
  }
  return { ok: true, path: abs };
}

// Migra chaves de progresso legadas (sem "\0") para o namespace da biblioteca
// padrão. Idempotente: chaves já com "\0" ficam intactas; nada é perdido. A
// escrita atômica + backup preservam o estado pré-migração (reversível).
async function migrateProgressKeys() {
  const read = await readJsonFile(PROGRESS_FILE);
  if (!read.ok || !read.parsed || typeof read.parsed !== "object") return;
  const prefix = `${DEFAULT_LIBRARY_ID}\0`;
  let changed = false;
  for (const key of Object.keys(read.parsed)) {
    if (key.includes("\0")) continue; // já migrado (ou de biblioteca explícita)
    const value = read.parsed[key];
    delete read.parsed[key];
    read.parsed[prefix + key] = value;
    changed = true;
  }
  if (!changed) return;
  console.log(
    `[PROGRESS] migrando chaves legadas para a biblioteca padrão (${DEFAULT_LIBRARY_ID})…`,
  );
  await writeFileAtomic(PROGRESS_FILE, JSON.stringify(read.parsed, null, 2));
  // O backup também precisa ser migrado? Não: o backup é o estado pré-mudança
  // (reversível); a recuperação automática já cobre chaves sem "\0".
}

// Formato público de uma biblioteca para /api/libraries e /api/tree (status
// computado; nunca expõe estado interno).
function librarySummary(lib, cached) {
  const tree = cached && cached.tree;
  let courseCount = 0;
  if (tree && Array.isArray(tree.children)) {
    const count = (nodes) =>
      nodes.reduce(
        (acc, n) =>
          acc +
          (n.type === "folder" ? 1 + count(n.children || []) : 0),
        0,
      );
    courseCount = count(tree.children);
  }
  return {
    id: lib.id,
    name: lib.name,
    path: lib.path,
    enabled: lib.enabled !== false,
    isDefault: lib.isDefault === true,
    status: cached ? cached.status : "unknown",
    error: cached ? cached.error : null,
    lastScanAt: cached ? cached.lastScanAt : null,
    courseCount,
    tree,
  };
}

// ==========================================================================
// Transcoding de fallback
// --------------------------------------------------------------------------
// Vídeos que o navegador não reproduz (ex.: MKV, codecs exóticos) são
// convertidos para MP4/H.264/AAC com ffmpeg — apenas quando o formato original
// falha no <video>; compatíveis seguem servidos diretamente, sem tocar no
// ffmpeg. O transcode usa MP4 fragmentado (frag_keyframe+empty_moov+
// default_base_moof): o init box fica no início do arquivo, então o servidor
// pode servir o .tmp enquanto cresce — o usuário começa a assistir em segundos,
// sem esperar a conversão inteira. O cache é persistente, deduplicado por job,
// invalidado por mtime do original, e o .tmp só vira final após rename atômico.
// ==========================================================================

let ffmpegAvailable = null;
let ffprobeAvailable = null;

// Detecta a presença do binário (FFMPEG_BIN/FFPROBE_BIN via env ou PATH).
function detectTool(bin) {
  return new Promise((resolve) => {
    const child = spawn(bin, ["-version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function ensureTools() {
  if (ffmpegAvailable === null) ffmpegAvailable = await detectTool(FFMPEG_BIN);
  if (ffprobeAvailable === null) ffprobeAvailable = await detectTool(FFPROBE_BIN);
}

// Nome de cache determinístico e seguro a partir da identidade da biblioteca +
// caminho relativo: sha1 evita colisão entre cursos de bibliotecas distintas
// ("Curso A/Aula 01.mkv" na biblioteca X ≠ na Y) e nunca expõe o nome real do
// arquivo em um path do cliente. A mudança de namespace deixa caches antigos
// órfãos (descartáveis; regeneram sob demanda — nada é apagado).
function transcodeCacheName(libId, rel) {
  return crypto
    .createHash("sha1")
    .update(`${libId}\0${rel}`)
    .digest("hex")
    .slice(0, 24) + ".mp4";
}

function execFileAsync(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        const err = new Error(`exit ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

// Analisa o arquivo para decidir compatibilidade sem confiar só na extensão
// (spec 3). Usa ffprobe; sem ffprobe, cai para o stderr do `ffmpeg -i`.
async function probeMedia(abs) {
  if (ffprobeAvailable) {
    try {
      const { stdout } = await execFileAsync(FFPROBE_BIN, [
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        abs,
      ]);
      const parsed = JSON.parse(stdout);
      if (parsed && Array.isArray(parsed.streams)) return parsed;
    } catch {}
  }
  if (ffmpegAvailable) {
    try {
      // `ffmpeg -i` sempre sai com código != 0; o stderr é o dado útil.
      const { stderr } = await execFileAsync(FFMPEG_BIN, ["-i", abs]);
      return parseFfmpegInfo(stderr);
    } catch (err) {
      if (err && err.stderr) return parseFfmpegInfo(err.stderr);
    }
  }
  return null;
}

function parseFfmpegInfo(stderr) {
  const streams = [];
  const fmt = /Input #0, ([^,]+),/.exec(stderr);
  const format = fmt ? fmt[1].trim() : "";
  const re = /Stream #\d+:\d+[^\n]*: ([^:]+): ([a-zA-Z0-9_]+)/g;
  let m;
  while ((m = re.exec(stderr))) {
    streams.push({
      codec_type: m[1].trim().toLowerCase(),
      codec_name: m[2].trim().toLowerCase(),
    });
  }
  if (!streams.length) return null;
  return { format_name: format, streams };
}

// Codecs/contêineres que Chromium/Firefox modernos reproduzem de forma confiável.
const BROWSER_VIDEO_CODECS = new Set(["h264", "vp8", "vp9", "av1", "theora"]);
const BROWSER_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);
const BROWSER_CONTAINERS = new Set(["mp4", "mov", "m4v", "webm", "ogg"]);

function isBrowserCompatibleVideo(probe) {
  if (!probe || !Array.isArray(probe.streams)) return false;
  // ffprobe JSON aninha o formato em `format.format_name`; o fallback de
  // `parseFfmpegInfo` (stderr do ffmpeg) o coloca no topo — aceita ambos.
  const rawContainer = probe.format_name || (probe.format && probe.format.format_name) || "";
  const container = rawContainer.split(",")[0].trim().toLowerCase();
  if (!BROWSER_CONTAINERS.has(container)) return false;
  let videoOk = false;
  for (const s of probe.streams) {
    const codec = (s.codec_name || "").toLowerCase();
    if (s.codec_type === "video") {
      if (!BROWSER_VIDEO_CODECS.has(codec)) return false;
      videoOk = true;
    } else if (s.codec_type === "audio" && !BROWSER_AUDIO_CODECS.has(codec)) {
      return false;
    }
  }
  return videoOk;
}

// --------------------------------------------------------------------------
// Jobs e scheduler
// --------------------------------------------------------------------------

const transcodeJobs = new Map(); // cacheName -> job
const transcodeQueue = []; // jobs aguardando um slot
let activeTranscodes = 0;

// Deduplica: várias requisições do mesmo vídeo compartilham UM job/ffmpeg.
function startTranscodeJob(libraryId, cacheName, rel, srcAbs, tmpPath, finalPath, probe) {
  const existing = transcodeJobs.get(cacheName);
  if (existing) {
    existing.lastConsumerAt = Date.now();
    return existing;
  }
  const duration = probe && probe.format ? Number(probe.format.duration) : null;
  const job = {
    cacheName,
    libraryId,
    rel,
    srcAbs,
    tmpPath,
    finalPath,
    status: "queued", // queued | processing | completed | failed
    error: null,
    proc: null,
    percent: null,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    createdAt: Date.now(),
    lastConsumerAt: Date.now(),
  };
  transcodeJobs.set(cacheName, job);
  transcodeQueue.push(job);
  console.log(`[TRANSCODE] iniciado: ${rel}`);
  scheduleNextTranscode();
  return job;
}

function scheduleNextTranscode() {
  while (activeTranscodes < MAX_CONCURRENT_TRANSCODES && transcodeQueue.length) {
    const job = transcodeQueue.shift();
    if (job.status !== "queued") continue;
    activeTranscodes++;
    runTranscode(job).catch(() => {});
  }
}

async function runTranscode(job) {
  // Portão global de jobs pesados: segura UM slot compartilhado com whisper
  // (nunca ffmpeg+whisper simultâneos). Liberado quando o processo termina
  // (close/error) ou se o spawn falhar na hora.
  const releaseHeavy = await acquireHeavySlot();
  let heavyReleased = false;
  const releaseHeavyOnce = () => {
    if (!heavyReleased) {
      heavyReleased = true;
      releaseHeavy();
    }
  };
  job.status = "processing";
  // Argumentos fixos, sem shell (spec 23): nada do usuário entra no comando.
  // -movflags frag_keyframe+empty_moov+default_base_moof: MP4 fragmentado com
  //   init no início (substitui o faststart — ver relatório/limitações).
  // -g 60: fragmentos ~2s — 1º frame chega antes e o seek fica mais fino.
  const args = [
    "-y",
    "-i",
    job.srcAbs,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "60",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof",
    "-f",
    "mp4",
    "-progress",
    "pipe:1",
    "-nostats",
    "-loglevel",
    "error",
    job.tmpPath,
  ];
  let proc;
  try {
    proc = spawn(FFMPEG_BIN, args, {
      cwd: TRANSCODE_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Spawn síncrono falhou: libera o slot e encerra sem travar a fila.
    job.status = "failed";
    job.error = `não foi possível iniciar o FFmpeg: ${err.message}`;
    console.error(`[TRANSCODE] falhou: ${job.rel} (${job.error})`);
    job.proc = null;
    activeTranscodes--;
    transcodeJobs.delete(job.cacheName);
    releaseHeavyOnce();
    scheduleNextTranscode();
    return;
  }
  job.proc = proc;
  let stderr = "";
  let lastLogPercent = -10;

  proc.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    let outSec = null;
    const us = /out_time_us=(\d+)/.exec(text);
    const ms = /out_time_ms=(\d+)/.exec(text);
    if (us) outSec = parseInt(us[1], 10) / 1e6;
    else if (ms) outSec = parseInt(ms[1], 10) / 1e3;
    if (outSec != null && job.duration && job.duration > 0) {
      job.percent = Math.min(100, Math.round((outSec / job.duration) * 100));
      if (job.percent >= lastLogPercent + 25) {
        lastLogPercent = job.percent;
        console.log(`[TRANSCODE] progresso ${job.percent}%: ${job.rel}`);
      }
    }
  });
  proc.stderr.on("data", (c) => {
    stderr += c.toString();
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  proc.on("error", (err) => {
    job.status = "failed";
    job.error = `não foi possível iniciar o FFmpeg: ${err.message}`;
    console.error(`[TRANSCODE] falhou: ${job.rel} (${job.error})`);
    job.proc = null;
    activeTranscodes--;
    transcodeJobs.delete(job.cacheName);
    releaseHeavyOnce();
    scheduleNextTranscode();
  });

  proc.on("close", async (code) => {
    activeTranscodes--;
    job.proc = null;
    if (code === 0) {
      try {
        // O .tmp só vira final após sucesso (rename atômico no mesmo FS).
        await fs.rename(job.tmpPath, job.finalPath);
        job.status = "completed";
        job.percent = 100;
        console.log(`[TRANSCODE] concluído: ${job.rel} → ${job.cacheName}`);
      } catch (err) {
        job.status = "failed";
        job.error = `falha ao finalizar o cache: ${err.message}`;
        console.error(`[TRANSCODE] falhou: ${job.rel} (${job.error})`);
      }
    } else {
      job.status = "failed";
      const tail = stderr.trim().split("\n").pop();
      job.error = `ffmpeg saiu com código ${code}${tail ? `: ${tail}` : ""}`;
      console.error(`[TRANSCODE] falhou: ${job.rel} (${job.error})`);
      await fs.unlink(job.tmpPath).catch(() => {});
    }
    // Remove do Map (streams ativos seguram o job por closure). Falhas ficam
    // um tempo para o fallback reportar o erro claro; completos sobem logo.
    const retention = job.status === "completed" ? 1000 : 10 * 60 * 1000;
    setTimeout(() => transcodeJobs.delete(job.cacheName), retention);
    releaseHeavyOnce();
    scheduleNextTranscode();
  });
}

// Cancela jobs enfileirados que perderam todos os consumidores (spec 18).
setInterval(() => {
  const now = Date.now();
  for (const job of transcodeJobs.values()) {
    if (job.status === "queued" && now - job.lastConsumerAt > 120000) {
      const idx = transcodeQueue.indexOf(job);
      if (idx >= 0) transcodeQueue.splice(idx, 1);
      transcodeJobs.delete(job.cacheName);
      console.log(`[TRANSCODE] cancelado (sem consumidores): ${job.rel}`);
    }
  }
}, 60000).unref();

// --------------------------------------------------------------------------
// Plano de fallback: cache -> job -> probe de compatibilidade -> novo job
// --------------------------------------------------------------------------

// URL de mídia: a biblioteca PADRÃO usa o formato legado "/media/<rel>"
// (back-compat de links/bookmarks); as demais prefixam "/media/<libId>/<rel>".
function mediaUrlFromRel(lib, rel) {
  const enc = rel.split("/").map(encodeURIComponent).join("/");
  return lib && lib.id !== DEFAULT_LIBRARY_ID
    ? `/media/${encodeURIComponent(lib.id)}/${enc}`
    : `/media/${enc}`;
}

async function getTranscodePlan(lib, rel, abs) {
  await ensureTools();
  const cacheName = transcodeCacheName(lib.id, rel);
  const finalPath = path.join(TRANSCODE_DIR, cacheName);
  const tmpPath = finalPath + ".tmp";

  // Symlink/junction apontando para fora da biblioteca: recusa antes de passar
  // o caminho ao ffprobe/ffmpeg (ssrf/filesystem — nunca analisar alvo externo).
  if (!(await fileWithinLibrary(lib, abs))) {
    return { error: true, message: "Arquivo não encontrado." };
  }

  const origStat = await fs.stat(abs).catch(() => null);
  if (!origStat) return { error: true, message: "Arquivo não encontrado." };

  // Cache válido? O original não mudou desde a conversão (spec 6).
  const finalStat = await fs.stat(finalPath).catch(() => null);
  if (finalStat && finalStat.mtimeMs >= origStat.mtimeMs) {
    console.log(`[TRANSCODE] cache encontrado: ${rel}`);
    return { compatible: false, status: "ready", url: `/transcoded/${cacheName}` };
  }

  // Job ativo (concluído nesta sessão ou em andamento): deduplica.
  const existing = transcodeJobs.get(cacheName);
  if (existing && existing.status === "failed") {
    return { error: true, message: existing.error || "Falha ao transcodificar este vídeo." };
  }
  if (existing && (existing.status === "queued" || existing.status === "processing")) {
    existing.lastConsumerAt = Date.now();
    console.log(`[TRANSCODE] aguardando job existente: ${rel}`);
    return { compatible: false, status: "transcoding", url: `/transcoded/${cacheName}` };
  }

  // O navegador reproduz o original? Não transcodifica (spec 2).
  const probe = await probeMedia(abs);
  if (probe && isBrowserCompatibleVideo(probe)) {
    return { compatible: true, url: mediaUrlFromRel(lib, rel) };
  }

  if (!ffmpegAvailable) {
    return {
      error: true,
      message:
        "Este vídeo não é compatível com o navegador e o FFmpeg não está disponível neste computador.",
    };
  }

  const job = startTranscodeJob(lib.id, cacheName, rel, abs, tmpPath, finalPath, probe);
  return { compatible: false, status: "transcoding", url: `/transcoded/${cacheName}` };
}

// --------------------------------------------------------------------------
// Streaming de arquivo em crescimento (progressive transcoding)
// --------------------------------------------------------------------------

function parseByteRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    start = 0;
    end = m[2] ? parseInt(m[2], 10) : null; // bytes=-N: raro; trata como 0-N
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? parseInt(m[2], 10) : null;
  }
  if (!Number.isFinite(start) || start < 0) return null;
  return { start, end: end == null ? null : Math.max(start, end) };
}

// Serva o .tmp enquanto o ffmpeg escreve: o <video> começa a tocar assim que o
// init + 1º fragmento existem. Seek para além do já convertido espera até o
// ffmpeg alcançar (limite TRANSCODE_SEEK_WAIT_MS) e então responde 416.
async function serveGrowingFile(req, res, job) {
  const tmpPath = job.tmpPath;
  // O fallback responde na hora; o ffmpeg pode ainda não ter criado o .tmp
  // quando o cliente já pede a URL (e um job enfileirado espera o slot).
  // Espera até o init existir (limite generoso) em vez de dar 404 prematuro
  // que derrubaria o <video>.
  const deadline = Date.now() + 30000;
  let currentSize = 0;
  while (Date.now() < deadline) {
    if (job.status === "completed" || job.status === "failed") break;
    try {
      currentSize = (await fs.stat(tmpPath)).size;
    } catch {}
    if (currentSize > 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  // Corrida: o transcode terminou entre a checagem de job ativo e o stat —
  // o .tmp já foi renomeado. Serve o final (Range completo) em vez de 404.
  if (job.status === "completed") {
    return res.sendFile(job.finalPath, (err) => {
      if (err && err.code !== "ECONNRESET") res.destroy();
    });
  }
  if (job.status === "failed") {
    return res.status(500).end();
  }
  if (currentSize === 0) {
    return res.status(404).end();
  }

  const range = parseByteRange(req.headers.range);
  let start = range ? range.start : 0;
  const end = range ? range.end : null;

  if (range && start > 0 && start >= currentSize) {
    const deadline = Date.now() + TRANSCODE_SEEK_WAIT_MS;
    while (Date.now() < deadline && job.status !== "failed" && job.status !== "completed") {
      await new Promise((r) => setTimeout(r, 300));
      try {
        currentSize = (await fs.stat(tmpPath)).size;
      } catch {}
      if (start < currentSize) break;
    }
    if (start >= currentSize) {
      return res
        .status(416)
        .set("Content-Range", `bytes */${currentSize}`)
        .end();
    }
  }

  res.set("Content-Type", "video/mp4");
  res.set("Accept-Ranges", "bytes");
  res.set("Cache-Control", "private, no-store");

  if (range) {
    // Total ainda desconhecido (arquivo cresce): Content-Range com "*".
    const availEnd = Math.max(start + 1, currentSize);
    res.status(206);
    res.set("Content-Range", `bytes ${start}-${availEnd - 1}/*`);
  } else {
    res.status(200);
  }

  streamGrowingFile(res, job, start, end);
}

// Lê o arquivo conforme ele cresce e entrega ao cliente; encerra quando o job
// conclui (EOF) ou falha. O fd aponta para o inode mesmo após o rename.
function streamGrowingFile(res, job, start, end) {
  const tmpPath = job.tmpPath;
  const BUF = Buffer.alloc(64 * 1024);
  let offset = start;
  let fd = null;
  let closed = false;
  let timer = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (fd) {
      const f = fd;
      fd = null;
      f.close().catch(() => {});
    }
  };
  const finish = () => {
    cleanup();
    res.end();
  };
  const fail = () => {
    cleanup();
    res.destroy();
  };
  res.on("close", cleanup);

  async function loop() {
    if (closed) return;
    if (end != null && offset >= end) {
      finish();
      return;
    }
    let stat;
    try {
      stat = await fd.stat();
    } catch {
      fail();
      return;
    }
    if (offset >= stat.size) {
      if (job.status === "completed") {
        finish();
        return;
      }
      if (job.status === "failed") {
        fail();
        return;
      }
      timer = setTimeout(loop, 200);
      return;
    }
    const limit = end == null ? Infinity : end - offset;
    const want = Math.min(BUF.length, limit, stat.size - offset);
    const { bytesRead } = await fd.read(BUF, 0, want, offset);
    if (bytesRead <= 0) {
      if (job.status === "completed") {
        finish();
        return;
      }
      timer = setTimeout(loop, 200);
      return;
    }
    offset += bytesRead;
    // Cópia: o subarray é uma view sobre o BUF que a próxima leitura reescreve;
    // Buffer.from garante que os bytes enviados não sejam corrompidos.
    const chunk = Buffer.from(BUF.subarray(0, bytesRead));
    if (!res.write(chunk)) {
      await new Promise((r) => res.once("drain", r));
    }
    if (closed) return;
    if (end != null && offset >= end) {
      finish();
      return;
    }
    timer = setTimeout(loop, 20);
  }

  fs.open(tmpPath, "r")
    .then((f) => {
      fd = f;
      loop();
    })
    .catch(() => {
      // Corrida de rename: o transcode terminou entre o cabeçalho e o open, e
      // o .tmp já virou final — abre o final (mesmo conteúdo, fd preso ao
      // inode) em vez de destruir a resposta com empty reply.
      if (job.status === "completed") {
        fs.open(job.finalPath, "r")
          .then((f) => {
            fd = f;
            loop();
          })
          .catch(() => fail());
      } else {
        fail();
      }
    });
}

// ==========================================================================
// Inteligência Artificial (preparação de arquitetura)
// --------------------------------------------------------------------------
// Esta seção NÃO gera legendas nem executa modelos: ela prepara a fundação —
// configuração persistente (data/ai-config.json), um registry data-driven de
// providers e endpoints de estado usados pela aba "Inteligência Artificial".
// A arquitetura mantém ASR ≠ LLM:
//   • ASR (Whisper, Moonshine) converte áudio → texto (local, offline);
//   • LLM é uma etapa OPCIONAL e posterior de correção/formatação (o LLM NUNCA
//     descobre timestamps e não pode reescrever a transcrição).
// Segurança: API keys ficam SOMENTE neste arquivo local. O GET /api/ai/config
// devolve `hasApiKey` (nunca a chave), o POST aceita apiKey (string = grava,
// clearApiKey=true = limpa, ausente = mantém) e nenhum log imprime a chave.
// Nada é executado via shell — o teste de conexão usa fetch nativo.
// ==========================================================================

const AI_CONFIG_FILE = path.join(DATA_DIR, "ai-config.json");
const BIN_DIR = path.join(__dirname, "bin");
const MODELS_DIR = path.join(__dirname, "models");
// Overrides manuais (opcionais) para binário/pasta de modelos do Whisper.
const WHISPER_BIN = process.env.WHISPER_BIN || null;
const WHISPER_MODEL_DIR = process.env.WHISPER_MODEL_DIR || null;

// Registry estático de providers de transcrição (ASR). Adicionar um provider
// novo = adicionar uma entrada aqui; o pipeline/UI/API não mudam. "runtime" é
// descrição, não acoplamento.
const AI_TRANSCRIPTION_PROVIDERS = [
  {
    id: "whisper",
    name: "Whisper",
    runtime: "whisper.cpp",
    local: true,
    binaryNames: ["whisper-cli", "whisper-cli-"],
    modelFilePattern: "ggml-{model}.bin",
    // Capacidades do runtime. `vad` (silero): o build instalado (whisper-cli
    // 1.9.2) REJEITA a flag curta `-vad` (exit 0, sem saída) e só aceita VAD via
    // `-vm`/`--vad-model`, que exige o modelo ggml-silero-vad.bin (não instalado
    // por padrão). Portanto VAD fica declarado como falso — honesto e sem
    // tentativas desperdiçadas; habilitar = instalar o modelo silero e passar
    // `-vm`. `wordTimestamps` é falso — o JSON bruto pode conter tokens, mas o
    // app não os estende. `threads` controla -t N (aceito pelo 1.9.2).
    capabilities: { vad: false, wordTimestamps: false, threads: true },
    models: [
      { id: "tiny", name: "Tiny" },
      { id: "base", name: "Base" },
      { id: "small", name: "Small" },
      { id: "medium", name: "Medium" },
      { id: "large-v3-turbo", name: "Large v3 Turbo" },
    ],
    languages: [
      { id: "auto", name: "Detecção automática" },
      { id: "pt", name: "Português (Brasil)" },
      { id: "en", name: "Inglês" },
      { id: "es", name: "Espanhol" },
      { id: "fr", name: "Francês" },
      { id: "de", name: "Alemão" },
      { id: "it", name: "Italiano" },
      { id: "nl", name: "Holandês" },
      { id: "ja", name: "Japonês" },
      { id: "ko", name: "Coreano" },
      { id: "zh", name: "Chinês" },
      { id: "ru", name: "Russo" },
    ],
  },
  {
    // Stub de arquitetura: Moonshine pode ser implementado depois SEM tocar
    // player/legendas/cache/jobs/UI/API.
    id: "moonshine",
    name: "Moonshine",
    runtime: "onnx",
    local: true,
    binaryNames: ["moonshine", "moonshine-"],
    modelFilePattern: "moonshine-{model}",
    // Stub: capacidades declaradas (nada disso é exercitado sem runtime).
    capabilities: { vad: false, wordTimestamps: false, threads: false },
    models: [
      { id: "tiny", name: "Tiny" },
      { id: "base", name: "Base" },
    ],
    languages: [
      { id: "en", name: "Inglês" },
    ],
  },
];
const AI_LLM_PROVIDER_TYPES = [
  { id: "openai-compatible", name: "OpenAI-compatible", chatEndpoint: "/chat/completions" },
];
const AI_LLM_PRESETS = [
  { id: "omniroute", name: "OmniRoute" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "custom", name: "Personalizado / outro compatível" },
];
const AI_STR_LIMITS = { name: 80, baseUrl: 500, model: 120, apiKey: 500 };
function objOr(v, dflt) { return v && typeof v === "object" && !Array.isArray(v) ? v : dflt; }
function clampStr(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }

function defaultAiConfig() {
  return {
    transcription: {
      enabled: true,
      provider: "whisper",
      model: "small",
      language: "pt",
      generateMode: "auto", // "auto" | "manual" (gerar sempre vs sob demanda)
      // Pré-geração sob demanda (fila priorizada P1/P2/P3):
      pregenFirstLesson: true, // primeira aula de cada curso após o scan (P2)
      pregenNextLesson: true, // próxima aula ao abrir uma aula (P1)
      background: false, // geração ampla em segundo plano (P3) — desligada por padrão
      vad: true, // VAD (silêncio) — SÓ é aplicado se o provider tiver capabilities.vad (whisper atual: false)
    },
    correction: { enabled: false, providerId: "", model: "" },
    // Tradução de legendas (LLM, sob demanda). Reusa o MESMO provider+modelo da
    // correção; a legenda original (língua-fonte) nunca é tocada — a tradução
    // é um artefato derivado por idioma (`hash-lang`). Sem LLM configurado a
    // tradução simplesmente não aparece (o player segue com a original).
    translation: { enabled: false, targetLanguage: "pt", keepTerms: true },
    // Pós-processamento determinístico local (sempre aplicado se habilitado).
    // A transcrição bruta original é SEMPRE preservada em raw/.
    postprocessing: { capitalize: true, segment: true, technicalDictionary: false },
    llm: { providers: [] },
    advanced: {
      maxConcurrentTranscriptions: 1,
      maxConcurrentAiJobs: 1, // portão global: ffmpeg + whisper nunca simultâneos
      transcriptionThreads: 0, // 0 = automático (não passa -t)
      llmTimeoutMs: 15000,
    },
    // Workspace de processamento: onde ficam WAV + saída do Whisper.
    // "auto" (padrão) = temp do SO — nunca toca o pendrive durante o
    // processamento. "custom" = diretório local validado pelo usuário.
    workspace: { mode: "auto", dir: "" },
    updatedAt: null,
  };
}
function findTranscriptionProvider(id) {
  return AI_TRANSCRIPTION_PROVIDERS.find(p => p.id === id) || null;
}
// Sanitiza o conteúdo persistido: valida contra o registry, trunca strings,
// garante tipos. API key é preservada (clamp) — a máscara acontece na saída.
function sanitizeAiConfig(raw) {
  if (!objOr(raw)) return defaultAiConfig();
  const out = defaultAiConfig();
  // transcription
  const tr = objOr(raw.transcription, {});
  out.transcription.enabled = tr.enabled !== false;
  out.transcription.generateMode =
    tr.generateMode === "manual" ? "manual" : "auto";
  out.transcription.pregenFirstLesson = tr.pregenFirstLesson !== false;
  out.transcription.pregenNextLesson = tr.pregenNextLesson !== false;
  out.transcription.background = tr.background === true;
  out.transcription.vad = tr.vad !== false;
  const curProv = findTranscriptionProvider(tr.provider);
  out.transcription.provider = curProv ? curProv.id : out.transcription.provider;
  if (curProv) {
    const m = curProv.models.some(x => x.id === tr.model);
    out.transcription.model = m ? clampStr(tr.model, 40) : curProv.models[0].id;
    const l = curProv.languages.some(x => x.id === tr.language);
    out.transcription.language = l ? clampStr(tr.language, 10) : curProv.languages[0].id;
  }
  // postprocessing (determinístico, local; transcrição bruta preservada)
  const pp = objOr(raw.postprocessing, {});
  out.postprocessing.capitalize = pp.capitalize !== false;
  out.postprocessing.segment = pp.segment !== false;
  out.postprocessing.technicalDictionary = pp.technicalDictionary === true;
  // correction
  const co = objOr(raw.correction, {});
  out.correction.enabled = co.enabled === true;
  out.correction.providerId = clampStr(co.providerId, 80);
  out.correction.model = clampStr(co.model, AI_STR_LIMITS.model);
  // translation (reusa o LLM da correção; idioma-alvo validado no registry)
  const tl = objOr(raw.translation, {});
  const whisperProv = findTranscriptionProvider("whisper");
  const trLangs = whisperProv ? whisperProv.languages : [];
  out.translation.enabled = tl.enabled === true;
  const tgt = clampStr(tl.targetLanguage, 10);
  out.translation.targetLanguage = trLangs.some(l => l.id === tgt) ? tgt : "pt";
  out.translation.keepTerms = tl.keepTerms !== false;
  // llm.providers
  const llm = objOr(raw.llm, {});
  if (Array.isArray(llm.providers)) {
    for (const p of llm.providers) {
      if (!objOr(p) || !clampStr(p.id, 80)) continue;
      const type = AI_LLM_PROVIDER_TYPES.find(t => t.id === p.type);
      const baseUrl = clampStr(p.baseUrl, AI_STR_LIMITS.baseUrl);
      out.llm.providers.push({
        id: clampStr(p.id, 80),
        type: type ? type.id : AI_LLM_PROVIDER_TYPES[0].id,
        name: clampStr(p.name, AI_STR_LIMITS.name) || clampStr(p.id, 80),
        baseUrl: (baseUrl === "" || /^https?:\/\//.test(baseUrl)) ? baseUrl : "",
        apiKey: typeof p.apiKey === "string" ? clampStr(p.apiKey, AI_STR_LIMITS.apiKey) : "",
        defaultModel: clampStr(p.defaultModel, AI_STR_LIMITS.model),
      });
    }
  }
  // advanced
  const ad = objOr(raw.advanced, {});
  const mct = Number(ad.maxConcurrentTranscriptions);
  out.advanced.maxConcurrentTranscriptions = Number.isFinite(mct)
    ? Math.min(8, Math.max(1, Math.floor(mct))) : out.advanced.maxConcurrentTranscriptions;
  const mca = Number(ad.maxConcurrentAiJobs);
  out.advanced.maxConcurrentAiJobs = Number.isFinite(mca)
    ? Math.min(8, Math.max(1, Math.floor(mca))) : out.advanced.maxConcurrentAiJobs;
  const th = Number(ad.transcriptionThreads);
  out.advanced.transcriptionThreads = Number.isFinite(th)
    ? Math.min(16, Math.max(0, Math.floor(th))) : out.advanced.transcriptionThreads;
  const to = Number(ad.llmTimeoutMs);
  out.advanced.llmTimeoutMs = Number.isFinite(to)
    ? Math.min(120000, Math.max(1000, Math.floor(to))) : out.advanced.llmTimeoutMs;
  // workspace
  const ws = objOr(raw.workspace, {});
  if (ws.mode === "custom") {
    const dir = clampStr(ws.dir, 2048);
    // Só aceita diretório não-vazio. A validação real (criável/escrevível) é
    // feita no POST; aqui só garantimos que o modo/valor sejam bem-formados.
    out.workspace.mode = "custom";
    out.workspace.dir = dir;
  }
  out.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt.slice(0, 40) : null;
  return out;
}

function sanitizePatchProvider(p) {
  if (!objOr(p) || !clampStr(p.id, 80)) return null;
  const type = AI_LLM_PROVIDER_TYPES.find(t => t.id === p.type);
  const baseUrl = clampStr(p.baseUrl, AI_STR_LIMITS.baseUrl);
  return {
    id: clampStr(p.id, 80),
    type: type ? type.id : AI_LLM_PROVIDER_TYPES[0].id,
    name: clampStr(p.name, AI_STR_LIMITS.name) || clampStr(p.id, 80),
    baseUrl: (baseUrl === "" || /^https?:\/\//.test(baseUrl)) ? baseUrl : "",
    apiKey: typeof p.apiKey === "string" ? clampStr(p.apiKey, AI_STR_LIMITS.apiKey) : "",
    defaultModel: clampStr(p.defaultModel, AI_STR_LIMITS.model),
  };
}
// Aplica um patch PARCIAL de configuração. Regras de apiKey por provider:
// apiKey (string não vazia) = sobrescreve; clearApiKey === true = limpa;
// ausente = mantém a chave existente. Deletar = `removeProviderId`.
function applyAiPatch(config, patch) {
  const out = JSON.parse(JSON.stringify(config));
  const src = objOr(patch, {});
  // llm.providers (upsert por id; removido no fim)
  const removeId = clampStr(src.llm && src.llm.removeProviderId, 80);
  if (Array.isArray(src.llm && src.llm.providers)) {
    const seen = new Set();
    for (const p of src.llm.providers) {
      const np = sanitizePatchProvider(p);
      if (!np || seen.has(np.id)) continue;
      seen.add(np.id);
      const existing = out.llm.providers.find(x => x.id === np.id);
      if (existing) {
        // Merge parcial: só sobrescreve os campos presentes no patch.
        if (p.type !== undefined) existing.type = np.type;
        if (p.name !== undefined) existing.name = np.name;
        if (p.baseUrl !== undefined) existing.baseUrl = np.baseUrl;
        if (p.defaultModel !== undefined) existing.defaultModel = np.defaultModel;
        if (np.apiKey) existing.apiKey = np.apiKey;
        else if (p.clearApiKey === true) existing.apiKey = "";
      } else {
        out.llm.providers.push(np);
      }
    }
  }
  if (removeId) out.llm.providers = out.llm.providers.filter(x => x.id !== removeId);
  // correction (depois de llm, para validar referência ao provider)
  const co = objOr(src.correction, {});
  if (Object.keys(co).length) {
    if (co.enabled !== undefined) out.correction.enabled = co.enabled === true;
    if (co.providerId !== undefined) {
      const has = out.llm.providers.some(x => x.id === co.providerId);
      if (co.providerId !== "" && !has) throw new Error("Provedor de correção inválido.");
      out.correction.providerId = clampStr(co.providerId, 80);
    }
    if (co.model !== undefined) out.correction.model = clampStr(co.model, AI_STR_LIMITS.model);
  }
  // translation (reusa o LLM da correção; idioma-alvo validado no registry)
  const tl = objOr(src.translation, {});
  if (Object.keys(tl).length) {
    if (tl.enabled !== undefined) out.translation.enabled = tl.enabled === true;
    if (tl.targetLanguage !== undefined) {
      const whisperProv = findTranscriptionProvider("whisper");
      const trLangs = whisperProv ? whisperProv.languages : [];
      if (!trLangs.some(l => l.id === tl.targetLanguage)) {
        throw new Error("Idioma-alvo de tradução inválido.");
      }
      out.translation.targetLanguage = clampStr(tl.targetLanguage, 10);
    }
    if (tl.keepTerms !== undefined) out.translation.keepTerms = tl.keepTerms === true;
  }
  // transcription
  const tr = objOr(src.transcription, {});
  if (Object.keys(tr).length) {
    if (tr.provider !== undefined) {
      const prov = findTranscriptionProvider(tr.provider);
      if (tr.provider !== "" && !prov) throw new Error("Provedor de transcrição inválido.");
      out.transcription.provider = prov ? prov.id : "";
    }
    const curProv = findTranscriptionProvider(out.transcription.provider);
    if (tr.model !== undefined) {
      if (!curProv || !curProv.models.some(m => m.id === tr.model)) throw new Error("Modelo de transcrição inválido.");
      out.transcription.model = clampStr(tr.model, 40);
    }
    if (tr.language !== undefined) {
      if (!curProv || !curProv.languages.some(l => l.id === tr.language)) throw new Error("Idioma de transcrição inválido.");
      out.transcription.language = clampStr(tr.language, 10);
    }
    if (tr.enabled !== undefined) out.transcription.enabled = tr.enabled === true;
    if (tr.generateMode !== undefined) out.transcription.generateMode = tr.generateMode === "manual" ? "manual" : "auto";
    if (tr.pregenFirstLesson !== undefined) out.transcription.pregenFirstLesson = tr.pregenFirstLesson === true;
    if (tr.pregenNextLesson !== undefined) out.transcription.pregenNextLesson = tr.pregenNextLesson === true;
    if (tr.background !== undefined) out.transcription.background = tr.background === true;
    if (tr.vad !== undefined) out.transcription.vad = tr.vad === true;
  }
  // postprocessing (determinístico, local; transcrição bruta preservada em raw/)
  const pp = objOr(src.postprocessing, {});
  if (Object.keys(pp).length) {
    if (pp.capitalize !== undefined) out.postprocessing.capitalize = pp.capitalize === true;
    if (pp.segment !== undefined) out.postprocessing.segment = pp.segment === true;
    if (pp.technicalDictionary !== undefined) out.postprocessing.technicalDictionary = pp.technicalDictionary === true;
  }
  // advanced
  const ad = objOr(src.advanced, {});
  if (Object.keys(ad).length) {
    const mct = Number(ad.maxConcurrentTranscriptions);
    out.advanced.maxConcurrentTranscriptions = Number.isFinite(mct)
      ? Math.min(8, Math.max(1, Math.floor(mct))) : out.advanced.maxConcurrentTranscriptions;
    const mj = Number(ad.maxConcurrentAiJobs);
    out.advanced.maxConcurrentAiJobs = Number.isFinite(mj)
      ? Math.min(8, Math.max(1, Math.floor(mj))) : out.advanced.maxConcurrentAiJobs;
    const th = Number(ad.transcriptionThreads);
    out.advanced.transcriptionThreads = Number.isFinite(th)
      ? Math.min(16, Math.max(0, Math.floor(th))) : out.advanced.transcriptionThreads;
    const to = Number(ad.llmTimeoutMs);
    out.advanced.llmTimeoutMs = Number.isFinite(to)
      ? Math.min(120000, Math.max(1000, Math.floor(to))) : out.advanced.llmTimeoutMs;
  }
  // workspace (validação de criável/escrevível acontece no POST — precisa de fs)
  const ws = objOr(src.workspace, {});
  if (Object.keys(ws).length) {
    const dir = clampStr(ws.dir, 2048);
    out.workspace.mode = ws.mode === "custom" ? "custom" : "auto";
    out.workspace.dir = out.workspace.mode === "custom" ? dir : "";
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

function genId() { return "p_" + crypto.randomBytes(6).toString("hex"); }
async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function scanDirForNames(dir, prefixes) {
  let names = [];
  try { names = await fs.readdir(dir); } catch { return []; }
  return names.filter(n => prefixes.some(pr => n.startsWith(pr)));
}
// Mascara o config para a API/UI: a apiKey NUNCA sai do backend. Cada provider
// vira { ..., hasApiKey: true/false }.
function maskAiConfig(config) {
  return {
    transcription: { ...config.transcription },
    correction: { ...config.correction },
    translation: { ...config.translation },
    postprocessing: { ...config.postprocessing },
    llm: {
      providers: config.llm.providers.map(p => ({
        id: p.id,
        type: p.type,
        name: p.name,
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
        hasApiKey: !!p.apiKey,
      })),
    },
    advanced: { ...config.advanced },
    workspace: { ...config.workspace },
    updatedAt: config.updatedAt,
  };
}

async function loadAiConfig() {
  const read = await readJsonFile(AI_CONFIG_FILE);
  const cfg = read.ok ? sanitizeAiConfig(read.parsed) : defaultAiConfig();
  // Override de ambiente (spec): só aplica quando a variável existe — senão o
  // config persistido (e editável pela Central de IA) vale.
  if (process.env.BACKGROUND_SUBTITLE_GENERATION !== undefined) {
    cfg.transcription.background =
      process.env.BACKGROUND_SUBTITLE_GENERATION === "true" ||
      process.env.BACKGROUND_SUBTITLE_GENERATION === "1";
  }
  return cfg;
}
// Escritas serializadas (mesmo padrão do progresso): read-modify-write atômico
// e sem colisão no arquivo temporário.
let aiConfigWriteQueue = Promise.resolve();
function saveAiConfig(mutator) {
  const run = aiConfigWriteQueue.then(async () => {
    const cfg = await loadAiConfig();
    const next = await mutator(cfg);
    refreshHeavyMax(next.advanced.maxConcurrentAiJobs);
    await writeFileAtomic(AI_CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
  });
  aiConfigWriteQueue = run.catch(() => {});
  return run;
}

// Prefixo de busca do modelo: "ggml-small.bin" vira "ggml-small", permitindo
// variantes quantizadas (ggml-small-q5_1.bin) sem config extra.
function modelSearchPrefix(provider, modelId) {
  const base = provider.modelFilePattern.replace("{model}", modelId);
  const m = base.match(/^(.*)(\.\w+)$/);
  return m ? m[1] : base;
}
// Detecta o estado REAL do provider (arquivos em bin/ e models/). Nada é
// executado; apenas leitura de diretório. Resultado honesto: sem binário → "Não
// instalado".
async function detectTranscriptionProvider(provider) {
  let binaryAvailable = false;
  if (provider.id === "whisper" && WHISPER_BIN) {
    binaryAvailable = await fileExists(WHISPER_BIN);
  }
  if (!binaryAvailable) {
    binaryAvailable = (await scanDirForNames(BIN_DIR, provider.binaryNames)).length > 0;
  }
  const modelDir = provider.id === "whisper" && WHISPER_MODEL_DIR ? WHISPER_MODEL_DIR : MODELS_DIR;
  const models = [];
  for (const m of provider.models) {
    const found = await scanDirForNames(modelDir, [modelSearchPrefix(provider, m.id)]);
    let installed = false;
    let sizeBytes = null;
    if (found.length) {
      installed = true;
      try { sizeBytes = (await fs.stat(path.join(modelDir, found[0]))).size; } catch {}
    }
    models.push({ id: m.id, name: m.name, installed, sizeBytes });
  }
  const installedModel = (models.find(x => x.installed) || {}).id || null;
  return {
    id: provider.id,
    name: provider.name,
    runtime: provider.runtime,
    local: provider.local,
    available: binaryAvailable,
    modelInstalled: !!installedModel,
    installedModel,
    models,
    languages: provider.languages.map(l => ({ id: l.id, name: l.name })),
    // Capacidades declaradas pelo runtime (VAD, threads, word timestamps).
    capabilities: provider.capabilities || { vad: false, wordTimestamps: false, threads: false },
  };
}

function sanitizeTestError(msg) {
  return String(msg).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}
async function getAiStatus() {
  const cfg = await loadAiConfig();
  const transcription = { providers: [], configured: null };
  for (const p of AI_TRANSCRIPTION_PROVIDERS) {
    transcription.providers.push(await detectTranscriptionProvider(p));
  }
  const configuredProvider = transcription.providers.find(p => p.id === cfg.transcription.provider) || null;
  const configuredModelInstalled = configuredProvider
    ? ((configuredProvider.models.find(m => m.id === cfg.transcription.model) || {}).installed ?? false)
    : false;
  transcription.configured = {
    provider: cfg.transcription.provider,
    model: cfg.transcription.model,
    language: cfg.transcription.language,
    enabled: cfg.transcription.enabled,
    available: configuredProvider ? configuredProvider.available : false,
    modelInstalled: configuredModelInstalled,
    vad: cfg.transcription.vad === true,
    vadSupported: configuredProvider ? configuredProvider.capabilities?.vad === true : false,
    pregenFirstLesson: cfg.transcription.pregenFirstLesson === true,
    pregenNextLesson: cfg.transcription.pregenNextLesson === true,
    background: cfg.transcription.background === true,
  };
  // Sinal único de disponibilidade real do pipeline (enabled + provider +
  // binário + modelo) — mesmo critério do `canGenerate` por vídeo. A UI usa
  // isto para esconder os controles de legenda quando o Whisper não está
  // configurado.
  try {
    transcription.configured.canGenerate =
      (await transcriptionAvailability(cfg)).available === true;
  } catch {
    transcription.configured.canGenerate = false;
  }
  const llm = {
    providers: cfg.llm.providers.map(p => ({
      id: p.id,
      type: p.type,
      name: p.name,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      hasApiKey: !!p.apiKey,
      configured: !!p.baseUrl,
    })),
    correction: cfg.correction,
  };
  // Workspace de processamento: diretório resolvido + espaço livre real.
  // Se o custom estiver quebrado (removido), reporta auto — nunca o pendrive.
  let workspace = { mode: cfg.workspace.mode, dir: cfg.workspace.dir, dirResolved: null, freeBytes: null, error: null };
  try {
    const resolved = await resolveWorkspaceDir(cfg);
    workspace.dirResolved = resolved;
    workspace.freeBytes = await getWorkspaceFreeBytes(resolved);
  } catch (err) {
    workspace.error = sanitizeTestError(err.message || "workspace error");
  }
  return { transcription, llm, advanced: cfg.advanced, workspace, updatedAt: cfg.updatedAt };
}

// ==========================================================================
// Legendas por IA (pipeline real)
// --------------------------------------------------------------------------
// Vídeo → extração de áudio (ffmpeg WAV16k mono) → ASR local (whisper) →
// transcrição bruta SEMPRE preservada (raw/) → pós-processamento determinístico
// → correção LLM OPCIONAL (nunca bloqueia a legenda) → WebVTT em cache por
// hash do caminho relativo. Geração é um recurso ADICIONAL: o player nunca
// depende dela. Offline-first; LLM é uma camada separada e opcional.
// ==========================================================================
const SUBTITLE_DIR = path.join(DATA_DIR, "subtitles");
const SUBTITLE_RAW_DIR = path.join(SUBTITLE_DIR, "raw");
const SUBTITLE_PROCESSED_DIR = path.join(SUBTITLE_DIR, "processed");
const SUBTITLE_WORK_DIR = path.join(SUBTITLE_DIR, "work");
// Edição manual: JSON estruturado (fonte de verdade do editor) — separado do
// raw (ASR, nunca sobrescrito) e do processed (gerado por IA). O VTT é
// DERIVADO deste JSON na gravação (espelho + .courseplayer/subtitles).
const SUBTITLE_EDITED_DIR = path.join(SUBTITLE_DIR, "edited");
// Tradução de legendas: artefato DERIVADO por idioma (`<hash>-<lang>.json`).
// O processado (língua-fonte) nunca é tocado; a tradução é gerada sob demanda
// via LLM e reusa o mesmo provider+modelo da correção.
const SUBTITLE_TRANSLATION_DIR = path.join(SUBTITLE_DIR, "translations");
// Backup de versões editadas antes de um "Regenerar" (nunca perder trabalho
// manual — ver §29/§30 do editor de legendas).
const SUBTITLE_BACKUP_DIR = path.join(SUBTITLE_DIR, "backup");
const SUBTITLE_JOBS_FILE = path.join(SUBTITLE_DIR, "jobs.json");

// --------------------------------------------------------------------------
// Workspace de processamento (transcrição): diretório LOCAL onde ficam os
// arquivos de trabalho pesados (WAV extraído + saída do Whisper). O objetivo
// é que o pendrive/biblioteca externa só seja tocado durante a leitura do
// vídeo e a gravação curta/atômica do artefato final — nunca durante o
// processamento. raw/processed (JSON pequenos, necessários para retomada)
// permanecem em data/subtitles; o que é grande/temporário fica aqui.
// Modo "auto" = temp do SO (os.tmpdir) — NUNCA assume a localização do app.
// --------------------------------------------------------------------------
const WORKSPACE_AUTO_ROOT = path.join(os.tmpdir(), "local-player-workspace");
// Espaço livre mínimo para iniciar uma extração (WAV ≈ 10 MB/min de vídeo;
// um curso longo precisa de folga sem derrubar o disco do sistema).
const WORKSPACE_MIN_FREE_BYTES = 300 * 1024 * 1024;
// Subpastas do workspace: audio/ = WAV (descartável), work/ = saída do Whisper.
const WORKSPACE_SUBDIRS = ["audio", "work"];

// Cria um diretório (e ancestrais) sem `recursive:true`. Motivo de segurança:
// `fs.mkdir(..., {recursive:true})` trava em paths patológicos tipo `/proc/x`
// neste kernel (bloqueia a thread do libuv e derruba o servidor inteiro). O
// `access`/`mkdir` NÃO-recursivo falham rápido, então um workspace custom
// inválido vira erro imediato — nunca um servidor enforcado.
async function safeMkdir(dir) {
  const stack = [];
  let cur = path.resolve(String(dir).slice(0, 4096));
  for (;;) {
    try {
      await fs.access(cur);
      break;
    } catch {
      /* ENOENT — caminho ainda não existe */
    }
    stack.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break; // chegou à raiz sem achar existente
    cur = parent;
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    await fs.mkdir(stack[i]); // não-recursivo: falha rápido em fs patológica
  }
}

// Resolve o diretório do workspace a partir da config. Modo "custom" usa o
// diretório configurado (validado); senão o temp do SO. Nunca resolve para o
// pendrive por padrão. Idempotente: cria as subpastas se faltarem. Se o custom
// estiver inacessível (pendrive removido, dir apagado), CAI para auto — a
// geração de legenda nunca é bloqueada por um workspace quebrado.
async function resolveWorkspaceDir(cfg) {
  const w = objOr(cfg && cfg.workspace, {});
  const want =
    w.mode === "custom" && w.dir
      ? path.resolve(String(w.dir).slice(0, 2048))
      : null;
  const dir = want || WORKSPACE_AUTO_ROOT;
  for (const sub of WORKSPACE_SUBDIRS) {
    try {
      await safeMkdir(path.join(dir, sub));
    } catch (err) {
      if (want) return resolveWorkspaceDir({ workspace: { mode: "auto", dir: "" } });
      throw err;
    }
  }
  return dir;
}

// Cria o diretório custom do workspace e prova que é escrevível. Usado na
// validação do POST /api/ai/config — rejeita pendrive/FAT (que não é o
// objetivo do workspace) apenas de forma transparente: se falhar, o usuário
// vê o erro e o config volta para "auto".
async function ensureWorkspaceWritable(dir) {
  await safeMkdir(dir); // nunca `recursive:true` (ver safeMkdir)
  const probe = path.join(dir, ".lp-workspace-probe");
  await fs.writeFile(probe, "ok", { encoding: "utf8" });
  await fs.rm(probe, { force: true });
  return dir;
}

// Bytes livres no disco do workspace (para a checagem pré-extração). Retorna
// null se o statfs não estiver disponível (nenhum Node suporta — é só Node 18+).
async function getWorkspaceFreeBytes(dir) {
  try {
    const s = await fs.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

// Estima o WAV resultante (16kHz mono PCM16 = 16000 * 2 bytes/s = 31.25 KB/s).
// Se o espaço livre for menor que o mínimo ou que o estimado + folga, aborta a
// extração com erro claro — NUNCA tenta em loop num disco cheio/pendrive.
async function ensureWorkspaceSpace(dir, durationSeconds) {
  const free = await getWorkspaceFreeBytes(dir);
  if (free === null) return null; // statfs indisponível: não bloqueia
  const need = Math.min(
    Math.max(durationSeconds * 32000, 64 * 1024 * 1024),
    1024 * 1024 * 1024,
  ) + 32 * 1024 * 1024; // +32MB de folga para a saída do whisper
  if (free < WORKSPACE_MIN_FREE_BYTES || free < need) {
    return { free, need };
  }
  return null;
}

// Hashes cujos artefatos derivados (WAV / saída do whisper) ainda são
// necessários: só jobs em execução ou aguardando slot. Jobs completed/cancelled/
// failed/waiting-source não precisam mais deles — o pipeline apaga na saída e
// jobs retomados regeneram com `-y`. O raw/ e processed/ (dados para retomada)
// ficam intactos — nunca são varridos aqui.
function subtitleJobKeepSet() {
  const keep = new Set();
  const active = new Set([
    "queued", "extracting", "transcribing", "processing", "correcting", "formatting",
  ]);
  for (const job of subtitleJobs.values()) {
    if (active.has(job.status)) keep.add(job.hash);
  }
  return keep;
}

async function cleanupWorkspace(cfg) {
  const dir = await resolveWorkspaceDir(cfg);
  const keep = subtitleJobKeepSet();
  let removed = 0;
  for (const sub of WORKSPACE_SUBDIRS) {
    const subdir = path.join(dir, sub);
    const names = await fs.readdir(subdir).catch(() => []);
    for (const n of names) {
      const m = /^([0-9a-f]{24})\./.exec(n);
      if (m && keep.has(m[1])) continue;
      await fs.rm(path.join(subdir, n), { force: true }).catch(() => {});
      removed++;
    }
  }
  return { removed };
}

// Limpeza de ÓRFÃOS no boot (recuperação após crash/queda de energia). O
// workspace e o antigo `data/subtitles/work` guardam artefatos DERIVADOS
// (WAV e saída bruta do whisper), todos regeneráveis a partir do vídeo. Se o
// processo morreu no meio de um job, esses arquivos ficam para trás e somem
// com o próximo `rescan` do OS (workspace em tmpdir) — mas em `data/` (disco
// do app) eles acumulariam. Aqui varremos ambos e apagamos só o que NÃO
// pertence a nenhum job conhecido (jobs vivos preservam seus artefatos).
async function cleanupSubtitleOrphans() {
  const keep = subtitleJobKeepSet();
  let removed = 0;
  // Workspace atual (audio + work).
  try {
    const cfg = await loadAiConfig();
    const dir = await resolveWorkspaceDir(cfg);
    for (const sub of WORKSPACE_SUBDIRS) {
      const subdir = path.join(dir, sub);
      const names = await fs.readdir(subdir).catch(() => []);
      for (const n of names) {
        const m = /^([0-9a-f]{24})\./.exec(n);
        if (m && keep.has(m[1])) continue;
        await fs.rm(path.join(subdir, n), { force: true }).catch(() => {});
        removed++;
      }
    }
  } catch {}
  // Legado: antigo data/subtitles/work (whisper escrevia aqui antes do
  // workspace local). Só arquivos com hash válido são alvo.
  const legacy = await fs.readdir(SUBTITLE_WORK_DIR).catch(() => []);
  for (const n of legacy) {
    const m = /^([0-9a-f]{24})\.(json|txt)$/.exec(n);
    if (!m) continue;
    if (keep.has(m[1])) continue;
    await fs.rm(path.join(SUBTITLE_WORK_DIR, n), { force: true }).catch(() => {});
    removed++;
  }
  if (removed) {
    console.log(`[SUBTITLE][INFO] boot: ${removed} arquivo(s) derivado(s) órfão(s) removido(s)`);
  }
  return { removed };
}

const SUBTITLE_VERSION = 1;
const SUBTITLE_EDITOR_VERSION = 1; // esquema do JSON editado
const SUBTITLE_EDIT_MAX_SEGMENTS = 2000; // limite de segurança por vídeo
const SUBTITLE_EDIT_MAX_TEXT = 2000; // limite de segurança por linha de texto
const SUBTITLE_EDIT_MIN_S = 0.05; // duração mínima de um segmento editado

// Fila priorizada: menor número = maior prioridade. A demanda imediata (P0) e a
// próxima aula (P1) sempre passam na frente da pré-geração (P2 = primeira aula
// de cada curso) e do background (P3). Nunca a biblioteca inteira de uma vez.
const PRIORITY_DEMAND = 0;
const PRIORITY_NEXT = 1;
const PRIORITY_FIRST = 2;
const PRIORITY_BG = 3;
// Janela em que um "transcribing" de baixa prioridade ainda é barato de
// cancelar (o modelo acabou de ser carregado; quase nada foi transcrito).
const PREEMPT_GRACE_MS = 20000;
// Onde um job preemptado volta na fila: nunca re-rouba o slot de quem o
// preemptou — volta como background (P3) e só roda quando sobrar espaço.
const PREEMPT_RETRY_PRIORITY = PRIORITY_BG;
// Pasta oculta dentro do curso com o artefato FINAL (legenda canônica). A pasta
// começa com "." e por isso o scan da biblioteca a ignora.
const COURSE_SUBTITLE_DIR = ".courseplayer/subtitles";
// Máximo de pipelines de transcrição simultâneos (1 por padrão: RAM é o
// limite; cada execução carrega o modelo inteiro na memória).
const MAX_CONCURRENT_TRANSCRIPTIONS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_TRANSCRIPTIONS || "1", 10),
);

// Chave de cache determinística e segura: sha1 da identidade `libraryId\0rel`
// (24 hex). O namespace por biblioteca garante que o MESMO rel em duas
// bibliotecas ("Curso A/Aula 1.mkv" no SSD e no pendrive) não colide em
// raw/processed/edited/backup nem em jobs.json. Nunca o nome do vídeo/curso em
// URLs. Mudança de namespace ⇒ raws antigos órfãos (nada é apagado).
function subtitleCacheName(libId, rel) {
  return crypto
    .createHash("sha1")
    .update(`${libId}\0${rel}`)
    .digest("hex")
    .slice(0, 24);
}

// Chave do artefato de TRADUÇÃO para um idioma-alvo: `baseHash-<lang>` (ex.
// `<24-hex>-pt`). Deriva do hash-base da legenda (escopo por biblioteca) e
// NUNCA colide com a legenda original (que usa só o baseHash). O lang é
// clampado/validado na entrada (só [a-z]{2,10}); nunca o nome de um arquivo.
function translationCacheName(hash, lang) {
  return `${hash}-${clampStr(lang, 10)}`;
}
function translationDocPath(hash, lang) {
  return path.join(SUBTITLE_TRANSLATION_DIR, translationCacheName(hash, lang) + ".json");
}

// Caminho do artefato FINAL dentro da pasta do curso (legenda canônica, viaja
// com o curso). Ancorado no path da BIBLIOTECA (lib.path), não em ROOT — o
// artefato move com a biblioteca. Se o vídeo estiver na raiz (rel sem "/"),
// não há curso — aí só o espelho em data/subtitles/ serve. A pasta
// .courseplayer é ignorada pelo scan da biblioteca (começa com ".").
function courseSubtitlePath(lib, rel, hash) {
  const idx = rel.indexOf("/");
  if (idx <= 0) return null;
  const courseName = rel.slice(0, idx);
  return path.join(lib.path, courseName, COURSE_SUBTITLE_DIR, hash + ".vtt");
}

// Escreve o artefato FINAL dentro da pasta do curso. Se a pasta do curso for
// somente-leitura (ex.: pendrive protegido), cai para o espelho em
// data/subtitles/ e loga — a geração nunca falha por causa disso.
async function writeCourseSubtitle(lib, rel, hash, vttText) {
  const dest = courseSubtitlePath(lib, rel, hash);
  if (!dest) return false;
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await writeFileAtomic(dest, vttText);
    return true;
  } catch (err) {
    console.log(
      `[SUBTITLE] não foi possível gravar em ${path.dirname(dest)} (${sanitizeTestError(err.message)}); mantendo espelho em data/subtitles/`,
    );
    return false;
  }
}

// Remover o VTT do curso (clear de um vídeo). Nunca lança.
async function removeCourseSubtitle(lib, rel, hash) {
  const dest = courseSubtitlePath(lib, rel, hash);
  if (dest) await fs.rm(dest, { force: true }).catch(() => {});
}

// O artefato final existe? Prioriza o VTT da pasta do curso (canônico) e cai
// para o espelho de data/subtitles/ (vídeos na raiz / resiliência).
async function hasFinalVtt(lib, rel, hash) {
  const courseVtt = courseSubtitlePath(lib, rel, hash);
  if (courseVtt) {
    const st = await fs.stat(courseVtt).catch(() => null);
    if (st && st.size > 0) return true;
  }
  const st = await fs.stat(path.join(SUBTITLE_DIR, hash + ".vtt")).catch(() => null);
  return !!(st && st.size > 0);
}

// Remove todos os VTTs finais de .courseplayer/subtitles de TODAS as
// bibliotecas (clear global). Não toca nos arquivos originais nem nos
// materiais dos cursos.
async function sweepCourseSubtitles() {
  const roots = getLibraries()
    .filter((l) => l.enabled !== false)
    .map((l) => l.path);
  await Promise.all(
    roots.map(async (root) => {
      let names = [];
      try {
        names = await fs.readdir(root);
      } catch {
        return;
      }
      await Promise.all(
        names
          .filter((n) => !n.startsWith(".") && n !== APP_DIR_NAME)
          .map(async (n) => {
            const courseSub = path.join(root, n, COURSE_SUBTITLE_DIR);
            await fs.rm(courseSub, { recursive: true, force: true }).catch(() => {});
            // Remove o `.courseplayer` se ficou vazio (a pasta nasce só para as
            // legendas; não remover deixaria um diretório órfão na biblioteca).
            const parent = path.join(root, n, ".courseplayer");
            const st = await fs.stat(parent).catch(() => null);
            if (st && st.isDirectory()) {
              const items = await fs.readdir(parent).catch(() => []);
              if (items.length === 0) await fs.rm(parent, { recursive: true, force: true }).catch(() => {});
            }
          }),
      );
    }),
  );
}

// ==========================================================================
// Pré-geração orientada à demanda (fila priorizada P1/P2/P3)
// --------------------------------------------------------------------------
// Regra central do sistema: gerar PRIMEIRO o que o usuário provavelmente vai
// precisar, e nunca a biblioteca inteira de uma vez. A demanda imediata (P0,
// aula aberta) e a próxima aula (P1) sempre passam na frente da primeira aula
// de cada curso (P2) e do background (P3, desligado por padrão).
// ==========================================================================
const BACKGROUND_BATCH = 20; // limite de P3 por varredura (controle claro)

// Já existe legenda válida (processed + VTT)? Skip-if-ready — evita enfileirar
// o que já está pronto e mantém a fila enxuta (sem ruído "cache encontrado").
async function hasValidSubtitle(lib, rel, abs) {
  const sourceStat = await fs.stat(abs).catch(() => null);
  if (!sourceStat) return false;
  const hash = subtitleCacheName(lib.id, rel);
  const processedPath = path.join(SUBTITLE_PROCESSED_DIR, hash + ".json");
  const doc = await loadValidProcessed(processedPath, abs, sourceStat);
  if (!doc) return false;
  return hasFinalVtt(lib, rel, hash);
}

// Primeiro vídeo de um curso em ordem natural (DFS: pastas antes dos arquivos,
// mesma ordenação do scan). Retorna o nó video ou null.
function firstVideoOfCourse(node) {
  for (const child of node.children || []) {
    if (child.type === "folder") {
      const v = firstVideoOfCourse(child);
      if (v) return v;
    } else if (child.type === "video") {
      return child;
    }
  }
  return null;
}

// P2: primeira aula de cada curso, após scan/rescan, somente se o config
// permitir e não houver legenda. Nunca além da primeira aula por curso.
async function maybePregenFirstLessons(tree) {
  const cfg = await loadAiConfig();
  if (!cfg.transcription.enabled || cfg.transcription.pregenFirstLesson !== true) return;
  if (cfg.transcription.generateMode === "manual") return; // só sob demanda
  const avail = await transcriptionAvailability(cfg);
  if (!avail.available) return; // sem binário/modelo: nada a enfileirar
  await loadSubtitleJobs();
  // P2: "primeira aula de cada curso". Com tópicos, um curso é uma pasta de
  // tipo "folder" cujo pai não é outro "folder" (senão seria módulo) — módulos
  // e tópicos ficam de fora da pré-geração de primeira aula.
  // Percorre TODAS as bibliotecas escaneadas com sucesso (auditoria §7).
  for (const lib of (tree.libraries || []).filter((l) => l.tree)) {
    const courses = [];
    const collectCourseRoots = (node, parentType) => {
      for (const child of node.children || []) {
        if (child.type !== "folder") continue;
        if (parentType !== "folder") courses.push(child);
        collectCourseRoots(child, child.type);
      }
    };
    collectCourseRoots(lib.tree, "root"); // a raiz da biblioteca não é um curso
    for (const course of courses) {
      const first = firstVideoOfCourse(course);
      if (!first) continue;
      const safe = resolveLibraryRel(lib, first.path);
      if (!safe) continue;
      if (await hasValidSubtitle(lib, safe.rel, safe.abs)) continue;
      startSubtitleJob(lib, safe.rel, safe.abs, { priority: PRIORITY_FIRST });
      console.log(`[SUBTITLE] pré-geração P2 (primeira aula): ${lib.id} ${safe.rel}`);
    }
  }
}

// P3: background controlado. Só enfileira quando não há demanda/pré-geração
// pendente (P0/P1/P2), em lote limitado por varredura. Desligado por padrão.
async function maybePregenBackground(tree) {
  const cfg = await loadAiConfig();
  if (!cfg.transcription.enabled || cfg.transcription.background !== true) return;
  const avail = await transcriptionAvailability(cfg);
  if (!avail.available) return;
  await loadSubtitleJobs();
  const active = ["queued", "extracting", "transcribing", "processing", "correcting", "formatting"];
  const pendingHigher = [...subtitleJobs.values()].some(
    (j) => active.includes(j.status) && j.priority < PRIORITY_BG,
  );
  if (pendingHigher) return; // nunca disputa slot com demanda/primeira aula
  const videos = []; // { lib, node }
  const walk = (lib, node) => {
    for (const c of node.children || []) {
      if (c.type === "folder") walk(lib, c);
      else if (c.type === "video") videos.push({ lib, node: c });
    }
  };
  for (const lib of (tree.libraries || []).filter((l) => l.tree)) {
    for (const course of (lib.tree.children || []).filter((c) => c.type === "folder")) {
      walk(lib, course);
    }
  }
  let enqueued = 0;
  for (const { lib, node: v } of videos) {
    if (enqueued >= BACKGROUND_BATCH) break;
    const safe = resolveLibraryRel(lib, v.path);
    if (!safe) continue;
    if (await hasValidSubtitle(lib, safe.rel, safe.abs)) continue;
    startSubtitleJob(lib, safe.rel, safe.abs, { priority: PRIORITY_BG });
    enqueued += 1;
  }
  if (enqueued > 0) {
    console.log(`[SUBTITLE] background P3: ${enqueued} vídeos enfileirados (lote máx. ${BACKGROUND_BATCH})`);
  }
}

// Dispara pré-geração pós-scan sem bloquear a resposta da API (fire-and-forget).
// Dedup + skip-if-ready tornam chamadas repetidas inofensivas.
function scheduleSubtitlePregen(tree) {
  maybePregenFirstLessons(tree).catch(() => {});
  maybePregenBackground(tree).catch(() => {});
}

async function ensureSubtitleDirs() {
  await Promise.all([
    fs.mkdir(SUBTITLE_DIR, { recursive: true }),
    fs.mkdir(SUBTITLE_RAW_DIR, { recursive: true }),
    fs.mkdir(SUBTITLE_PROCESSED_DIR, { recursive: true }),
    fs.mkdir(SUBTITLE_WORK_DIR, { recursive: true }),
    fs.mkdir(SUBTITLE_EDITED_DIR, { recursive: true }),
    fs.mkdir(SUBTITLE_TRANSLATION_DIR, { recursive: true }),
    fs.mkdir(SUBTITLE_BACKUP_DIR, { recursive: true }),
  ]);
}

// Estado em memória dos jobs + fila priorizada (poucos pipelines por vez).
const subtitleJobs = new Map(); // hash -> job
const subtitleQueue = []; // hashes aguardando um slot (ordenado por prioridade)
const activeSubtitleHashes = new Set(); // hashes em execução AGORA
let subtitleMax = MAX_CONCURRENT_TRANSCRIPTIONS;
let subtitleJobsLoaded = false;

// --------------------------------------------------------------------------
// device-unavailable / awaiting-source (Fase 4). Quando o vídeo está num
// dispositivo externo (pendrive/HD) que foi desmontado ou desconectado no meio
// da geração, o job NÃO deve virar "failed" e nem tentar em loop: ele entra em
// "waiting-source" (persistido) e um watcher barato (30s, .unref) re-enfileira
// assim que a fonte voltar a existir. Erros reais (EACCES/EPERM) continuam
// "failed" — não há recuperação automática para esses.
// --------------------------------------------------------------------------
const SUBTITLE_STATUS_WAITING_SOURCE = "waiting-source";
const waitingSourceHashes = new Set(); // hashes aguardando a fonte voltar
const DEVICE_UNAVAILABLE_CODES = new Set([
  "ENODEV", "EIO", "ESTALE", "ENXIO", "EBUSY", "ENOTCONN", "ENOENT",
]);
function isDeviceUnavailableCode(code) {
  return typeof code === "string" && DEVICE_UNAVAILABLE_CODES.has(code);
}

function subtitleJobPersistShape(job) {
  return {
    hash: job.hash,
    libraryId: job.libraryId,
    rel: job.rel,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error || null,
    priority: job.priority ?? PRIORITY_FIRST,
    language: job.language,
    provider: job.provider,
    model: job.model,
    kind: job.kind || null, // "translation" para jobs de tradução (hash = baseHash-lang)
    lang: job.lang || null, // idioma-alvo do job de tradução
    baseHash: job.baseHash || null, // hash-base da legenda original
  };
}

async function persistSubtitleJobs() {
  const payload = {};
  for (const job of subtitleJobs.values()) {
    payload[job.hash] = subtitleJobPersistShape(job);
  }
  await writeFileAtomic(SUBTITLE_JOBS_FILE, JSON.stringify(payload, null, 2)).catch(
    () => {},
  );
}

// No boot: recarrega jobs.json e reconcilia. Jobs que estavam em execução mas
// o processo morreu (restart) são retomados a partir do raw se ele existir;
// caso contrário viram "cancelled". Nada é re-executado aqui (o raw nunca é
// re-gerado pelo whisper depois de existir).
async function loadSubtitleJobs() {
  if (subtitleJobsLoaded) return;
  subtitleJobsLoaded = true;
  await ensureSubtitleDirs();
  const read = await readJsonFile(SUBTITLE_JOBS_FILE);
  if (!read.ok) {
    if (read.raw !== null) {
      // jobs.json existe mas está corrompido (crash no meio de uma escrita ou
      // queda de energia). Preserva o arquivo como evidência e começa vazio —
      // jobs de legenda são best-effort: sem backup nem auto-resgate de fila,
      // a demanda (P0/P1/P2) reenfileira o que importa no próximo boot.
      const corruptFile = SUBTITLE_JOBS_FILE + ".corrupt-" + Date.now();
      await fs.rename(SUBTITLE_JOBS_FILE, corruptFile).catch(() => {});
      console.error(`[SUBTITLE][WARN] ${path.basename(SUBTITLE_JOBS_FILE)} corrompido — preservado em ${path.basename(corruptFile)}; fila recomeça vazia`);
    }
    return;
  }
  if (!read.parsed) return;
  for (const [hash, rec] of Object.entries(read.parsed)) {
    if (!rec || typeof rec.hash !== "string" || !rec.hash) continue;
    const job = {
      hash: rec.hash,
      libraryId: rec.libraryId || DEFAULT_LIBRARY_ID,
      rel: rec.rel || "",
      status: rec.status || "cancelled",
      priority: Number.isInteger(rec.priority)
        ? Math.min(3, Math.max(0, rec.priority))
        : PRIORITY_FIRST,
      force: false,
      stageStartedAt: null,
      requeueOnCancel: false,
      createdAt: rec.createdAt || Date.now(),
      updatedAt: rec.updatedAt || Date.now(),
      error: rec.error || null,
      language: rec.language || null,
      provider: rec.provider || null,
      model: rec.model || null,
      kind: rec.kind === "translation" ? "translation" : null,
      lang: rec.kind === "translation" ? (rec.lang || null) : null,
      baseHash: rec.kind === "translation" ? (rec.baseHash || null) : null,
      proc: null,
      progress: "",
      percent: null,
    };
    // `abs` não é persistido — reconstrói do rel (o pipeline usa job.abs para
    // o fs.stat; sem isso um job retomado após restart falharia com "Arquivo
    // de vídeo não encontrado"). Resolve pelo libraryId persistido no job.
    if (job.rel) {
      const lib = getLibraryById(job.libraryId);
      const safe = lib ? resolveLibraryRel(lib, job.rel) : resolveSafeRelPath(job.rel);
      job.abs = safe ? safe.abs : null;
    }
    // Jobs que estavam "waiting-source" voltam a ser vigiados pelo watcher.
    if (job.status === SUBTITLE_STATUS_WAITING_SOURCE) {
      waitingSourceHashes.add(job.hash);
    }
    const active = new Set([
      "queued", "extracting", "transcribing", "processing", "correcting", "formatting",
      "translating",
    ]);
    if (active.has(job.status)) {
      if (job.kind === "translation") {
        // Job de tradução: idempotente (regenera do processed) — nunca retoma
        // de raw; só volta para a fila.
        job.status = "queued";
        job.progress = "";
      } else {
        const rawPath = path.join(SUBTITLE_RAW_DIR, job.hash + ".json");
        if (await fileExists(rawPath)) {
          // raw existe → retoma do pós-processamento (nunca re-roda whisper).
          job.status = "processing";
          job.progress = "Retomando do pós-processamento";
        } else {
          // Sem artefato válido → o job VOLTA para a fila e recomeça do zero.
          job.status = "queued";
          job.progress = "";
        }
      }
      // Ambos (queued e processing) vão para a fila — o scheduler executa
      // qualquer um; sem isso um job retomado ficava travado em "processing".
      subtitleQueue.push(job.hash);
    }
    subtitleJobs.set(job.hash, job);
  }
  await persistSubtitleJobs();
  // Re-enfileirados entram no scheduler assim que o boot terminar.
  scheduleNextSubtitleJob();
}

function getSubtitleJob(hash) {
  return subtitleJobs.get(hash) || null;
}

function updateSubtitleJob(hash, patch, persist = true) {
  const job = subtitleJobs.get(hash);
  if (!job) return null;
  Object.assign(job, patch, { updatedAt: Date.now() });
  if (persist) persistSubtitleJobs();
  return job;
}

// Deduplica: várias requisições para o MESMO vídeo compartilham UM job. Um
// segundo POST enquanto o primeiro roda recebe {alreadyRunning:true}. Quando a
// nova requisição é MAIS prioritária, o job ativo é PROMOVIDO (mesma execução,
// prioridade elevada) — nunca cria um segundo job para o mesmo vídeo.
function startSubtitleJob(lib, rel, abs, opts = {}) {
  // `opts.lang` presente = job de TRADUÇÃO: chave derivada `baseHash-lang`,
  // independe da transcrição (a própria pode coexistir na fila) e NUNCA colide
  // com a legenda original. O scheduler despacha pelo `kind`.
  const isTranslation = typeof opts.lang === "string" && opts.lang.length > 0;
  const baseHash = subtitleCacheName(lib.id, rel);
  const hash = isTranslation ? translationCacheName(baseHash, opts.lang) : baseHash;
  const priority = Number.isInteger(opts.priority)
    ? Math.min(3, Math.max(0, opts.priority))
    : PRIORITY_DEMAND;
  const force = opts.force === true;
  const existing = subtitleJobs.get(hash);
  const active = new Set([
    "queued", "extracting", "transcribing", "processing", "correcting", "formatting",
    "translating",
  ]);
  if (existing && active.has(existing.status)) {
    const promoted = priority < existing.priority;
    if (promoted) {
      updateSubtitleJob(hash, { priority });
      console.log(`[SUBTITLE] promovido P${priority}: ${rel}${isTranslation ? " → " + opts.lang : ""}`);
    }
    return { job: existing, alreadyRunning: true, promoted };
  }
  const job = {
    hash,
    libraryId: lib.id,
    rel,
    abs, // apenas runtime (não persistido — ver persistShape)
    status: "queued",
    priority,
    force,
    stageStartedAt: null,
    requeueOnCancel: false,
    progress: "Na fila",
    percent: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    language: null,
    provider: null,
    model: null,
    proc: null,
    kind: isTranslation ? "translation" : null,
    lang: isTranslation ? opts.lang : null,
    baseHash: isTranslation ? baseHash : null,
  };
  subtitleJobs.set(hash, job);
  subtitleQueue.push(hash);
  persistSubtitleJobs();
  // Demanda imediata (P0/P1) pode liberar slot preemptando um job pesado de
  // baixa prioridade que esteja só no começo (barato de reiniciar).
  maybePreemptFor(priority);
  scheduleNextSubtitleJob();
  return { job, alreadyRunning: false, promoted: false };
}

// Remove a saída parcial do Whisper (.json/.txt) de TODOS os locais possíveis:
// o antigo data/subtitles/work e o workspace local (auto ou custom). Fire-and-
// forget — é best-effort; o pipeline também limpa no finally quando o proc morre.
async function removeWhisperWorkOutput(hash) {
  const dirs = [path.join(SUBTITLE_WORK_DIR)];
  const cfg = await loadAiConfig().catch(() => null);
  if (cfg) {
    const w = await resolveWorkspaceDir(cfg).catch(() => WORKSPACE_AUTO_ROOT);
    dirs.push(path.join(w, "work"));
  } else {
    dirs.push(path.join(WORKSPACE_AUTO_ROOT, "work"));
  }
  for (const d of new Set(dirs)) {
    await Promise.all([
      fs.rm(path.join(d, hash + ".json"), { force: true }).catch(() => {}),
      fs.rm(path.join(d, hash + ".txt"), { force: true }).catch(() => {}),
    ]);
  }
}

function cancelSubtitleJob(hash, opts = {}) {
  const job = subtitleJobs.get(hash);
  if (!job) return false;
  if (job.status === "queued") {
    const idx = subtitleQueue.indexOf(hash);
    if (idx >= 0) subtitleQueue.splice(idx, 1);
    updateSubtitleJob(hash, { status: "cancelled", progress: "Cancelado", error: null });
    console.log(`[SUBTITLE] cancelado: ${job.rel}`);
    return true;
  }
  const active = new Set([
    "extracting", "transcribing", "processing", "correcting", "formatting",
    "translating",
  ]);
  if (active.has(job.status)) {
    updateSubtitleJob(hash, {
      status: "cancelled",
      progress: "Cancelando…",
      error: null,
      // Preemptão: o job volta para a fila (P3) no finally do pipeline, em vez
      // de ficar "cancelled" de verdade.
      requeueOnCancel: opts.preempt === true,
    });
    if (job.proc) {
      try { job.proc.kill("SIGTERM"); } catch {}
    }
    job.proc = null;
    // Remove a saída parcial do whisper para o retry não ler JSON truncado
    // (cobre o work antigo e o workspace local).
    removeWhisperWorkOutput(hash).catch(() => {});
    console.log(
      opts.preempt
        ? `[SUBTITLE] preemptado: ${job.rel} (re-enfileira em P${PREEMPT_RETRY_PRIORITY})`
        : `[SUBTITLE] cancelando: ${job.rel}`,
    );
    return true;
  }
  if (job.status === SUBTITLE_STATUS_WAITING_SOURCE) {
    waitingSourceHashes.delete(hash);
    updateSubtitleJob(hash, { status: "cancelled", progress: "Cancelado", error: null });
    console.log(`[SUBTITLE] cancelado (aguardava fonte): ${job.rel}`);
    return true;
  }
  return false;
}

async function subtitleJobPublic(hash) {
  const job = subtitleJobs.get(hash);
  if (!job) return null;
  const lib = getLibraryById(job.libraryId) || getDefaultLibrary();
  return {
    hash: job.hash,
    libraryId: job.libraryId,
    rel: job.rel,
    status: job.status,
    stage: job.status, // estado do pipeline (legado: "status" também)
    priority: job.priority,
    progress: job.progress || "",
    percent: job.percent ?? null,
    error: job.error || null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    language: job.language,
    provider: job.provider,
    model: job.model,
    kind: job.kind || null,
    lang: job.lang || null,
    hasVtt: await hasFinalVtt(lib, job.rel, job.hash),
  };
}

// Um job em execução só é preemptível quando reiniciá-lo é barato: extração de
// áudio (rápida) ou transcrição recém-iniciada (dentro da janela de graça).
// Transcrição profunda NÃO é interrompida — cancelar desperdiçaria o trabalho
// e o modelo (carregado por execução) seria recarregado de novo de qualquer forma.
function isPreemptible(job) {
  if (!job) return false;
  if (job.status === "extracting") return true;
  if (job.status === "transcribing") {
    const started = job.stageStartedAt || job.updatedAt || 0;
    return Date.now() - started < PREEMPT_GRACE_MS;
  }
  return false;
}

// Quando um job de maior prioridade entra, tenta liberar um slot preemptando o
// job em execução de MENOR prioridade (maior número) que seja barato de
// reiniciar. O preemptado volta para a fila em P3 no finally do pipeline.
function maybePreemptFor(priority) {
  let target = null;
  for (const hash of activeSubtitleHashes) {
    const job = subtitleJobs.get(hash);
    if (!job || job.priority <= priority) continue; // nunca preempta quem é igual ou mais prioritário (número menor)
    if (!isPreemptible(job)) continue;
    if (!target || job.priority > target.job.priority) target = { hash, job };
  }
  if (target) {
    cancelSubtitleJob(target.hash, { preempt: true });
    return true;
  }
  return false;
}

// Reflete o config avançado (Central de IA / env) no limite de pipelines.
function refreshSubtitleMax(value) {
  const n = Number(value);
  subtitleMax = Number.isFinite(n)
    ? Math.min(8, Math.max(1, Math.floor(n)))
    : subtitleMax;
}

// Ordena a fila por prioridade (menor número primeiro). O sort é estável, então
// jobs de MESMA prioridade preservam a ordem de chegada (FIFO dentro do nível).
function sortSubtitleQueue() {
  subtitleQueue.sort(
    (a, b) =>
      (subtitleJobs.get(a)?.priority ?? PRIORITY_FIRST) -
      (subtitleJobs.get(b)?.priority ?? PRIORITY_FIRST),
  );
}

// Scheduler priorizado: preenche até `subtitleMax` pipelines, sempre pegando o
// job de maior prioridade da fila. A deduplicação/promoção garante que cada
// vídeo tem no máximo um job; o gate `heavySlots` garante que ffmpeg+whisper
// nunca rodam simultaneamente com outras tarefas pesadas.
function scheduleNextSubtitleJob() {
  sortSubtitleQueue();
  while (activeSubtitleHashes.size < subtitleMax && subtitleQueue.length) {
    const hash = subtitleQueue.shift();
    const job = subtitleJobs.get(hash);
    // Aceita "queued" (novo/recomeço) e "processing" (retomado do raw).
    if (!job || (job.status !== "queued" && job.status !== "processing")) continue;
    activeSubtitleHashes.add(hash);
    // Tradução (LLM, não consome slot pesado) usa pipeline próprio; transcrição
    // mantém o fluxo original (ffmpeg+whisper com heavySlots).
    if (job.kind === "translation") runTranslationPipeline(job).catch(() => {});
    else runSubtitlePipeline(job).catch(() => {});
  }
}

// Watcher de retomada (Fase 4): re-enfileira jobs "waiting-source" quando o
// arquivo volta a existir E está estável há >=15s (acabou de montar/copiar).
// Barato: um fs.stat por hash a cada 30s, com .unref (não segura o processo).
// Nunca tenta em loop num dispositivo ausente — só age quando a fonte volta.
async function resumeWaitingSource() {
  if (!waitingSourceHashes.size) return;
  for (const hash of [...waitingSourceHashes]) {
    const job = subtitleJobs.get(hash);
    if (!job || job.status !== SUBTITLE_STATUS_WAITING_SOURCE) {
      waitingSourceHashes.delete(hash);
      continue;
    }
    const st = await fs.stat(job.abs).catch(() => null);
    if (!st) continue; // fonte ainda ausente — espera o próximo ciclo
    if (Date.now() - st.mtimeMs < 15000) continue; // pode estar copiando ainda
    waitingSourceHashes.delete(hash);
    updateSubtitleJob(hash, {
      status: "queued",
      progress: "Na fila",
      error: null,
      priority: job.priority ?? PRIORITY_DEMAND,
    });
    // Re-enfileira no scheduler — sem isso o job fica "queued" eternamente
    // (a status já foi atualizada, mas a hash saiu da fila quando o job rodou).
    subtitleQueue.push(hash);
    console.log(`[SUBTITLE][DEVICE] fonte voltou, re-enfileirando: ${job.rel}`);
  }
  scheduleNextSubtitleJob();
}
setInterval(() => {
  resumeWaitingSource().catch(() => {});
}, 30000).unref();

// Resolve o binário do whisper: WHISPER_BIN (env) OU bin/whisper-cli*.
async function resolveWhisperBinary(provider) {
  if (provider.id === "whisper" && WHISPER_BIN) {
    if (await fileExists(WHISPER_BIN)) return WHISPER_BIN;
  }
  const found = await scanDirForNames(BIN_DIR, provider.binaryNames);
  if (found.length) return path.join(BIN_DIR, found[0]);
  return null;
}

// Resolve o arquivo de modelo instalado: models/ ou WHISPER_MODEL_DIR.
async function resolveWhisperModelFile(provider, modelId) {
  const dir =
    provider.id === "whisper" && WHISPER_MODEL_DIR
      ? WHISPER_MODEL_DIR
      : MODELS_DIR;
  const prefix = modelSearchPrefix(provider, modelId);
  const found = await scanDirForNames(dir, [prefix]);
  if (found.length) return path.join(dir, found[0]);
  return null;
}

// Verifica se o pipeline pode rodar de verdade. Sem binário/modelo/config
// habilitada → motivo explícito (nunca falso sucesso, nunca crash).
async function transcriptionAvailability(cfg) {
  if (!cfg.transcription.enabled) {
    return { available: false, reason: "disabled" };
  }
  const provider = findTranscriptionProvider(cfg.transcription.provider);
  if (!provider) return { available: false, reason: "unknown_provider" };
  if (!provider.local) return { available: false, reason: "not_local" };
  if (!(await resolveWhisperBinary(provider))) {
    return { available: false, reason: "binary_not_installed" };
  }
  if (!(await resolveWhisperModelFile(provider, cfg.transcription.model))) {
    return { available: false, reason: "model_not_installed" };
  }
  return { available: true, provider, reason: null };
}

// Cache válido? O processed é reaproveitado somente se a origem não mudou
// (mtime + size — não re-hasheia o vídeo inteiro) e a versão bate.
async function loadValidProcessed(processedPath, abs, sourceStat) {
  const read = await readJsonFile(processedPath);
  if (!read.ok || !read.parsed || read.parsed.version !== SUBTITLE_VERSION) {
    return null;
  }
  const doc = read.parsed;
  const src = doc.source || {};
  if (src.mtimeMs === sourceStat.mtimeMs && src.size === sourceStat.size) {
    return doc;
  }
  return null;
}

// Pipeline principal: estados queued → extracting → transcribing → processing
// → correcting (opcional) → formatting → completed/failed/cancelled. Nunca roda
// ffmpeg + whisper simultaneamente (slot pesado compartilhado). LLM não
// consome slot e nunca bloqueia a legenda. Cancelamento é checado entre etapas.
async function runSubtitlePipeline(job) {
  const hash = job.hash;
  const rel = job.rel;
  // A biblioteca do job (persistida) resolve o path canônico do VTT e o abs do
  // vídeo. Um job de biblioteca removida cai na padrão e falha honesto ("Arquivo
  // não encontrado") — best-effort, nunca quebra o pipeline dos demais.
  const lib = getLibraryById(job.libraryId) || getDefaultLibrary();
  try {
    const cfg = await loadAiConfig();
    refreshHeavyMax(cfg.advanced.maxConcurrentAiJobs);
    refreshSubtitleMax(cfg.advanced.maxConcurrentTranscriptions);
    // Workspace local (auto = temp do SO, custom = dir validado). O pendrive só
    // é tocado para ler o vídeo e gravar o VTT final — nunca para WAV/saída.
    const workspaceDir = await resolveWorkspaceDir(cfg);
    updateSubtitleJob(hash, {
      language: cfg.transcription.language,
      provider: cfg.transcription.provider,
      model: cfg.transcription.model,
    });

    const avail = await transcriptionAvailability(cfg);
    if (!avail.available) {
      const msg =
        avail.reason === "disabled"
          ? "Transcrição desabilitada nas configurações."
          : avail.reason === "binary_not_installed"
            ? "Binário do Whisper não instalado."
            : avail.reason === "model_not_installed"
              ? "Modelo do Whisper não instalado."
              : "Provedor de transcrição indisponível.";
      updateSubtitleJob(hash, { status: "failed", progress: "", error: msg });
      console.log(`[SUBTITLE] falhou (unavailable: ${avail.reason}): ${rel}`);
      return;
    }

    const sourceStat = await fs.stat(job.abs).catch((err) => ({ __err: err }));
    if (!sourceStat) {
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: "Arquivo de vídeo não encontrado.",
      });
      return;
    }
    if (sourceStat.__err) {
      // Fonte sumiu / dispositivo desmontado: vira "waiting-source" (nunca
      // retry em loop; o watcher religa quando o arquivo voltar a existir).
      if (isDeviceUnavailableCode(sourceStat.__err.code)) {
        updateSubtitleJob(hash, {
          status: SUBTITLE_STATUS_WAITING_SOURCE,
          progress: "",
          error: "Dispositivo indisponível — aguardando a fonte voltar.",
        });
        waitingSourceHashes.add(hash);
        console.log(
          `[SUBTITLE][DEVICE] fonte indisponível (${sourceStat.__err.code}), aguardando: ${rel}`,
        );
      } else {
        updateSubtitleJob(hash, {
          status: "failed",
          progress: "",
          error: `Erro ao acessar o vídeo: ${sanitizeTestError(sourceStat.__err.code || sourceStat.__err.message)}`,
        });
        console.log(`[SUBTITLE] falhou (acesso: ${sourceStat.__err.code}): ${rel}`);
      }
      return;
    }

    // Symlink/junction apontando para fora da biblioteca: o raw/extrato seria
    // gerado a partir de um arquivo fora da biblioteca (ex.: link → /etc/passwd,
    // link → data/ de outra lib). Recusa antes de extrair com ffmpeg/whisper.
    if (!(await fileWithinLibrary(lib, job.abs))) {
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: "Arquivo fora da biblioteca.",
      });
      console.log(`[SUBTITLE] recusado (fora da biblioteca): ${rel}`);
      return;
    }

    // 0) force (botão "Regenerar"): descarta artefatos existentes para a
    // transcrição rodar de novo — cache, raw e VTTs (espelho + curso). A
    // versão EDITADA manualmente é preservada em backup/ (nunca apagada em
    // silêncio — a edição manual é sempre a camada final e não pode ser
    // destruída sem confirmação explícita no frontend).
    if (job.force) {
      console.log(`[SUBTITLE] force: regenerando do zero: ${rel}`);
      updateSubtitleJob(hash, { force: false }, false);
      await backupEditedSubtitle(hash);
      const targets = [
        path.join(SUBTITLE_RAW_DIR, hash + ".json"),
        path.join(SUBTITLE_PROCESSED_DIR, hash + ".json"),
        path.join(SUBTITLE_DIR, hash + ".vtt"),
      ];
      const courseVtt = courseSubtitlePath(lib, rel, hash);
      if (courseVtt) targets.push(courseVtt);
      await Promise.all(targets.map(p => fs.rm(p, { force: true }).catch(() => {})));
    }

    // 1) Cache já pronto e válido? (processed + vtt) → conclui direto.
    const processedPath = path.join(SUBTITLE_PROCESSED_DIR, hash + ".json");
    if (await loadValidProcessed(processedPath, job.abs, sourceStat)) {
      updateSubtitleJob(hash, { status: "completed", progress: "Cache encontrado", error: null });
      console.log(`[SUBTITLE] cache encontrado: ${rel}`);
      return;
    }

    // 2) Retoma do raw se existir (nunca re-roda whisper). Só confia no raw se
    // foi transcrito DESTE arquivo (mtime+size batem): um vídeo substituído (ou
    // tocado) re-extrai/re-transcreve — nunca reusa transcrição velha.
    const rawPath = path.join(SUBTITLE_RAW_DIR, hash + ".json");
    let rawDoc = null;
    if (await fileExists(rawPath)) {
      const r = await readJsonFile(rawPath);
      if (r.ok && r.parsed && r.parsed.version === SUBTITLE_VERSION) {
        const rs = r.parsed.source;
        if (rs && rs.mtimeMs === sourceStat.mtimeMs && rs.size === sourceStat.size) {
          rawDoc = r.parsed;
        }
      }
    }

    if (!rawDoc) {
      // 3) Extração de áudio (segura slot pesado). WAV fica no workspace
      // LOCAL, nunca no pendrive. Checa espaço antes de começar.
      if (job.status === "cancelled") return;
      const wavPath = path.join(workspaceDir, "audio", hash + ".wav");
      const spaceIssue = await ensureWorkspaceSpace(workspaceDir, sourceStat.size / 600000);
      if (spaceIssue) {
        updateSubtitleJob(hash, {
          status: "failed",
          progress: "",
          error: `Espaço insuficiente no workspace (~${Math.round(spaceIssue.free / 1048576)}MB livres; precisa ~${Math.round(spaceIssue.need / 1048576)}MB). Limpe o workspace ou escolha outro diretório.`,
        });
        console.log(`[SUBTITLE] workspace sem espaço: ${rel}`);
        return;
      }
      updateSubtitleJob(hash, { status: "extracting", progress: "Extraindo áudio…", stageStartedAt: Date.now() });
      console.log(`[SUBTITLE][PROCESS] extraindo áudio: ${rel}`);
      const releaseHeavy = await acquireHeavySlot();
      try {
        await extractAudioToWav(job.abs, wavPath);
      } finally {
        releaseHeavy();
      }
      if (job.status === "cancelled") {
        await fs.unlink(wavPath).catch(() => {});
        return;
      }

      // 4) Transcrição (segura slot pesado — nunca junto do ffmpeg).
      updateSubtitleJob(hash, { status: "transcribing", progress: "Transcrevendo…", percent: null });
      console.log(`[SUBTITLE][PROCESS] transcrevendo: ${rel}`);
      const releaseHeavy2 = await acquireHeavySlot();
      try {
        const result = await runWhisperTranscription({
          provider: avail.provider,
          model: cfg.transcription.model,
          language: cfg.transcription.language,
          vad: cfg.transcription.vad === true && avail.provider.capabilities?.vad === true,
          threads: cfg.advanced.transcriptionThreads || 0,
          wavPath,
          outPrefix: path.join(workspaceDir, "work", hash),
          // Progresso real do whisper (stderr `progress = N%`); se o provider
          // não emite, o frontend mostra estado indeterminado — nunca inventa.
          onProgress: (percent) => {
            if (job.status === "transcribing") {
              updateSubtitleJob(hash, { percent }, false);
            }
          },
          // Expõe o processo para cancelamento/preempção matarem de verdade.
          setProc: (proc) => {
            job.proc = proc;
          },
        });
        job.proc = null;
        if (!result.ok) throw new Error(result.error || "Falha na transcrição.");
        rawDoc = {
          version: SUBTITLE_VERSION,
          source: { rel, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
          // Com `-l auto` o idioma detectado vem do JSON do whisper; senão usa
          // o config. Vira a "língua-fonte" real (usada pelo seletor de idioma).
          language: result.language || cfg.transcription.language,
          provider: avail.provider.id,
          model: cfg.transcription.model,
          createdAt: new Date().toISOString(),
          rawText: result.rawText || "",
          segments: result.segments || [],
        };
        await writeFileAtomic(rawPath, JSON.stringify(rawDoc, null, 2));
      } finally {
        releaseHeavy2();
        await fs.unlink(wavPath).catch(() => {});
        // Saída temporária do whisper (workspace local) — já consumida no raw.
        const workPrefix = path.join(workspaceDir, "work", hash);
        await Promise.all([
          fs.rm(workPrefix + ".json", { force: true }).catch(() => {}),
          fs.rm(workPrefix + ".txt", { force: true }).catch(() => {}),
        ]);
      }
      if (job.status === "cancelled") {
        // Preempção mantém o raw (retomada de "processing" no re-enfileiramento);
        // cancelamento real descarta o raw órfão.
        if (!job.requeueOnCancel) {
          await fs.rm(rawPath, { force: true }).catch(() => {});
        }
        return;
      }
    }

    // 5) Pós-processamento determinístico → processed (sempre roda).
    updateSubtitleJob(hash, { status: "processing", progress: "Pós-processando…" });
    console.log(`[SUBTITLE][PROCESS] pós-processando: ${rel}`);
    let processedSegments = await postprocessSegments(rawDoc.segments || [], cfg);
    const processedDoc = {
      version: SUBTITLE_VERSION,
      source: rawDoc.source,
      language: rawDoc.language,
      provider: rawDoc.provider,
      model: rawDoc.model,
      createdAt: new Date().toISOString(),
      correctedByLlm: false,
      segments: processedSegments,
    };

    // 6) Correção LLM opcional (rede; não consome slot pesado; nunca bloqueia).
    if (cfg.correction.enabled && cfg.correction.providerId && cfg.correction.model) {
      if (job.status !== "cancelled") {
        updateSubtitleJob(hash, { status: "correcting", progress: "Corrigindo com IA…" });
        console.log(`[SUBTITLE][PROCESS] corrigindo (LLM): ${rel}`);
        const corrected = await runLlmCorrection({
          providerId: cfg.correction.providerId,
          model: cfg.correction.model,
          segments: processedSegments,
          timeoutMs: cfg.advanced.llmTimeoutMs,
        });
        if (corrected) {
          processedSegments = corrected;
          processedDoc.correctedByLlm = true;
        } else {
          // LLM indisponível/timeout/saída inválida: a legenda segue com a
          // versão anterior (nunca é bloqueada).
          console.log(
            `[SUBTITLE] LLM não aplicado (indisponível, timeout ou saída inválida): ${rel}`,
          );
        }
      }
      if (job.status === "cancelled") return;
    }

    // 7) Formatação → WebVTT (com timestamps controlados pelo app).
    updateSubtitleJob(hash, { status: "formatting", progress: "Formatando legendas…" });
    console.log(`[SUBTITLE][PROCESS] formatando VTT: ${rel}`);
    processedDoc.segments = processedSegments;
    await writeFileAtomic(processedPath, JSON.stringify(processedDoc, null, 2));
    const vttText = renderVtt(processedSegments);
    // Espelho (cache de registro validado por mtime+size) + artefato final na
    // pasta do curso (Curso/.courseplayer/subtitles/<hash>.vtt).
    await writeFileAtomic(path.join(SUBTITLE_DIR, hash + ".vtt"), vttText);
    await writeCourseSubtitle(lib, rel, hash, vttText);

    updateSubtitleJob(hash, { status: "completed", progress: "", error: null, percent: null });
    console.log(
      `[SUBTITLE][PROCESS] concluído: ${rel} (${processedSegments.length} segmentos)`,
    );
  } catch (err) {
    if (job.status !== "cancelled") {
      // Falha no meio do pipeline pode ser o dispositivo ter sumido durante a
      // extração/transcrição (ex.: pendrive desmontado) — ffmpeg/whisper morrem
      // com "No such file or directory". Nesse caso o job espera a fonte voltar
      // em vez de virar "failed" (retomada controlada, ver resumeWaitingSource).
      const devErr = await fs.stat(job.abs).catch((e) => e);
      if (devErr && isDeviceUnavailableCode(devErr.code)) {
        updateSubtitleJob(hash, {
          status: SUBTITLE_STATUS_WAITING_SOURCE,
          progress: "",
          error: "Dispositivo indisponível — aguardando a fonte voltar.",
        });
        waitingSourceHashes.add(hash);
        console.log(
          `[SUBTITLE][DEVICE] fonte sumiu durante o processamento (${devErr.code}), aguardando: ${rel}`,
        );
        return;
      }
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: sanitizeTestError(err.message || "erro"),
      });
      console.error(
        `[SUBTITLE] falhou: ${rel} (${sanitizeTestError(err.message || "erro")})`,
      );
    }
  } finally {
    // Libera o slot de execução SEMPRE (sem isso a fila trava depois do
    // primeiro lote de `subtitleMax` jobs).
    activeSubtitleHashes.delete(hash);
    // Preempção: job barato cancelado para abrir slot a um P0/P1 volta à fila
    // em P3 (PREEMPT_RETRY_PRIORITY) em vez de virar "cancelled" — nunca
    // re-rouba o slot de quem o preemptou e só roda quando sobrar espaço.
    if (job.requeueOnCancel) {
      updateSubtitleJob(
        hash,
        {
          status: "queued",
          priority: PREEMPT_RETRY_PRIORITY,
          requeueOnCancel: false,
          progress: "Na fila",
          error: null,
          stageStartedAt: null,
          proc: null,
          percent: null,
        },
        false,
      );
      subtitleQueue.push(hash);
      console.log(
        `[SUBTITLE] re-enfileirado em P${PREEMPT_RETRY_PRIORITY}: ${rel}`,
      );
    }
    scheduleNextSubtitleJob();
  }
}

// --------------------------------------------------------------------------
// Pipeline de TRADUÇÃO (LLM, sob demanda). Consome a legenda processada
// (língua-fonte) e gera o artefato derivado `baseHash-lang`. Não roda
// ffmpeg/whisper (não consome heavySlots); o LLM é rede e não bloqueia a
// legenda original. Reusa o provider+modelo da correção. Idempotente: se
// falhar/cancelar, basta re-enfileirar e regenerar do processed.
// --------------------------------------------------------------------------
async function runTranslationPipeline(job) {
  const hash = job.hash; // `baseHash-lang`
  const rel = job.rel;
  const lib = getLibraryById(job.libraryId) || getDefaultLibrary();
  const baseHash = job.baseHash || hash.split("-")[0];
  const lang = job.lang;
  try {
    const cfg = await loadAiConfig();
    // Pré-condição honesta: tradução habilitada + LLM da correção configurado.
    const llmOk =
      cfg.translation.enabled === true &&
      cfg.correction.enabled === true &&
      cfg.correction.providerId &&
      cfg.correction.model;
    if (!llmOk) {
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: "Tradução indisponível: habilite a tradução e configure o LLM da correção.",
      });
      console.log(`[SUBTITLE][TRANSLATE] falhou (sem LLM habilitado): ${rel} → ${lang}`);
      return;
    }
    const sourceStat = await fs.stat(job.abs).catch(() => null);
    if (!sourceStat) {
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: "Arquivo de vídeo não encontrado.",
      });
      return;
    }
    const processedPath = path.join(SUBTITLE_PROCESSED_DIR, baseHash + ".json");
    const processed = await loadValidProcessed(processedPath, job.abs, sourceStat);
    if (!processed || !Array.isArray(processed.segments) || !processed.segments.length) {
      // A legenda original não existe/está obsoleta → nada a traduzir. O
      // frontend encadeia: gera a transcrição primeiro e re-solicita.
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: "Legenda original indisponível — gere a transcrição primeiro.",
      });
      console.log(`[SUBTITLE][TRANSLATE] falhou (sem processed válido): ${rel} → ${lang}`);
      return;
    }

    updateSubtitleJob(hash, { status: "translating", progress: "Traduzindo…" });
    console.log(`[SUBTITLE][TRANSLATE] traduzindo: ${rel} → ${lang}`);
    const translated = await runLlmTranslation({
      providerId: cfg.correction.providerId,
      model: cfg.correction.model,
      segments: processed.segments,
      targetLanguage: lang,
      keepTerms: cfg.translation.keepTerms === true,
      timeoutMs: cfg.advanced.llmTimeoutMs,
    });
    if (job.status === "cancelled") {
      if (job.requeueOnCancel) {
        updateSubtitleJob(hash, {
          status: "queued",
          priority: PREEMPT_RETRY_PRIORITY,
          requeueOnCancel: false,
          progress: "Na fila",
          error: null,
          stageStartedAt: null,
          proc: null,
          percent: null,
        }, false);
        subtitleQueue.push(hash);
      }
      return;
    }
    if (!translated) {
      // LLM falhou/timeout/saída inválida: legenda original continua valendo.
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: "Falha na tradução (LLM indisponível ou saída inválida).",
      });
      console.log(`[SUBTITLE][TRANSLATE] LLM não aplicado: ${rel} → ${lang}`);
      return;
    }

    updateSubtitleJob(hash, { status: "formatting", progress: "Formatando…" });
    const doc = {
      version: SUBTITLE_VERSION,
      source: processed.source,
      language: processed.language,
      targetLanguage: lang,
      provider: cfg.correction.providerId,
      model: cfg.correction.model,
      createdAt: new Date().toISOString(),
      correctedByLlm: false,
      segments: translated,
    };
    await writeFileAtomic(translationDocPath(baseHash, lang), JSON.stringify(doc, null, 2));
    const vttText = renderVtt(translated);
    const vttName = translationCacheName(baseHash, lang);
    await writeFileAtomic(path.join(SUBTITLE_DIR, vttName + ".vtt"), vttText);
    await writeCourseSubtitle(lib, rel, vttName, vttText);

    updateSubtitleJob(hash, { status: "completed", progress: "", error: null, percent: null });
    console.log(
      `[SUBTITLE][TRANSLATE] concluído: ${rel} → ${lang} (${translated.length} segmentos)`,
    );
  } catch (err) {
    if (job.status !== "cancelled") {
      updateSubtitleJob(hash, {
        status: "failed",
        progress: "",
        error: sanitizeTestError(err.message || "erro"),
      });
      console.error(
        `[SUBTITLE][TRANSLATE] falhou: ${rel} → ${lang} (${sanitizeTestError(err.message || "erro")})`,
      );
    }
  } finally {
    activeSubtitleHashes.delete(hash);
    scheduleNextSubtitleJob();
  }
}
// --------------------------------------------------------------------------
function extractAudioToWav(srcAbs, wavPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      srcAbs,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      wavPath,
    ];
    const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    proc.on("error", (err) => {
      reject(new Error(`não foi possível iniciar o FFmpeg: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const tail = stderr.trim().split("\n").pop() || "";
        reject(
          new Error(`ffmpeg saiu com código ${code}${tail ? `: ${tail}` : ""}`),
        );
      }
    });
  });
}

// --------------------------------------------------------------------------
// Transcrição Whisper (whisper.cpp): real, sem invenção de CLI/formato.
// Saída JSON (-oj) com segments {start,end,text}; rawText preserva a
// transcrição crua completa. Defesa em profundidade: sem binário/modelo →
// {ok:false} explícito. Moonshine (runtime onnx) não tem executor aqui —
// fica "em preparação" e nunca é chamado com CLI inventado.
// --------------------------------------------------------------------------
function runWhisperTranscription({
  provider,
  model,
  language,
  wavPath,
  outPrefix,
  vad = false,
  threads = 0,
  onProgress = null,
  setProc = null,
}) {
  return new Promise((resolve) => {
    resolveWhisperBinary(provider)
      .then(async (bin) => {
        if (!bin) {
          return resolve({ ok: false, error: "Binário do Whisper não instalado." });
        }
        const modelFile = await resolveWhisperModelFile(provider, model);
        if (!modelFile) {
          return resolve({ ok: false, error: "Modelo do Whisper não instalado." });
        }

        // Flags opcionais dependem do build do whisper.cpp. `-vad` (silero) é
        // mais recente e pode faltar em builds antigos; se o binário rejeitar
        // qualquer flag extra, fazemos UM retry com o conjunto mínimo (sem
        // VAD/threads/pp) para a transcrição nunca quebrar por flag.
        const buildArgs = (useVad, useThreads, usePp) => {
          const args = [
            "-m", modelFile,
            "-f", wavPath,
            "-l", language || "pt",
            "-oj", "-otxt",
            "-of", outPrefix,
          ];
          if (useVad) args.push("-vad");
          if (useThreads) args.push("-t", String(threads));
          if (usePp) args.push("-pp");
          return args;
        };

        const runOnce = (useVad, useThreads, usePp) =>
          new Promise((runResolve) => {
            const args = buildArgs(useVad, useThreads, usePp);
            const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
            if (setProc) setProc(proc);
            let stderr = "";
            proc.stderr.on("data", (c) => {
              const chunk = c.toString();
              stderr += chunk;
              if (stderr.length > 4000) stderr = stderr.slice(-4000);
              // Progresso real (whisper -pp imprime `progress = N%` em stderr).
              if (onProgress && usePp) {
                const m = /progress\s*=\s*(\d+(?:\.\d+)?)\s*%/.exec(chunk);
                if (m) onProgress(Math.min(100, Math.round(Number(m[1]))));
              }
            });
            proc.on("error", (err) => {
              if (setProc) setProc(null);
              runResolve({
                ok: false,
                error: `não foi possível iniciar o Whisper: ${err.message}`,
              });
            });
            proc.on("close", async (code) => {
              if (setProc) setProc(null);
              if (code !== 0) {
                const tail = stderr.trim().split("\n").pop() || "";
                return runResolve({
                  ok: false,
                  error: `whisper saiu com código ${code}${tail ? `: ${tail}` : ""}`,
                  stderr,
                });
              }
              const read = await readJsonFile(outPrefix + ".json");
              if (!read.ok || !read.parsed) {
                // Propaga o stderr: alguns builds (ex.: whisper-cli 1.9.2)
                // rejeitam uma flag opcional com exit code 0 e sem arquivos de
                // saída (ex.: `-vad` → "error: unknown argument: -vad"). Sem o
                // stderr aqui, o retry-once abaixo não detectaria a flag e a
                // transcrição falharia em vez de recomeçar com o conjunto mínimo.
                const tail = stderr.trim().split("\n").pop() || "";
                return runResolve({
                  ok: false,
                  error: `Whisper não gerou saída JSON.${tail ? ` (${tail})` : ""}`,
                  stderr,
                });
              }
              const doc = read.parsed;

              // Esquema legado (whisper.cpp <= 1.6): { text, segments:[{start,end,text}] },
              // start/end em SEGUNDOS.
              let segs = Array.isArray(doc.segments)
                ? doc.segments
                    .filter(
                      (s) =>
                        s &&
                        Number.isFinite(s.start) &&
                        Number.isFinite(s.end) &&
                        typeof s.text === "string" &&
                        s.text.trim(),
                    )
                    .map((s) => ({
                      start: Math.max(0, Number(s.start)),
                      end: Math.max(0, Number(s.end)),
                      text: String(s.text).trim(),
                    }))
                : [];

              // Esquema whisper.cpp 1.7+ (confirmado no binário 1.9.2):
              // { result, transcription:[{offsets:{from,to}, text}] } — offsets em
              // MILISSEGUNDOS, sem `segments` nem `text` top-level. Converte para
              // segundos para o pipeline consumir igual aos dois schemas.
              if (!segs.length && Array.isArray(doc.transcription)) {
                segs = doc.transcription
                  .filter(
                    (s) =>
                      s &&
                      s.offsets &&
                      Number.isFinite(s.offsets.from) &&
                      Number.isFinite(s.offsets.to) &&
                      typeof s.text === "string" &&
                      s.text.trim(),
                  )
                  .map((s) => ({
                    start: Math.max(0, Number(s.offsets.from) / 1000),
                    end: Math.max(0, Number(s.offsets.to) / 1000),
                    text: String(s.text).trim(),
                  }));
              }

              runResolve({
                ok: true,
                rawText:
                  typeof doc.text === "string"
                    ? doc.text
                    : segs.map((s) => s.text).join(" "),
                segments: segs,
                // Idioma detectado pelo whisper (essencial com `-l auto`):
                // whisper.cpp 1.7+ põe em `result.language`; o esquema legado
                // tinha `language` no topo. Vira a "língua-fonte" real do doc.
                language:
                  (doc.result && typeof doc.result.language === "string"
                    ? doc.result.language
                    : typeof doc.language === "string"
                      ? doc.language
                      : null) || null,
              });
            });
          });

        // Tenta com o conjunto completo; se o build rejeitar flag, cai para o
        // conjunto mínimo. Mantém o erro do PRIMEIRO (mais informativo) se os
        // dois falharem por outro motivo.
        const first = await runOnce(vad, threads > 0, true);
        if (first.ok) return resolve(first);
        if (/unknown argument|unrecognized|invalid option|unknown option|-vad/.test(first.stderr || "")) {
          console.log("[SUBTITLE] whisper rejeitou flags extras; retry com conjunto mínimo");
          const second = await runOnce(false, false, false);
          return resolve(second.ok ? second : first);
        }
        return resolve(first);
      })
      .catch((err) =>
        resolve({ ok: false, error: sanitizeTestError(err.message || "erro") }),
      );
  });
}

// --------------------------------------------------------------------------
// Pós-processamento determinístico (SEMPRE aplicado; transcrição bruta nunca é
// alterada — fica preservada em raw/). Limpeza de texto, capitalização de
// sentença, mescla de blocos curtos (≤2 linhas) e divisão de blocos longos
// respeitando os timestamps do ASR. Não depende de LLM nem de rede.
// --------------------------------------------------------------------------
const SUBTITLE_CUE_MAX_CHARS = 150; // ~2 linhas de legenda
const SUBTITLE_MERGE_GAP_S = 1.0; // mescla se o intervalo for pequeno
const SUBTITLE_MIN_CUE_S = 0.5; // garante end > start

function cleanCueText(text) {
  let t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  t = t.replace(/\s+([,.;:!?])/g, "$1"); // espaço antes de pontuação
  t = t.replace(/([.,;:])([A-Za-zÀ-ÿ0-9])/g, "$1 $2"); // espaço após pontuação
  return t;
}

function capitalizeSentence(text) {
  const parts = text.match(/[^.!?]+[.!?]*/g);
  if (!parts) return text.charAt(0).toUpperCase() + text.slice(1);
  return parts
    .map((p) => {
      const t = p.trim();
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : p;
    })
    .join(" ");
}

async function postprocessSegments(rawSegments, cfg) {
  const opts = cfg.postprocessing || {};
  const capitalize = opts.capitalize !== false;
  const canMerge = opts.segment !== false;

  // Limpeza SEM capitalizar ainda: a capitalização acontece SÓ no final, sobre
  // os blocos já mesclados — evita maiúscula no meio da frase.
  let cues = [];
  for (const s of rawSegments) {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
    const text = cleanCueText(s.text);
    if (!text) continue;
    let start = Math.max(0, Number(s.start));
    let end = Math.max(0, Number(s.end));
    if (end <= start) end = start + SUBTITLE_MIN_CUE_S;
    cues.push({ start, end, text });
  }

  // Mescla blocos curtos consecutivos (gap pequeno e cabendo em ≤2 linhas).
  if (canMerge && cues.length) {
    const merged = [];
    for (const cue of cues) {
      const last = merged[merged.length - 1];
      if (
        last &&
        cue.start - last.end <= SUBTITLE_MERGE_GAP_S &&
        (last.text + " " + cue.text).length <= SUBTITLE_CUE_MAX_CHARS
      ) {
        last.text = last.text + " " + cue.text;
        last.end = cue.end;
      } else {
        merged.push({ ...cue });
      }
    }
    cues = merged;
  }

  // Divide blocos longos mantendo o intervalo do ASR (proporcional ao tempo).
  const split = [];
  for (const cue of cues) {
    const words = cue.text.split(/\s+/);
    if (words.length <= 14 && cue.text.length <= SUBTITLE_CUE_MAX_CHARS) {
      split.push(cue);
      continue;
    }
    const half = Math.max(1, Math.ceil(words.length / 2));
    const part1 = words.slice(0, half).join(" ");
    const part2 = words.slice(half).join(" ");
    const mid = (cue.start + cue.end) / 2;
    split.push({ ...cue, text: part1, end: mid });
    split.push({ ...cue, text: part2, start: mid });
  }

  return split
    .filter((c) => c.text.trim())
    .map((c, i) => {
      let start = Math.max(0, Number(c.start) || 0);
      let end = Math.max(0, Number(c.end) || 0);
      if (end <= start) end = start + SUBTITLE_MIN_CUE_S;
      const text = c.text.trim();
      return {
        id: "s" + (i + 1),
        start,
        end,
        text: capitalize ? capitalizeSentence(text) : text,
      };
    });
}

// --------------------------------------------------------------------------
// WebVTT: máx 2 linhas, sem cortar palavras, sem timestamps negativos,
// end > start garantido, formato HH:MM:SS.mmm.
// --------------------------------------------------------------------------
function formatVttTime(sec) {
  const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const mm = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    s,
  ).padStart(2, "0")}.${String(mm).padStart(3, "0")}`;
}

function splitCueLines(text, maxLines = 2, maxChars = 42) {
  const words = text.trim().split(/\s+/);
  if (words.length === 1) return [words[0]];
  const lines = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (lines.length === maxLines - 1) {
      // última linha: acumula o resto (nunca corta palavra)
      cur = cur ? cur + " " + w : w;
      continue;
    }
    const candidate = cur ? cur + " " + w : w;
    if (cur && candidate.length > maxChars) {
      lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text.trim()];
}

function renderVtt(segments) {
  const lines = ["WEBVTT", ""];
  for (const seg of segments) {
    if (!seg || typeof seg.text !== "string" || !seg.text.trim()) continue;
    const start = Math.max(0, Number(seg.start) || 0);
    let end = Number(seg.end) || start;
    if (end <= start) end = start + SUBTITLE_MIN_CUE_S;
    lines.push(`${formatVttTime(start)} --> ${formatVttTime(end)}`);
    for (const line of splitCueLines(seg.text)) lines.push(line);
    lines.push("");
  }
  return lines.join("\n");
}

// ==========================================================================
// Editor de legendas — camada sobre o pipeline de IA existente.
// --------------------------------------------------------------------------
// Fonte de verdade do editor: `data/subtitles/edited/<hash>.json` (JSON
// estruturado com segments [{id,start,end,text}], id STÁVEL durante a edição e
// `version` para detecção de conflito entre abas). Se não houver edição, o
// editor opera sobre o `processed` (gerado por IA) — o `raw` (transcrição do
// ASR) NUNCA é tocado. O WebVTT é DERIVADO: na gravação da edição ele é
// reescrito no espelho e no `.courseplayer/subtitles/` (artefato final). No
// "Regenerar" (force), a versão editada é preservada em backup/ antes de o
// pipeline refazer a transcrição.
// ==========================================================================

// Resolve o VTT final de um vídeo: canônico na pasta do curso primeiro, depois
// o espelho em data/subtitles/ (vídeos na raiz / resiliência). Mesma regra da
// rota /subtitles/*.
async function resolveSubtitleVttPath(lib, rel, hash) {
  const courseVtt = courseSubtitlePath(lib, rel, hash);
  if (courseVtt) {
    const st = await fs.stat(courseVtt).catch(() => null);
    if (st && st.size > 0) return courseVtt;
  }
  const mirror = path.join(SUBTITLE_DIR, hash + ".vtt");
  const st = await fs.stat(mirror).catch(() => null);
  if (st && st.size > 0) return mirror;
  return null;
}

// Parser WebVTT mínimo (para editar legendas de um curso copiado sem data/,
// onde o VTT canônico é o único artefato). Só o necessário: timestamps
// HH:MM:SS.mmm (ou H:MM:SS.mmm, aceita vírgula), texto sem tags de cue.
function parseVttSegments(vttText) {
  if (typeof vttText !== "string" || !vttText.trim()) return [];
  const lines = vttText.split(/\r?\n/);
  const segments = [];
  let i = 0;
  // Pula o header WEBVTT até a primeira linha de timestamp.
  while (i < lines.length && !/^\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s+-->\s+/.test(lines[i])) i++;
  const toSec = (hh, mm, ss, mmm) => {
    const ms = Number(mmm) * (mmm.length === 1 ? 100 : mmm.length === 2 ? 10 : 1);
    return Number(hh) * 3600 + Number(mm) * 60 + Number(ss) + ms / 1000;
  };
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    const m =
      /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s+-->\s+(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/.exec(
        line,
      );
    if (!m) continue;
    const start = toSec(m[1], m[2], m[3], m[4]);
    const end = toSec(m[5], m[6], m[7], m[8]);
    const textLines = [];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i].replace(/<[^>]*>/g, "").trim());
      i++;
    }
    const text = textLines.join(" ").trim();
    if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
      segments.push({ id: "s" + (segments.length + 1), start, end, text });
    }
  }
  return segments;
}

// Documento editável de um vídeo: edição manual > processed (gerado) > VTT
// (curso copiado). Nunca o raw (transcrição bruta do ASR é imutável).
async function loadEditableDoc(lib, rel, hash, abs, sourceStat) {
  // 1) Edição manual (fonte preferida; preservada mesmo se o vídeo mudou —
  //    o flag staleSource avisa a UI, mas nunca descarta o trabalho).
  const editedPath = path.join(SUBTITLE_EDITED_DIR, hash + ".json");
  const ed = await readJsonFile(editedPath);
  if (ed.ok && ed.parsed && Array.isArray(ed.parsed.segments)) {
    const doc = ed.parsed;
    const src = doc.source || {};
    const staleSource =
      !sourceStat ||
      !(src.mtimeMs === sourceStat.mtimeMs && src.size === sourceStat.size);
    return {
      hash,
      rel,
      source: "edited",
      segments: doc.segments,
      version: Number.isInteger(doc.version) ? doc.version : 0,
      updatedAt: doc.updatedAt || null,
      edited: true,
      staleSource: !!staleSource,
      correctedByLlm: !!doc.correctedByLlm,
      language: doc.language || null,
      provider: doc.provider || null,
      model: doc.model || null,
    };
  }
  // 2) Processed válido (mtime+size batem com o arquivo atual).
  if (sourceStat) {
    const processedPath = path.join(SUBTITLE_PROCESSED_DIR, hash + ".json");
    const proc = await loadValidProcessed(processedPath, abs, sourceStat);
    if (proc && Array.isArray(proc.segments)) {
      return {
        hash,
        rel,
        source: "processed",
        segments: proc.segments,
        version: 0,
        updatedAt: proc.createdAt || null,
        edited: false,
        staleSource: false,
        correctedByLlm: !!proc.correctedByLlm,
        language: proc.language || null,
        provider: proc.provider || null,
        model: proc.model || null,
      };
    }
  }
  // 3) VTT final (ex.: curso copiado sem o data/ local).
  const vttPath = await resolveSubtitleVttPath(lib, rel, hash);
  if (vttPath) {
    const txt = await fs.readFile(vttPath, "utf8").catch(() => null);
    if (txt) {
      const segs = parseVttSegments(txt);
      if (segs && segs.length) {
        return {
          hash,
          rel,
          source: "vtt",
          segments: segs,
          version: 0,
          updatedAt: null,
          edited: false,
          staleSource: false,
          correctedByLlm: null,
          language: null,
          provider: null,
          model: null,
        };
      }
    }
  }
  return null;
}

// Validação estrita dos segmentos vindos do cliente (editor). Garante start<end,
// ids estáveis/únicos, texto não-vazio com limite de tamanho. Retorna o array
// sanitizado (arredondado a 3 casas) ou null se inválido.
function validateEditorSegments(segments) {
  if (!Array.isArray(segments) || segments.length > SUBTITLE_EDIT_MAX_SEGMENTS) {
    return null;
  }
  const out = [];
  const ids = new Set();
  for (const s of segments) {
    if (!s || typeof s !== "object") return null;
    const id = typeof s.id === "string" && s.id.trim() ? s.id.trim() : null;
    if (!id || id.length > 64 || ids.has(id)) return null;
    const start = Number(s.start);
    const end = Number(s.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < 0) return null;
    if (end - start < SUBTITLE_EDIT_MIN_S) return null;
    const text = typeof s.text === "string" ? s.text.replace(/\r\n/g, "\n").trim() : null;
    if (text === null || !text || text.length > SUBTITLE_EDIT_MAX_TEXT) return null;
    ids.add(id);
    out.push({
      id,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text,
    });
  }
  return out.length ? out : null;
}

// Grava a edição manual: JSON estruturado (fonte de verdade) + VTT derivado no
// espelho e na pasta do curso. Concorrência entre abas via `version`: se o
// cliente mandou uma versão que não é a atual, recusa com 409 (nunca sobrescreve
// em silêncio uma edição mais recente).
async function saveEditedSubtitle(lib, rel, hash, abs, segments, expectedVersion, sourceStat) {
  const editedPath = path.join(SUBTITLE_EDITED_DIR, hash + ".json");
  const cur = await readJsonFile(editedPath);
  const curVersion =
    cur.ok && Number.isInteger(cur.parsed.version) ? cur.parsed.version : 0;
  if (expectedVersion != null && expectedVersion !== curVersion) {
    return { conflict: true, serverVersion: curVersion };
  }
  const version = curVersion + 1;
  const now = new Date().toISOString();
  const doc = {
    editorVersion: SUBTITLE_EDITOR_VERSION,
    docVersion: SUBTITLE_VERSION,
    source: { rel, mtimeMs: sourceStat.mtimeMs, size: sourceStat.size },
    segments,
    version,
    updatedAt: now,
    editedAt: now,
    correctedByLlm: false,
  };
  await fs.mkdir(SUBTITLE_EDITED_DIR, { recursive: true });
  await writeFileAtomic(editedPath, JSON.stringify(doc, null, 2));
  const vttText = renderVtt(segments);
  await writeFileAtomic(path.join(SUBTITLE_DIR, hash + ".vtt"), vttText);
  await writeCourseSubtitle(lib, rel, hash, vttText);
  return { conflict: false, version, updatedAt: now };
}

// Preserva a edição manual antes de uma regeneração por IA: copia o JSON
// editado para backup/<hash>.<ts>.json e remove o ativo (a nova transcrição
// volta a ser a versão "gerada"; o backup guarda o trabalho manual).
async function backupEditedSubtitle(hash) {
  const editedPath = path.join(SUBTITLE_EDITED_DIR, hash + ".json");
  const st = await fs.stat(editedPath).catch(() => null);
  if (!st) return false;
  try {
    await fs.mkdir(SUBTITLE_BACKUP_DIR, { recursive: true });
    const backupName = `${hash}.${Date.now()}.json`;
    await fs.copyFile(editedPath, path.join(SUBTITLE_BACKUP_DIR, backupName));
    await fs.rm(editedPath, { force: true });
    console.log(`[SUBTITLE] versão editada preservada em backup/${backupName}`);
    return true;
  } catch (err) {
    console.log(
      `[SUBTITLE] não foi possível preservar a edição manual (${sanitizeTestError(
        err.message,
      )})`,
    );
    return false;
  }
}

// SRT derivado da versão atual (editada ou gerada). Formato HH:MM:SS,mmm.
function formatSrt(segments) {
  const lines = [];
  let n = 0;
  const toSrt = (sec) => {
    const ms = Math.max(0, Math.round((Number(sec) || 0) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
      s,
    ).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  for (const seg of segments) {
    if (!seg || typeof seg.text !== "string" || !seg.text.trim()) continue;
    const start = Math.max(0, Number(seg.start) || 0);
    let end = Number(seg.end) || start;
    if (end <= start) end = start + SUBTITLE_MIN_CUE_S;
    n++;
    lines.push(String(n));
    lines.push(`${toSrt(start)} --> ${toSrt(end)}`);
    lines.push(seg.text);
    lines.push("");
  }
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Correção LLM (opcional) — camada GENÉRICA OpenAI-compatible. O provider é
// resolvido pelo registry (nunca if(provider===X) no fluxo). O LLM recebe
// APENAS [{id,text}] e retorna APENAS [{id,text}]; os timestamps são sempre
// controlados pelo app. Guardrail rejeita saída inválida (ids faltando/
// duplicados/inventados) e mudança indevida de conteúdo → usa a versão
// anterior. Falha/timeout NUNCA bloqueia a legenda. Chave só no backend.
// --------------------------------------------------------------------------
const SUBTITLE_LLM_SYSTEM_PROMPT =
  "Você é um corretor de legendas de vídeos em português. Recebe um JSON array de " +
  "objetos {\"id\", \"text\"} com transcrições de áudio. Para cada item devolva o texto " +
  "CORRIGIDO apenas em pontuação, capitalização e pequenos erros de reconhecimento óbvios.\n" +
  "Regras obrigatórias:\n" +
  "- NÃO mude o significado, o conteúdo, nomes técnicos, números, marcas, siglas, " +
  "linguagens de programação ou termos de negócio.\n" +
  "- NÃO resuma, explique, adicione, remova, reordene nem traduza.\n" +
  "- NÃO altere os \"id\" e devolva exatamente o mesmo conjunto de ids, um por item, na " +
  "mesma ordem.\n" +
  "- NÃO inclua timestamps (você não os recebe e não deve retorná-los).\n" +
  "- Devolva SOMENTE um JSON array: [{\"id\": \"...\", \"text\": \"...\"}, ...] sem " +
  "texto antes ou depois.";

// A conversa com o LLM (OpenAI-compatible) é idêntica para correção e tradução:
// envia só [{id,text}], aplica timeout/abort, nunca loga chave/prompt. Devolve o
// array PARSEADO ou null (falha/timeout/forma inválida) — o guardrail fica com
// quem chama (correção ≠ tradução).
async function llmSegmentsChat({ providerId, model, systemPrompt, segments, timeoutMs }) {
  try {
    const cfg = await loadAiConfig();
    const provider = cfg.llm.providers.find((p) => p.id === providerId);
    if (!provider || !provider.baseUrl || !provider.apiKey) return null;
    const type =
      AI_LLM_PROVIDER_TYPES.find((t) => t.id === provider.type) ||
      AI_LLM_PROVIDER_TYPES[0];
    const url = provider.baseUrl.replace(/\/+$/, "") + type.chatEndpoint;

    const payload = segments.map((s) => ({ id: s.id, text: s.text }));
    const body = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
      temperature: 0,
      max_tokens: Math.min(16000, Math.max(512, payload.length * 40)),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + provider.apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) return null;

    const j = await resp.json();
    const content =
      j &&
      j.choices &&
      j.choices[0] &&
      j.choices[0].message &&
      typeof j.choices[0].message.content === "string"
        ? j.choices[0].message.content
        : null;
    if (!content) return null;

    try {
      return JSON.parse(content);
    } catch {
      // Alguns providers embrulham em {"segments": [...]} — tenta extrair.
      const m = /"segments"\s*:\s*(\[[\s\S]*\])/.exec(content);
      if (!m) return null;
      try {
        return JSON.parse(m[1]);
      } catch {
        return null;
      }
    }
  } catch (err) {
    const why = err && err.name === "AbortError" ? "timeout" : "erro";
    console.log(
      `[SUBTITLE] LLM ignorado (${why}): ${sanitizeTestError(
        (err && err.message) || "",
      )}`,
    );
    return null; // usa o resultado anterior; legenda nunca é bloqueada
  }
}

async function runLlmCorrection({ providerId, model, segments, timeoutMs }) {
  const parsed = await llmSegmentsChat({
    providerId,
    model,
    systemPrompt: SUBTITLE_LLM_SYSTEM_PROMPT,
    segments,
    timeoutMs,
  });
  if (!parsed) return null;
  return applyLlmGuardrail(segments, parsed);
}

function applyLlmGuardrail(original, corrected) {
  const arr = Array.isArray(corrected)
    ? corrected
    : corrected && Array.isArray(corrected.segments)
      ? corrected.segments
      : null;
  if (!arr || !Array.isArray(arr)) return null;

  const expected = new Set(original.map((s) => s.id));
  const byId = new Map(original.map((s) => [s.id, s]));
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    if (!item || typeof item.id === "undefined") return null;
    const id = String(item.id);
    if (!expected.has(id)) return null; // id inventado → rejeita tudo
    if (seen.has(id)) return null; // duplicado → rejeita tudo
    seen.add(id);
    if (typeof item.text !== "string") return null;
    out.push({
      id,
      text: item.text.trim(),
      start: byId.get(id).start,
      end: byId.get(id).end,
    });
  }
  if (seen.size !== expected.size) return null; // faltando → rejeita

  // Ordem controlada pelo app (o LLM pode ter reordenado — não aceitamos).
  out.sort(
    (a, b) => original.findIndex((s) => s.id === a.id) - original.findIndex((s) => s.id === b.id),
  );

  // Proteção contra resumo/reescrita exagerada: tamanho não pode encolher
  // além de 40% nem explodir além de 4x (heurística determinística).
  for (let i = 0; i < out.length; i++) {
    const oLen = original[i].text.replace(/\s+/g, "").length;
    const cLen = out[i].text.replace(/\s+/g, "").length;
    if (oLen > 0 && (cLen < oLen * 0.4 || cLen > oLen * 4)) return null;
  }
  return out;
}

// --------------------------------------------------------------------------
// Tradução de legendas (LLM, sob demanda). A tradução é um artefato DERIVADO
// da legenda processada (língua-fonte) — nunca toca raw/processed/original.
// Reusa o MESMO provider+modelo da correção (`cfg.correction`). O LLM recebe
// APENAS [{id,text}] (timestamps nunca saem do app). Guardrail próprio:
// transição de idioma exige limites de tamanho mais folgados que a correção
// (EN→PT costuma alongar), mas a rejeição de ids faltando/duplicado/inventado
// e o reordenamento continuam idênticos. Falha/timeout ⇒ legenda original.
// --------------------------------------------------------------------------
function subtitleTranslatePrompt(targetLang, keepTerms) {
  const termsRule = keepTerms
    ? "\n" +
      "- PRESERVE SEM TRADUZIR: termos técnicos, nomes de linguagens de programação (SQL, Python, " +
      "Node.js...), código, comandos, marcas, siglas, números, unidades, nomes próprios e títulos " +
      "de produtos/ferramentas."
    : "";
  return (
    "Você é um tradutor profissional de legendas de vídeo para " +
    targetLang +
    ". Recebe um JSON array de objetos {\"id\", \"text\"} com a transcrição em outro idioma. " +
    "Para cada item devolva a TRADUÇÃO FIEL e fluente para " +
    targetLang +
    ".\n" +
    "Regras obrigatórias:\n" +
    "- Traduza o significado exato do texto; não resuma, não explique, não adicione nem omita." +
    termsRule +
    "\n" +
    "- Use gramática, pontuação e ortografia corretas em " +
    targetLang +
    " (variação Brasil).\n" +
    "- NÃO altere os \"id\" e devolva exatamente o mesmo conjunto de ids, um por item, na " +
    "mesma ordem.\n" +
    "- NÃO inclua timestamps (você não os recebe e não deve retorná-los).\n" +
    "- Devolva SOMENTE um JSON array: [{\"id\": \"...\", \"text\": \"...\"}, ...] sem " +
    "texto antes ou depois."
  );
}

async function runLlmTranslation({ providerId, model, segments, targetLanguage, keepTerms = true, timeoutMs }) {
  const parsed = await llmSegmentsChat({
    providerId,
    model,
    systemPrompt: subtitleTranslatePrompt(targetLanguage, keepTerms),
    segments,
    timeoutMs,
  });
  if (!parsed) return null;
  return applyLlmTranslationGuardrail(segments, parsed);
}

function applyLlmTranslationGuardrail(original, translated) {
  const arr = Array.isArray(translated)
    ? translated
    : translated && Array.isArray(translated.segments)
      ? translated.segments
      : null;
  if (!arr || !Array.isArray(arr)) return null;

  const expected = new Set(original.map((s) => s.id));
  const byId = new Map(original.map((s) => [s.id, s]));
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    if (!item || typeof item.id === "undefined") return null;
    const id = String(item.id);
    if (!expected.has(id)) return null; // id inventado → rejeita tudo
    if (seen.has(id)) return null; // duplicado → rejeita tudo
    seen.add(id);
    if (typeof item.text !== "string") return null;
    out.push({
      id,
      text: item.text.trim(),
      start: byId.get(id).start,
      end: byId.get(id).end,
    });
  }
  if (seen.size !== expected.size) return null; // faltando → rejeita

  // Ordem controlada pelo app (o LLM pode ter reordenado — não aceitamos).
  out.sort(
    (a, b) => original.findIndex((s) => s.id === a.id) - original.findIndex((s) => s.id === b.id),
  );

  // Tradução EN→PT tende a alongar; sumarizar é o risco real. Limites mais
  // folgados que a correção: encolher além de 25% ou explodir além de 6x é
  // indício de resumo/reescrita exagerada (heurística determinística).
  for (let i = 0; i < out.length; i++) {
    const oLen = original[i].text.replace(/\s+/g, "").length;
    const cLen = out[i].text.replace(/\s+/g, "").length;
    if (oLen > 0 && (cLen < oLen * 0.25 || cLen > oLen * 6)) return null;
  }
  return out;
}

const app = express();

// Headers de segurança baseline em TODA resposta (JSON/erros/HTML/arquivos):
// nosniff evita MIME-sniffing (material não pode ser renderizado como outro
// tipo); Referrer-Policy evita vazar paths/nomes de cursos no Referer ao abrir
// links externos; X-Frame-Options impede a UI de ser embutida num iframe de
// outro site (clickjacking).
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Frame-Options", "DENY");
  next();
});


app.use(express.json({ limit: "100kb" }));


// GET /api/subtitles/editor?path=<rel> — documento editável (edição manual,
// processed ou VTT). Sem artefato → source:null. Também serve de fonte de dados
// do overlay do player (estruturado, sem duplicar parser de VTT no frontend).
app.get("/api/subtitles/editor", async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  const ext = path.extname(safe.abs).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return res.status(400).json({ error: "not a video" });
  try {
    await loadSubtitleJobs();
    const sourceStat = await fs.stat(safe.abs).catch(() => null);
    const hash = subtitleCacheName(lib.id, safe.rel);
    const lang = /^[a-z]{2,10}$/.test(req.query.lang || "") ? req.query.lang : "";
    // Tradução: serve o doc derivado `hash-lang` (nunca edited/raw).
    if (lang) {
      const processed = sourceStat
        ? await loadValidProcessed(
            path.join(SUBTITLE_PROCESSED_DIR, hash + ".json"),
            safe.abs,
            sourceStat,
          )
        : null;
      if (processed && processed.language === lang) {
        // `lang` == língua-fonte: o usuário quer a ORIGINAL.
        const doc = await loadEditableDoc(lib, safe.rel, hash, safe.abs, sourceStat);
        const ready = !!(sourceStat && (await hasFinalVtt(lib, safe.rel, hash)));
        const cfg = await loadAiConfig();
        const avail = await transcriptionAvailability(cfg);
        return res.json({
          ...doc,
          ready,
          canRegenerate: !!avail.available,
          canGenerate: !!avail.available,
        });
      }
      const tKey = translationCacheName(hash, lang);
      const tRead = await readJsonFile(translationDocPath(hash, lang));
      const tDoc = tRead.ok && tRead.parsed ? tRead.parsed : null;
      const ready = !!(tDoc && Array.isArray(tDoc.segments) && (await hasFinalVtt(lib, safe.rel, tKey)));
      return res.json({
        hash: tKey,
        rel: safe.rel,
        source: ready ? "translated" : null,
        segments: ready && Array.isArray(tDoc.segments) ? tDoc.segments : [],
        version: tDoc && tDoc.version ? tDoc.version : 0,
        edited: false,
        language: tDoc && tDoc.language ? tDoc.language : null,
        targetLanguage: lang,
        ready,
        canRegenerate: false,
        canGenerate: false,
      });
    }
    const doc = await loadEditableDoc(lib, safe.rel, hash, safe.abs, sourceStat);
    if (!doc) {
      return res.json({
        hash,
        rel: safe.rel,
        source: null,
        segments: [],
        version: 0,
        edited: false,
        ready: false,
      });
    }
    const ready = !!(sourceStat && (await hasFinalVtt(lib, safe.rel, hash)));
    const cfg = await loadAiConfig();
    const avail = await transcriptionAvailability(cfg);
    res.json({
      ...doc,
      ready,
      canRegenerate: !!avail.available,
      canGenerate: !!avail.available,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "editor error") });
  }
});

// POST /api/subtitles/save?path=<rel> — grava a edição manual (JSON + VTT
// derivado). Concorrência: version divergente → 409 (alterada em outra aba).
app.post("/api/subtitles/save", async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  const ext = path.extname(safe.abs).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return res.status(400).json({ error: "not a video" });
  const segments = validateEditorSegments(req.body && req.body.segments);
  if (!segments) return res.status(400).json({ error: "invalid segments" });
  const expectedVersion =
    req.body && Number.isInteger(req.body.version) ? req.body.version : null;
  try {
    await loadSubtitleJobs();
    const sourceStat = await fs.stat(safe.abs).catch(() => null);
    if (!sourceStat) return res.status(404).json({ error: "video not found" });
    const hash = subtitleCacheName(lib.id, safe.rel);
    const result = await saveEditedSubtitle(
      lib,
      safe.rel,
      hash,
      safe.abs,
      segments,
      expectedVersion,
      sourceStat,
    );
    if (result.conflict) {
      return res.status(409).json({
        error:
          "Esta legenda foi alterada em outra aba. Recarregue o editor antes de salvar.",
        serverVersion: result.serverVersion,
      });
    }
    console.log(
      `[SUBTITLE] edição salva: ${safe.rel} (${segments.length} segmentos, v${result.version})`,
    );
    res.json({ ok: true, version: result.version, updatedAt: result.updatedAt, hash });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "save error") });
  }
});

// GET /api/subtitles/export?path=<rel>&format=vtt|srt — baixa a versão atual
// (editada se existir, senão a gerada). Nada além do texto; sem caminhos do
// usuário em URL (nome do arquivo é o hash).
app.get("/api/subtitles/export", async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const format = req.query.format === "srt" ? "srt" : "vtt";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  try {
    await loadSubtitleJobs();
    const sourceStat = await fs.stat(safe.abs).catch(() => null);
    const hash = subtitleCacheName(lib.id, safe.rel);
    const doc = await loadEditableDoc(lib, safe.rel, hash, safe.abs, sourceStat);
    if (!doc) return res.status(404).json({ error: "sem legenda" });
    const text = format === "srt" ? formatSrt(doc.segments) : renderVtt(doc.segments);
    res.set(
      "Content-Type",
      format === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8",
    );
    res.set("Content-Disposition", `attachment; filename="${hash}.${format}"`);
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "export error") });
  }
});

// POST /api/subtitles/ai-corrections?path=<rel> — "Corrigir com IA" no editor.
// Reusa o MESMO runLlmCorrection + guardrail do pipeline. O LLM recebe apenas
// {id,text} e retorna {id,text}; timestamps NUNCA são enviados nem alterados.
// As correções voltam como mapas id→text para o editor aplicar na versão de
// trabalho (o usuário revisa e salva; nada é gravado automaticamente).
app.post("/api/subtitles/ai-corrections", async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  const raw = req.body && req.body.segments;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: "segments obrigatórios" });
  }
  const segments = raw
    .map((s) => ({
      id: String(s && s.id),
      text: typeof s.text === "string" ? s.text : "",
    }))
    .filter((s) => s.id && s.text);
  if (!segments.length) return res.status(400).json({ error: "segments vazios" });
  try {
    const cfg = await loadAiConfig();
    if (!cfg.correction.enabled || !cfg.correction.providerId || !cfg.correction.model) {
      return res
        .status(400)
        .json({ error: "correção por IA desabilitada nas configurações" });
    }
    const corrected = await runLlmCorrection({
      providerId: cfg.correction.providerId,
      model: cfg.correction.model,
      segments,
      timeoutMs: cfg.advanced.llmTimeoutMs,
    });
    if (!corrected) return res.json({ ok: false, applied: false });
    res.json({ ok: true, applied: true, corrections: corrected });
  } catch (err) {
    res
      .status(500)
      .json({ error: sanitizeTestError(err.message || "ai-corrections error") });
  }
});



app.get("/api/tree", async (req, res) => {
  const force = req.query.rescan === "1";
  const tree = await getTree(force);
  if (force) scheduleSubtitlePregen(tree); // P2/P3 pós-scan (fire-and-forget)
  res.json(tree);
});

app.post("/api/rescan", async (req, res) => {
  const tree = await getTree(true);
  scheduleSubtitlePregen(tree); // P2/P3 pós-scan (fire-and-forget)
  res.json(tree);
});

// --------------------------------------------------------------------------
// Bibliotecas: CRUD + rescan. Config-only — o filesystem NUNCA é tocado pela
// remoção (REQUISITO OBRIGATÓRIO); jobs ativos bloqueiam com 409.
// --------------------------------------------------------------------------

// Jobs ativos que bloqueiam a remoção de uma biblioteca: transcode `processing`
// (ffmpeg rodando), legenda em fase pesada do pipeline (extracting/transcribing/
// processing/correcting/formatting) e scan em andamento. Jobs APENAS enfileirados
// NÃO bloqueiam — são descartados na remoção (nunca deixam job apontando para
// biblioteca inexistente).
function libraryHasActiveJobs(id) {
  for (const job of transcodeJobs.values()) {
    if (job.libraryId === id && job.status === "processing") return true;
  }
  const activeSub = new Set([
    "extracting", "transcribing", "processing", "correcting", "formatting",
  ]);
  for (const job of subtitleJobs.values()) {
    if (job.libraryId === id && activeSub.has(job.status)) return true;
  }
  if (scanningLibraryIds.has(id)) return true;
  return false;
}

// Descarta jobs ENFILEIRADOS de uma biblioteca após a remoção (a política
// permite remover biblioteca com fila parada; jobs ativos foram bloqueados).
function discardQueuedJobsForLibrary(id) {
  for (const [cacheName, job] of transcodeJobs) {
    if (job.libraryId === id && job.status === "queued") {
      const idx = transcodeQueue.indexOf(job);
      if (idx >= 0) transcodeQueue.splice(idx, 1);
      transcodeJobs.delete(cacheName);
      console.log(`[TRANSCODE] descartado (biblioteca removida): ${job.rel}`);
    }
  }
  let discarded = 0;
  for (const [hash, job] of subtitleJobs) {
    if (job.libraryId === id && job.status === "queued") {
      cancelSubtitleJob(hash);
      discarded += 1;
    }
  }
  if (discarded) persistSubtitleJobs().catch(() => {});
}

app.get("/api/libraries", async (req, res) => {
  await loadLibraries();
  res.json({ libraries: getLibraries().map((l) => librarySummary(l)) });
});

// Cria uma biblioteca: `{ name?, path }`. Path validado/canonicalizado UMA vez
// (nunca reutilizado em operações de mídia — ver auditoria §11). Id estável =
// randomUUID, imune a rename de nome/path.
app.post("/api/libraries", async (req, res) => {
  await loadLibraries();
  const proposed = req.body && typeof req.body.path === "string" ? req.body.path : "";
  const v = await validateLibraryPath(proposed);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const name =
    req.body && typeof req.body.name === "string" && req.body.name.trim()
      ? req.body.name.trim()
      : path.basename(v.path) || v.path;
  const entry = {
    id: crypto.randomUUID(),
    name,
    path: v.path,
    enabled: true,
    isDefault: false,
    createdAt: Date.now(),
  };
  librariesCache = getLibraries().concat(entry);
  await persistLibraries();
  console.log(`[LIBRARIES] criada: ${name} (${entry.id}) → ${v.path}`);
  res.status(201).json(librarySummary(entry));
});

// Atualiza `{ name?, enabled?, path? }`. Path da PADRÃO é imutável (403); para
// as demais, path é revalidado como no POST (400/409). Renomear nunca muda o id.
app.patch("/api/libraries/:id", async (req, res) => {
  await loadLibraries();
  const lib = getLibraryById(req.params.id);
  if (!lib) return res.status(404).json({ error: "library not found" });
  let newPath = null;
  if (req.body && typeof req.body.path === "string") {
    const v = await validateLibraryPath(req.body.path);
    if (!v.ok) return res.status(400).json({ error: v.error });
    newPath = v.path;
  }
  if (req.body && typeof req.body.name === "string") {
    lib.name = req.body.name.trim() || lib.name;
  }
  if (req.body && typeof req.body.enabled === "boolean") {
    lib.enabled = req.body.enabled;
  }
  if (newPath) {
    treeCaches.delete(lib.id);
    lib.path = newPath;
  }
  await persistLibraries();
  res.json(librarySummary(lib));
});

// Remove da CONFIGURAÇÃO. Nunca aceita `?path=` nem body com absolute path (a
// decisão é por id). Id inexistente → 404; jobs ativos → 409.
// NENHUM arquivo da biblioteca é tocado; progresso e caches permanecem intactos.
app.delete("/api/libraries/:id", async (req, res) => {
  if (
    (req.query && req.query.path !== undefined) ||
    (req.body && typeof req.body.path === "string")
  ) {
    return res.status(400).json({ error: "remoção é por id; não aceita path" });
  }
  await loadLibraries();
  const lib = getLibraryById(req.params.id);
  if (!lib) return res.status(404).json({ error: "library not found" });
  if (libraryHasActiveJobs(lib.id)) {
    return res.status(409).json({ error: "há jobs ativos para esta biblioteca" });
  }
  discardQueuedJobsForLibrary(lib.id);
  treeCaches.delete(lib.id);
  scanningLibraryIds.delete(lib.id);
  librariesCache = getLibraries().filter((l) => l.id !== lib.id);
  await persistLibraries();
  console.log(`[LIBRARIES] removida da configuração: ${lib.name} (${lib.id})`);
  res.json({ ok: true });
});

// Força o scan de UMA biblioteca. Scan já em andamento → 409 (dedup). Diretório
// sumiu → 200 com `status:"unavailable"` (não é erro de rota — pendrive removível).
app.post("/api/libraries/:id/rescan", async (req, res) => {
  await loadLibraries();
  const lib = getLibraryById(req.params.id);
  if (!lib) return res.status(404).json({ error: "library not found" });
  if (scanningLibraryIds.has(lib.id)) {
    return res.status(409).json({ error: "scan já em andamento para esta biblioteca" });
  }
  res.json(await rescanLibrary(lib));
});

app.get("/api/progress", async (req, res) => {
  res.json(await readProgress());
});

app.post("/api/progress", async (req, res) => {
  const { path: relPath, position, duration, completed } = req.body || {};
  const requestId =
    req.body && typeof req.body.requestId === "string" ? req.body.requestId : undefined;
  // Toggle manual de conclusão (✓ na sidebar): a única operação normal que
  // pode regredir `completed` de true para false (ação explícita do usuário).
  const explicitToggle = !!(req.body && req.body.explicitToggle);
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, relPath);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  // Validação estrita de finitos: NaN/Infinity não podem ser persistidos
  // (uma entrada corrompida nunca deve substituir um estado válido).
  if (
    typeof position !== "number" ||
    !Number.isFinite(position) ||
    typeof duration !== "number" ||
    !Number.isFinite(duration)
  ) {
    return res.status(400).json({ error: "invalid position/duration" });
  }
  const key = `${lib.id}\0${safe.rel}`;
  try {
    await updateProgress(
      (progress) => {
        progress[key] = {
          position: Math.max(0, position),
          duration: Math.max(0, duration),
          completed: !!completed,
          updatedAt: Date.now(),
        };
      },
      { requestId, allowCompletedRegression: explicitToggle },
    );
    console.log(`[PROGRESS] save: ${safe.rel}${requestId ? ` requestId=${requestId}` : ""}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "failed to save progress" });
  }
});

app.post("/api/progress/clear", async (req, res) => {
  const { coursePath } = req.body || {};
  const requestId =
    req.body && typeof req.body.requestId === "string" ? req.body.requestId : undefined;
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safeCourse =
    coursePath != null ? resolveLibraryRel(lib, coursePath) : null;
  if (coursePath != null && !safeCourse)
    return res.status(400).json({ error: "invalid course path" });

  const beforeKeys = Object.keys(await readProgress());
  try {
    // allowShrink: esta é a ÚNICA operação autorizada a remover chaves de
    // progresso. Todo o resto (startup, rescan, reload, scan, migração…)
    // nunca pode reduzir o estado persistido.
    await updateProgress(
      (progress) => {
        if (safeCourse) {
          // Chave = `<libId>\0<rel>`; limpa por prefixo de biblioteca + curso.
          const prefix = `${lib.id}\0${safeCourse.rel}`;
          for (const key of Object.keys(progress)) {
            if (key === prefix || key.startsWith(prefix + "/")) {
              delete progress[key];
            }
          }
        } else {
          for (const key of Object.keys(progress)) {
            delete progress[key];
          }
        }
      },
      { allowShrink: true, requestId },
    );
    const afterKeys = Object.keys(await readProgress());
    const removedKeys = beforeKeys.filter((k) => !afterKeys.includes(k));
    console.log(
      `[PROGRESS-CLEAR] ${new Date().toISOString()} escopo=${safeCourse ? safeCourse.rel : "global"} biblioteca=${lib.id} antes=${beforeKeys.length} depois=${afterKeys.length} removidas=${removedKeys.length}${requestId ? ` requestId=${requestId}` : ""}`,
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "failed to clear progress" });
  }
});

// Fallback de compatibilidade: devolve o plano de reprodução (cache pronto,
// transcode em andamento, ou o próprio original quando compatível). NUNCA
// bloqueia esperando o transcode terminar — devolve a URL na hora e o /transcoded
// serve o arquivo em crescimento.
app.get("/api/video/fallback", async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  // BUG-001: não tocar o ffprobe/ffmpeg em arquivos da pasta do app
  // (server.js, data/ai-config.json) mesmo estando dentro de ROOT.
  if (isAppDirRel(safe, lib)) return res.status(404).json({ error: "invalid path" });
  try {
    const plan = await getTranscodePlan(lib, safe.rel, safe.abs);
    res.json(plan);
  } catch (err) {
    console.error("[TRANSCODE] erro ao preparar fallback:", err.message);
    res.status(500).json({ error: "failed to prepare video" });
  }
});

// Limpa o cache de transcoding (spec 29). NUNCA toca progress.json.
app.post("/api/transcode/clear", async (req, res) => {
  try {
    const procs = [...transcodeJobs.values()]
      .filter((j) => j.proc)
      .map((j) => j.proc);
    transcodeJobs.clear();
    transcodeQueue.length = 0;
    for (const p of procs) {
      try {
        p.kill("SIGTERM");
      } catch {}
    }
    setTimeout(() => {
      for (const p of procs) {
        try {
          p.kill("SIGKILL");
        } catch {}
      }
    }, 2000);
    const files = await fs.readdir(TRANSCODE_DIR).catch(() => []);
    await Promise.all(
      files.map((f) => fs.rm(path.join(TRANSCODE_DIR, f), { force: true }).catch(() => {})),
    );
    console.log("[TRANSCODE] cache limpo");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "failed to clear transcode cache" });
  }
});

// --------------------------------------------------------------------------
// Status de armazenamento (Fase 6): números REAIS de espaço para a aba
// "Dados e armazenamento" das Configurações. Nunca aceita path de cliente.
// --------------------------------------------------------------------------
async function dirSize(dir) {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fs.stat(p).catch(() => null))?.size || 0;
  }
  return total;
}

// --- Estado do sistema (biblioteca/dispositivo) -----------------------------
// Sonda a disponibilidade real da biblioteca (ROOT), do diretório do app
// (__dirname) e do arquivo que a SPA precisa (public/index.html). Cada sonda
// falha rápido em códigos ENOENT/device e degrada para "timeout" se o
// filesystem travar (mount travado) em vez de responder — um GET / não pode
// ficar pendurado. Usado por GET /api/system/status e pelo intercept de GET /
// (página de indisponibilidade em vez de "Cannot GET /").
async function getSystemStatus() {
  const now = Date.now();
  const probe = (p) => {
    const check = fs.access(p).then(
      () => ({ state: "ok", code: null }),
      (err) => {
        const c = err && err.code;
        return {
          state: !c ? "unexpected" : c === "ENOENT" ? "missing" : isDeviceUnavailableCode(c) ? "device" : "unexpected",
          code: c || null,
        };
      },
    );
    return Promise.race([
      check,
      new Promise((r) => {
        const t = setTimeout(() => r({ state: "timeout", code: null }), 750);
        if (t && t.unref) t.unref();
      }),
    ]);
  };

  const [lib, self, spa] = await Promise.all([
    probe(ROOT),
    probe(__dirname),
    probe(SPA_INDEX_PATH),
  ]);
  const states = [lib.state, self.state, spa.state];
  const codes = [lib.code, self.code, spa.code].filter(Boolean);

  // Derivação do motivo visível a partir das sondas (em ordem de prioridade).
  let reason = null;
  if (!states.every((s) => s === "ok")) {
    if (states.includes("unexpected")) reason = "unexpected"; // EACCES/EPERM — não mascarar
    else if (states.includes("timeout")) reason = "device-unavailable"; // fs travado ≈ dispositivo inacessível
    else if (states.includes("device")) reason = "device-unavailable";
    else if (lib.state === "missing" || self.state === "missing") reason = "library-missing"; // drive inteiro fora / biblioteca fora
    else if (spa.state === "missing") reason = "spa-missing";
    else reason = "unexpected";
  }

  return {
    server: "online",
    library: lib.state === "ok" ? "available" : "unavailable",
    spa: spa.state === "ok" ? "available" : "unavailable",
    ready: states.every((s) => s === "ok"),
    reason,
    code: codes[0] || null,
    lastCheck: now,
  };
}

app.get("/api/storage/status", async (req, res) => {
  try {
    const cfg = await loadAiConfig();
    const wsDir = await resolveWorkspaceDir(cfg).catch(() => null);
    const statfsFree = async (dir) => {
      try {
        const s = await fs.statfs(dir);
        return Number(s.bavail) * Number(s.bsize);
      } catch {
        return null;
      }
    };
    res.json({
      dataBytes: await dirSize(DATA_DIR),
      transcodeBytes: await dirSize(TRANSCODE_DIR),
      subtitlesBytes: await dirSize(SUBTITLE_DIR),
      appFreeBytes: await statfsFree(DATA_DIR),
      workspace: {
        mode: cfg.workspace.mode,
        dir: cfg.workspace.dir,
        dirResolved: wsDir,
        freeBytes: wsDir ? await getWorkspaceFreeBytes(wsDir) : null,
      },
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "storage error") });
  }
});

// Estado do sistema: biblioteca/dispositivo/aplicação. Sem paths absolutos,
// sem segredos — apenas o que o servidor consegue verificar agora. no-store:
// o cliente (página de indisponibilidade) precisa de uma leitura fresca para
// decidir se recarrega quando o dispositivo volta.
app.get("/api/system/status", async (req, res) => {
  const st = await getSystemStatus().catch(() => null);
  if (!st) {
    return res.status(503).json({ server: "online", ready: false, reason: "unexpected" });
  }
  res.set("Cache-Control", "no-store").json(st);
});

// Logs técnicos em memória (anel). Filtros opcionais:
//   ?level=INFO|WARN|ERROR|DEVICE|PROCESS  (DEVICE/PROCESS filtram por sub-tag no texto)
//   ?q=<texto>  (busca livre, case-insensitive)
// Retorna sempre as entradas mais recentes (janela do anel).
app.get("/api/logs", (req, res) => {
  const level = (typeof req.query.level === "string" ? req.query.level : "").toUpperCase();
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  let entries = logBuffer;
  if (level && level !== "ALL") {
    if (level === "DEVICE") entries = entries.filter((e) => e.msg.includes("[DEVICE]"));
    else if (level === "PROCESS") entries = entries.filter((e) => e.msg.includes("[PROCESS]"));
    else entries = entries.filter((e) => e.level === level);
  }
  if (q) entries = entries.filter((e) => e.msg.toLowerCase().includes(q));
  res.json({ entries: entries.slice(-400), max: MAX_LOG_ENTRIES });
});

// --- Inteligência Artificial: rotas de estado/configuração -----------------
// Nenhuma rota aceita caminho de arquivo do cliente (anti path-traversal).
// apiKey: grava via POST, devolve apenas hasApiKey; nunca em logs.

app.get("/api/ai/status", async (req, res) => {
  try {
    res.json(await getAiStatus());
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "status error") });
  }
});

app.get("/api/ai/config", async (req, res) => {
  try {
    res.json(maskAiConfig(await loadAiConfig()));
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "config error") });
  }
});

app.post("/api/ai/config", async (req, res) => {
  try {
    const config = await saveAiConfig((cfg) => applyAiPatch(cfg, req.body));
    // Valida o workspace custom antes de aceitar: deve ser criável/escrevível
    // (preferencialmente num disco local — mas sem presumir caminhos).
    if (config.workspace.mode === "custom") {
      try {
        await ensureWorkspaceWritable(config.workspace.dir);
      } catch (err) {
        config.workspace.mode = "auto";
        config.workspace.dir = "";
        await saveAiConfig(() => config);
        return res.status(400).json({
          error: "Diretório de trabalho inválido: " + sanitizeTestError(err.message || "não criável"),
        });
      }
    }
    res.json(maskAiConfig(config));
  } catch (err) {
    res.status(400).json({ error: sanitizeTestError(err.message || "config error") });
  }
});

app.post("/api/ai/reset", async (req, res) => {
  try {
    await fs.rm(AI_CONFIG_FILE, { force: true });
    res.json(maskAiConfig(await loadAiConfig()));
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "reset error") });
  }
});

app.post("/api/ai/llm/test", async (req, res) => {
  try {
    const body = objOr(req.body, {});
    let provider = null;
    let apiKey = "";
    if (body.providerId) {
      const cfg = await loadAiConfig();
      provider = cfg.llm.providers.find((p) => p.id === clampStr(body.providerId, 80)) || null;
      if (!provider) return res.status(400).json({ ok: false, error: "Provedor não encontrado." });
      apiKey = provider.apiKey;
    } else {
      provider = {
        baseUrl: clampStr(body.baseUrl, AI_STR_LIMITS.baseUrl),
        defaultModel: clampStr(body.model, AI_STR_LIMITS.model),
      };
      apiKey = clampStr(body.apiKey, AI_STR_LIMITS.apiKey);
    }
    const baseUrl = (provider.baseUrl || "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(baseUrl)) {
      return res.status(400).json({ ok: false, error: "URL inválida (use http:// ou https://)." });
    }
    const model = provider.defaultModel;
    if (!model) return res.status(400).json({ ok: false, error: "Informe um modelo para o teste." });
    const timeoutMs = (await loadAiConfig()).advanced.llmTimeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const endpoint = baseUrl.endsWith("/chat/completions")
        ? baseUrl
        : `${baseUrl}/chat/completions`;
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Responda apenas: OK" }],
          max_tokens: 5,
          temperature: 0,
        }),
        signal: ctrl.signal,
      });
      const latencyMs = Date.now() - started;
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const j = await resp.json();
          if (j && typeof j.error === "string") detail = sanitizeTestError(j.error);
          else if (j && j.error && typeof j.error.message === "string") detail = sanitizeTestError(j.error.message);
        } catch {}
        return res.json({ ok: false, error: detail, status: resp.status, latencyMs });
      }
      console.log(`[AI] teste de conexão OK: ${model} (${latencyMs}ms)`);
      return res.json({ ok: true, model, latencyMs });
    } catch (err) {
      const latencyMs = Date.now() - started;
      const reason = err && err.name === "AbortError"
        ? `Tempo limite excedido (${Math.round(timeoutMs / 1000)}s).`
        : (err && err.cause && err.cause.code
          ? `Falha de rede (${err.cause.code}).`
          : sanitizeTestError(err.message || "erro"));
      return res.json({ ok: false, error: reason, latencyMs });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    res.status(400).json({ ok: false, error: sanitizeTestError(err.message || "test error") });
  }
});

// --- Legendas por IA: rotas -------------------------------------------------
// Todos os caminhos vindos do navegador passam por resolveSafeRelPath (anti
// path-traversal). Cache só via /subtitles/<hash>.vtt (hash hex estrito), nunca
// nome de arquivo do usuário. Geração é não-bloqueante para o player.

// Estado combinado (legenda pronta? job ativo? pode gerar?) para o player e a
// Central de IA. `lang` opcional: quando presente e ≠ língua-fonte, o estado
// reporta a TRADUÇÃO para aquele idioma (job de tradução, pronto, encadeamento
// com a transcrição). Sem `lang` (ou == fonte) o estado é o da legenda original.
async function subtitleStatusFor(lib, rel, abs, lang) {
  const hash = subtitleCacheName(lib.id, rel);
  const cfg = await loadAiConfig();
  const sourceStat = await fs.stat(abs).catch(() => null);
  let sourceReady = false;
  let sourceLanguage = cfg.transcription.language;
  if (sourceStat) {
    const processedPath = path.join(SUBTITLE_PROCESSED_DIR, hash + ".json");
    const doc = await loadValidProcessed(processedPath, abs, sourceStat);
    if (doc) {
      sourceReady = true;
      if (doc.language) sourceLanguage = doc.language;
    }
  }
  const avail = await transcriptionAvailability(cfg);
  const canTranslate =
    cfg.translation.enabled === true &&
    cfg.correction.enabled === true &&
    !!cfg.correction.providerId &&
    !!cfg.correction.model;

  // `lang` pede tradução? Só quando difere da língua-fonte real.
  const wantTranslation =
    typeof lang === "string" && lang.length > 0 && lang !== sourceLanguage;
  const transKey = wantTranslation ? translationCacheName(hash, lang) : null;
  const transJob = transKey ? subtitleJobs.get(transKey) : null;

  const activeStatus = new Set([
    "queued", "extracting", "transcribing", "processing", "correcting", "formatting",
    "translating", SUBTITLE_STATUS_WAITING_SOURCE,
  ]);

  let ready = false;
  let translationReady = false;
  if (sourceStat) {
    if (!wantTranslation) {
      const processedPath = path.join(SUBTITLE_PROCESSED_DIR, hash + ".json");
      const doc = await loadValidProcessed(processedPath, abs, sourceStat);
      if (doc && (await hasFinalVtt(lib, rel, hash))) ready = true;
    } else if (transKey) {
      const tDoc = await readJsonFile(translationDocPath(hash, lang));
      if (
        tDoc.ok &&
        tDoc.parsed &&
        tDoc.parsed.version === SUBTITLE_VERSION &&
        Array.isArray(tDoc.parsed.segments) &&
        (await hasFinalVtt(lib, rel, transKey))
      ) {
        ready = true;
        translationReady = true;
      }
    }
  }
  const sourceStatus = subtitleJobs.get(hash);
  const job = wantTranslation ? transJob : sourceStatus;
  // Existe versão editada manualmente? Só faz sentido para a legenda original.
  const editedDoc = await readJsonFile(path.join(SUBTITLE_EDITED_DIR, hash + ".json"));
  const edited = !!(editedDoc.ok && editedDoc.parsed && Array.isArray(editedDoc.parsed.segments));
  return {
    hash,
    ready,
    edited: wantTranslation ? false : edited,
    status:
      job && activeStatus.has(job.status)
        ? job.status
        : job && (job.status === "failed" || job.status === "cancelled")
          ? job.status
          : null,
    progress: job && activeStatus.has(job.status) ? job.progress : null,
    percent: job && activeStatus.has(job.status) ? job.percent ?? null : null,
    error:
      job && (job.status === "failed" || job.status === SUBTITLE_STATUS_WAITING_SOURCE)
        ? job.error
        : null,
    canGenerate: wantTranslation ? (canTranslate && sourceReady) : !!avail.available,
    // Disponibilidade do Whisper (gerar a legenda ORIGINAL) — o frontend usa
    // para encadear a transcrição quando uma tradução foi pedida sem original.
    canGenerateSource: !!avail.available,
    generateMode: cfg.transcription.generateMode,
    language: sourceLanguage,
    sourceReady,
    needTranscription: wantTranslation && !sourceReady,
    canTranslate,
    translation: {
      enabled: cfg.translation.enabled === true,
      targetLanguage: cfg.translation.targetLanguage,
      keepTerms: cfg.translation.keepTerms === true,
      ready: translationReady,
    },
    pregenNextLesson: cfg.transcription.pregenNextLesson === true,
    pregenFirstLesson: cfg.transcription.pregenFirstLesson === true,
    background: cfg.transcription.background === true,
  };
}

app.post("/api/subtitles/generate", async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  // BUG-001: não rodar extração sobre arquivos da pasta do app.
  if (isAppDirRel(safe, lib)) return res.status(400).json({ error: "invalid path" });
  // Symlink apontando para fora da biblioteca: recusa na porta de entrada.
  if (!(await fileWithinLibrary(lib, safe.abs))) {
    return res.status(400).json({ error: "invalid path" });
  }
  const ext = path.extname(safe.abs).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return res.status(400).json({ error: "not a video" });
  const priority = Number.isInteger(Number(req.query.priority))
    ? Math.min(3, Math.max(0, Number(req.query.priority)))
    : null;
  const force = req.query.force === "1" || req.query.force === "true";
  const skipIfReady = req.query.skipIfReady === "1" || req.query.skipIfReady === "true";
  // `lang` presente e ≠ fonte = geração de TRADUÇÃO (job derivado `hash-lang`).
  const lang = /^[a-z]{2,10}$/.test(req.query.lang || "") ? req.query.lang : "";
  try {
    await loadSubtitleJobs(); // reconcilia antes do dedup
    if (skipIfReady && !force && !lang) {
      // Skip-if-ready (usado por P1/P2/P3): legenda já válida ⇒ não enfileira.
      if (await hasValidSubtitle(lib, safe.rel, safe.abs)) {
        return res.json({ ok: true, skipped: true, alreadyRunning: false, status: "completed" });
      }
    }
    if (lang) {
      const hash = subtitleCacheName(lib.id, safe.rel);
      const sourceStat = await fs.stat(safe.abs).catch(() => null);
      const processed = sourceStat
        ? await loadValidProcessed(
            path.join(SUBTITLE_PROCESSED_DIR, hash + ".json"),
            safe.abs,
            sourceStat,
          )
        : null;
      if (!processed || !Array.isArray(processed.segments) || !processed.segments.length) {
        // Sem legenda original válida: a tradução não tem o que traduzir. O
        // frontend encadeia — enfileira a transcrição (P0) e re-solicita a
        // tradução quando a original estiver pronta.
        if (skipIfReady && !force) {
          const { job, alreadyRunning, promoted } = startSubtitleJob(lib, safe.rel, safe.abs, {
            priority: priority ?? PRIORITY_DEMAND,
            force,
          });
          return res.json({
            ok: true,
            needTranscription: true,
            hash: job.hash,
            status: job.status,
            alreadyRunning,
            promoted,
          });
        }
        return res.json({ ok: false, needTranscription: true, error: "Legenda original indisponível — gere a transcrição primeiro." });
      }
      const transKey = translationCacheName(hash, lang);
      if (!force && (await hasFinalVtt(lib, safe.rel, transKey))) {
        return res.json({ ok: true, skipped: true, alreadyRunning: false, status: "completed" });
      }
      const { job, alreadyRunning, promoted } = startSubtitleJob(lib, safe.rel, safe.abs, {
        priority: priority ?? PRIORITY_DEMAND,
        force,
        lang,
      });
      return res.json({
        ok: true,
        hash: job.hash,
        status: job.status,
        alreadyRunning,
        promoted,
        translation: true,
      });
    }
    const { job, alreadyRunning, promoted } = startSubtitleJob(lib, safe.rel, safe.abs, {
      priority: priority ?? PRIORITY_DEMAND,
      force,
    });
    res.json({
      ok: true,
      hash: job.hash,
      status: job.status,
      alreadyRunning,
      promoted,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "generate error") });
  }
});

// Gera legendas de um curso inteiro em P3 (background, mesma fila, dedup por
// hash). Só vídeos sem legenda válida são enfileirados. `path` = rel do curso.
app.post("/api/subtitles/generate-course", async (req, res) => {
  const courseRel = typeof req.query.path === "string" ? req.query.path : "";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, courseRel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  try {
    await loadSubtitleJobs();
    const tree = await getTree(false);
    const libEntry = (tree.libraries || []).find((l) => l.id === lib.id);
    const course = (libEntry && libEntry.tree
      ? libEntry.tree.children || []
      : []
    ).find((c) => c.type === "folder" && c.path === safe.rel);
    if (!course) return res.status(404).json({ error: "course not found" });
    const videos = [];
    const walk = (node) => {
      for (const c of node.children || []) {
        if (c.type === "folder") walk(c);
        else if (c.type === "video") videos.push(c);
      }
    };
    walk(course);
    let enqueued = 0;
    let skipped = 0;
    for (const v of videos) {
      const vsafe = resolveLibraryRel(lib, v.path);
      if (!vsafe) continue;
      if (await hasValidSubtitle(lib, vsafe.rel, vsafe.abs)) {
        skipped += 1;
        continue;
      }
      startSubtitleJob(lib, vsafe.rel, vsafe.abs, { priority: PRIORITY_BG });
      enqueued += 1;
    }
    console.log(`[SUBTITLE] generate-course: ${enqueued} enfileirados, ${skipped} já prontos (${safe.rel})`);
    res.json({ ok: true, enqueued, skipped, total: videos.length });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "generate-course error") });
  }
});

app.get("/api/subtitles/status", async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  try {
    await loadSubtitleJobs();
    const lang = /^[a-z]{2,10}$/.test(req.query.lang || "") ? req.query.lang : "";
    res.json(await subtitleStatusFor(lib, safe.rel, safe.abs, lang));
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "status error") });
  }
});

app.get("/api/subtitles/list", async (req, res) => {
  try {
    await loadSubtitleJobs();
    const processed = [];
    const files = await fs.readdir(SUBTITLE_PROCESSED_DIR).catch(() => []);
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      const read = await readJsonFile(path.join(SUBTITLE_PROCESSED_DIR, f));
      if (!read.ok || !read.parsed) continue;
      const doc = read.parsed;
      const hash = f.replace(/\.json$/, "");
      const vttStat = await fs
        .stat(path.join(SUBTITLE_DIR, hash + ".vtt"))
        .catch(() => null);
      processed.push({
        hash,
        rel: (doc.source && doc.source.rel) || "",
        language: doc.language,
        provider: doc.provider,
        model: doc.model,
        segments: (doc.segments || []).length,
        correctedByLlm: !!doc.correctedByLlm,
        hasVtt: !!(vttStat && vttStat.size > 0),
        createdAt: doc.createdAt || null,
      });
    }
    const jobs = await Promise.all(
      [...subtitleJobs.values()].map((j) => subtitleJobPublic(j.hash)),
    );
    const running = jobs.filter((j) =>
      ["extracting", "transcribing", "processing", "correcting", "formatting", "translating"].includes(j.status),
    );
    res.json({
      summary: {
        processed: processed.length,
        queued: jobs.filter((j) => j.status === "queued").length,
        running: running.length,
        failed: jobs.filter((j) => j.status === "failed").length,
      },
      jobs,
      processed,
    });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "list error") });
  }
});

app.post("/api/subtitles/cancel", async (req, res) => {
  const rel = typeof req.query.path === "string" ? req.query.path : "";
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return res.status(400).json({ error: "invalid path" });
  try {
    await loadSubtitleJobs();
    const cancelled = cancelSubtitleJob(subtitleCacheName(lib.id, safe.rel));
    res.json({ ok: true, cancelled });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "cancel error") });
  }
});

// Exclui a legenda de um vídeo (path) ou todo o cache de legendas (sem path).
app.post("/api/subtitles/clear", async (req, res) => {
  const { path: relPath } = req.body || {};
  const lib = requestLibrary(req);
  if (!lib) return res.status(400).json({ error: "unknown library" });
  let rel = null;
  if (relPath != null) {
    const safe = resolveLibraryRel(lib, relPath);
    if (!safe) return res.status(400).json({ error: "invalid path" });
    rel = safe.rel;
  }
  try {
    await loadSubtitleJobs();
    if (rel) {
      const hash = subtitleCacheName(lib.id, rel);
      cancelSubtitleJob(hash);
      // Traduções derivadas do mesmo vídeo: cancela jobs (`hash-lang`), apaga
      // docs (`translations/<hash>-*.json`), espelhos e canônicos `hash-lang.vtt`.
      const prefix = hash + "-";
      const transDocs = await fs.readdir(SUBTITLE_TRANSLATION_DIR).catch(() => []);
      await Promise.all([
        ...[...subtitleJobs.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => cancelSubtitleJob(k)),
        ...transDocs
          .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
          .map((f) => fs.rm(path.join(SUBTITLE_TRANSLATION_DIR, f), { force: true })),
        ...transDocs
          .filter((f) => f.startsWith(prefix) && f.endsWith(".vtt"))
          .map((f) => fs.rm(path.join(SUBTITLE_DIR, f), { force: true })),
        ...transDocs
          .filter((f) => f.startsWith(prefix) && f.endsWith(".vtt"))
          .map((f) => removeCourseSubtitle(lib, rel, f.replace(/\.vtt$/, ""))),
        fs.rm(path.join(SUBTITLE_RAW_DIR, hash + ".json"), { force: true }),
        fs.rm(path.join(SUBTITLE_PROCESSED_DIR, hash + ".json"), { force: true }),
        fs.rm(path.join(SUBTITLE_DIR, hash + ".vtt"), { force: true }),
        fs.rm(path.join(SUBTITLE_EDITED_DIR, hash + ".json"), { force: true }),
        removeCourseSubtitle(lib, rel, hash),
      ]);
      subtitleJobs.delete(hash);
      for (const k of [...subtitleJobs.keys()]) {
        if (k.startsWith(prefix)) subtitleJobs.delete(k);
      }
      console.log(`[SUBTITLE] legenda excluída: ${rel} (${lib.id})`);
    } else {
      for (const hash of [...subtitleJobs.keys()]) cancelSubtitleJob(hash);
      await Promise.all([
        fs.rm(SUBTITLE_RAW_DIR, { recursive: true, force: true }),
        fs.rm(SUBTITLE_PROCESSED_DIR, { recursive: true, force: true }),
        fs.rm(SUBTITLE_WORK_DIR, { recursive: true, force: true }),
        fs.rm(SUBTITLE_EDITED_DIR, { recursive: true, force: true }),
        fs.rm(SUBTITLE_TRANSLATION_DIR, { recursive: true, force: true }),
        fs.rm(SUBTITLE_BACKUP_DIR, { recursive: true, force: true }),
      ]);
      const allFiles = await fs.readdir(SUBTITLE_DIR).catch(() => []);
      await Promise.all(
        allFiles
          .filter((f) => f.endsWith(".vtt"))
          .map((f) => fs.rm(path.join(SUBTITLE_DIR, f), { force: true })),
      );
      await sweepCourseSubtitles();
      subtitleJobs.clear();
      await ensureSubtitleDirs();
      // Workspace local também é varrido (WAV/saída do whisper).
      try {
        await cleanupWorkspace(await loadAiConfig());
      } catch {}
      console.log("[SUBTITLE] cache de legendas limpo");
    }
    await persistSubtitleJobs();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "clear error") });
  }
});

// Limpa o workspace de processamento (WAV + saída temporária do Whisper) SEM
// tocar em raw/processed (retomada) nem nos VTTs finais. Arquivos de jobs em
// andamento são preservados.
app.post("/api/subtitles/workspace/cleanup", async (req, res) => {
  try {
    const cfg = await loadAiConfig();
    const { removed } = await cleanupWorkspace(cfg);
    console.log(`[SUBTITLE] workspace limpo (${removed} arquivo(s) temporário(s))`);
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(500).json({ error: sanitizeTestError(err.message || "cleanup error") });
  }
});

// Serve o cache de legendas. Nome validado estritamente (hash hex 24 com sufixo
// opcional de idioma `-lang` para traduções) — nunca um caminho do usuário.
app.get("/subtitles/*", async (req, res, next) => {
  const name = req.path.replace(/^\/subtitles\/?/, "");
  const m = /^([0-9a-f]{24})(?:-([a-z]{2,10}))?\.vtt$/.exec(name);
  if (!m) return next();
  const hash = m[1];
  const lang = m[2] || "";
  // O frontend envia ?rel=<videoPath>&libraryId=<id> para servir o VTT canônico
  // da pasta do curso. Só aceita quando o hash bate com sha1(libId+"\0"+rel)[0:24]
  // — nunca serve um arquivo arbitrário. Sem rel, cai para o espelho de data/subtitles/.
  let vttPath = null;
  const relParam = typeof req.query.rel === "string" ? req.query.rel : "";
  if (relParam) {
    const lib = requestLibrary(req);
    const safe = lib ? resolveLibraryRel(lib, relParam) : null;
    if (safe && subtitleCacheName(lib.id, safe.rel) === hash) {
      // `name` = `hash.vtt` (original) ou `hash-lang.vtt` (tradução); o
      // canônico é ancorado no mesmo curso.
      const courseVtt = courseSubtitlePath(lib, safe.rel, name.replace(/\.vtt$/, ""));
      if (courseVtt) {
        const st = await fs.stat(courseVtt).catch(() => null);
        if (st && st.size > 0) vttPath = courseVtt;
      }
    }
  }
  if (!vttPath) {
    const mirror = path.join(SUBTITLE_DIR, name);
    const st = await fs.stat(mirror).catch(() => null);
    if (!st) return res.status(404).end();
    vttPath = mirror;
  }
  res.set("Content-Type", "text/vtt; charset=utf-8");
  res.sendFile(vttPath, (err) => {
    if (err && err.code !== "ECONNRESET") next(err);
  });
});

// Parseia um caminho /media/<libId>/<rel> (ou /media/<rel> legado → biblioteca
// padrão). O primeiro segmento só é tratado como id de biblioteca quando casa
// com um id REGISTRADO não-padrão; senão todo o caminho é rel contra a padrão
// (back-compat de links/bookmarks). Retorna `{ lib, safe }` ou null (malformado
// / escapa da raiz da biblioteca).
function parseMediaRequest(req) {
  // No middleware montado em "/media", o Express deixa `req.path` RELATIVO ao
  // mount (sem o prefixo "/media"); na rota "/media/*" (fallback) o path é
  // completo. Normaliza ambos: tira "/media" se presente, depois o(s) "/" inicial(is).
  let raw = req.path.replace(/^\/media\/?/, "").replace(/^\/+/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {
    return null;
  }
  let lib = getDefaultLibrary();
  let rel = raw;
  const firstSlash = raw.indexOf("/");
  if (firstSlash !== -1) {
    const head = raw.slice(0, firstSlash);
    const candidate = getLibraryById(head);
    if (candidate) {
      lib = candidate;
      rel = raw.slice(firstSlash + 1);
    }
  }
  if (!lib) return null;
  const safe = resolveLibraryRel(lib, rel);
  if (!safe) return null;
  return { lib, safe };
}

// Bloqueia dotfiles em /media (paridade com o antigo `dotfiles: "ignore"` do
// static): o scan já ignora `.courseplayer`/`.topic`; servir por URL não
// reintroduz vazamento. Um segmento começando com "." → 404.
function hasDotSegment(rel) {
  return rel.split("/").some((s) => s.startsWith("."));
}

// BUG-001 (auditoria): a pasta do app fica DENTRO de ROOT. O static abaixo foi
// substituído por resolução por-biblioteca + sendFile (materiais e vídeos
// seguem o mesmo caminho); bloqueia explicitamente a pasta do app na biblioteca
// PADRÃO (nas externas, uma pasta chamada "_LocalPlayer" é legítima).
app.use("/media", (req, res, next) => {
  const parsed = parseMediaRequest(req);
  if (!parsed) return next(); // malformado/escapa: fallback responde 404
  req.mediaParsed = parsed;
  if (isAppDirRel(parsed.safe, parsed.lib)) return res.status(404).end();
  if (hasDotSegment(parsed.safe.rel)) return res.status(404).end();
  next();
});


// Serve vídeos e materiais com suporte nativo a Range requests e proteção
// contra path traversal. O arquivo original é enviado SEMPRE diretamente,
// sem nenhum processamento. `res.sendFile` (express/send) já define
// Accept-Ranges, Content-Length e Content-Type e trata o header Range
// (respostas 206), que é o que o <video> usa para seek e buffering.
app.get("/media/*", async (req, res, next) => {
  const parsed = req.mediaParsed || parseMediaRequest(req);
  if (!parsed) return res.status(404).end();
  // Symlink/junction apontando para fora da biblioteca: recusa (404) antes de
  // qualquer stat/sendFile — o original pode estar em qualquer lugar do disco.
  if (!(await fileWithinLibrary(parsed.lib, parsed.safe.abs))) {
    return res.status(404).end();
  }
  const st = await fs.stat(parsed.safe.abs).catch(() => null);
  if (!st) return res.status(404).end();
  // Materiais com conteúdo ativo (HTML/SVG/XML/JS/JSON) são servidos como
  // download: nunca renderizados no origin da app (XSS via material). nosniff
  // vale para todos os tipos (anti MIME-sniffing). Vídeos/imagens continuam
  // inline (o <video>/<img> precisa renderizar).
  res.set("X-Content-Type-Options", "nosniff");
  if (ACTIVE_EXT.has(path.extname(parsed.safe.abs).toLowerCase())) {
    res.set("Content-Disposition", "attachment");
  }
  return res.sendFile(parsed.safe.abs, (err) => {
    if (err && err.code !== "ECONNRESET") next(err);
  });
});

// Serve o cache de transcoding. Nome validado estritamente (hash hex): nunca
// um caminho do usuário. Com job ativo, entrega o .tmp em crescimento
// (progressive); sem job, serve o final com Range completo; .tmp órfão = 404.
const TRANSCODED_NAME_RE = /^([0-9a-f]{24})\.mp4$/;

app.get("/transcoded/*", async (req, res, next) => {
  const name = req.path.replace(/^\/transcoded\/?/, "");
  const m = TRANSCODED_NAME_RE.exec(name);
  if (!m) return next();

  const cacheName = m[1] + ".mp4";
  const finalPath = path.join(TRANSCODE_DIR, cacheName);
  const job = transcodeJobs.get(cacheName);
  const active = job && (job.status === "queued" || job.status === "processing");
  if (active) {
    return serveGrowingFile(req, res, job);
  }

  const finalStat = await fs.stat(finalPath).catch(() => null);
  if (finalStat) {
    return res.sendFile(finalPath, (err) => {
      if (err && err.code !== "ECONNRESET") next(err);
    });
  }
  return res.status(404).end();
});

// Página de indisponibilidade — self-contained, servida DE MEMÓRIA. Vive como
// string no servidor de propósito: quando o pendrive é desmontado, public/ (e
// qualquer HTML em disco) some junto — a única página que ainda dá para servir
// é esta, que não depende da SPA, de assets externos nem do disco. Mesmos
// tokens de cor/fonte/radius do tema (public/styles.css). O JS interno usa
// aspas simples + concatenação (sem template literals nem backticks) porque o
// contêiner abaixo é um template literal.
const UNAVAILABLE_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Local Player — indisponível</title>
<style>
  :root{
    --bg:#0a0c12; --bg-card:#141a26; --bg-card-2:#192132; --bg-hover:#20293b;
    --border:#263144; --text:#f1f5fb; --text-mid:#c3cfe0; --text-dim:#9aa8bf;
    --accent:#ff8a3d; --accent-dark:#e66d22; --radius:16px;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    background-color:var(--bg);
    background-image:
      radial-gradient(ellipse 90% 70% at 12% -15%, rgba(255,138,61,.1), rgba(255,138,61,.05) 25%, rgba(255,138,61,.02) 45%, transparent 65%),
      radial-gradient(ellipse 70% 60% at 100% -10%, rgba(58,87,140,.12), rgba(58,87,140,.05) 30%, rgba(58,87,140,.02) 50%, transparent 70%),
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.04'/%3E%3C/svg%3E");
    background-repeat:no-repeat,no-repeat,repeat;
    background-size:auto,auto,140px 140px;
    background-attachment:fixed;
    color:var(--text);
    font-family:"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    display:flex;align-items:center;justify-content:center;
    min-height:100vh;min-height:100dvh;padding:20px;
  }
  .card{
    width:min(460px,100%);
    background:var(--bg-card);
    border:1px solid var(--border);
    border-radius:var(--radius);
    box-shadow:0 20px 40px rgba(0,0,0,.28);
    padding:38px 30px 28px;
    text-align:center;
  }
  .logo{
    width:56px;height:56px;border-radius:50%;
    background:linear-gradient(135deg,var(--accent),#ffd5b7);
    box-shadow:0 0 26px rgba(255,138,61,.45);
    margin:0 auto 18px;
    display:flex;align-items:center;justify-content:center;
    color:#0a0c12;
  }
  h1{font-size:21px;font-weight:700;line-height:1.25;margin-bottom:10px}
  .msg{color:var(--text-mid);font-size:14px;line-height:1.55;min-height:44px;max-width:34ch;margin:0 auto}
  .actions{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;margin-top:24px}
  .btn{
    display:inline-flex;align-items:center;justify-content:center;
    min-height:38px;padding:0 20px;border-radius:999px;
    border:1px solid transparent;
    font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;
    transition:background .15s ease,border-color .15s ease,filter .15s ease;
  }
  .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .btn--primary{background:linear-gradient(135deg,var(--accent),var(--accent-dark));color:#fff}
  .btn--primary:hover{filter:brightness(1.06)}
  .btn--secondary{background:var(--bg-card-2);border-color:var(--border);color:var(--text)}
  .btn--secondary:hover{background:var(--bg-hover)}
  .context{
    margin-top:26px;padding-top:18px;border-top:1px solid var(--border);
    text-align:left;font-size:12.5px;color:var(--text-dim);
  }
  .ctx-row{display:flex;justify-content:space-between;gap:14px;padding:3px 0}
  .ctx-row dt{font-weight:600;color:var(--text-mid)}
  .ctx-row dd{font-variant-numeric:tabular-nums;white-space:nowrap}
  .diag{
    margin-top:14px;padding-top:12px;border-top:1px solid var(--border);
    text-align:left;font-size:12.5px;color:var(--text-dim);
  }
  .diag-line{word-break:break-word;color:var(--text-mid)}
  .diag-hint{margin-top:6px;line-height:1.5}
  @media (max-width:480px){
    .card{padding:30px 20px 24px}
    h1{font-size:19px}
    .btn{width:100%}
  }
</style>
</head>
<body>
  <main class="card">
    <div class="logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="2.5" y="7" width="19" height="10" rx="2"></rect>
        <circle cx="6.5" cy="12" r=".6" fill="currentColor"></circle>
        <circle cx="10" cy="12" r=".6" fill="currentColor"></circle>
        <line x1="17" y1="12" x2="19" y2="12"></line>
      </svg>
    </div>
    <h1 id="state-title" role="status" aria-live="polite">Verificando…</h1>
    <p class="msg" id="state-msg">Verificando o estado da aplicação.</p>
    <div class="actions">
      <button class="btn btn--primary" id="retry-btn" type="button">Tentar novamente</button>
      <button class="btn btn--secondary" id="diag-btn" type="button" aria-expanded="false" aria-controls="diag">Ver diagnóstico</button>
    </div>
    <dl class="context" id="context">
      <div class="ctx-row"><dt>Servidor</dt><dd id="ctx-server">—</dd></div>
      <div class="ctx-row"><dt>Biblioteca</dt><dd id="ctx-library">—</dd></div>
      <div class="ctx-row"><dt>Aplicação</dt><dd id="ctx-spa">—</dd></div>
      <div class="ctx-row"><dt>Última verificação</dt><dd id="ctx-last">—</dd></div>
    </dl>
    <div class="diag" id="diag" hidden>
      <p class="diag-line" id="diag-reason">—</p>
      <p class="diag-hint">Dica: confira se o dispositivo de armazenamento está conectado e montado e clique em “Tentar novamente”.</p>
    </div>
  </main>
  <script>
  (function () {
    'use strict';
    var TITLES = {
      'library-missing': 'Biblioteca indisponível',
      'device-unavailable': 'Dispositivo desconectado',
      'spa-missing': 'Aplicação ainda não está pronta',
      'unexpected': 'Não foi possível carregar o Local Player'
    };
    var MSGS = {
      'library-missing': 'O dispositivo onde seus cursos estão armazenados não está disponível no momento. Conecte ou remonte o dispositivo e tente novamente.',
      'device-unavailable': 'O dispositivo foi desconectado ou desmontado durante o uso. Reconecte-o e tente novamente.',
      'spa-missing': 'Os arquivos da aplicação ainda não puderam ser carregados. Tente novamente em instantes.',
      'unexpected': 'Ocorreu um erro ao carregar a aplicação. Tente novamente.'
    };
    var retryable = { 'library-missing': true, 'device-unavailable': true, 'spa-missing': true };
    var titleEl = document.getElementById('state-title');
    var msgEl = document.getElementById('state-msg');
    var ctxLib = document.getElementById('ctx-library');
    var ctxSpa = document.getElementById('ctx-spa');
    var ctxServer = document.getElementById('ctx-server');
    var ctxTime = document.getElementById('ctx-last');
    var diagEl = document.getElementById('diag');
    var diagBtn = document.getElementById('diag-btn');
    var diagReason = document.getElementById('diag-reason');

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function fmtTime(ts) {
      var d = new Date(ts);
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    // Aplica o estado à UI. Retorna true se o estado pode se auto-resolver
    // (auto-retry); false para "unexpected" (não adianta insistir — só o
    // botão manual "Tentar novamente" reavalia).
    function applyStatus(s) {
      var reason = s && s.reason;
      if (!reason || !TITLES[reason]) reason = 'unexpected';
      titleEl.textContent = TITLES[reason];
      msgEl.textContent = MSGS[reason];
      ctxServer.textContent = 'Online';
      ctxLib.textContent = s && s.library === 'available' ? 'Disponível' : 'Indisponível';
      ctxSpa.textContent = s && s.spa === 'available' ? 'Disponível' : 'Indisponível';
      ctxTime.textContent = s && s.lastCheck ? fmtTime(s.lastCheck) : '—';
      diagReason.textContent = (s && s.reason ? s.reason : 'offline') + (s && s.code ? ' (' + s.code + ')' : '');
      return retryable[reason] === true;
    }

    // Consulta o estado real. Falha de rede não mata a cadeia de retry: a UI
    // mostra o estado offline, mas a próxima tentativa agendada ainda roda.
    function check() {
      var ctrl = new AbortController();
      var to = setTimeout(function () { ctrl.abort(); }, 3000);
      return fetch('/api/system/status', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) { return r.json(); })
        .then(function (s) {
          clearTimeout(to);
          if (s && s.ready) { location.reload(); return { reloaded: true }; }
          return { reloaded: false, retry: applyStatus(s) };
        })
        .catch(function () {
          clearTimeout(to);
          applyStatus(null);
          return { reloaded: false, retry: true };
        });
    }

    document.getElementById('retry-btn').addEventListener('click', function () {
      location.reload();
    });
    diagBtn.addEventListener('click', function () {
      if (diagEl.hasAttribute('hidden')) {
        diagEl.removeAttribute('hidden');
        diagBtn.setAttribute('aria-expanded', 'true');
      } else {
        diagEl.setAttribute('hidden', '');
        diagBtn.setAttribute('aria-expanded', 'false');
      }
    });

    // Auto-retry limitado (5s→10s→15s→30s→60s) e apenas para estados
    // recuperáveis. Nada de polling infinito: depois da cadeia, o usuário usa
    // o botão "Tentar novamente".
    var delays = [5000, 10000, 15000, 30000, 60000];
    check().then(function (r) {
      if (r.reloaded || !r.retry) return;
      (function loop() {
        if (!delays.length) return;
        setTimeout(function () {
          check().then(function (r2) {
            if (r2.reloaded || !r2.retry) return;
            delays.shift();
            loop();
          });
        }, delays[0]);
      })();
    });
  })();
  </script>
</body>
</html>`;

// Intercept de GET / ANTES do express.static(public). Quando o estado real do
// sistema não está pronto (biblioteca/dispositivo/aplicação indisponível),
// serve a página de indisponibilidade em vez de deixar o Express cair no
// finalhandler com "Cannot GET /". Corresponde SÓ a "/" — rotas de API,
// /media/*, /subtitles/* e /transcoded/* continuam intocadas; rotas inexis-
// tentes continuam 404 real. No caminho feliz, next() → express.static serve
// a SPA normalmente (nenhuma diferença perceptível).
app.get("/", async (req, res, next) => {
  const st = await getSystemStatus().catch(() => null);
  if (!st || st.ready) return next();
  console.error(`[APP] servindo página de indisponibilidade (reason=${st.reason || "?"}, code=${st.code || "-"})`);
  res
    .status(503)
    .set("Cache-Control", "no-store")
    .set("X-Content-Type-Options", "nosniff")
    .type("html")
    .send(UNAVAILABLE_HTML);
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res) => {
      // CSP só na SPA (assets próprios, sem recursos externos; inline styles
      // vêm de atributos style gerados pelo app). Não é aplicado à página de
      // indisponibilidade (servida de memória com script inline próprio).
      res.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
    },
  }),
);

// Erros assíncronos não tratados não devem derrubar o servidor (o usuário
// perde o player e o progresso corre risco de gravação incompleta).
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

let server;

// Abre o navegador padrão na home após o boot (conveniência de uso local).
// spawn SEM shell (a URL é construída só de HOST/PORT — nunca entrada do
// usuário); detached + unref para não segurar o processo. Nunca roda em modo
// teste (LP_DATA_DIR é sandbox dos testes) e pode ser desligado com
// LP_NO_BROWSER=1.
function openBrowserInBackground() {
  if (process.env.LP_DATA_DIR) return; // testes/sandbox
  if (process.env.LP_NO_BROWSER === "1" || process.env.LP_NO_BROWSER === "true") return;
  const host = HOST && HOST !== "0.0.0.0" && HOST !== "::" ? HOST : "127.0.0.1";
  const url = `http://${host}:${PORT}/`;
  const platform = process.platform;
  const cmd = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

// O servidor só sobe quando executado diretamente (`node server.js`). Quando
// `require`'d (testes com node:test), expõe as funções puras do scan sem bindar
// porta nem tocar em data/ (ensureTools/initPersistence ficam de fora).
if (require.main === module) {
  ensureTools();
  // Sobe o listener SÓ depois que a persistência (registro de bibliotecas,
  // migração de progresso, jobs) terminar — o log de boot reflete a realidade
  // e nenhuma requisição chega antes do registry estar carregado.
  initPersistence()
    .then(() => {
      server = app.listen(PORT, HOST, () => {
        console.log(
          `Local Player rodando em http://${HOST || "0.0.0.0"}:${PORT}`,
        );
        const libCount = getLibraries().length;
        console.log(`Bibliotecas: ${libCount} (padrão: ${ROOT})`);
        openBrowserInBackground();
      });

      // Duas instâncias simultâneas escrevendo no mesmo progress.json podem
      // corromper o arquivo. Em vez de virar um processo zumbi silencioso
      // (o handler de uncaughtException engolia o erro), sai com mensagem clara.
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.error(
            `A porta ${PORT} já está em uso: outra instância do Local Player já está rodando. Encerre-a antes de iniciar novamente.`,
          );
          process.exit(1);
        }
        throw err;
      });
    })
    .catch((err) => {
      console.error("Falha ao iniciar persistência:", err && err.message);
      process.exit(1);
    });
} else {
  module.exports = {
    scanDir,
    resolveSafeRelPath,
    resolveLibraryRel,
    normalizeDisplayTitle,
    validateLibraryPath,
    getLibraries,
    getLibraryById,
    getDefaultLibrary,
    initLibraries,
    persistLibraries,
    migrateProgressKeys,
    transcodeCacheName,
    subtitleCacheName,
    translationCacheName,
    translationDocPath,
    courseSubtitlePath,
    scanLibrary,
    defaultAiConfig,
    sanitizeAiConfig,
    applyAiPatch,
    maskAiConfig,
    applyLlmTranslationGuardrail,
  };
}

// --------------------------------------------------------------------------
// Shutdown/cancelamento robusto (Fase 3). Num pendrive/HD externo, derrubar o
// servidor com whisper/ffmpeg em andamento deixaria processos órfãos lendo
// arquivos de um dispositivo que pode ser desmontado a seguir — e jobs em
// fila seriam perdidos silenciosamente. No SIGINT (Ctrl+C) / SIGTERM
// (kill, systemd, fechamento de sessão) cancelamos tudo de forma ordeira:
//   1. Marca os jobs como cancelled e mata os processos ativos (SIGTERM).
//   2. Aguarda a fila de progresso drenar (última posição não é perdida).
//   3. Persiste o estado da fila (retomável na próxima subida).
//   4. Fecha o HTTP e, em até ~5s, garante a saída (escalando para SIGKILL).
// O processo é encerrado mesmo que um subprocesso se recuse a morrer — nunca
// ficamos enforcados esperando um ffmpeg/whisper preso num disco que sumiu.
// --------------------------------------------------------------------------
let shuttingDown = false;
async function shutdownNow(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[SHUTDOWN] encerrando processos e jobs ativos…");
  // 1a. Subtitle jobs: cancela fila + mata processos whisper em andamento.
  const subtitleProcs = [];
  for (const hash of [...subtitleJobs.keys()]) {
    const job = subtitleJobs.get(hash);
    if (!job) continue;
    if (job.status === "queued") {
      updateSubtitleJob(hash, { status: "cancelled", progress: "Cancelado", error: null });
    } else if (["extracting", "transcribing", "processing", "correcting", "formatting"].includes(job.status)) {
      updateSubtitleJob(hash, { status: "cancelled", progress: "Cancelando…", error: null });
      if (job.proc) {
        subtitleProcs.push(job.proc);
        job.proc = null;
      }
    }
  }
  subtitleQueue.length = 0;
  // 1b. Transcode jobs: mata ffmpeg em andamento + esvazia a fila.
  const transcodeProcs = [...transcodeJobs.values()]
    .filter((j) => j.proc)
    .map((j) => j.proc);
  transcodeJobs.clear();
  transcodeQueue.length = 0;
  for (const p of subtitleProcs) { try { p.kill("SIGTERM"); } catch {} }
  for (const p of transcodeProcs) { try { p.kill("SIGTERM"); } catch {} }
  // 1c. Progresso (BUG-002): uma gravação pode estar pendente na fila (última
  //     posição assistida). Espera drenar com timeout — a fila é rápida, mas o
  //     shutdown nunca fica preso num disco irresponsivo. Novos saves já são
  //     rejeitados em updateProgress (shuttingDown).
  await Promise.race([
    progressWriteQueue,
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_PROGRESS_FLUSH_MS)),
  ]);
  // 2. Persiste o estado da fila de legendas SÍNCRONO (o async poderia não
  //    completar antes do exit). Jobs "cancelled" ficam gravados e o boot não
  //    os religa. Garantia de durabilidade sem depender do loop de eventos.
  try {
    const payload = {};
    for (const job of subtitleJobs.values()) {
      payload[job.hash] = subtitleJobPersistShape(job);
    }
    writeFileAtomicSync(SUBTITLE_JOBS_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.error("[SHUTDOWN] falha ao persistir jobs:", err);
  }
  // 3. Fecha o HTTP e encerra. Se um subprocesso preso segurar o loop, força.
  let exited = false;
  const forceExit = setTimeout(() => {
    if (exited) return;
    for (const p of subtitleProcs) { try { p.kill("SIGKILL"); } catch {} }
    for (const p of transcodeProcs) { try { p.kill("SIGKILL"); } catch {} }
    exited = true;
    process.exit(code);
  }, 5000);
  server.close(() => {
    if (exited) return;
    exited = true;
    clearTimeout(forceExit);
    process.exit(code);
  });
  // close() não espera conexões keep-alive eternas: força em 3s.
  setTimeout(() => {
    if (!exited) {
      for (const p of subtitleProcs) { try { p.kill("SIGKILL"); } catch {} }
      for (const p of transcodeProcs) { try { p.kill("SIGKILL"); } catch {} }
    }
  }, 3000);
}
process.on("SIGINT", () => shutdownNow(0));
process.on("SIGTERM", () => shutdownNow(0));
