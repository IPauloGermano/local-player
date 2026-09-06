// Normalização de títulos de exibição e utilitários de texto.
const path = require("path");
const os = require("os");

function naturalSort(a, b) {
  return a.name.localeCompare(b.name, "pt-BR", {
    numeric: true,
    sensitivity: "base",
  });
}

const VIDEO_EXT_STRIP_RE =
  /(?:\.(?:mp4|mkv|webm|avi|mov|m4v|ts|flv|wmv|mpg|mpeg))+$/i;
const LEADING_JUNK_RE = /^[^\wÀ-ÿ]+/; // "==", "###", "--", "**", ">", "_", "=", emojis…
const LEADING_LABEL_RE =
  /^\s*(?:aula|lesson|m[oó]dulo|parte|cap[ií]tulo|v[ií]deo|video)\s*[:\-–—]?\s*\d{1,3}(?![\d.])\s*[-:–—]?\s*/i;
const AUTHOR_SUFFIX_RE =
  /\s+[-–—|•·]\s*\b(?:by|por)\b(?!\s+(?:que|quê|quando|exemplo|isso)\b)\s+\S.*$/i;
const TRAILING_DOTS_RE = /\.{2,}$|…+$/;

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

function removeLeadingNumbering(t) {
  let sawNumbering = false;
  for (let guard = 0; guard < 6; guard++) {
    const decimalSep = t.match(
      /^\s*\d{1,3}\.\d{1,3}(?!\d)\s*[-–—_.:)\]][-\s]*/,
    );
    if (decimalSep) {
      sawNumbering = true;
      t = t.slice(decimalSep[0].length);
      continue;
    }
    const decimalCap = t.match(/^\s*\d{1,3}\.\d{1,3}(?!\d)\s+(?=[A-ZÀ-Ú])/);
    if (decimalCap) {
      sawNumbering = true;
      t = t.slice(decimalCap[0].length);
      continue;
    }
    if (/^\s*\d{1,3}\.\d{1,3}(?!\d)\s+(?=[a-zà-ú0-9("])/.test(t)) break;
    const simpleSep = t.match(/^\s*\d{1,3}(?!\d)\s*(?:[-–—_.:)\]][-\s]*|_\s*)/);
    if (simpleSep) {
      sawNumbering = true;
      t = t.slice(simpleSep[0].length);
      continue;
    }
    const padded = t.match(/^\s*(0\d{1,2})\s+(?=\S)/);
    if (padded) {
      sawNumbering = true;
      t = t.slice(padded[0].length);
      continue;
    }
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

function toDisplayCase(t) {
  let s = String(t || "").toLowerCase();
  for (const [key, canon] of TITLE_CASE_ENTRIES) {
    s = s.replace(
      new RegExp(`(?<![A-Za-zÀ-ÿ0-9])${key}(?![A-Za-zÀ-ÿ0-9])`, "g"),
      canon,
    );
  }
  const firstWord = s.match(/^\S+/);
  if (
    firstWord &&
    TITLE_KEEP_CASE[firstWord[0].toLowerCase()] === firstWord[0]
  ) {
    return s;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function captureModuleNumber(t) {
  const m = t.match(
    /^\s*(\d{1,3}(?:\.\d{1,3})?)(?![\d.])\s*(?:[-–—_.:)\]][-\s]*|_\s*|\s+)/,
  );
  return m ? m[1] : null;
}

function normalizeDisplayTitle(rawName, opts = {}) {
  const { isVideo = false, keepNumber = false } = opts;
  let t = String(rawName || "").trim();
  if (isVideo) t = t.replace(VIDEO_EXT_STRIP_RE, "");
  if (!isVideo) t = t.replace(/\(TP\)\s*$/i, "").trim();
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
      if (remainder && !/^[.\d]/.test(remainder)) t = remainder;
    }
    t = t.replace(AUTHOR_SUFFIX_RE, "");
    t = removeLeadingNumbering(t);
    t = t.replace(/\s*~\d+\s*$/, "");
    t = t.replace(/^\s*\[[^\]]{1,40}\]\s*/, "");
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
  if (/^\d{1,3}$/.test(t)) return t.padStart(2, "0");
  return t;
}

function sanitizeDisplayPath(p) {
  if (!p || typeof p !== "string") return "";
  try {
    const home = os.homedir();
    if (home && (p === home || p.startsWith(home + path.sep) || p.startsWith(home + "/"))) {
      return "~" + p.slice(home.length);
    }
  } catch {}
  return p;
}

module.exports = {
  naturalSort,
  removeLeadingNumbering,
  toDisplayCase,
  captureModuleNumber,
  normalizeDisplayTitle,
  sanitizeDisplayPath,
  TITLE_KEEP_CASE,
  TITLE_CASE_ENTRIES,
  VIDEO_EXT_STRIP_RE,
  LEADING_JUNK_RE,
  LEADING_LABEL_RE,
  AUTHOR_SUFFIX_RE,
  TRAILING_DOTS_RE,
};
