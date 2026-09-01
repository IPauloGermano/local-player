// Frontend do "Local Player" - SPA simples (sem build step) que consome a API
// local para navegar pelos cursos, tocar vídeos e acompanhar o progresso.

const state = {
  // `libraries` é a fonte de verdade (array de {id, name, path, enabled,
  // isDefault, status, error, lastScanAt, courseCount, tree}); `tree` é o alias
  // da biblioteca padrão, mantido para os walkers legados.
  libraries: [],
  tree: null,
  progress: {},
  currentCourseNode: null,
  currentVideoNode: null,
  flatVideos: [],
  lastSearchResults: [],
};

const DEFAULT_LIB_ID = "default";

function getLibById(id) {
  return (state.libraries || []).find((l) => l.id === id) || null;
}

// Helpers puros de escopo contextual (scope.js, carregado antes de app.js):
// isDescendantPath, isSidebarNavigableNode, flattenVideos,
// collectCoursesInScope, collectDirectCourses, buildContinueItems. Nada de
// DOM/estado — compartilhados por Home, tópicos e sidebar.
const {
  isDescendantPath,
  isSidebarNavigableNode,
  flattenVideos,
  collectCoursesInScope,
  collectDirectCourses,
  buildContinueItems,
  getNodeProgressStats,
  getLibraryProgressSummary,
} = window.LocalPlayerScope;

// Marca cada nó de uma árvore com o id da biblioteca a que pertence — o rel
// path de uma aula é idêntico em duas bibliotecas, então todo acesso a
// progresso/mídia precisa saber de qual biblioteca o nó veio.
function annotateLibId(node, libId) {
  if (!node) return;
  node.libId = libId;
  for (const c of node.children || []) annotateLibId(c, libId);
}

function isExternalLib(libId) {
  return !!libId && libId !== DEFAULT_LIB_ID;
}

// Chave de progresso/favorito = "<libraryId>\0<rel>" (mesma do servidor).
function progKey(path, libId) {
  return (libId || DEFAULT_LIB_ID) + "\0" + path;
}

function progFor(node) {
  return state.progress[progKey(node.path, node.libId)];
}

// Correlação frontend→servidor (forense de progresso): cada requisição de
// save carrega um id único que o servidor registra no log de escrita.
function newRequestId() {
  return (window.crypto && window.crypto.randomUUID
    ? window.crypto.randomUUID()
    : Date.now() + "-" + Math.random().toString(36).slice(2, 10));
}

// Query string (para a API) de uma biblioteca não-padrão; vazio na padrão.
function libQuery(node) {
  return isExternalLib(node && node.libId)
    ? "&libraryId=" + encodeURIComponent(node.libId)
    : "";
}

// Rotas de hash com prefixo de biblioteca (legado sem prefixo = padrão).
function courseRoute(node) {
  const p = isExternalLib(node.libId) ? encodeURIComponent(node.libId) + "/" : "";
  return `/course/${p}${encodeURIComponent(node.path)}`;
}

function topicRoute(node) {
  const p = isExternalLib(node.libId) ? encodeURIComponent(node.libId) + "/" : "";
  return `/topic/${p}${encodeURIComponent(node.path)}`;
}

function courseHref(node, lessonPath) {
  return "#" + courseRoute(node) + (lessonPath ? `?lesson=${encodeURIComponent(lessonPath)}` : "");
}

// Árvore de uma biblioteca (legado sem libId = padrão).
function libTree(libId) {
  const lib = getLibById(libId);
  return (lib && lib.tree) || state.tree;
}

let expandedFolders = new Set();

// Cursos favoritados (persistidos localmente no navegador), keyed por
// "<libraryId>\0<path>" — duas bibliotecas podem ter o mesmo rel path.
// Migração: favoritos salvos antes das bibliotecas são paths crus ("Curso X")
// → entram na biblioteca padrão ("default\0Curso X").
const favorites = new Set(
  JSON.parse(localStorage.getItem("course-favorites") || "[]").map((k) =>
    k.includes("\0") ? k : DEFAULT_LIB_ID + "\0" + k,
  ),
);

function isFavorite(path, libId) {
  return favorites.has(progKey(path, libId));
}

function toggleFavorite(path, libId) {
  const key = progKey(path, libId);
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  localStorage.setItem("course-favorites", JSON.stringify([...favorites]));
}

function favButtonHtml(path, libId) {
  const on = isFavorite(path, libId);
  return `<button class="fav-btn ${on ? "on" : ""}" data-fav="${encodeURIComponent(path)}" data-lib="${encodeURIComponent(libId || "")}" title="${on ? "Remover dos favoritos" : "Favoritar curso"}">${on ? "★" : "☆"}</button>`;
}

// Modo da seção "Seu progresso" (expandida/compacta), persistido no
// localStorage. Sem preferência salva, telas pequenas começam compactas.
const PROGRESS_MODE_KEY = "course-player-progress-mode";

function getProgressMode() {
  const saved = localStorage.getItem(PROGRESS_MODE_KEY);
  if (saved === "expanded" || saved === "compact") return saved;
  return window.matchMedia("(max-width: 640px)").matches
    ? "compact"
    : "expanded";
}

function setProgressMode(mode, section) {
  localStorage.setItem(PROGRESS_MODE_KEY, mode);
  if (!section) return;
  section.dataset.progressMode = mode;
  const toggle = section.querySelector(".progress-toggle");
  if (toggle) {
    const expanded = mode === "expanded";
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.setAttribute(
      "aria-label",
      expanded ? "Recolher seção de progresso" : "Expandir seção de progresso",
    );
  }
  const panel = section.querySelector(".progress-panel");
  if (panel) panel.setAttribute("aria-hidden", String(mode !== "expanded"));
  const summary = section.querySelector(".progress-summary");
  if (summary) summary.setAttribute("aria-hidden", String(mode === "expanded"));
}

// Preferências do usuário, persistidas no localStorage (mesmo padrão de
// favoritos e do modo de progresso). "closeOtherModules": ao abrir um módulo,
// fechar automaticamente os demais módulos abertos do curso (acordeão).
const SETTINGS_KEY = "course-player-settings";

function getSettings() {
  try {
    return {
      closeOtherModules: false,
      ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"),
    };
  } catch {
    return { closeOtherModules: false };
  }
}

function setSetting(key, value) {
  const settings = getSettings();
  settings[key] = value;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---------- Modo de visualização (teatro / normal) ----------
// Preferência de interface persistida no mesmo objeto de settings (nunca em
// progress.json). Modo Teatro é o padrão; o sumário abre fechado no teatro.
function getViewMode() {
  return getSettings().viewMode === "normal" ? "normal" : "theater";
}
function setViewMode(mode) {
  setSetting("viewMode", mode === "normal" ? "normal" : "theater");
}
function getSummaryOpen() {
  return getSettings().summaryOpen === true;
}
function setSummaryOpen(open) {
  setSetting("summaryOpen", !!open);
}

// ---------- Atalhos de teclado configuráveis ----------
// Cada ação tem UMA tecla, editável em Configurações. Persistido em
// course-player-settings.shortcuts (mesmo padrão das demais preferências —
// nunca dentro de progress.json). Ações sem player (busca, início, próxima,
// anterior) funcionam em qualquer rota; as demais exigem o vídeo carregado.
const DEFAULT_SHORTCUTS = {
  search: "/",
  home: "h",
  next: "n",
  prev: "p",
  playpause: " ",
  back5: "ArrowLeft",
  fwd5: "ArrowRight",
  back10: "j",
  fwd10: "l",
  mute: "m",
  speedDown: ",",
  speedUp: ".",
  fullscreen: "f",
  theater: "t",
};

const SHORTCUT_LABELS = {
  next: "Próxima aula",
  prev: "Aula anterior",
  playpause: "Reproduzir / Pausar",
  fwd5: "Avançar 5 segundos",
  back5: "Voltar 5 segundos",
  fwd10: "Avançar 10 segundos",
  back10: "Voltar 10 segundos",
  mute: "Silenciar",
  speedUp: "Aumentar velocidade",
  speedDown: "Diminuir velocidade",
  fullscreen: "Tela cheia",
  theater: "Modo teatro",
  search: "Abrir busca",
  home: "Início",
};

// Ordem de exibição na aba Configurações.
const SHORTCUT_ORDER = [
  "next",
  "prev",
  "playpause",
  "fwd5",
  "back5",
  "fwd10",
  "back10",
  "mute",
  "speedUp",
  "speedDown",
  "fullscreen",
  "theater",
  "search",
  "home",
];

let shortcutKeyToAction = {}; // tecla (lowercase) → ação
let captureState = null; // { action, row } durante captura na Settings

function getShortcuts() {
  const saved = getSettings().shortcuts || {};
  const result = {};
  for (const [action, key] of Object.entries(DEFAULT_SHORTCUTS)) {
    result[action] =
      typeof saved[action] === "string" && saved[action] !== ""
        ? saved[action]
        : key;
  }
  return result;
}

function setShortcut(action, key) {
  const settings = getSettings();
  const shortcuts = getShortcuts();
  shortcuts[action] = key;
  settings.shortcuts = shortcuts;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function buildShortcutMap() {
  shortcutKeyToAction = {};
  for (const [action, key] of Object.entries(getShortcuts())) {
    shortcutKeyToAction[key.toLowerCase()] = action;
  }
}

function actionForKey(key) {
  return shortcutKeyToAction[key.toLowerCase()] || null;
}

function shortcutLabel(key) {
  if (key === " ") return "Espaço";
  if (key === "ArrowLeft") return "←";
  if (key === "ArrowRight") return "→";
  if (key.length === 1) return key.toUpperCase();
  return key; // F1–F12, Escape, etc.
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (s) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[s],
  );
}

function stripExt(name) {
  return name.replace(/\.[^/.]+$/, "");
}

// Títulos de exibição: o servidor envia o campo `title` já normalizado
// (normalizeDisplayTitle no server.js) para cursos, módulos e aulas. O
// fallback aqui é mínimo (nome cru sem extensão) porque a árvore sempre
// traz `title`.

const warnedTitles = new Set();

// Siglas de 4+ letras legitimamente maiúsculas (as de 2-3 letras nunca
// disparam a regra de CAPS abaixo).
const TITLE_ACRONYMS = new Set(["HTML", "HTTP", "HTTPS", "JSON", "RBAC"]);

// Valida o título antes de exibir: deve parecer escrito para a plataforma
// (sem número/símbolo no início, sem "..." no fim, sem sublinhados, sem
// espaços duplicados, sem CAPS). Apenas avisa no console — o caso é
// reportado para correção manual, sem esconder o conteúdo.
function validateDisplayTitle(title, context) {
  if (warnedTitles.has(context)) return;
  const issues = [];
  // Módulos/tópicos mantêm o número de exibição ("01 - Título") — a regra
  // de "não começar com número" vale para aulas.
  const isModuleTitle =
    context.startsWith("módulo:") || context.startsWith("curso:");
  if (
    !isModuleTitle &&
    /^\d/.test(title) &&
    !/^\d[a-zA-ZÀ-ÿ]/.test(title)
  )
    issues.push("começa com número");
  if (/^[^A-Za-zÀ-ÿ0-9]/.test(title)) issues.push("começa com símbolo");
  if (title.includes("==")) issues.push("contém '=='");
  if (/(?:\.\.\.|…)$/.test(title)) issues.push("termina com '...'");
  if (/[-–—_:;|•·\s_]$/.test(title)) issues.push("termina com separador");
  if (/\s{2,}/.test(title)) issues.push("espaços duplicados");
  if (title.includes("_")) issues.push("contém sublinhado");
  const firstWord = (title.match(/^\S+/) || [""])[0];
  if (/^[a-zà-ÿ]/.test(title) && !/\d/.test(firstWord))
    issues.push("primeira letra minúscula");
  const capsRuns = title.match(/[A-ZÀ-Ú]{4,}/g) || [];
  for (const run of capsRuns) {
    if (!TITLE_ACRONYMS.has(run)) {
      issues.push("possível CAPS");
      break;
    }
  }
  if (!issues.length) return;
  warnedTitles.add(context);
  console.warn(
    `[Título não padronizado] ${context} → "${title}" (${issues.join(", ")})`,
  );
}

function displayTitle(node, context) {
  let title =
    node && typeof node.title === "string" && node.title
      ? node.title
      : node && node.name
        ? stripExt(node.name)
        : "";
  validateDisplayTitle(title, `${context}:${(node && node.path) || ""}`);
  return title;
}

function lessonTitle(node) {
  return displayTitle(node, "aula");
}

function moduleTitle(node) {
  return displayTitle(node, "módulo");
}

function courseTitle(node) {
  return displayTitle(node, "curso");
}

function topicTitle(node) {
  return displayTitle(node, "tópico");
}

function normalizeText(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function toSearchTokens(query) {
  return normalizeText(query)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function scoreMatch(text, tokens) {
  if (!tokens.length) return 0;
  const haystack = normalizeText(text);
  let score = 0;
  for (const token of tokens) {
    const idx = haystack.indexOf(token);
    if (idx === -1) return 0;
    score += Math.max(1, 24 - Math.min(24, idx));
    if (haystack.startsWith(token)) score += 6;
  }
  return score;
}

function mediaUrl(relPath, libId) {
  const rel = relPath.split("/").map(encodeURIComponent).join("/");
  return isExternalLib(libId)
    ? "/media/" + encodeURIComponent(libId) + "/" + rel
    : "/media/" + rel;
}

function courseColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++)
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue},60%,32%), hsl(${(hue + 40) % 360},65%,18%))`;
}

function initials(name) {
  const clean = name.replace(/[\[\]]/g, "");
  const words = clean.split(/\s+/).filter(Boolean);
  const chars = words
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  // Inserido como conteúdo de um div via template → escapar para nunca
  // permitir que o primeiro caractere do nome vire um markup (ex.: "<b").
  return escapeHtml(chars);
}

async function loadAll() {
  const [treeRes, progRes, aiRes] = await Promise.all([
    fetch("/api/tree"),
    fetch("/api/progress"),
    fetch("/api/ai/status"),
  ]);
  const treeData = await treeRes.json();
  const libraries = Array.isArray(treeData.libraries) ? treeData.libraries : [];
  state.libraries = libraries;
  const defaultLib = libraries.find((l) => l.isDefault) || libraries[0] || null;
  state.tree = (defaultLib && defaultLib.tree) || null;
  for (const lib of libraries) annotateLibId(lib.tree, lib.id);
  const progress = await progRes.json();
  // Whisper configurado ⇒ controles de legenda visíveis; caso contrário o
  // frontend oculta "Gerar legendas" e o botão CC. Falha/indisponibilidade ⇒
  // falso (conservador: esconder é seguro, mostrar sem Whisper é inútil).
  try {
    const ai = await aiRes.json();
    subtitleGenerateEnabled = !!(
      ai &&
      ai.transcription &&
      ai.transcription.configured &&
      ai.transcription.configured.canGenerate
    );
  } catch {
    subtitleGenerateEnabled = false;
  }
  for (const key of Object.keys(progress)) {
    const p = progress[key];
    // Saneamento: posição no fim/ultrapassada com vídeo não concluído
    // fazia o seek de retomada cair no final e disparar `ended` falso
    // (pulando para o próximo vídeo sem terminar o atual).
    if (
      p &&
      p.duration > 0 &&
      !p.completed &&
      p.position >= p.duration - 1
    ) {
      p.position = Math.max(0, p.duration - 5);
    }
  }
  state.progress = progress;
}

function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.round(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m} min`;
  return `${sec}s`;
}

function countStats(node) {
  if (node.type === "video") {
    const p = progFor(node);
    return { total: 1, done: p && p.completed ? 1 : 0 };
  }
  if (node.type === "folder") {
    let total = 0;
    let done = 0;
    for (const child of node.children) {
      if (child.type === "file") continue;
      const s = countStats(child);
      total += s.total;
      done += s.done;
    }
    return { total, done };
  }
  return { total: 0, done: 0 };
}

function flattenMaterials(node, out = []) {
  if (node.type === "file") {
    out.push(node);
    return out;
  }
  if (node.type === "folder" || node.type === "topic") {
    for (const c of node.children) flattenMaterials(c, out);
  }
  return out;
}

function buildSearchResults(roots, query) {
  const tokens = toSearchTokens(query);
  if (!tokens.length) return [];

  const results = [];
  // Caminha a árvore inteira de CADA biblioteca: tópicos viram resultados
  // próprios (clique → #/topic/) e cursos aninhados em tópicos também aparecem
  // (aulas/materiais inclusive). Cada resultado leva o libraryId de origem.
  for (const tree of (Array.isArray(roots) ? roots : [roots]).filter(Boolean)) {
    for (const folder of collectAllFolders(tree)) {
      if (folder.type === "topic") {
        const topicScore = scoreMatch(
          `${folder.name} ${topicTitle(folder)} ${folder.path}`,
          tokens,
        );
        if (topicScore) {
          results.push({
            type: "topic",
            libId: folder.libId,
            path: folder.path,
            courseName: "Tópico",
            label: topicTitle(folder),
            hint: folder.path,
            score: topicScore + 15,
          });
        }
        continue;
      }

    const course = folder;
    const courseScore = scoreMatch(
      `${course.name} ${courseTitle(course)} ${course.path}`,
      tokens,
    );
    if (courseScore) {
      results.push({
        type: "course",
        libId: course.libId,
        coursePath: course.path,
        courseName: courseTitle(course),
        label: courseTitle(course),
        hint: "Curso",
        score: courseScore + 15,
      });
    }

    for (const video of flattenVideos(course)) {
      const videoLabel = lessonTitle(video);
      const videoScore = scoreMatch(
        `${videoLabel} ${video.name} ${video.path} ${courseTitle(course)}`,
        tokens,
      );
      if (videoScore) {
        results.push({
          type: "lesson",
          libId: course.libId,
          coursePath: course.path,
          lessonPath: video.path,
          courseName: courseTitle(course),
          label: videoLabel,
          hint: video.path,
          score: videoScore + 10,
        });
      }
    }

    for (const file of flattenMaterials(course)) {
      const fileScore = scoreMatch(
        `${file.name} ${file.path} ${courseTitle(course)}`,
        tokens,
      );
      if (fileScore) {
        results.push({
          type: "material",
          libId: course.libId,
          coursePath: course.path,
          courseName: courseTitle(course),
          label: file.name,
          hint: file.path,
          score: fileScore,
        });
      }
    }
  }
  }

  results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  return results.slice(0, 18);
}

function findParentFolder(node, targetPath) {
  if (node.type !== "folder" && node.type !== "topic") return null;
  if (node.children.some((c) => c.path === targetPath)) return node;
  for (const c of node.children) {
    if (c.type === "folder" || c.type === "topic") {
      const found = findParentFolder(c, targetPath);
      if (found) return found;
    }
  }
  return null;
}

function findAncestorFolders(node, targetPath) {
  if (node.type !== "folder" && node.type !== "topic") return null;
  for (const c of node.children) {
    if (c.path === targetPath) return [node.path];
    if (c.type === "folder" || c.type === "topic") {
      const res = findAncestorFolders(c, targetPath);
      if (res) return [node.path, ...res];
    }
  }
  return null;
}

// Busca um nó na árvore inteira pelo path relativo (cursos podem estar
// aninhados dentro de tópicos). `root` é `state.tree` ou uma pasta.
function findNodeByPath(root, targetPath) {
  if (!root || !Array.isArray(root.children)) return null;
  if (root.path === targetPath) return root;
  for (const child of root.children) {
    const found = findNodeByPath(child, targetPath);
    if (found) return found;
  }
  return null;
}

// Todas as pastas da árvore (tópicos e cursos), recursivo.
function collectAllFolders(root, out = []) {
  for (const c of root.children || []) {
    if (c.type === "folder" || c.type === "topic") {
      out.push(c);
      collectAllFolders(c, out);
    }
  }
  return out;
}

// ---------- Home ----------
function clearProgress(coursePath, libId) {
  // coursePath null = limpar tudo; senão limpa o escopo da biblioteca da aula.
  const body = { coursePath: coursePath ?? null };
  if (isExternalLib(libId)) body.libraryId = libId;
  fetch("/api/progress/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(() => loadAll())
    .then(() => route())
    .catch(() => {});
}

// Remove o cache de vídeos transcodificados (data/transcoded/) e cancela
// conversões em andamento. Nunca toca em progress.json.
function clearTranscodeCache() {
  fetch("/api/transcode/clear", { method: "POST" }).catch(() => {});
}

// Diálogo de confirmação próprio (sem `confirm()` nativo): overlay + modal com
// foco no botão seguro ao abrir e restaurado ao fechar; Esc/overlay/cancelar
// fecham sem agir.
function openConfirmDialog({
  title,
  message,
  confirmLabel = "Confirmar",
  cancelLabel = "Cancelar",
  danger = false,
  onConfirm,
}) {
  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-title" id="modal-title">${escapeHtml(title)}</div>
      <div class="modal-message">${escapeHtml(message)}</div>
      <div class="modal-actions">
        <button class="btn-cancel secondary-btn" type="button">${escapeHtml(cancelLabel)}</button>
        <button class="btn-confirm ${danger ? "danger" : ""}" type="button">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = (confirmed) => {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
    if (previousFocus && previousFocus.focus) previousFocus.focus();
    if (confirmed && onConfirm) onConfirm();
  };
  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close(false);
    }
  }

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close(false);
  });
  overlay.querySelector(".btn-cancel").addEventListener("click", () => close(false));
  overlay.querySelector(".btn-confirm").addEventListener("click", () => close(true));
  document.addEventListener("keydown", onKeydown);
  overlay.querySelector(".btn-cancel").focus();
}

// ---------- Configurações ----------
function startCapture(row) {
  const action = row.dataset.action;
  captureState = { action, row };
  row.classList.add("capturing");
  const msg = row.querySelector(".shortcut-msg");
  if (msg) {
    msg.hidden = false;
    msg.textContent = "Pressione uma tecla...";
    msg.classList.remove("error");
  }
  row.setAttribute(
    "aria-label",
    `Atalho de ${SHORTCUT_LABELS[action]}: pressione uma tecla...`,
  );
}

function stopCapture(preserveMsg) {
  if (!captureState) return;
  const { action, row } = captureState;
  captureState = null;
  row.classList.remove("capturing");
  const msg = row.querySelector(".shortcut-msg");
  if (msg && !preserveMsg) {
    msg.hidden = true;
    msg.textContent = "";
    msg.classList.remove("error");
  }
  row.setAttribute(
    "aria-label",
    `Atalho de ${SHORTCUT_LABELS[action]}: ${shortcutLabel(getShortcuts()[action])}`,
  );
}

// ---------- Configurações: página reorganizada por categorias ----------
// Navegação interna (#/settings/<categoria>) + uma categoria por vez no
// conteúdo. Nenhuma funcionalidade foi removida: cada controle real da página
// antiga vive em exatamente uma categoria. As categorias foram decididas a
// partir do que EXISTE no código (não de uma lista genérica): não há
// configuração de áudio nem de legendas para organizar — a configuração de
// transcrição vive em "Inteligência Artificial" e o status/fila/logs em
// "Diagnóstico".

const SETTINGS_CATS = [
  {
    id: "geral",
    label: "Geral",
    group: "Preferências",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  },
  {
    id: "reproducao",
    label: "Reprodução",
    group: "Preferências",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>`,
  },
  {
    id: "atalhos",
    label: "Atalhos",
    group: "Preferências",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><line x1="6" y1="8" x2="6.01" y2="8"></line><line x1="10" y1="8" x2="10.01" y2="8"></line><line x1="14" y1="8" x2="14.01" y2="8"></line><line x1="18" y1="8" x2="18.01" y2="8"></line><line x1="8" y1="12" x2="8.01" y2="12"></line><line x1="12" y1="12" x2="12.01" y2="12"></line><line x1="16" y1="12" x2="16.01" y2="12"></line><line x1="7" y1="16" x2="17" y2="16"></line></svg>`,
  },
  {
    id: "ia",
    label: "Inteligência Artificial",
    group: "IA & Automação",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 6.8L21 11l-6.6 2.2L12 20l-2.4-6.8L3 11l6.6-2.2z"></path></svg>`,
  },
  {
    id: "dados",
    label: "Armazenamento",
    group: "Sistema & Dados",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>`,
  },
  {
    id: "bibliotecas",
    label: "Bibliotecas",
    group: "Sistema & Dados",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  },
  {
    id: "diagnostico",
    label: "Diagnóstico",
    group: "Sistema & Dados",
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
  },
];

function settingsCatFromHash(raw) {
  return SETTINGS_CATS.some((c) => c.id === raw) ? raw : "geral";
}

function settingsCurrentCat() {
  const m = location.hash.match(/^#\/settings(?:\/([a-z]+))?/i);
  return settingsCatFromHash(m ? m[1] : "geral");
}

function renderSettings(app, rawCat) {
  const cat = settingsCatFromHash(rawCat || settingsCurrentCat());
  if (diagPollTimer) {
    clearInterval(diagPollTimer);
    diagPollTimer = null;
  }

  // Agrupamento de categorias para a navegação SaaS
  const groups = [
    { name: "Preferências", cats: SETTINGS_CATS.filter((c) => c.group === "Preferências") },
    { name: "IA & Automação", cats: SETTINGS_CATS.filter((c) => c.group === "IA & Automação") },
    { name: "Sistema & Dados", cats: SETTINGS_CATS.filter((c) => c.group === "Sistema & Dados") },
  ];

  app.innerHTML = `
    <div class="settings-header">
      <div class="settings-header-main">
        <h1 class="settings-title">
          <span style="color: var(--accent); display: flex; align-items: center;">⚙</span>
          Central de Configurações
        </h1>
        <p class="settings-subtitle">Gerencie preferências, inteligência artificial, bibliotecas de mídia e armazenamento do sistema.</p>
      </div>
      <button class="settings-back-btn" id="settings-back" type="button" aria-label="Voltar para a tela inicial">
        ← Voltar ao Início
      </button>
    </div>
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Categorias de configurações">
        ${groups.map((g) => `
          <div class="settings-nav-group-title">${escapeHtml(g.name)}</div>
          ${g.cats.map((c) => `
            <a class="settings-nav-item ${c.id === cat ? "is-active" : ""}"
               href="#/settings/${c.id}"
               ${c.id === cat ? 'aria-current="page"' : ""}>
              <span class="settings-nav-icon">${c.icon}</span>
              <span class="settings-nav-label">${escapeHtml(c.label)}</span>
            </a>`).join("")}
        `).join("")}
      </nav>
      <div class="settings-content">
        ${renderSettingsCategory(cat)}
      </div>
    </div>`;

  document.getElementById("settings-back").addEventListener("click", () => {
    location.hash = "/";
  });

  bindSettingsCategory(cat, app);
  window.scrollTo(0, 0);
}

function renderSettingsCategory(cat) {
  switch (cat) {
    case "reproducao": return renderSettingsReproducao();
    case "atalhos": return renderSettingsAtalhos();
    case "ia": return renderAiSection();
    case "dados": return renderSettingsDados();
    case "bibliotecas": return renderSettingsBibliotecas();
    case "diagnostico": return renderSettingsDiagnostico();
    default: return renderSettingsGeral();
  }
}

function bindSettingsCategory(cat, app) {
  switch (cat) {
    case "reproducao": bindSettingsReproducao(app); break;
    case "atalhos": bindSettingsAtalhos(app); break;
    case "ia": bindAiSection(app); break;
    case "dados": bindSettingsDados(app); break;
    case "bibliotecas": bindSettingsBibliotecas(app); break;
    case "diagnostico": initSettingsDiagnostics(app); break;
    default: bindSettingsGeral(app); break;
  }
}

// --- Categoria: Geral ---
function renderSettingsGeral() {
  const on = getSettings().closeOtherModules;
  return `
    <section class="settings-card" aria-label="Aplicação">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Navegação e Interface</h2>
            <p class="settings-section-desc">Personalize o comportamento geral de visualização e navegação na aplicação.</p>
          </div>
        </div>
      </div>
      <div class="settings-row" id="close-modules-row" style="cursor: pointer;">
        <div class="settings-row-text">
          <div class="settings-row-title">Fechar outros módulos ao abrir</div>
          <div class="settings-row-desc">Quando ativado, expandir um módulo fecha automaticamente os demais módulos para manter a barra lateral compacta.</div>
        </div>
        <button class="switch ${on ? "on" : ""}" id="toggle-close-modules" type="button" role="switch" aria-checked="${on}" aria-label="Fechar outros módulos ao abrir">
          <span class="switch-track"></span>
          <span class="switch-thumb"></span>
        </button>
      </div>
    </section>`;
}

function bindSettingsGeral(app) {
  const switchBtn = app.querySelector("#toggle-close-modules");
  const applySwitch = (next) => {
    setSetting("closeOtherModules", next);
    switchBtn.classList.toggle("on", next);
    switchBtn.setAttribute("aria-checked", String(next));
  };
  switchBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    applySwitch(!getSettings().closeOtherModules);
  });
  app.querySelector("#close-modules-row").addEventListener("click", () => {
    applySwitch(!getSettings().closeOtherModules);
  });
}

// --- Categoria: Reprodução ---
function renderSettingsReproducao() {
  return `
    <section class="settings-card" aria-label="Reprodução">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polygon points="10 8 16 12 10 16 10 8"></polygon></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Preferências do Player</h2>
            <p class="settings-section-desc">Defina as opções padrão para a reprodução de aulas em vídeo.</p>
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Velocidade padrão de reprodução</div>
          <div class="settings-row-desc">Taxa de reprodução inicial ao abrir qualquer aula. Pode ser reajustada no player a qualquer momento.</div>
        </div>
        <select class="settings-select" id="default-speed" aria-label="Velocidade padrão de reprodução">
          ${(() => {
            const saved = parseFloat(localStorage.getItem("course-player-speed") || "1");
            return [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
              .map((s) => `<option value="${s}" ${Math.abs(saved - s) < 0.001 ? "selected" : ""}>${s % 1 ? s : s.toFixed(0)}×</option>`)
              .join("");
          })()}
        </select>
      </div>
    </section>`;
}

function bindSettingsReproducao(app) {
  const speedSel = app.querySelector("#default-speed");
  if (speedSel) {
    speedSel.addEventListener("change", () => {
      localStorage.setItem("course-player-speed", String(speedSel.value));
    });
  }
}

// --- Categoria: Atalhos ---
function renderSettingsAtalhos() {
  return `
    <section class="settings-card" aria-label="Atalhos de teclado">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2" ry="2"></rect><line x1="6" y1="8" x2="6.01" y2="8"></line><line x1="10" y1="8" x2="10.01" y2="8"></line><line x1="14" y1="8" x2="14.01" y2="8"></line><line x1="18" y1="8" x2="18.01" y2="8"></line><line x1="8" y1="12" x2="8.01" y2="12"></line><line x1="12" y1="12" x2="12.01" y2="12"></line><line x1="16" y1="12" x2="16.01" y2="12"></line><line x1="7" y1="16" x2="17" y2="16"></line></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Atalhos de Teclado</h2>
            <p class="settings-section-desc">Clique em qualquer ação abaixo e pressione uma nova tecla para remapear.</p>
          </div>
        </div>
      </div>
      <div class="shortcut-list">
        ${SHORTCUT_ORDER.map((action) => {
          const key = getShortcuts()[action];
          return `
            <button type="button" class="shortcut-row" data-action="${action}"
                    aria-label="Atalho de ${SHORTCUT_LABELS[action]}: ${shortcutLabel(key)}">
              <span class="shortcut-name">${SHORTCUT_LABELS[action]}</span>
              <span class="shortcut-value">
                <kbd class="shortcut-key">${shortcutLabel(key)}</kbd>
                <span class="shortcut-msg" role="status" aria-live="polite" hidden></span>
              </span>
            </button>`;
        }).join("")}
      </div>
      <div class="settings-actions" style="margin-top: 16px;">
        <button class="btn btn--secondary" id="reset-shortcuts" type="button">Restaurar atalhos padrão</button>
      </div>
    </section>`;
}

function bindSettingsAtalhos(app) {
  app.querySelectorAll(".shortcut-row").forEach((row) => {
    row.addEventListener("click", () => startCapture(row));
  });
  app.querySelector("#reset-shortcuts").addEventListener("click", () => {
    openConfirmDialog({
      title: "Restaurar atalhos padrão",
      message:
        "Isso substitui todos os atalhos personalizados pelos valores padrão.",
      confirmLabel: "Restaurar",
      cancelLabel: "Cancelar",
      danger: false,
      onConfirm: () => {
        const settings = getSettings();
        settings.shortcuts = { ...DEFAULT_SHORTCUTS };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        buildShortcutMap();
        renderSettings(app, "atalhos");
      },
    });
  });
}

// --- Categoria: Dados e armazenamento ---
function renderSettingsDados() {
  return `
    <section class="settings-card" aria-label="Dados e armazenamento">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Uso de Armazenamento</h2>
            <p class="settings-section-desc">Estatísticas de espaço em disco e diretório de processamento temporário.</p>
          </div>
        </div>
      </div>
      <div class="storage-status" id="storage-status">
        <p class="ai-inline-msg">Carregando uso de armazenamento…</p>
      </div>
      <div class="settings-subsection">
        <h3 class="settings-subsection-heading">Workspace de legendas</h3>
        <p class="settings-row-desc" style="margin-bottom: 12px;">Local onde o áudio e a transcrição temporários são processados pelo Whisper.</p>
        <div class="workspace-fields" id="workspace-fields">
          <p class="ai-inline-msg">Carregando configuração do workspace…</p>
        </div>
      </div>
      <div class="settings-actions" style="margin-top: 16px;">
        <button class="btn btn--secondary" id="cleanup-workspace" type="button">Limpar workspace (arquivos temporários)</button>
        <button class="btn btn--secondary" id="clear-transcode-cache" type="button">Limpar cache de vídeos transcodificados</button>
      </div>
    </section>

    <!-- Zona de Perigo -->
    <section class="settings-card settings-danger-card" aria-label="Zona de Perigo">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          </div>
          <div>
            <h2 class="settings-section-heading" style="color: #fca5a5;">Zona Crítica</h2>
            <p class="settings-section-desc">Ações destrutivas e irreversíveis sobre os registros salvos.</p>
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Limpar todo o progresso de estudo</div>
          <div class="settings-row-desc">Apaga o histórico de aulas assistidas, timestamps e conclusões em todas as bibliotecas.</div>
        </div>
        <button class="btn btn--danger" id="clear-all-progress" type="button">Limpar todo o progresso</button>
      </div>
    </section>`;
}

function bindSettingsDados(app) {
  app.querySelector("#clear-all-progress").addEventListener("click", () => {
    openConfirmDialog({
      title: "Limpar todo o progresso",
      message:
        "Todo o progresso salvo será removido: posição dos vídeos, aulas concluídas e tempo assistido de todos os cursos. Esta ação não pode ser desfeita.",
      confirmLabel: "Limpar tudo",
      cancelLabel: "Cancelar",
      danger: true,
      onConfirm: () => clearProgress(null),
    });
  });

  app.querySelector("#clear-transcode-cache").addEventListener("click", () => {
    openConfirmDialog({
      title: "Limpar cache de transcoding",
      message:
        "Os vídeos transcodificados serão removidos de data/transcoded/ e conversões em andamento serão canceladas. Seu progresso não é afetado. Vídeos incompatíveis terão que ser convertidos novamente na próxima reprodução.",
      confirmLabel: "Limpar cache",
      cancelLabel: "Cancelar",
      danger: false,
      onConfirm: () => clearTranscodeCache(),
    });
  });

  initSettingsStorage(app);
}

// --- Categoria: Bibliotecas ---
function renderSettingsBibliotecas() {
  // Fallback se o estado ainda não carregou — o servidor sempre retorna a
  // biblioteca padrão; essa linha só cobre um render antes do loadAll().
  const libs = state.libraries.length
    ? state.libraries
    : [
        {
          id: DEFAULT_LIB_ID,
          name: "Biblioteca",
          path: "",
          isDefault: true,
          enabled: true,
          status: "ready",
          courseCount: 0,
        },
      ];
  const rows = libs
    .map((lib) => {
      const isDefault = lib.isDefault === true;
      const badge =
        lib.enabled === false
          ? `<span class="lib-badge lib-badge-off">Desativada</span>`
          : lib.status === "unavailable" || lib.status === "error"
            ? `<span class="lib-badge lib-badge-warn" title="${escapeHtml(lib.error || "diretório indisponível")}">⚠ indisponível</span>`
            : `<span class="lib-badge lib-badge-ok">✓ Disponível</span>`;
      const pathText = isDefault && !lib.path ? "Biblioteca da instalação" : lib.path;
      const actions = [
        `<button type="button" class="lib-btn" data-action="rescan">Reescanear</button>`,
        `<button type="button" class="lib-btn" data-action="edit">Editar</button>`,
        `<button type="button" class="lib-btn" data-action="toggle">${
          lib.enabled === false ? "Ativar" : "Desativar"
        }</button>`,
        `<button type="button" class="lib-btn lib-btn-danger" data-action="remove">Remover</button>`,
      ];
      return `
    <div class="lib-row" data-lib-id="${encodeURIComponent(lib.id)}">
      <div class="lib-row-main">
        <div class="lib-row-name">${escapeHtml(lib.name)}${isDefault ? ' <span class="lib-tag">padrão</span>' : ""}</div>
        <div class="lib-row-path" title="${escapeHtml(pathText)}">${escapeHtml(pathText)}</div>
      </div>
      ${badge}
      <span class="lib-row-count">${lib.courseCount} curso${lib.courseCount === 1 ? "" : "s"}</span>
      <span class="lib-row-actions">${actions.join("")}</span>
    </div>`;
    })
    .join("");
  return `
    <section class="settings-card" aria-label="Bibliotecas">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Bibliotecas de Mídia</h2>
            <p class="settings-section-desc">Gerencie pastas de conteúdo além da biblioteca padrão. Cada biblioteca tem seus próprios cursos, progresso e caches isolados.</p>
          </div>
        </div>
      </div>
      <div class="lib-list" id="lib-list">${rows}</div>
      <div class="settings-actions" style="margin-top: 14px;">
        <button type="button" class="btn btn--primary" id="lib-add">＋ Adicionar biblioteca</button>
      </div>
      <div id="lib-error" class="ai-inline-msg error" hidden></div>
      <p class="ai-note" style="margin-top: 14px;">O caminho é informado manualmente (cole ou digite o caminho absoluto da pasta). Remover apenas desliga a biblioteca da configuração — nenhum arquivo é apagado e o histórico é preservado.</p>
    </section>`;
}

function bindSettingsBibliotecas(app) {
  const showError = (msg) => {
    const err = app.querySelector("#lib-error");
    if (!err) return;
    err.textContent = msg;
    err.hidden = false;
  };
  const refresh = async () => {
    await loadAll();
    renderSettings(app);
  };
  const doFetch = async (url, opts) => {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  app.querySelector("#lib-add").addEventListener("click", () => {
    openLibraryDialog(app, { mode: "add", onSaved: refresh });
  });

  const list = app.querySelector("#lib-list");
  list.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    const row = btn.closest(".lib-row");
    if (!row) return;
    const libId = decodeURIComponent(row.dataset.libId);
    const lib = getLibById(libId) || null;
    const action = btn.dataset.action;

    if (action === "rescan") {
      doFetch(`/api/libraries/${encodeURIComponent(libId)}/rescan`, { method: "POST" })
        .then(refresh)
        .catch((err) => showError("Reescaneamento falhou: " + err.message));
      return;
    }
    if (action === "edit") {
      openLibraryDialog(app, { mode: "edit", libId, onSaved: refresh });
      return;
    }
    if (action === "toggle") {
      doFetch(`/api/libraries/${encodeURIComponent(libId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !(lib && lib.enabled) }),
      })
        .then(refresh)
        .catch((err) => showError("Falha ao alternar: " + err.message));
      return;
    }
    if (action === "remove") {
      openConfirmDialog({
        title: "Remover biblioteca",
        message:
          `A biblioteca "${lib && lib.name ? lib.name : ""}" será removida da configuração. ` +
          "Nenhum arquivo da pasta será apagado; progresso e caches (transcoding/legendas) são preservados. Esta ação não pode ser desfeita.",
        confirmLabel: "Remover da configuração",
        cancelLabel: "Cancelar",
        danger: true,
        onConfirm: () => {
          doFetch(`/api/libraries/${encodeURIComponent(libId)}`, { method: "DELETE" })
            .then(refresh)
            .catch((err) => showError("Falha ao remover: " + err.message));
        },
      });
    }
  });
}

// Diálogo de adicionar/editar biblioteca: campo de caminho colado/digitado
// (sem seletor de pasta nativo), nome opcional, switch de ativação.
function openLibraryDialog(app, { mode, libId, onSaved }) {
  const lib = libId ? getLibById(libId) : null;
  const isEdit = mode === "edit";
  const previousFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-title" id="modal-title">${isEdit ? "Editar biblioteca" : "Adicionar biblioteca"}</div>
      <div class="modal-body">
        <p class="ai-note">${
          isEdit
            ? "Ajuste o nome, o caminho e o estado da biblioteca."
            : "Cole ou digite o caminho absoluto da pasta com o conteúdo. A pasta será escaneada e aparecerá na Home, ao lado da biblioteca padrão."
        }</p>
        <div class="lib-field">
          <label class="ai-label" for="lib-path">Caminho da pasta</label>
          <input class="ai-input" id="lib-path" type="text" value="${escapeHtml(lib ? lib.path : "")}" placeholder="/caminho/para/sua/pasta" autocomplete="off">
        </div>
        <div class="lib-field">
          <label class="ai-label" for="lib-name">Nome (opcional)</label>
          <input class="ai-input" id="lib-name" type="text" value="${escapeHtml(lib ? lib.name : "")}" placeholder="ex.: HD Externo, Cursos de Inglês" autocomplete="off">
        </div>
        ${isEdit ? `<label class="ai-label"><input type="checkbox" id="lib-enabled" ${lib && lib.enabled === false ? "" : "checked"}> Biblioteca ativa</label>` : ""}
        <div id="lib-dialog-error" class="ai-inline-msg error" hidden></div>
      </div>
      <div class="modal-actions">
        <button class="btn-cancel secondary-btn" type="button">Cancelar</button>
        <button class="btn-confirm" type="button">${isEdit ? "Salvar" : "Adicionar"}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
    if (previousFocus && previousFocus.focus) previousFocus.focus();
  };
  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  }
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector(".btn-cancel").addEventListener("click", close);

  const confirmBtn = overlay.querySelector(".btn-confirm");
  const pathInput = overlay.querySelector("#lib-path");
  const nameInput = overlay.querySelector("#lib-name");
  const enabledBox = overlay.querySelector("#lib-enabled");

  const submit = async () => {
    const path = (pathInput.value || "").trim();
    const name = (nameInput.value || "").trim();
    const enabled = enabledBox ? enabledBox.checked : true;
    confirmBtn.disabled = true;
    // Edit com caminho vazio = manter o atual (evita revalidar path à toa).
    const body = { name, enabled };
    if (!isEdit || path) body.path = path;
    try {
      const res = await fetch(
        isEdit ? `/api/libraries/${encodeURIComponent(libId)}` : "/api/libraries",
        {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      close();
      if (onSaved) await onSaved();
    } catch (err) {
      confirmBtn.disabled = false;
      const errEl = overlay.querySelector("#lib-dialog-error");
      if (errEl) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    }
  };
  confirmBtn.addEventListener("click", submit);
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
}

// --- Categoria: Diagnóstico ---
function renderSettingsDiagnostico() {
  return `
    <section class="settings-card" aria-label="Diagnóstico">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Diagnóstico do Sistema</h2>
            <p class="settings-section-desc">Status da instalação, ambiente do servidor e fila de processamento de IA em tempo real.</p>
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Raiz da Biblioteca Principal</div>
          <div class="settings-row-desc" id="diag-root">…</div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Instância do Servidor</div>
          <div class="settings-row-desc" id="diag-server">…</div>
        </div>
      </div>
      <div class="settings-subsection">
        <h3 class="settings-subsection-heading">Legendas — Status e Fila</h3>
        <div class="log-summary" id="log-summary"><p class="ai-inline-msg">Carregando…</p></div>
        <div class="log-queue" id="log-queue"><p class="ai-inline-msg">Carregando…</p></div>
        <div class="settings-actions" style="margin-top: 12px;">
          <button class="btn btn--secondary" id="log-toggle" type="button" aria-expanded="false" aria-controls="log-panel">Ver logs em tempo real</button>
        </div>
        <div class="log-panel" id="log-panel" hidden style="margin-top: 14px;">
          <div class="log-filters" id="log-filters">
            <button type="button" class="log-filter active" data-lvl="ALL">Todos</button>
            <button type="button" class="log-filter" data-lvl="INFO">Info</button>
            <button type="button" class="log-filter" data-lvl="WARN">Avisos</button>
            <button type="button" class="log-filter" data-lvl="ERROR">Erros</button>
            <button type="button" class="log-filter" data-lvl="DEVICE">Dispositivo</button>
            <button type="button" class="log-filter" data-lvl="PROCESS">Processo</button>
          </div>
          <div class="log-view" id="log-view" role="log" aria-live="polite"><p class="ai-inline-msg">Carregando…</p></div>
        </div>
      </div>
    </section>`;
}

async function initSettingsStorage(app) {
  const statusEl = app.querySelector("#storage-status");
  const wsEl = app.querySelector("#workspace-fields");
  const cleanupBtn = app.querySelector("#cleanup-workspace");

  if (cleanupBtn) {
    cleanupBtn.addEventListener("click", () => {
      openConfirmDialog({
        title: "Limpar workspace",
        message:
          "Remove os arquivos temporários de processamento de legendas (áudio e transcrição) do workspace. Progresso e legendas já geradas não são afetados.",
        confirmLabel: "Limpar workspace",
        cancelLabel: "Cancelar",
        danger: false,
        onConfirm: async () => {
          try {
            const r = await fetch("/api/subtitles/workspace/cleanup", { method: "POST" });
            const d = await r.json().catch(() => ({}));
            const note = app.querySelector("#ws-note");
            if (note) note.textContent = `Workspace limpo (${d.removed ?? 0} arquivo(s) removido(s)).`;
            loadStorage();
          } catch (e) {
            const note = app.querySelector("#ws-note");
            if (note) note.textContent = "Erro ao limpar o workspace: " + e.message;
          }
        },
      });
    });
  }

  async function loadStorage() {
    try {
      const [stRes, cfgRes] = await Promise.all([
        fetch("/api/storage/status"),
        fetch("/api/ai/config"),
      ]);
      const st = await stRes.json();
      const cfg = await cfgRes.json();
      const fmt = aiFormatSize;
      const ws = cfg.workspace || { mode: "auto", dir: "" };
      const resolved = st.workspace && st.workspace.dirResolved;

      if (statusEl) {
        statusEl.innerHTML = `
          <div class="storage-grid">
            <div class="storage-item"><span class="storage-value">${fmt(st.appFreeBytes)}</span><span class="storage-label">livres no disco do app</span></div>
            <div class="storage-item"><span class="storage-value">${fmt(st.dataBytes)}</span><span class="storage-label">usados em data/</span></div>
            <div class="storage-item"><span class="storage-value">${fmt(st.transcodeBytes)}</span><span class="storage-label">cache de transcoding</span></div>
            <div class="storage-item"><span class="storage-value">${fmt(st.subtitlesBytes)}</span><span class="storage-label">legendas (data/subtitles)</span></div>
          </div>`;
      }

      if (wsEl) {
        const wsFree = st.workspace && st.workspace.freeBytes != null
          ? ` · ${fmt(st.workspace.freeBytes)} livres`
          : "";
        wsEl.innerHTML = `
          <label class="ai-label ws-mode"><input type="radio" name="ws-mode" value="auto" ${ws.mode !== "custom" ? "checked" : ""}> Automático (temporário do sistema)</label>
          <label class="ai-label ws-mode"><input type="radio" name="ws-mode" value="custom" ${ws.mode === "custom" ? "checked" : ""}> Pasta própria</label>
          <div class="workspace-dir-row">
            <input class="ai-input" id="ws-dir" type="text" placeholder="/caminho/para/workspace" value="${escapeHtml(ws.dir || "")}" ${ws.mode === "custom" ? "" : "disabled"}>
            <button class="btn btn--primary" id="ws-apply" type="button">Aplicar</button>
          </div>
          <p class="ai-note" id="ws-note">${escapeHtml(resolved ? "Diretório: " + resolved + wsFree : "Workspace indisponível")}</p>`;
        bindWorkspaceForm(wsEl, cfg);
      }
    } catch (e) {
      if (statusEl) statusEl.innerHTML = `<p class="ai-inline-msg">Não foi possível carregar o uso de armazenamento.</p>`;
    }
  }

  function bindWorkspaceForm(root) {
    const radios = root.querySelectorAll('input[name="ws-mode"]');
    const dirInput = root.querySelector("#ws-dir");
    const applyBtn = root.querySelector("#ws-apply");
    const note = root.querySelector("#ws-note");
    radios.forEach((r) =>
      r.addEventListener("change", () => {
        const custom = r.value === "custom";
        dirInput.disabled = !custom;
        if (!custom) dirInput.value = "";
      })
    );
    applyBtn.addEventListener("click", async () => {
      const mode = root.querySelector('input[name="ws-mode"]:checked').value;
      const dir = mode === "custom" ? (dirInput.value || "").trim() : "";
      note.textContent = "Salvando…";
      try {
        const r = await fetch("/api/ai/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspace: { mode, dir } }),
        });
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || "configuração rejeitada");
        }
        note.textContent = "Workspace salvo.";
        loadStorage();
      } catch (e) {
        note.textContent = "Erro: " + e.message;
      }
    });
  }

  loadStorage();
}

// Painel de Diagnóstico: status atual da transcrição, fila e logs técnicos
// em memória (GET /api/logs + /api/subtitles/list). Faz polling leve a cada
// 3s enquanto a página de Configurações estiver montada.
let diagPollTimer = null;

async function initSettingsDiagnostics(app) {
  if (diagPollTimer) {
    clearInterval(diagPollTimer);
    diagPollTimer = null;
  }
  // Informações estáticas da instalação.
  const rootEl = app.querySelector("#diag-root");
  if (rootEl) rootEl.textContent = "Biblioteca em disco (RAIZ do app)";
  const serverEl = app.querySelector("#diag-server");
  if (serverEl) serverEl.textContent = `Local Player · ${location.host}`;

  const summaryEl = app.querySelector("#log-summary");
  const queueEl = app.querySelector("#log-queue");
  const viewEl = app.querySelector("#log-view");
  const filtersEl = app.querySelector("#log-filters");
  const panelEl = app.querySelector("#log-panel");
  const toggleEl = app.querySelector("#log-toggle");
  if (!summaryEl || !viewEl) return; // não é a rota de Configurações
  let activeLevel = "ALL";

  // Logs ficam recolhidos por padrão (painel "Ver logs"); abrir dispara o
  // primeiro fetch — o polling de 3s só consulta /api/logs com o painel aberto.
  if (toggleEl && panelEl) {
    toggleEl.addEventListener("click", () => {
      const open = panelEl.hidden;
      panelEl.hidden = !open;
      toggleEl.setAttribute("aria-expanded", String(open));
      toggleEl.textContent = open ? "Ocultar logs" : "Ver logs";
      if (open) refresh();
    });
  }

  if (filtersEl) {
    filtersEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".log-filter");
      if (!btn) return;
      activeLevel = btn.dataset.lvl;
      filtersEl.querySelectorAll(".log-filter").forEach((b) =>
        b.classList.toggle("active", b.dataset.lvl === activeLevel)
      );
      refresh();
    });
  }

  async function refresh() {
    // Auto-cura: se o DOM do Diagnóstico já saiu da página (navegou para outra
    // categoria/rota), encerra o polling em vez de continuar consultando à toa.
    if (!summaryEl.isConnected) {
      clearInterval(diagPollTimer);
      diagPollTimer = null;
      return;
    }
    const logsOpen = !panelEl || !panelEl.hidden;
    const [listRes, logsRes] = await Promise.all([
      fetch("/api/subtitles/list"),
      logsOpen
        ? fetch(`/api/logs?level=${encodeURIComponent(activeLevel)}`)
        : Promise.resolve(null),
    ]);
    const list = await listRes.json().catch(() => null);
    const logs = logsRes ? await logsRes.json().catch(() => null) : null;

    if (list && list.summary) {
      const s = list.summary;
      const waiting = (list.jobs || []).filter((j) => j.status === "waiting-source").length;
      summaryEl.innerHTML = `
        <div class="log-summary-grid">
          <div class="log-summary-item"><span class="log-summary-num">${s.running}</span><span class="log-summary-label">em execução</span></div>
          <div class="log-summary-item"><span class="log-summary-num">${s.queued}</span><span class="log-summary-label">na fila</span></div>
          <div class="log-summary-item"><span class="log-summary-num">${waiting}</span><span class="log-summary-label">aguardando dispositivo</span></div>
          <div class="log-summary-item"><span class="log-summary-num">${s.failed}</span><span class="log-summary-label">com erro</span></div>
          <div class="log-summary-item"><span class="log-summary-num">${s.processed}</span><span class="log-summary-label">legendas prontas</span></div>
        </div>`;
      const queuedJobs = (list.jobs || []).filter(
        (j) => j.status === "queued" || j.status === "waiting-source"
      );
      queueEl.innerHTML = queuedJobs.length
        ? queuedJobs
            .slice(0, 15)
            .map(
              (j) =>
                `<div class="log-queue-item" title="${escapeHtml(j.rel || "")}">${escapeHtml(
                  j.rel || j.hash || ""
                )} <span class="log-queue-state">${j.status === "waiting-source" ? "aguardando dispositivo" : "fila"}</span></div>`
            )
            .join("")
        : `<p class="ai-inline-msg ok">Fila vazia.</p>`;
    } else {
      summaryEl.innerHTML = `<p class="ai-inline-msg error">Falha ao carregar o status.</p>`;
    }

    if (logs && logs.entries) {
      if (!logs.entries.length) {
        viewEl.innerHTML = `<p class="ai-inline-msg">Sem eventos neste filtro.</p>`;
      } else {
        viewEl.innerHTML = logs.entries
          .map((e) => {
            const lvl = (e.level || "INFO").toLowerCase();
            const t = new Date(e.ts).toLocaleTimeString("pt-BR");
            return `<div class="log-line log-${lvl}"><span class="log-time">${t}</span><span class="log-level log-level-${lvl}">${(e.level || "INFO").toUpperCase()}</span><span class="log-msg">${escapeHtml(e.msg)}</span></div>`;
          })
          .join("");
      }
    } else {
      viewEl.innerHTML = `<p class="ai-inline-msg error">Falha ao carregar os logs.</p>`;
    }
  }

  refresh();
  diagPollTimer = setInterval(refresh, 3000);
}

// ---------- Inteligência Artificial (preparação de arquitetura) ----------
// Seção dentro de Configurações. NÃO gera legendas: configura providers de
// transcrição (ASR) e de correção (LLM opcional). Os dados vêm de /api/ai/*;
// chaves de API nunca chegam ao navegador (só hasApiKey).

const AI_TABS = [
  {
    id: "overview",
    label: "Visão Geral",
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`,
  },
  {
    id: "tutor",
    label: "Tutor IA",
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
  },
  {
    id: "skills",
    label: "Skills",
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`,
  },
  {
    id: "transcription",
    label: "Transcrição",
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
  },
  {
    id: "correction",
    label: "Correção & Tradução",
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`,
  },
  {
    id: "providers",
    label: "Provedores LLM",
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,
  },
  {
    id: "models",
    label: "Modelos",
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="21 8 21 21 3 21 3 8"></polyline><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`,
  },
  {
    id: "advanced",
    label: "Avançado",
    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  },
];

let aiState = {
  config: null,
  status: null,
  subtitles: null, // resumo do pipeline de legendas (processed/queued/failed)
  tab: "overview",
  loading: true,
  error: "",
  saved: "",
  testingId: null,
  editingProviderId: null,
  form: null,
};

// Whisper configurado (enabled + provider + binário + modelo)? Preenchido no
// loadAll via /api/ai/status. Quando falso, os controles de geração de legenda
// ("Gerar legendas" e o botão CC do player) são ocultados.
let subtitleGenerateEnabled = false;

function renderAiSection() {
  return `
    <section class="settings-card ai-section">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.4 6.8L21 11l-6.6 2.2L12 20l-2.4-6.8L3 11l6.6-2.2z"></path></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Central de Inteligência Artificial</h2>
            <p class="settings-section-desc">Gerencie transcrição local (Whisper), Tutor IA, skills de otimização e conexões com modelos locais ou em nuvem.</p>
          </div>
        </div>
      </div>
      <div class="ai-tabs" role="tablist" aria-label="Inteligência Artificial">
        ${AI_TABS.map((t) => `
          <button type="button" class="ai-tab ${aiState.tab === t.id ? "active" : ""}"
                  data-ai-tab="${t.id}" role="tab" aria-selected="${aiState.tab === t.id}">
            <span style="display: flex; align-items: center; gap: 6px;">
              ${t.icon || ""}
              <span>${escapeHtml(t.label)}</span>
            </span>
          </button>`).join("")}
      </div>
      <div class="ai-panel" id="ai-panel"></div>
    </section>`;
}

async function loadAiData() {
  const [configRes, statusRes, subsRes] = await Promise.all([
    fetch("/api/ai/config"),
    fetch("/api/ai/status"),
    fetch("/api/subtitles/list").catch(() => null),
  ]);
  if (!configRes.ok || !statusRes.ok) throw new Error("ai load failed");
  aiState.config = await configRes.json();
  aiState.status = await statusRes.json();
  aiState.subtitles = subsRes && subsRes.ok
    ? (await subsRes.json()).summary || null
    : null;
}

function bindAiSection(app) {
  const panel = document.getElementById("ai-panel");
  app.querySelectorAll(".ai-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      aiState.tab = btn.dataset.aiTab;
      app.querySelectorAll(".ai-tab").forEach((b) => {
        const on = b.dataset.aiTab === aiState.tab;
        b.classList.toggle("active", on);
        b.setAttribute("aria-selected", String(on));
      });
      renderAiPanelInto(panel);
    });
  });
  renderAiPanelInto(panel);
  loadAiData()
    .then(() => { aiState.loading = false; renderAiPanelInto(panel); })
    .catch(() => {
      aiState.loading = false;
      aiState.error = "Não foi possível carregar as configurações de IA.";
      renderAiPanelInto(panel);
    });
}

function renderAiPanelInto(panel) {
  if (aiState.loading && !aiState.config) {
    panel.innerHTML = `<p class="ai-note">Carregando…</p>`;
    return;
  }
  if (aiState.error && !aiState.config) {
    panel.innerHTML = `<p class="ai-inline-msg error">${escapeHtml(aiState.error)}</p>`;
    return;
  }
  let html;
  try {
    html = renderAiPanel();
  } catch (err) {
    // Uma aba quebrada nunca deve deixar conteúdo desatualizado ou quebrar a
    // página de Configurações: mostra o erro no próprio painel.
    console.error("[AI] erro ao renderizar aba:", aiState.tab, err);
    panel.innerHTML = `<p class="ai-inline-msg error">Erro ao renderizar esta aba: ${escapeHtml((err && err.message) || "erro desconhecido")}</p>`;
    return;
  }
  panel.innerHTML = html;
  bindAiPanel(panel);
}

function renderAiPanel() {
  switch (aiState.tab) {
    case "tutor": return renderAiTutor();
    case "skills": return renderAiSkills();
    case "transcription": return renderAiTranscription();
    case "correction": return renderAiCorrection();
    case "providers": return renderAiProviders();
    case "models": return renderAiModels();
    case "advanced": return renderAiAdvanced();
    default: return renderAiOverview();
  }
}
function bindAiPanel(panel) {
  switch (aiState.tab) {
    case "tutor": return bindAiTutor(panel);
    case "skills": return bindAiSkills(panel);
    case "transcription": return bindAiTranscription(panel);
    case "correction": return bindAiCorrection(panel);
    case "providers": return bindAiProviders(panel);
    case "models": return bindAiModels(panel);
    case "advanced": return bindAiAdvanced(panel);
    default: return bindAiOverview(panel);
  }
}

async function saveAiPatch(patch) {
  const res = await fetch("/api/ai/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Erro ao salvar.");
  aiState.config = data;
  aiState.status = await (await fetch("/api/ai/status")).json();
  return data;
}

function aiMsg(id, type, text) {
  const el = document.getElementById(id);
  if (el) {
    el.className = `ai-inline-msg ${type}`;
    el.textContent = text;
    el.hidden = false;
  }
}

function aiTranscriptionProvider(id) {
  return (aiState.status?.transcription?.providers || []).find((p) => p.id === id) || null;
}
function aiLlmProvider(id) {
  return (aiState.config?.llm?.providers || []).find((p) => p.id === id) || null;
}

function renderAiOverview() {
  const cfg = aiState.config;
  const tr = aiState.status?.transcription?.configured || null;
  const trProvider = aiTranscriptionProvider(cfg?.transcription?.provider);
  const trModel = cfg?.transcription?.model || "";
  const trInstalled = !!(tr && tr.available && tr.modelInstalled);
  const trDot = trInstalled ? "ok" : (tr && tr.available ? "warn" : "off");
  const trSub = trInstalled
    ? "Disponível" + (trModel ? ` · ${trModel}` : "")
    : (tr && tr.available
      ? "Modelo não instalado (veja a aba Modelos)"
      : "Não instalado");
  const co = cfg?.correction || {};
  const coProvider = aiLlmProvider(co.providerId);
  const coConfigured = co.enabled && coProvider && coProvider.baseUrl;
  const coDot = coConfigured ? "ok" : (coProvider ? "warn" : "off");
  const coSub = coProvider
    ? (co.enabled ? "Ativa" : "Desativada")
      + ` · ${escapeHtml(coProvider.name)}`
      + (co.model ? ` · ${escapeHtml(co.model)}` : "")
    : "Nenhum provedor de LLM configurado";
  // Resumo do pipeline de legendas (processados / em fila / com erro).
  const s = aiState.subtitles;
  const stat = (n, label, cls) =>
    `<span class="ai-stat"><b class="${cls}">${n ?? "—"}</b> ${label}</span>`;
  return `
    <div class="ai-status-grid">
      <div class="ai-status-card">
        <div class="ai-status-head">
          <span class="ai-status-dot ${trDot}"></span>
          <span class="ai-status-title">Transcrição local</span>
        </div>
        <p class="ai-status-sub">${trSub}</p>
        <p class="ai-status-desc">Converte áudio em texto com timestamps, 100% offline.</p>
      </div>
      <div class="ai-status-card">
        <div class="ai-status-head">
          <span class="ai-status-dot ${coDot}"></span>
          <span class="ai-status-title">Correção por IA</span>
        </div>
        <p class="ai-status-sub">${coSub}</p>
        <p class="ai-status-desc">Etapa opcional que melhora pontuação e legibilidade sem alterar o conteúdo falado.</p>
      </div>
    </div>
    <div class="ai-pipeline-stats">
      ${stat(s ? s.processed : null, "vídeos processados", "ok")}
      ${stat(s ? s.queued : null, "em fila", "warn")}
      ${stat(s ? s.failed : null, "com erro", "err")}
    </div>
    <p class="ai-note">As legendas são geradas localmente e funcionam sem internet. Os provedores de LLM são opcionais e nunca recebem o conteúdo do seu curso além da própria transcrição.</p>`;
}
function bindAiOverview() {}

function renderAiTranscription() {
  const cfg = aiState.config;
  const provs = aiState.status?.transcription?.providers || [];
  const prov = aiTranscriptionProvider(cfg.transcription.provider);
  const avail = !!(prov && prov.available);
  const modelOptions = (prov ? prov.models : []).map((m) =>
    `<option value="${m.id}" ${m.id === cfg.transcription.model ? "selected" : ""}>${escapeHtml(m.name)}${m.installed ? " ✓" : " — não instalado"}</option>`).join("");
  const langOptions = (prov ? prov.languages : []).map((l) =>
    `<option value="${l.id}" ${l.id === cfg.transcription.language ? "selected" : ""}>${escapeHtml(l.name)}</option>`).join("");
  const sub = aiState.subtitles;
  const trStat = (n, label, cls) =>
    `<span class="ai-stat"><b class="${cls}">${n ?? "—"}</b> ${label}</span>`;
  return `
    <div class="ai-field ai-tr-summary">
      <div class="ai-tr-summary-head">
        <span class="ai-label">Legendas no pipeline</span>
        <a class="ai-tr-summary-link" href="#/settings/diagnostico">Ver fila e logs →</a>
      </div>
      <div class="ai-pipeline-stats">
        ${trStat(sub ? sub.processed : null, "prontas", "ok")}
        ${trStat(sub ? sub.queued : null, "em fila", "warn")}
        ${trStat(sub ? sub.running : null, "gerando", "warn")}
        ${trStat(sub ? sub.failed : null, "com erro", "err")}
      </div>
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-tr-provider">Provedor de transcrição</label>
      <select class="ai-select" id="ai-tr-provider">
        ${provs.map((p) => `<option value="${p.id}" ${p.id === cfg.transcription.provider ? "selected" : ""}>${escapeHtml(p.name)}${p.available ? "" : " — não instalado"}</option>`).join("")}
      </select>
      ${avail ? "" : `<p class="ai-note">O binário deste provedor não foi encontrado em <code>bin/</code>. Veja a aba Modelos.</p>`}
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-tr-model">Modelo</label>
      <select class="ai-select" id="ai-tr-model">${modelOptions || '<option value="">—</option>'}</select>
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-tr-language">Idioma</label>
      <select class="ai-select" id="ai-tr-language">${langOptions || '<option value="">—</option>'}</select>
    </div>
    <div class="ai-field ai-field-switch">
      <button class="switch ${cfg.transcription.enabled ? "on" : ""}" id="ai-tr-enabled" type="button" role="switch" aria-checked="${cfg.transcription.enabled}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <label class="ai-label" for="ai-tr-enabled">Transcrição por IA habilitada</label>
    </div>
    <div class="ai-field">
      <span class="ai-label">Quando gerar legendas</span>
      <div class="ai-radio-row">
        <label class="ai-radio">
          <input type="radio" name="ai-tr-mode" value="auto" ${cfg.transcription.generateMode === "auto" ? "checked" : ""}>
          <span>Gerar automaticamente</span>
        </label>
        <label class="ai-radio">
          <input type="radio" name="ai-tr-mode" value="manual" ${cfg.transcription.generateMode === "manual" ? "checked" : ""}>
          <span>Gerar somente quando solicitado</span>
        </label>
      </div>
    </div>
    <div class="ai-field ai-field-switch">
      <button class="switch ${cfg.transcription.pregenFirstLesson !== false ? "on" : ""}" id="ai-tr-pregen-first" type="button" role="switch" aria-checked="${cfg.transcription.pregenFirstLesson !== false}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="ai-tr-pregen-first">Pré-gerar a primeira aula de cada curso</label>
        <p class="ai-field-desc">Após escanear a biblioteca, enfileira a primeira aula de cada curso (prioridade baixa) para que já tenha legenda ao chegar.</p>
      </div>
    </div>
    <div class="ai-field ai-field-switch">
      <button class="switch ${cfg.transcription.pregenNextLesson !== false ? "on" : ""}" id="ai-tr-pregen-next" type="button" role="switch" aria-checked="${cfg.transcription.pregenNextLesson !== false}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="ai-tr-pregen-next">Preparar a próxima aula</label>
        <p class="ai-field-desc">Ao abrir uma aula, enfileira a legenda da próxima aula da fila (prioridade alta) enquanto a atual já tem legenda ou está gerando.</p>
      </div>
    </div>
    <div class="ai-field ai-field-switch">
      <button class="switch ${cfg.transcription.background === true ? "on" : ""}" id="ai-tr-background" type="button" role="switch" aria-checked="${cfg.transcription.background === true}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="ai-tr-background">Gerar legendas em segundo plano</label>
        <p class="ai-field-desc">Com a fila vazia, enfileira um lote de vídeos sem legenda (prioridade mais baixa). <strong>Desligado por padrão</strong> — nunca gera a biblioteca inteira de uma vez.</p>
      </div>
    </div>
    <div class="settings-actions">
      <button class="btn btn--secondary" id="ai-tr-check" type="button">Verificar instalação</button>
      <button class="btn btn--primary" id="ai-tr-save" type="button">Salvar</button>
    </div>
    <p class="ai-note">Quando "Gerar automaticamente" está ativo, as legendas são geradas em segundo plano ao abrir uma aula (nunca bloqueiam a reprodução). Sem binário/modelo instalado, o status fica "Legenda indisponível" — veja as abas Modelos e Avançado.</p>
    <p class="ai-inline-msg ok" id="ai-tr-msg" hidden></p>`;
}
function bindAiTranscription(panel) {
  const cfg = aiState.config;
  const providerEl = document.getElementById("ai-tr-provider");
  if (providerEl) {
    providerEl.addEventListener("change", () => {
      const prov = aiTranscriptionProvider(providerEl.value);
      cfg.transcription.provider = providerEl.value;
      cfg.transcription.model = prov && prov.models.length ? prov.models[0].id : "";
      cfg.transcription.language = prov && prov.languages.length ? prov.languages[0].id : "";
      renderAiPanelInto(panel);
    });
  }
  const modelEl = document.getElementById("ai-tr-model");
  if (modelEl) modelEl.addEventListener("change", () => { cfg.transcription.model = modelEl.value; });
  const langEl = document.getElementById("ai-tr-language");
  if (langEl) langEl.addEventListener("change", () => { cfg.transcription.language = langEl.value; });
  const sw = document.getElementById("ai-tr-enabled");
  if (sw) {
    sw.addEventListener("click", () => {
      cfg.transcription.enabled = !cfg.transcription.enabled;
      sw.classList.toggle("on", cfg.transcription.enabled);
      sw.setAttribute("aria-checked", String(cfg.transcription.enabled));
    });
  }
  document.querySelectorAll('input[name="ai-tr-mode"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) cfg.transcription.generateMode = r.value;
    });
  });
  const bindSwitch = (id, key, defaultOn) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", () => {
      const current = cfg.transcription[key] !== undefined
        ? cfg.transcription[key]
        : defaultOn;
      cfg.transcription[key] = !current;
      el.classList.toggle("on", cfg.transcription[key]);
      el.setAttribute("aria-checked", String(cfg.transcription[key]));
    });
  };
  bindSwitch("ai-tr-pregen-first", "pregenFirstLesson", true);
  bindSwitch("ai-tr-pregen-next", "pregenNextLesson", true);
  bindSwitch("ai-tr-background", "background", false);
  const save = document.getElementById("ai-tr-save");
  if (save) {
    save.addEventListener("click", async () => {
      try {
        await saveAiPatch({ transcription: cfg.transcription });
        aiMsg("ai-tr-msg", "ok", "Configurações de transcrição salvas.");
      } catch (err) {
        aiMsg("ai-tr-msg", "error", err.message);
      }
    });
  }
  const check = document.getElementById("ai-tr-check");
  if (check) {
    check.addEventListener("click", async () => {
      aiState.status = await (await fetch("/api/ai/status")).json();
      renderAiPanelInto(panel);
    });
  }
}

function aiGoToTab(tab) {
  aiState.tab = tab;
  document.querySelectorAll(".ai-tab").forEach((b) => {
    const on = b.dataset.aiTab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  const panel = document.getElementById("ai-panel");
  if (panel) renderAiPanelInto(panel);
}

function renderAiCorrection() {
  const co = aiState.config.correction;
  const tr = aiState.config.translation || { enabled: false, targetLanguage: "pt", keepTerms: true };
  const pp = aiState.config.postprocessing || { capitalize: true, segment: true, technicalDictionary: false };
  const providers = aiState.config.llm.providers || [];
  const trLangList =
    (aiState.status?.transcription?.providers || []).find((p) => p.id === "whisper")?.languages ||
    Object.keys(SUBTITLE_LANG_NAMES).map((id) => ({ id, name: SUBTITLE_LANG_NAMES[id] }));
  const trLangOptions = trLangList
    .map((l) => `<option value="${l.id}" ${l.id === tr.targetLanguage ? "selected" : ""}>${escapeHtml(l.name)}</option>`)
    .join("");
  const ppSwitch = (id, label, on, desc) => `
    <div class="ai-field ai-field-switch">
      <button class="switch ${on ? "on" : ""}" id="${id}" type="button" role="switch" aria-checked="${on}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="${id}">${label}</label>
        <p class="ai-field-desc">${desc}</p>
      </div>
    </div>`;
  const llmBlock = providers.length ? `
    <h4 class="ai-block-title">Correção por LLM <span class="ai-block-tag">opcional</span></h4>
    <div class="ai-field ai-field-switch">
      <button class="switch ${co.enabled ? "on" : ""}" id="ai-co-enabled" type="button" role="switch" aria-checked="${co.enabled}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="ai-co-enabled">Corrigir e formatar legendas com um modelo de linguagem</label>
      </div>
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-co-provider">Provedor de correção</label>
      <select class="ai-select" id="ai-co-provider">
        ${providers.map((p) => `<option value="${p.id}" ${p.id === co.providerId ? "selected" : ""}>${escapeHtml(p.name)}${p.baseUrl ? "" : " — sem URL"}</option>`).join("")}
      </select>
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-co-model">Modelo</label>
      <input class="ai-input" id="ai-co-model" type="text" value="${escapeHtml(co.model)}" placeholder="ex.: gpt-4o-mini, llama-3.1-8b, claude-…">
    </div>
    <hr class="ai-sep">
    <h4 class="ai-block-title">Tradução de legendas <span class="ai-block-tag">opcional</span></h4>
    <div class="ai-field ai-field-switch">
      <button class="switch ${tr.enabled ? "on" : ""}" id="ai-tr-tr-enabled" type="button" role="switch" aria-checked="${tr.enabled}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="ai-tr-tr-enabled">Traduzir legendas para outro idioma</label>
        <p class="ai-field-desc">Uma aula em outro idioma (ex. inglês) ganha legenda traduzida sob demanda, selecionável no menu de legendas do player. Reusa o LLM da correção — a transcrição original nunca é alterada.</p>
      </div>
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-tr-tr-lang">Idioma da legenda traduzida</label>
      <select class="ai-select" id="ai-tr-tr-lang">${trLangOptions || '<option value="pt">Português</option>'}</select>
    </div>
    <div class="ai-field ai-field-switch">
      <button class="switch ${tr.keepTerms ? "on" : ""}" id="ai-tr-tr-terms" type="button" role="switch" aria-checked="${tr.keepTerms}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="ai-tr-tr-terms">Preservar termos da língua original</label>
        <p class="ai-field-desc">Mantém termos técnicos, código, marcas e siglas sem traduzir.</p>
      </div>
    </div>
    <p class="ai-note">Sem LLM configurado, apenas a legenda original (língua do áudio) é exibida.</p>
    <p class="ai-note"><strong>A correção por LLM é opcional. A transcrição original é preservada.</strong> O guarda-raio aceita apenas a melhoria de pontuação e legibilidade: nunca altera o conteúdo falado, não traduz, não resume, não inventa e não mexe nos timestamps.</p>
  ` : `
    <h4 class="ai-block-title">Correção por LLM <span class="ai-block-tag">opcional</span></h4>
    <p class="ai-empty">Nenhum provedor de LLM configurado.</p>
    <p class="ai-note">As legendas ainda são geradas usando somente a transcrição local. Para habilitar a correção opcional, configure um provedor na aba <strong>Provedores LLM</strong>.</p>
    <div class="settings-actions">
      <button class="btn btn--secondary" id="ai-co-goto-providers" type="button">Ir para Provedores LLM</button>
    </div>`;
  return `
    <h4 class="ai-block-title">Pós-processamento determinístico <span class="ai-block-tag">sempre ativo</span></h4>
    <p class="ai-note">Aplicado localmente a toda legenda gerada, sem rede. A transcrição bruta do ASR é sempre preservada em disco.</p>
    ${ppSwitch("ai-pp-capitalize", "Capitalização de frases", pp.capitalize, "Inicia cada bloco com maiúscula e normaliza pontuação.")}
    ${ppSwitch("ai-pp-segment", "Segmentação", pp.segment, "Divide blocos longos e evita cortes no meio de palavras.")}
    ${ppSwitch("ai-pp-dict", "Dicionário técnico", pp.technicalDictionary, "Preserva termos técnicos (PostgreSQL, APIs, frameworks…).")}
    <hr class="ai-sep">
    ${llmBlock}
    <div class="settings-actions">
      <button class="btn btn--primary" id="ai-co-save" type="button">Salvar</button>
    </div>
    <p class="ai-inline-msg ok" id="ai-co-msg" hidden></p>`;
}
function bindAiCorrection(panel) {
  const cfg = aiState.config;
  const gotoBtn = document.getElementById("ai-co-goto-providers");
  if (gotoBtn) gotoBtn.addEventListener("click", () => aiGoToTab("providers"));
  const sw = document.getElementById("ai-co-enabled");
  if (sw) {
    sw.addEventListener("click", () => {
      cfg.correction.enabled = !cfg.correction.enabled;
      sw.classList.toggle("on", cfg.correction.enabled);
      sw.setAttribute("aria-checked", String(cfg.correction.enabled));
    });
  }
  const provEl = document.getElementById("ai-co-provider");
  if (provEl) provEl.addEventListener("change", () => { cfg.correction.providerId = provEl.value; });
  const modelEl = document.getElementById("ai-co-model");
  if (modelEl) modelEl.addEventListener("input", () => { cfg.correction.model = modelEl.value; });
  // Tradução de legendas (mesmo LLM da correção).
  const trEnabled = document.getElementById("ai-tr-tr-enabled");
  if (trEnabled) {
    trEnabled.addEventListener("click", () => {
      cfg.translation.enabled = !cfg.translation.enabled;
      trEnabled.classList.toggle("on", cfg.translation.enabled);
      trEnabled.setAttribute("aria-checked", String(cfg.translation.enabled));
    });
  }
  const trLang = document.getElementById("ai-tr-tr-lang");
  if (trLang) trLang.addEventListener("change", () => { cfg.translation.targetLanguage = trLang.value; });
  const trTerms = document.getElementById("ai-tr-tr-terms");
  if (trTerms) {
    trTerms.addEventListener("click", () => {
      cfg.translation.keepTerms = !cfg.translation.keepTerms;
      trTerms.classList.toggle("on", cfg.translation.keepTerms);
      trTerms.setAttribute("aria-checked", String(cfg.translation.keepTerms));
    });
  }
  // Switches de pós-processamento determinístico.
  const ppBind = (id, key) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("click", () => {
        cfg.postprocessing[key] = !cfg.postprocessing[key];
        el.classList.toggle("on", cfg.postprocessing[key]);
        el.setAttribute("aria-checked", String(cfg.postprocessing[key]));
      });
    }
  };
  ppBind("ai-pp-capitalize", "capitalize");
  ppBind("ai-pp-segment", "segment");
  ppBind("ai-pp-dict", "technicalDictionary");
  const save = document.getElementById("ai-co-save");
  if (save) {
    save.addEventListener("click", async () => {
      try {
        await saveAiPatch({
          correction: cfg.correction,
          translation: cfg.translation,
          postprocessing: cfg.postprocessing,
        });
        aiMsg("ai-co-msg", "ok", "Configurações de correção salvas.");
      } catch (err) {
        aiMsg("ai-co-msg", "error", err.message);
      }
    });
  }
}

function renderAiTutor() {
  const tu = aiState.config.tutor || {
    enabled: true,
    providerId: "",
    model: "",
    temperature: 0.3,
    systemPrompt: "",
    includeTranscription: true,
    includeMaterials: true,
  };
  const providers = aiState.config.llm.providers || [];
  const selProvider = providers.find((p) => p.id === tu.providerId) || providers[0] || null;
  const isLocalProvider = selProvider && selProvider.baseUrl && (
    selProvider.baseUrl.includes("127.0.0.1") ||
    selProvider.baseUrl.includes("localhost") ||
    selProvider.baseUrl.includes(":11434") ||
    selProvider.baseUrl.includes(":1234") ||
    selProvider.baseUrl.includes(":8080")
  );

  const tuSwitch = (id, label, on, desc) => `
    <div class="ai-field ai-field-switch">
      <button class="switch ${on ? "on" : ""}" id="${id}" type="button" role="switch" aria-checked="${on}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="${id}">${label}</label>
        ${desc ? `<p class="ai-field-desc">${desc}</p>` : ""}
      </div>
    </div>`;

  const llmBlock = providers.length ? `
    <div class="ai-field">
      <label class="ai-label" for="ai-tu-provider">Provedor LLM para o Tutor</label>
      <select class="ai-select" id="ai-tu-provider">
        <option value="" ${!tu.providerId ? "selected" : ""}>Padrão (primeiro configurado)</option>
        ${providers.map((p) => `<option value="${p.id}" ${p.id === tu.providerId ? "selected" : ""}>${escapeHtml(p.name)}${p.defaultModel ? ` (${escapeHtml(p.defaultModel)})` : ""}</option>`).join("")}
      </select>
      ${isLocalProvider ? `
        <div style="margin-top: 8px; padding: 8px 12px; background: rgba(51, 201, 111, 0.08); border: 1px solid rgba(51, 201, 111, 0.25); border-radius: 8px; font-size: 12px; color: #86efac; display: flex; align-items: center; gap: 6px;">
          <span>⚡</span>
          <span><strong>Modelo Local ativo (${escapeHtml(selProvider.name)}):</strong> Processamento 100% offline, seguro e sem custos por token.</span>
        </div>
      ` : ""}
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-tu-model">Modelo (opcional se definido no provedor)</label>
      <input class="ai-input" id="ai-tu-model" type="text" value="${escapeHtml(tu.model || "")}" placeholder="ex.: llama3.2, qwen2.5-coder, gpt-4o-mini…">
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-tu-temp">Temperatura / Criatividade: <span id="ai-tu-temp-val">${Number(tu.temperature || 0.3).toFixed(1)}</span></label>
      <input class="ai-range" id="ai-tu-temp" type="range" min="0" max="1" step="0.1" value="${tu.temperature !== undefined ? tu.temperature : 0.3}">
      <p class="ai-field-desc">Valores menores (ex.: 0.2 - 0.4) geram respostas mais didáticas, precisas e fiéis ao conteúdo da aula.</p>
    </div>
  ` : `
    <p class="ai-empty">Nenhum provedor de LLM configurado.</p>
    <p class="ai-note">Para usar o Tutor IA, cadastre um provedor local (Ollama, LM Studio) ou em nuvem (OpenRouter, OpenAI) na aba <strong>Provedores LLM</strong>.</p>
    <div class="settings-actions">
      <button class="btn btn--secondary" id="ai-tu-goto-providers" type="button">Ir para Provedores LLM</button>
    </div>`;

  return `
    <h4 class="ai-block-title">Tutor IA Integrado ao Player</h4>
    <p class="ai-note">Assistente pedagógico contextualizado com o conteúdo da aula atual (transcrição, materiais e notas). Permite tirar dúvidas e interagir diretamente dentro do player.</p>
    ${tuSwitch("ai-tu-enabled", "Ativar botão ✨ Tutor IA no player de aulas", tu.enabled !== false, "Quando ativado, o botão do Tutor IA fica acessível na barra de controle e nas opções da aula.")}
    <hr class="ai-sep">
    <h4 class="ai-block-title">Configurações do Modelo</h4>
    ${llmBlock}
    <hr class="ai-sep">
    <h4 class="ai-block-title">Contexto Automático da Aula</h4>
    ${tuSwitch("ai-tu-inc-trans", "Incluir transcrição completa da aula no contexto", tu.includeTranscription !== false, "Envia as falas transcritas pelo Whisper como fonte primária para as respostas.")}
    ${tuSwitch("ai-tu-inc-mat", "Incluir documentos e materiais de apoio no contexto", tu.includeMaterials !== false, "Lê e inclui resumos de arquivos de texto (.txt, .md, códigos) e documentos PDF associados à aula.")}
    <hr class="ai-sep">
    <h4 class="ai-block-title">Prompt do Sistema (Opcional)</h4>
    <div class="ai-field">
      <label class="ai-label" for="ai-tu-prompt">Instruções personalizadas para o Tutor</label>
      <textarea class="ai-textarea" id="ai-tu-prompt" rows="4" placeholder="Deixe em branco para usar as diretrizes pedagógicas padrão com proteção anti-injeção.">${escapeHtml(tu.systemPrompt || "")}</textarea>
    </div>
    <div class="settings-actions">
      <button class="btn btn--primary" id="ai-tu-save" type="button">Salvar</button>
      <button class="btn btn--secondary" id="ai-tu-reset-prompt" type="button">Restaurar prompt padrão</button>
    </div>
    <p class="ai-inline-msg ok" id="ai-tu-msg" hidden></p>`;
}

function bindAiTutor(panel) {
  const cfg = aiState.config;
  const tu = cfg.tutor = cfg.tutor || {
    enabled: true,
    providerId: "",
    model: "",
    temperature: 0.3,
    systemPrompt: "",
    includeTranscription: true,
    includeMaterials: true,
  };

  const gotoBtn = document.getElementById("ai-tu-goto-providers");
  if (gotoBtn) gotoBtn.addEventListener("click", () => aiGoToTab("providers"));

  const swEnabled = document.getElementById("ai-tu-enabled");
  if (swEnabled) {
    swEnabled.addEventListener("click", () => {
      tu.enabled = !tu.enabled;
      swEnabled.classList.toggle("on", tu.enabled);
      swEnabled.setAttribute("aria-checked", String(tu.enabled));
    });
  }

  const swTrans = document.getElementById("ai-tu-inc-trans");
  if (swTrans) {
    swTrans.addEventListener("click", () => {
      tu.includeTranscription = !tu.includeTranscription;
      swTrans.classList.toggle("on", tu.includeTranscription);
      swTrans.setAttribute("aria-checked", String(tu.includeTranscription));
    });
  }

  const swMat = document.getElementById("ai-tu-inc-mat");
  if (swMat) {
    swMat.addEventListener("click", () => {
      tu.includeMaterials = !tu.includeMaterials;
      swMat.classList.toggle("on", tu.includeMaterials);
      swMat.setAttribute("aria-checked", String(tu.includeMaterials));
    });
  }

  const tempInput = document.getElementById("ai-tu-temp");
  const tempVal = document.getElementById("ai-tu-temp-val");
  if (tempInput && tempVal) {
    tempInput.addEventListener("input", () => {
      tu.temperature = Number(tempInput.value) || 0.3;
      tempVal.textContent = tu.temperature.toFixed(1);
    });
  }

  const resetPromptBtn = document.getElementById("ai-tu-reset-prompt");
  const promptInput = document.getElementById("ai-tu-prompt");
  if (resetPromptBtn && promptInput) {
    resetPromptBtn.addEventListener("click", () => {
      promptInput.value = "";
      tu.systemPrompt = "";
    });
  }

  const saveBtn = document.getElementById("ai-tu-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const provSel = document.getElementById("ai-tu-provider");
      if (provSel) tu.providerId = provSel.value;
      const modelIn = document.getElementById("ai-tu-model");
      if (modelIn) tu.model = modelIn.value.trim();
      if (promptInput) tu.systemPrompt = promptInput.value;

      try {
        await saveAiPatch({ tutor: tu });
        aiMsg("ai-tu-msg", "ok", "Configurações do Tutor IA salvas com sucesso.");
      } catch (err) {
        aiMsg("ai-tu-msg", "error", err.message);
      }
    });
  }
}

function renderAiSkills() {
  const cfg = aiState.config;
  const sk = cfg.skills = cfg.skills || {
    caveman: { enabled: false, mode: "caveman", preserveCode: true, customInstructions: "", applyToTutor: true },
    rtk: { enabled: false, stripBoilerplate: true, filterLogs: true, maxLinesPerSnippet: 60, applyToMaterials: true },
    headroom: { enabled: false, compressCode: true, compressJson: true, alignCache: true, applyToContext: true },
  };
  const cv = sk.caveman || {};
  const rtk = sk.rtk || {};
  const hr = sk.headroom || {};

  const skSwitch = (id, label, on, desc) => `
    <div class="ai-field ai-field-switch">
      <button class="switch ${on ? "on" : ""}" id="${id}" type="button" role="switch" aria-checked="${on}">
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="${id}">${label}</label>
        ${desc ? `<p class="ai-field-desc">${desc}</p>` : ""}
      </div>
    </div>`;

  return `
    <h4 class="ai-block-title">Skills & Otimizadores de Contexto / Tokens</h4>
    <p class="ai-note">Otimizações e extensões inspiradas nos projetos de código aberto <strong>Caveman</strong>, <strong>RTK</strong> e <strong>Headroom</strong> para reduzir custos de tokens, eliminar ruídos e maximizar a eficiência dos modelos de IA.</p>

    <!-- Skill 1: Caveman -->
    <div class="ai-field" style="margin-top: 16px;">
      <h4 class="ai-block-title">
        <span>🦴 Caveman</span>
        <span class="ai-block-tag">Token Reducer</span>
        <a href="https://github.com/juliusbrussee/caveman" target="_blank" rel="noopener noreferrer" class="ai-tr-summary-link" style="margin-left: auto; font-size: 11px;">GitHub ↗</a>
      </h4>
      <p class="ai-field-desc" style="margin-bottom: 8px;">Corta enrolações, preâmbulos e cortesias das respostas da IA para economizar até 60–75% de tokens, mantendo termos técnicos e códigos 100% exatos.</p>
      ${skSwitch("ai-sk-cv-enabled", "Habilitar Skill Caveman", cv.enabled === true, "Aplica diretivas de resposta ultra-concisa nas interações com o Tutor IA.")}

      <div class="ai-field" style="margin-top: 8px;">
        <span class="ai-label">Modo de Concisão</span>
        <div class="ai-radio-row">
          <label class="ai-radio">
            <input type="radio" name="ai-sk-cv-mode" value="caveman" ${cv.mode === "caveman" || !cv.mode ? "checked" : ""}>
            <span>Caveman (Ultra-econômico)</span>
          </label>
          <label class="ai-radio">
            <input type="radio" name="ai-sk-cv-mode" value="concise" ${cv.mode === "concise" ? "checked" : ""}>
            <span>Conciso (Didático / Tópicos)</span>
          </label>
          <label class="ai-radio">
            <input type="radio" name="ai-sk-cv-mode" value="custom" ${cv.mode === "custom" ? "checked" : ""}>
            <span>Personalizado</span>
          </label>
        </div>
      </div>

      <div class="ai-field" id="ai-sk-cv-custom-wrap" ${cv.mode === "custom" ? "" : "hidden"}>
        <label class="ai-label" for="ai-sk-cv-custom-input">Instruções personalizadas de concisão</label>
        <textarea class="ai-textarea" id="ai-sk-cv-custom-input" rows="2" placeholder="Ex: Responda em bullet points curtos, sem saudações...">${escapeHtml(cv.customInstructions || "")}</textarea>
      </div>

      ${skSwitch("ai-sk-cv-code", "Preservar códigos e comandos exatos", cv.preserveCode !== false, "Garante que exemplos de código, comandos e sintaxe não sofram cortes ou alterações.")}
      ${skSwitch("ai-sk-cv-tutor", "Aplicar nas conversas do Tutor IA", cv.applyToTutor !== false, "Injeta automaticamente as regras de concisão no prompt de sistema do chat.")}
    </div>

    <hr class="ai-sep">

    <!-- Skill 2: RTK -->
    <div class="ai-field">
      <h4 class="ai-block-title">
        <span>⚡ RTK (Rust Token Killer)</span>
        <span class="ai-block-tag">Noise Filter</span>
        <a href="https://github.com/rtk-ai/rtk" target="_blank" rel="noopener noreferrer" class="ai-tr-summary-link" style="margin-left: auto; font-size: 11px;">GitHub ↗</a>
      </h4>
      <p class="ai-field-desc" style="margin-bottom: 8px;">Filtra ruídos de logs de terminal, divisores repetitivos e traces longos em materiais anexados às aulas, economizando 60–90% de contexto.</p>
      ${skSwitch("ai-sk-rtk-enabled", "Habilitar Skill RTK", rtk.enabled === true, "Ativa a filtragem de ruídos em arquivos e materiais didáticos antes do envio ao LLM.")}
      ${skSwitch("ai-sk-rtk-boilerplate", "Remover divisores e boilerplates repetitivos", rtk.stripBoilerplate !== false, "Elimina linhas consecutivas de separadores (====, ----, ####) e cabeçalhos redundantes.")}
      ${skSwitch("ai-sk-rtk-logs", "Filtrar saídas de logs e stacktraces excessivos", rtk.filterLogs !== false, "Suprime sequências repetitivas de logs de download/build (npm, pip, etc.).")}

      <div class="ai-field" style="margin-top: 6px;">
        <label class="ai-label" for="ai-sk-rtk-maxlines">Limite máximo de linhas por trecho de material</label>
        <input class="ai-input" id="ai-sk-rtk-maxlines" type="number" min="10" max="500" value="${rtk.maxLinesPerSnippet || 60}" style="max-width: 140px;">
        <p class="ai-field-desc">Preserva o início e o fim do arquivo, resumindo trechos intermediários excessivamente longos.</p>
      </div>
      ${skSwitch("ai-sk-rtk-materials", "Aplicar aos materiais de apoio (.txt, .md, .log, códigos)", rtk.applyToMaterials !== false, "Processa arquivos de apoio anexados às aulas.")}
    </div>

    <hr class="ai-sep">

    <!-- Skill 3: Headroom -->
    <div class="ai-field">
      <h4 class="ai-block-title">
        <span>📦 Headroom</span>
        <span class="ai-block-tag">Context & Cache Layer</span>
        <a href="https://github.com/headroomlabs-ai/headroom" target="_blank" rel="noopener noreferrer" class="ai-tr-summary-link" style="margin-left: auto; font-size: 11px;">GitHub ↗</a>
      </h4>
      <p class="ai-field-desc" style="margin-bottom: 8px;">Camada de otimização de contexto especializada por tipo de conteúdo e alinhamento de prefixos para maximizar o cache de prompt dos provedores.</p>
      ${skSwitch("ai-sk-hr-enabled", "Habilitar Skill Headroom", hr.enabled === true, "Ativa a compressão estruturada e o alinhamento de cache de contexto.")}
      ${skSwitch("ai-sk-hr-code", "CodeCompressor: Comprimir espaçamento e quebras vazias em código", hr.compressCode !== false, "Remove quebras de linha supérfluas e espaços em branco preservando a sintaxe.")}
      ${skSwitch("ai-sk-hr-json", "SmartCrusher: Minificar dados e arquivos JSON estruturados", hr.compressJson !== false, "Comprime JSONs de materiais e transcrições para formato compacto de baixo consumo de tokens.")}
      ${skSwitch("ai-sk-hr-align", "Prompt Cache Alignment: Ordenação e prefixos determinísticos", hr.alignCache !== false, "Garante ordem estável de materiais e seções para maximizar cache hits (KV-cache) no provedor LLM.")}
      ${skSwitch("ai-sk-hr-context", "Aplicar na montagem do contexto da aula", hr.applyToContext !== false, "Otimiza os blocos montados para o Tutor IA.")}
    </div>

    <div class="settings-actions" style="margin-top: 20px;">
      <button class="btn btn--primary" id="ai-sk-save" type="button">Salvar Skills</button>
    </div>
    <p class="ai-inline-msg ok" id="ai-sk-msg" hidden></p>`;
}

function bindAiSkills(panel) {
  const cfg = aiState.config;
  const sk = cfg.skills = cfg.skills || {
    caveman: { enabled: false, mode: "caveman", preserveCode: true, customInstructions: "", applyToTutor: true },
    rtk: { enabled: false, stripBoilerplate: true, filterLogs: true, maxLinesPerSnippet: 60, applyToMaterials: true },
    headroom: { enabled: false, compressCode: true, compressJson: true, alignCache: true, applyToContext: true },
  };
  const cv = sk.caveman = sk.caveman || {};
  const rtk = sk.rtk = sk.rtk || {};
  const hr = sk.headroom = sk.headroom || {};

  const bindSwitch = (id, obj, key, defaultOn = false) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", () => {
      const current = obj[key] !== undefined ? obj[key] : defaultOn;
      obj[key] = !current;
      el.classList.toggle("on", obj[key]);
      el.setAttribute("aria-checked", String(obj[key]));
    });
  };

  // Caveman switches & radios
  bindSwitch("ai-sk-cv-enabled", cv, "enabled", false);
  bindSwitch("ai-sk-cv-code", cv, "preserveCode", true);
  bindSwitch("ai-sk-cv-tutor", cv, "applyToTutor", true);

  const customWrap = document.getElementById("ai-sk-cv-custom-wrap");
  document.querySelectorAll('input[name="ai-sk-cv-mode"]').forEach((r) => {
    r.addEventListener("change", () => {
      if (r.checked) {
        cv.mode = r.value;
        if (customWrap) customWrap.hidden = cv.mode !== "custom";
      }
    });
  });

  const customInput = document.getElementById("ai-sk-cv-custom-input");
  if (customInput) {
    customInput.addEventListener("input", () => {
      cv.customInstructions = customInput.value;
    });
  }

  // RTK switches & inputs
  bindSwitch("ai-sk-rtk-enabled", rtk, "enabled", false);
  bindSwitch("ai-sk-rtk-boilerplate", rtk, "stripBoilerplate", true);
  bindSwitch("ai-sk-rtk-logs", rtk, "filterLogs", true);
  bindSwitch("ai-sk-rtk-materials", rtk, "applyToMaterials", true);

  const maxLinesInput = document.getElementById("ai-sk-rtk-maxlines");
  if (maxLinesInput) {
    maxLinesInput.addEventListener("input", () => {
      rtk.maxLinesPerSnippet = Number(maxLinesInput.value) || 60;
    });
  }

  // Headroom switches
  bindSwitch("ai-sk-hr-enabled", hr, "enabled", false);
  bindSwitch("ai-sk-hr-code", hr, "compressCode", true);
  bindSwitch("ai-sk-hr-json", hr, "compressJson", true);
  bindSwitch("ai-sk-hr-align", hr, "alignCache", true);
  bindSwitch("ai-sk-hr-context", hr, "applyToContext", true);

  // Save button
  const saveBtn = document.getElementById("ai-sk-save");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      try {
        if (customInput) cv.customInstructions = customInput.value;
        if (maxLinesInput) rtk.maxLinesPerSnippet = Number(maxLinesInput.value) || 60;
        await saveAiPatch({ skills: sk });
        aiMsg("ai-sk-msg", "ok", "Configurações de Skills e Otimizadores salvas com sucesso.");
      } catch (err) {
        aiMsg("ai-sk-msg", "error", err.message);
      }
    });
  }
}

function aiGenId() { return "p_" + Math.random().toString(36).slice(2, 12); }

async function aiTestProvider(payload, msgId) {
  const el = document.getElementById(msgId);
  if (el) { el.hidden = false; el.className = "ai-inline-msg"; el.textContent = "Testando…"; }
  try {
    const res = await fetch("/api/ai/llm/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (el) {
      el.className = `ai-inline-msg ${data.ok ? "ok" : "error"}`;
      el.textContent = data.ok
        ? `Conectado · ${data.model || ""} · ${data.latencyMs}ms`
        : `Falha: ${data.error || "erro desconhecido"}`;
    }
  } catch {
    if (el) { el.className = "ai-inline-msg error"; el.textContent = "Falha ao testar."; }
  }
}

const AI_PRESETS = [
  { id: "ollama", name: "Ollama (Local - http://127.0.0.1:11434/v1)", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio (Local - http://127.0.0.1:1234/v1)", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp", name: "llama.cpp / vLLM (Local - http://127.0.0.1:8080/v1)", baseUrl: "http://127.0.0.1:8080/v1" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "omniroute", name: "OmniRoute", baseUrl: "" },
  { id: "custom", name: "Personalizado / outro compatível", baseUrl: "" },
];

function renderAiProviderCard(p) {
  const isLocal = p.baseUrl && (
    p.baseUrl.includes("127.0.0.1") ||
    p.baseUrl.includes("localhost") ||
    p.baseUrl.includes(":11434") ||
    p.baseUrl.includes(":1234") ||
    p.baseUrl.includes(":8080")
  );
  return `
    <div class="ai-provider-card">
      <div class="ai-provider-head">
        <div>
          <div class="ai-provider-name" style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span>${escapeHtml(p.name)}</span>
            <span class="lib-badge ${isLocal ? "lib-badge-ok" : "lib-badge-warn"}" style="font-size: 10.5px; padding: 2px 7px;">
              ${isLocal ? "⚡ Local (Offline)" : "🌐 Nuvem / API"}
            </span>
          </div>
          <div class="ai-provider-meta">${p.baseUrl ? escapeHtml(p.baseUrl) : "URL não definida"}</div>
        </div>
        <span class="ai-provider-key ${p.hasApiKey ? "has" : ""}">${p.hasApiKey ? "● Chave de API salva" : (isLocal ? "○ Sem chave (Local)" : "○ Sem chave")}</span>
      </div>
      ${p.defaultModel ? `<div class="ai-provider-model">Modelo padrão: <code>${escapeHtml(p.defaultModel)}</code></div>` : ""}
      <div class="ai-provider-actions">
        <button class="btn btn--secondary btn--sm" id="ai-test-${p.id}" type="button">Testar conexão</button>
        <button class="btn btn--secondary btn--sm" id="ai-edit-${p.id}" type="button">Editar</button>
        <button class="btn btn--danger btn--sm" id="ai-remove-${p.id}" type="button">Remover</button>
      </div>
      <p class="ai-inline-msg ok" id="ai-test-msg-${p.id}" hidden></p>
    </div>`;
}

function renderAiProviderForm(editId) {
  const editing = editId !== "_new";
  const existing = editing ? aiLlmProvider(editId) : null;
  if (!aiState.form) {
    aiState.form = {
      preset: existing ? (AI_PRESETS.find((x) => x.baseUrl === existing.baseUrl) ? AI_PRESETS.find((x) => x.baseUrl === existing.baseUrl).id : "custom") : "ollama",
      name: existing ? existing.name : "",
      baseUrl: existing ? existing.baseUrl : "http://127.0.0.1:11434/v1",
      model: existing ? existing.defaultModel : "llama3.2",
      apiKey: "",
      clearApiKey: false,
    };
  }
  const f = aiState.form;
  const hasKey = existing && existing.hasApiKey;
  return `
    <div class="ai-provider-form">
      <h3 class="ai-form-title">${editing ? "Editar Provedor LLM" : "Novo Provedor LLM"}</h3>
      <div class="ai-field">
        <label class="ai-label" for="ai-f-preset">Preset Rápido</label>
        <select class="ai-select" id="ai-f-preset">
          ${AI_PRESETS.map((x) => `<option value="${x.id}" ${x.id === f.preset ? "selected" : ""}>${escapeHtml(x.name)}</option>`).join("")}
        </select>
        <p class="ai-field-desc">Selecione um preset para preenchimento automático de URLs de servidores locais ou serviços em nuvem.</p>
      </div>
      <div class="ai-field">
        <label class="ai-label" for="ai-f-name">Nome de Identificação</label>
        <input class="ai-input" id="ai-f-name" type="text" value="${escapeHtml(f.name)}" placeholder="ex.: Ollama Local, LM Studio, OpenRouter">
      </div>
      <div class="ai-field">
        <label class="ai-label" for="ai-f-url">URL Base da API (Endpoint OpenAI-compatible)</label>
        <input class="ai-input" id="ai-f-url" type="text" value="${escapeHtml(f.baseUrl)}" placeholder="http://127.0.0.1:11434/v1">
      </div>
      <div class="ai-field">
        <label class="ai-label" for="ai-f-model">Modelo Padrão</label>
        <input class="ai-input" id="ai-f-model" type="text" value="${escapeHtml(f.model)}" placeholder="ex.: llama3.2, qwen2.5-coder, gpt-4o-mini">
      </div>
      <div class="ai-field">
        <label class="ai-label" for="ai-f-key">Chave de API (Opcional para provedores locais)</label>
        <div class="ai-pw-wrap">
          <input class="ai-input" id="ai-f-key" type="password" value="${escapeHtml(f.apiKey)}" autocomplete="off" placeholder="${hasKey ? "•••••• (chave salva)" : "Opcional se local (ex.: Ollama / LM Studio)"}">
          <button type="button" class="ai-eye" id="ai-f-eye" aria-label="Mostrar ou ocultar chave">👁</button>
        </div>
        ${hasKey ? `<label class="ai-label ai-label-small"><input type="checkbox" id="ai-f-clearkey"> Limpar chave salva</label><p class="ai-note">Deixe o campo vazio para manter a chave atual; marque a opção para removê-la.</p>` : ""}
      </div>
      <div class="ai-provider-actions" style="margin-top: 14px;">
        <button class="btn btn--secondary" id="ai-f-test" type="button">Testar conexão</button>
        <button class="btn btn--primary" id="ai-f-save" type="button">Salvar provedor</button>
        <button class="btn btn--secondary" id="ai-f-cancel" type="button">Cancelar</button>
      </div>
      <p class="ai-inline-msg ok" id="ai-f-msg" hidden></p>
    </div>`;
}

function renderAiProviders() {
  const providers = aiState.config.llm.providers || [];
  const editing = aiState.editingProviderId !== null;
  return `
    ${editing ? renderAiProviderForm(aiState.editingProviderId) : ""}
    ${providers.length
      ? `<div class="ai-provider-list">${providers.map(renderAiProviderCard).join("")}</div>`
      : `<p class="ai-empty">Nenhum provedor de LLM configurado.</p>`}
    <div class="settings-actions">
      <button class="btn btn--secondary" id="ai-pr-add" type="button">+ Adicionar provedor</button>
    </div>
    <p class="ai-note">Suporta qualquer endpoint compatível com a API OpenAI (<code>chat/completions</code>). A chave fica salva apenas no seu computador, nunca no navegador.</p>`;
}

function bindAiProviders(panel) {
  const cfg = aiState.config;
  const add = document.getElementById("ai-pr-add");
  if (add) {
    add.addEventListener("click", () => {
      aiState.editingProviderId = "_new";
      aiState.form = null;
      renderAiPanelInto(panel);
    });
  }
  (cfg.llm.providers || []).forEach((p) => {
    const test = document.getElementById(`ai-test-${p.id}`);
    if (test) test.addEventListener("click", () => aiTestProvider({ providerId: p.id }, `ai-test-msg-${p.id}`));
    const edit = document.getElementById(`ai-edit-${p.id}`);
    if (edit) {
      edit.addEventListener("click", () => {
        aiState.editingProviderId = p.id;
        aiState.form = null;
        renderAiPanelInto(panel);
      });
    }
    const remove = document.getElementById(`ai-remove-${p.id}`);
    if (remove) {
      remove.addEventListener("click", () => {
        openConfirmDialog({
          title: "Remover provedor",
          message: `O provedor "${p.name}" será removido. A chave de API salva para ele também será apagada.`,
          confirmLabel: "Remover",
          cancelLabel: "Cancelar",
          danger: true,
          onConfirm: async () => {
            const patch = { llm: { removeProviderId: p.id } };
            if (cfg.correction.providerId === p.id) {
              cfg.correction.providerId = "";
              patch.correction = { providerId: "" };
            }
            try {
              await saveAiPatch(patch);
              if (aiState.editingProviderId === p.id) aiState.editingProviderId = null;
              renderAiPanelInto(panel);
            } catch (err) {
              aiMsg(`ai-test-msg-${p.id}`, "error", err.message);
            }
          },
        });
      });
    }
  });
  if (!document.getElementById("ai-f-name")) return;
  const f = aiState.form;
  const setField = () => {
    f.name = document.getElementById("ai-f-name").value;
    f.baseUrl = document.getElementById("ai-f-url").value;
    f.model = document.getElementById("ai-f-model").value;
    f.apiKey = document.getElementById("ai-f-key").value;
  };
  const presetEl = document.getElementById("ai-f-preset");
  presetEl.addEventListener("change", () => {
    const pr = AI_PRESETS.find((x) => x.id === presetEl.value) || AI_PRESETS[0];
    f.preset = pr.id;
    document.getElementById("ai-f-url").value = pr.baseUrl;
    if (!document.getElementById("ai-f-name").value.trim()) {
      document.getElementById("ai-f-name").value =
        pr.name === "Personalizado / outro compatível" ? "" : pr.name;
    }
  });
  document.getElementById("ai-f-eye").addEventListener("click", () => {
    const keyEl = document.getElementById("ai-f-key");
    keyEl.type = keyEl.type === "password" ? "text" : "password";
  });
  const clearKeyEl = document.getElementById("ai-f-clearkey");
  if (clearKeyEl) clearKeyEl.addEventListener("change", () => { f.clearApiKey = clearKeyEl.checked; });
  const save = document.getElementById("ai-f-save");
  save.addEventListener("click", async () => {
    setField();
    const editing = aiState.editingProviderId !== "_new";
    const id = editing ? aiState.editingProviderId : aiGenId();
    const patch = {
      llm: {
        providers: [{
          id,
          type: "openai-compatible",
          name: f.name || id,
          baseUrl: f.baseUrl,
          defaultModel: f.model,
          apiKey: f.apiKey,
          clearApiKey: f.clearApiKey,
        }],
      },
    };
    try {
      await saveAiPatch(patch);
      aiState.editingProviderId = null;
      aiState.form = null;
      renderAiPanelInto(panel);
    } catch (err) {
      aiMsg("ai-f-msg", "error", err.message);
    }
  });
  document.getElementById("ai-f-cancel").addEventListener("click", () => {
    aiState.editingProviderId = null;
    aiState.form = null;
    renderAiPanelInto(panel);
  });
  document.getElementById("ai-f-test").addEventListener("click", () => {
    setField();
    aiTestProvider({ baseUrl: f.baseUrl, model: f.model, apiKey: f.apiKey }, "ai-f-msg");
  });
}

function aiFormatSize(bytes) {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) { n /= 1024; u++; }
  return `${n.toFixed(u ? 1 : 0)} ${units[u]}`;
}

function renderAiModels() {
  const providers = aiState.status?.transcription?.providers || [];
  const llmProviders = aiState.config?.llm?.providers || [];
  const asrBlock = providers.length ? providers.map((pr) => `
      <div class="ai-provider-card ai-models-card">
        <div class="ai-provider-head">
          <div>
            <div class="ai-provider-name">${escapeHtml(pr.name)} <span class="ai-provider-meta">· ${pr.runtime}</span></div>
            <div class="ai-provider-meta">${pr.available ? "Binário instalado" : "Binário não encontrado em bin/"}</div>
          </div>
        </div>
        <div class="ai-model-list">
          ${pr.models.map((m) => `
            <div class="ai-model-row">
              <span class="ai-model-name">${escapeHtml(m.name)}</span>
              <span class="ai-model-state ${m.installed ? "ok" : "off"}">${m.installed ? "instalado" : "não instalado"}</span>
              <span class="ai-model-size">${aiFormatSize(m.sizeBytes)}</span>
            </div>`).join("")}
        </div>
      </div>`).join("")
    : `<p class="ai-empty">Nenhum provedor de transcrição disponível.</p>`;
  const llmBlock = llmProviders.length ? `
    <div class="ai-provider-card ai-models-card">
      <div class="ai-provider-head">
        <div class="ai-provider-name">Provedores de LLM</div>
      </div>
      <div class="ai-model-list">
        ${llmProviders.map((p) => `
          <div class="ai-model-row">
            <span class="ai-model-name">${escapeHtml(p.name)}</span>
            <span class="ai-model-state ${p.baseUrl ? "ok" : "off"}">${p.baseUrl ? "configurado" : "sem URL"}</span>
            <span class="ai-model-size">${escapeHtml(p.defaultModel || "modelo livre")}</span>
          </div>`).join("")}
      </div>
    </div>
    <p class="ai-note">Modelos de LLM são livres (definidos por provedor, ex.: gpt-4o-mini, llama-3.1-8b). A disponibilidade é validada no teste de conexão da aba Provedores LLM.</p>`
    : `<p class="ai-empty">Nenhum provedor de LLM configurado.</p>`;
  return `
    <h4 class="ai-block-title">Modelos de transcrição (ASR)</h4>
    ${asrBlock}
    <h4 class="ai-block-title">Modelos de LLM</h4>
    ${llmBlock}
    <div class="settings-actions">
      <button class="btn btn--secondary" id="ai-md-check" type="button">Verificar novamente</button>
    </div>
    <p class="ai-note">Instalação manual do ASR: coloque o binário em <code>bin/</code> e o modelo em <code>models/</code> (consulte o README de cada pasta). Nada é baixado automaticamente pelo projeto.</p>`;
}
function bindAiModels(panel) {
  const check = document.getElementById("ai-md-check");
  if (check) {
    check.addEventListener("click", async () => {
      aiState.status = await (await fetch("/api/ai/status")).json();
      renderAiPanelInto(panel);
    });
  }
}

function renderAiAdvanced() {
  const cfg = aiState.config;
  const ad = aiState.config.advanced;
  const cachedCount = aiState.subtitles ? aiState.subtitles.processed : null;
  const vadSupported = !!(aiState.status?.transcription?.configured || {}).vadSupported;
  return `
    <h4 class="ai-block-title">Concorrência</h4>
    <div class="ai-field">
      <label class="ai-label" for="ai-ad-conc">Transcrições simultâneas (máx.)</label>
      <input class="ai-input ai-input-num" id="ai-ad-conc" type="number" min="1" max="8" value="${ad.maxConcurrentTranscriptions}">
    </div>
    <div class="ai-field">
      <label class="ai-label" for="ai-ad-heavy">Tarefas pesadas simultâneas (máx.)</label>
      <input class="ai-input ai-input-num" id="ai-ad-heavy" type="number" min="1" max="8" value="${ad.maxConcurrentAiJobs}">
      <p class="ai-note">Compartilha um único limite entre extração de áudio (ffmpeg), transcrição (whisper) e correção (LLM), para nunca rodar várias tarefas pesadas ao mesmo tempo que o player.</p>
    </div>
    <hr class="ai-sep">
    <h4 class="ai-block-title">Transcrição (whisper.cpp)</h4>
    <div class="ai-field">
      <label class="ai-label" for="ai-ad-threads">Threads de transcrição</label>
      <input class="ai-input ai-input-num" id="ai-ad-threads" type="number" min="0" max="16" value="${ad.transcriptionThreads || 0}">
      <p class="ai-note"><code>0</code> = automático (deixa o whisper decidir). Valores acima de 0 passam <code>-t N</code> para o whisper.cpp.</p>
    </div>
    <div class="ai-field ai-field-switch">
      <button class="switch ${vadSupported && cfg.transcription.vad !== false ? "on" : ""} ${vadSupported ? "" : "disabled"}" id="ai-ad-vad" type="button" role="switch" aria-checked="${vadSupported && cfg.transcription.vad !== false}" ${vadSupported ? "" : "disabled"}>
        <span class="switch-track"></span>
        <span class="switch-thumb"></span>
      </button>
      <div class="ai-switch-text">
        <label class="ai-label" for="ai-ad-vad">VAD — pular silêncio (silero)</label>
        <p class="ai-field-desc">${vadSupported
          ? "Passa <code>-vad</code> ao whisper.cpp para ignorar trechos sem fala. Se o binário rejeitar a flag, o pipeline tenta uma vez sem VAD automaticamente."
          : "Indisponível no build instalado: o whisper-cli 1.9.2 rejeita a flag curta <code>-vad</code> e o VAD exigiria o modelo silero (<code>ggml-silero-vad.bin</code>) via <code>-vm</code>, não instalado por padrão. Habilite instalando esse modelo."}</p>
      </div>
    </div>
    <hr class="ai-sep">
    <h4 class="ai-block-title">Tempo limite de conexão LLM</h4>
    <div class="ai-field">
      <label class="ai-label" for="ai-ad-timeout">Tempo limite (segundos)</label>
      <input class="ai-input ai-input-num" id="ai-ad-timeout" type="number" min="1" max="120" value="${Math.round(ad.llmTimeoutMs / 1000)}">
      <p class="ai-note">Em timeout a correção é ignorada e a legenda segue com a versão anterior — nunca quebra a reprodução.</p>
    </div>
    <hr class="ai-sep">
    <h4 class="ai-block-title">Cache de legendas</h4>
    <div class="ai-field">
      <p class="ai-note">Artefato final na pasta do curso (<code>.courseplayer/subtitles/&lt;hash&gt;.vtt</code>) · cache de registro em <code>data/subtitles/</code> · ${cachedCount ?? "—"} vídeos processados · invalidado por tamanho + data do arquivo.</p>
      <button class="btn btn--danger" id="ai-ad-clearcache" type="button">Excluir todas as legendas (forçar regeneração)</button>
    </div>
    <hr class="ai-sep">
    <h4 class="ai-block-title">Diagnóstico</h4>
    <p class="ai-note">Logs de pipeline usam o prefixo <code>[SUBTITLE]</code> no console do servidor (ex.: extraindo áudio, transcrevendo, corrigindo, concluído). Chaves de API nunca aparecem em logs.</p>
    <div class="settings-actions">
      <button class="btn btn--primary" id="ai-ad-save" type="button">Salvar</button>
      <button class="btn btn--danger" id="ai-ad-reset" type="button">Limpar configurações de IA</button>
    </div>
    <p class="ai-inline-msg ok" id="ai-ad-msg" hidden></p>`;
}
function bindAiAdvanced(panel) {
  const cfg = aiState.config;
  const conc = document.getElementById("ai-ad-conc");
  const heavy = document.getElementById("ai-ad-heavy");
  const timeout = document.getElementById("ai-ad-timeout");
  const threads = document.getElementById("ai-ad-threads");
  const vad = document.getElementById("ai-ad-vad");
  if (vad) {
    vad.addEventListener("click", () => {
      const current = cfg.transcription.vad !== undefined ? cfg.transcription.vad : true;
      cfg.transcription.vad = !current;
      vad.classList.toggle("on", cfg.transcription.vad);
      vad.setAttribute("aria-checked", String(cfg.transcription.vad));
    });
  }
  const save = document.getElementById("ai-ad-save");
  save.addEventListener("click", async () => {
    cfg.advanced.maxConcurrentTranscriptions = Math.min(8, Math.max(1, Math.floor(Number(conc.value) || 1)));
    cfg.advanced.maxConcurrentAiJobs = Math.min(8, Math.max(1, Math.floor(Number(heavy.value) || 1)));
    cfg.advanced.llmTimeoutMs = Math.min(120000, Math.max(1000, Math.floor((Number(timeout.value) || 15) * 1000)));
    cfg.advanced.transcriptionThreads = Math.min(16, Math.max(0, Math.floor(Number(threads && threads.value) || 0)));
    try {
      await saveAiPatch({ advanced: cfg.advanced, transcription: { vad: cfg.transcription.vad } });
      aiMsg("ai-ad-msg", "ok", "Configurações avançadas salvas.");
    } catch (err) {
      aiMsg("ai-ad-msg", "error", err.message);
    }
  });
  const clearCache = document.getElementById("ai-ad-clearcache");
  if (clearCache) {
    clearCache.addEventListener("click", () => {
      openConfirmDialog({
        title: "Excluir todas as legendas",
        message: "Todas as legendas geradas serão apagadas (transcrição bruta, processada e VTT). Elas serão regeneradas na próxima vez que a geração for solicitada.",
        confirmLabel: "Excluir",
        cancelLabel: "Cancelar",
        danger: true,
        onConfirm: async () => {
          try {
            const res = await fetch("/api/subtitles/clear", { method: "POST" });
            if (!res.ok) throw new Error("clear failed");
            await loadAiData();
            renderAiPanelInto(panel);
            aiMsg("ai-ad-msg", "ok", "Cache de legendas excluído.");
          } catch (err) {
            aiMsg("ai-ad-msg", "error", err.message);
          }
        },
      });
    });
  }
  const reset = document.getElementById("ai-ad-reset");
  reset.addEventListener("click", () => {
    openConfirmDialog({
      title: "Limpar configurações de IA",
      message: "Todas as configurações de IA (providers, chaves, preferências) serão apagadas e voltarão ao padrão.",
      confirmLabel: "Limpar",
      cancelLabel: "Cancelar",
      danger: true,
      onConfirm: async () => {
        await fetch("/api/ai/reset", { method: "POST" });
        await loadAiData();
        aiState.editingProviderId = null;
        aiState.form = null;
        renderAiPanelInto(panel);
      },
    });
  });
}

// ---------- Modo Teatro / sumário colapsável ----------
// Aplica o modo de visualização ao DOM do curso SEM re-renderizar o player:
// alternar teatro/normal ou abrir/fechar o sumário não deve reiniciar o vídeo.
// O layout (player-col | sidebar) é controlado por classes no .course-view;
// os botões do player refletem o estado via aria-pressed/label.
function applyViewModeToDOM() {
  const view = document.querySelector(".course-view");
  const theater = getViewMode() === "theater";
  if (view) {
    view.classList.toggle("theater", theater);
    view.classList.toggle("summary-open", theater && getSummaryOpen());
  }
  const theaterItem = document.querySelector('[data-more="theater"]');
  if (theaterItem) {
    theaterItem.classList.toggle("is-active", theater);
    theaterItem.setAttribute("aria-pressed", String(theater));
    theaterItem.textContent = theater ? "Sair do modo teatro" : "Modo teatro";
  }
  const summaryItem = document.querySelector('[data-more="summary"]');
  if (summaryItem) {
    if (isMobileDrawer()) {
      // Mobile: o item ⋮ > Resumo da aula é o controle do drawer. O rótulo
      // reflete o estado real do drawer (setDrawerOpen também o atualiza) e
      // não depende do teatro — evita que alternar teatro sobrescreva o
      // estado do drawer com um estado paralelo desatualizado.
      const view = document.querySelector(".course-view");
      const open = !!(view && view.classList.contains("drawer-open"));
      summaryItem.hidden = false;
      summaryItem.classList.toggle("is-active", open);
      summaryItem.setAttribute("aria-pressed", String(open));
      summaryItem.textContent = open ? "Fechar sumário" : "Resumo da aula";
    } else {
      const open = theater && getSummaryOpen();
      summaryItem.hidden = !theater;
      summaryItem.classList.toggle("is-active", open);
      summaryItem.setAttribute("aria-pressed", String(open));
      summaryItem.textContent = open ? "Fechar sumário" : "Resumo da aula";
    }
  }
}

function toggleTheaterMode() {
  setViewMode(getViewMode() === "theater" ? "normal" : "theater");
  applyViewModeToDOM();
}

function toggleSummaryPanel() {
  if (isMobileDrawer()) {
    toggleDrawer();
    return;
  }
  setSummaryOpen(!getSummaryOpen());
  applyViewModeToDOM();
}

// ---------- Drawer mobile (sumário off-canvas) ----------
// Em telas ≤900px o sumário deixa de empilhar abaixo do player e vira um
// drawer que desliza da direita (CSS em styles.css). O estado NÃO é
// persistido: trocar de aula re-renderiza a página e fecha o drawer — é o
// comportamento desejado. A classe .drawer-open no .course-view comanda a
// visibilidade; o backdrop fecha ao tocar fora; Esc fecha também.
function isMobileDrawer() {
  return window.matchMedia("(max-width: 900px)").matches;
}
function setDrawerOpen(open) {
  const view = document.querySelector(".course-view");
  if (!view) return;
  view.classList.toggle("drawer-open", open);
  const btn = document.getElementById("lesson-sidebar-toggle");
  if (btn) btn.setAttribute("aria-expanded", String(open));
  // Reflete o estado no item ⋮ > Resumo da aula (o mesmo controle no mobile).
  const summaryItem = document.querySelector('[data-more="summary"]');
  if (summaryItem) {
    summaryItem.textContent = open ? "Fechar sumário" : "Resumo da aula";
    summaryItem.setAttribute("aria-pressed", String(open));
  }
  // Ao abrir, refresca a árvore: o updateProgressUI pausa os re-renders com o
  // drawer aberto, então este refresh garante que o progresso exibido ao
  // abrir está atual (a lista re-renderiza sem perder o scroll de quem abre).
  if (open && state.currentCourseNode) {
    renderTree(state.currentCourseNode, false);
  }
}
function toggleDrawer() {
  const view = document.querySelector(".course-view");
  if (!view) return;
  setDrawerOpen(!view.classList.contains("drawer-open"));
}
function closeMobileDrawer() {
  const view = document.querySelector(".course-view");
  if (view && view.classList.contains("drawer-open")) {
    setDrawerOpen(false);
    return true;
  }
  return false;
}

// Card reutilizado por Home e renderTopic: curso → card com progresso/favorito;
// tópico → card com contagem de itens, href #/topic/ e tag "Tópico".
function renderNodeCard(node) {
  if (node.type === "topic") {
    const coverImage = node.coverImage ? mediaUrl(node.coverImage, node.libId) : null;
    const topicHref = "#" + topicRoute(node);
    const n = node.children.length;
    const meta = `${n} ${n === 1 ? "item" : "itens"}`;
    return `
      <div class="course-card">
        <a class="course-card-link" href="${topicHref}">
          <div class="course-card-thumb ${coverImage ? "has-image" : ""}"${coverImage ? "" : ` style="background:${courseColor(node.name)}"`}>
            ${coverImage ? `<img src="${coverImage}" alt="${escapeHtml(topicTitle(node))}" />` : initials(topicTitle(node))}
          </div>
          <div class="course-card-body">
            <div class="course-card-title">${escapeHtml(topicTitle(node))}</div>
            <div class="course-card-meta">${meta}</div>
            <div class="topic-card-tag">Tópico</div>
          </div>
        </a>
      </div>`;
  }
  const stats = getNodeProgressStats(node, progFor);
  const pct = stats.pct;
  const coverImage = node.coverImage ? mediaUrl(node.coverImage, node.libId) : null;
  const href = courseRoute(node);
  return `
    <div class="course-card">
      <a class="course-card-link" href="#${href}">
        <div class="course-card-thumb ${coverImage ? "has-image" : ""}"${coverImage ? "" : ` style="background:${courseColor(node.name)}"`}>
          ${coverImage ? `<img src="${coverImage}" alt="${escapeHtml(courseTitle(node))}" />` : initials(courseTitle(node))}
        </div>
        <div class="course-card-body">
          <div class="course-card-title">${escapeHtml(courseTitle(node))}</div>
          <div class="course-card-meta">${stats.done}/${stats.total} concluídas · ${pct}%</div>
          <div class="course-card-meta">${formatDuration(stats.watchedSeconds)} assistidos</div>
          <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        </div>
      </a>
      ${favButtonHtml(node.path, node.libId)}
    </div>`;
}

// ---------- Escopo contextual: seções reutilizáveis (Home + tópicos) ----------

// Card de "Continuar assistindo" (uma aula por curso, já agrupada em
// buildContinueItems). Compartilhado pela Home (global) e por tópicos (escopo).
function renderContinueCard(item, i) {
  const pct = item.progress.duration
    ? Math.min(
        100,
        Math.round((item.progress.position / item.progress.duration) * 100),
      )
    : 0;
  const continueHref = courseHref(item.course, item.video.path);
  return `
    <a class="continue-card" href="${continueHref}" aria-label="Continuar aula: ${escapeHtml(lessonTitle(item.video))}" style="--i:${i}">
      <div>
        <div class="lesson-name">${escapeHtml(lessonTitle(item.video))}</div>
        <div class="course-name">${escapeHtml(courseTitle(item.course))}</div>
      </div>
      <div class="continue-card-progress">
        <div class="progress-bar continue-progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <span class="continue-pct">${pct}%</span>
      </div>
    </a>`;
}

// Seção "Continuar assistindo": cabeçalho + cards. `summary` vem do escopo.
function renderContinueSection(items, summary) {
  const inProgressLabel = `${summary.inProgressLessons} ${
    summary.inProgressLessons === 1 ? "aula" : "aulas"
  } em andamento`;
  let html = `
    <section class="home-section">
      <div class="section-head">
        <div>
          <h2 class="section-heading">Continuar assistindo</h2>
          <p class="section-subtitle">Retome de onde parou · ${inProgressLabel}</p>
        </div>
      </div>
      <div class="continue-row">`;
  items.forEach((item, i) => {
    html += renderContinueCard(item, i);
  });
  html += `</div>
    </section>`;
  return html;
}

// Bloco "Seu progresso": resumo agregado do escopo (Home = cursos diretos;
// tópico = subárvore). `totalCourses` alimenta o rodapé "de X disponíveis".
function renderProgressSection(summary, totalCourses) {
  const progressMode = getProgressMode();
  const progressExpanded = progressMode === "expanded";
  const watchedLabel = formatDuration(summary.watchedSeconds);
  return `
    <section class="home-section progress-section" id="progress-section" data-progress-mode="${progressMode}">
      <div class="section-head">
        <div>
          <h2 class="section-heading">Seu progresso</h2>
          <p class="section-subtitle">Visão geral da sua jornada de estudos</p>
        </div>
        <button class="progress-toggle" type="button" aria-expanded="${progressExpanded}" aria-controls="progress-panel" aria-label="${progressExpanded ? "Recolher seção de progresso" : "Expandir seção de progresso"}">
          <svg class="progress-toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </button>
      </div>
      <div class="progress-summary" aria-hidden="${progressExpanded}">
        <div class="progress-summary-inner">
          <div class="progress-summary-pct">${summary.pct}%</div>
          <div class="progress-summary-bar"><div class="progress-summary-bar-fill" style="width:${summary.pct}%"></div></div>
          <div class="progress-summary-meta">${summary.doneLessons} aulas concluídas · ${summary.startedCourses} cursos ativos · ${watchedLabel} estudadas</div>
        </div>
      </div>
      <div class="progress-panel-wrap">
        <div class="progress-panel" id="progress-panel" aria-hidden="${!progressExpanded}">
        <div class="progress-panel-hero">
          <div class="progress-panel-hero-value">${summary.pct}%</div>
          <div class="progress-panel-hero-label">conclusão geral</div>
        </div>
        <div class="progress-panel-bar"><div class="progress-panel-bar-fill" style="--w:${summary.pct}%"></div></div>
        <div class="progress-panel-stats">
          <div class="progress-stat">
            <div class="progress-stat-value">${summary.doneLessons}</div>
            <div class="progress-stat-label">aulas concluídas</div>
            <div class="progress-stat-sub">de ${summary.totalLessons} na biblioteca</div>
          </div>
          <div class="progress-stat">
            <div class="progress-stat-value">${watchedLabel}</div>
            <div class="progress-stat-label">tempo estudado</div>
            <div class="progress-stat-sub">acumulado localmente</div>
          </div>
          <div class="progress-stat">
            <div class="progress-stat-value">${summary.startedCourses}</div>
            <div class="progress-stat-label">cursos ativos</div>
            <div class="progress-stat-sub">de ${totalCourses} disponíveis</div>
          </div>
        </div>
        </div>
      </div>
    </section>`;
}

// Liga o botão recolher/expandir da seção "Seu progresso" (se existir).
function bindProgressToggle() {
  const progressSection = document.getElementById("progress-section");
  const progressToggle = progressSection?.querySelector(".progress-toggle");
  if (progressToggle) {
    progressToggle.addEventListener("click", () => {
      const next =
        progressSection.dataset.progressMode === "expanded"
          ? "compact"
          : "expanded";
      setProgressMode(next, progressSection);
    });
  }
}

function renderHome(app) {
  // Bibliotecas visíveis na Home: a padrão + as externas habilitadas com
  // árvore (indisponíveis/desativadas ficam fora; a lista completa fica em
  // Configurações → Bibliotecas).
  const libs = (
    state.libraries.length
      ? state.libraries
      : [{ id: DEFAULT_LIB_ID, name: "Biblioteca", tree: state.tree }]
  ).filter((l) => l.enabled !== false && l.tree);
  const sections = libs.map((lib) => {
    const topNodes = ((lib.tree && lib.tree.children) || []).filter(
      (c) => c.type === "folder" || c.type === "topic",
    );
    return { lib, topNodes };
  });
  // Home mista: pastas da raiz viram cards de curso (type "folder") ou de
  // tópico (type "topic") — classificação explícita por marcador/nome no scan.
  const hasTopics = sections.some((s) => s.topNodes.some((c) => c.type === "topic"));
  // Escopos (paths REAIS, nunca título):
  //   allCourses  = TODOS os cursos de TODAS as bibliotecas (global) → alimenta
  //                 "Continuar assistindo" (global na Home, como sempre).
  //   directCourses = cursos DIRETOS da raiz de cada biblioteca (filhos
  //                 "folder") → "Seu progresso" só conta o que pertence à Home;
  //                 sem cursos diretos, a seção é ocultada.
  const allCourses = [];
  const directCourses = [];
  for (const lib of libs) {
    allCourses.push(...collectCoursesInScope(lib.tree));
    directCourses.push(...collectDirectCourses(lib.tree));
  }
  const search = (document.getElementById("search-input").value || "").trim();
  const results = buildSearchResults(libs.map((l) => l.tree), search);
  // Resumo GLOBAL (todas as bibliotecas) → rodapé de "Continuar assistindo".
  // Resumo de "Seu progresso" na Home: PREFERE o escopo DIRETO (cursos filhos
  // da raiz — comportamento contextual documentado); se a raiz não tem curso
  // direto (ex.: biblioteca toda organizada em tópicos), cai para o GLOBAL,
  // para o progresso existente não ficar invisível na Home (persistência é a
  // fonte de verdade; o bloco nunca some por organização em tópicos).
  const continueSummary = getLibraryProgressSummary(allCourses, progFor);
  const progressScope = directCourses.length ? directCourses : allCourses;
  const librarySummary = getLibraryProgressSummary(progressScope, progFor);
  state.lastSearchResults = results;
  // Tópicos têm path (sem coursePath); cursos/aulas/materiais têm coursePath.
  const matchedPaths = new Set(
    results.map((r) => (r.type === "topic" ? r.path : r.coursePath)),
  );
  for (const s of sections) {
    s.filtered = search
      ? s.topNodes.filter((c) => matchedPaths.has(c.path))
      : s.topNodes;
  }
  const grouped = libs.length > 1 && !search;

  // "Continuar assistindo": GLOBAL na Home (todos os cursos de todas as
  // bibliotecas, incluindo os aninhados em tópicos). Uma aula por curso — a
  // elegível com updatedAt mais recente. Regras preservadas: concluídas e
  // <=5s ficam fora.
  const topContinue = buildContinueItems(allCourses, progFor);

  let html = "";

  if (search) {
    html += `<div class="section-title">Resultados da pesquisa <span class="count">(${results.length})</span></div>`;
    if (!results.length) {
      html += `<div class="empty-state">Nenhum resultado para "${escapeHtml(search)}".</div>`;
    } else {
      html += `<div class="search-results">`;
      for (const item of results) {
        const tag =
          item.type === "course"
            ? "Curso"
            : item.type === "topic"
              ? "Tópico"
              : item.type === "lesson"
                ? "Aula"
                : "Material";
        let itemHref;
        if (item.type === "topic") {
          itemHref = "#" + topicRoute({ path: item.path, libId: item.libId });
        } else if (item.lessonPath) {
          itemHref =
            "#" +
            courseRoute({ path: item.coursePath, libId: item.libId }) +
            `?lesson=${encodeURIComponent(item.lessonPath)}`;
        } else {
          itemHref = "#" + courseRoute({ path: item.coursePath, libId: item.libId });
        }
        html += `
          <a class="search-result-item" href="${itemHref}" data-type="${item.type}">
            <span class="search-result-tag">${tag}</span>
            <span class="search-result-main">${escapeHtml(item.label)}</span>
            <span class="search-result-sub">${escapeHtml(item.courseName)} · ${escapeHtml(item.hint)}</span>
          </a>`;
      }
      html += `</div>`;
    }
  }

  if (topContinue.length) {
    html += renderContinueSection(topContinue, continueSummary);
  }

  // "Seu progresso" na Home: escopo DIRETO quando houver cursos na raiz; sem
  // cursos diretos (ex.: biblioteca toda organizada em tópicos), o bloco mostra
  // o resumo GLOBAL — o progresso existente nunca some da Home por estrutura.
  if (progressScope.length) {
    html += renderProgressSection(librarySummary, progressScope.length);
  }

  const totalShown = sections.reduce((n, s) => n + s.filtered.length, 0);
  // Uma biblioteca (ou busca ativa): cabeçalho único, como sempre foi.
  if (!grouped) {
    const sectionLabel = hasTopics ? "Biblioteca" : "Meus cursos";
    html += `<div class="section-title">${sectionLabel} <span class="count">(${totalShown})</span></div>`;
  }
  if (!totalShown) {
    if (!libs.length) {
      html += `<div class="empty-state">Nenhuma biblioteca configurada. Adicione uma pasta em <a href="#/settings" style="text-decoration:underline;color:inherit;font-weight:600;">Configurações → Bibliotecas</a>.</div>`;
    } else {
      html += `<div class="empty-state">Nenhum curso encontrado na biblioteca.</div>`;
    }
  }
  for (const s of sections) {
    if (!s.filtered.length) continue;
    // Mais de uma biblioteca: cada uma ganha um cabeçalho com o próprio nome.
    if (grouped) {
      html += `<div class="section-title">${escapeHtml(s.lib.name)} <span class="count">(${s.filtered.length})</span></div>`;
    }
    const ordered = search
      ? s.filtered
      : s.filtered.slice().sort(
          (a, b) =>
            Number(isFavorite(b.path, b.libId)) - Number(isFavorite(a.path, a.libId)),
        );
    html += `<div class="course-grid">`;
    for (const node of ordered) {
      html += renderNodeCard(node);
    }
    html += `</div>`;
  }

  app.innerHTML = html;
  // Cards de curso, "Continuar assistindo" e resultados de busca agora são
  // <a href> reais: o navegador cuida de clique, Ctrl+clique, botão do meio,
  // arrastar e "abrir em nova aba". O route() (via hashchange) segue o mesmo.
  app.querySelectorAll(".fav-btn").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFavorite(decodeURIComponent(el.dataset.fav), decodeURIComponent(el.dataset.lib || ""));
      renderHome(app);
    });
  });

  bindProgressToggle();
}

// ---------- Curso ----------
function renderFolderChildren(folderNode, depth = 1) {
  let html = "";
  for (const child of folderNode.children) {
    // A sidebar é de NAVEGAÇÃO de aulas: só módulos/pastas e vídeos entram.
    // Arquivos/material (type "file") aparecem apenas em "Materiais da aula".
    if (!isSidebarNavigableNode(child)) continue;
    if (child.type === "folder" || child.type === "topic") {
      const stats = countStats(child);
      const isOpen = expandedFolders.has(child.path);
      // data-depth permite ao CSS diferenciar módulo (1) de submódulo (2+) e
      // capar a indentação em níveis profundos. Tabindex/role/aria-expanded
      // tornam a pasta operável por teclado.
      html += `
        <div class="tree-folder">
          <div class="tree-folder-head ${isOpen ? "open" : ""}" data-folder="${encodeURIComponent(child.path)}" data-depth="${Math.min(depth, 4)}" role="button" tabindex="0" aria-expanded="${isOpen}">
            <span class="chev">▶</span>
            <span class="folder-title"><span class="folder-title-inner">${escapeHtml(moduleTitle(child))}</span></span>
            <span class="folder-progress">${stats.done}/${stats.total}</span>
          </div>
          <div class="tree-folder-children ${isOpen ? "open" : ""}" data-folder-body="${encodeURIComponent(child.path)}">
            ${renderFolderChildren(child, depth + 1)}
          </div>
        </div>`;
    } else if (child.type === "video") {
      const p = progFor(child);
      const done = p && p.completed;
      const active =
        state.currentVideoNode && state.currentVideoNode.path === child.path;
      const pct =
        done
          ? 100
          : p && p.duration
            ? Math.min(100, Math.round((p.position / p.duration) * 100))
            : 0;
      // Posição global da aula no curso (n/total) — contador secundário de
      // cada aula, sempre visível para orientar a navegação.
      const lessonIndex = state.flatVideos.indexOf(child) + 1;
      const lessonTotal = state.flatVideos.length;
      html += `
        <div class="tree-lesson ${done ? "done" : ""} ${active ? "active" : ""}" data-lesson="${encodeURIComponent(child.path)}">
          <button class="check" type="button" data-lesson="${encodeURIComponent(child.path)}" aria-label="${done ? "Desmarcar como assistido" : "Marcar como assistido"}">${done ? "✓" : ""}</button>
          <span class="lesson-title"><span class="lesson-title-inner">${escapeHtml(lessonTitle(child))}</span></span>
          <span class="lesson-mini-progress"><span style="width:${pct}%"></span></span>
          <span class="lesson-counter">${lessonIndex}/${lessonTotal}</span>
        </div>`;
    }
  }
  return html;
}

function updateLessonCompleteButton(videoNode) {
  const btn = document.getElementById("toggle-lesson-complete-btn");
  if (!btn) return;
  const targetVideo = videoNode || state.currentVideoNode;
  if (!targetVideo) return;
  const p = progFor(targetVideo);
  const isDone = !!(p && p.completed);
  btn.classList.toggle("is-completed", isDone);
  const label = isDone
    ? "Desmarcar aula como concluída"
    : "Marcar aula como concluída";
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  const icon = btn.querySelector(".complete-icon");
  if (icon) icon.textContent = isDone ? "✓" : "○";
  const text = btn.querySelector(".complete-text");
  if (text) text.textContent = isDone ? "Concluída" : "Concluir";
}

function toggleLessonCompleted(lessonPath, event) {
  if (event) event.stopPropagation();
  const lesson = state.flatVideos.find((v) => v.path === lessonPath);
  if (!lesson) return;

  const key = progKey(lessonPath, lesson.libId);
  const current = state.progress[key] || {
    position: 0,
    duration: 0,
    completed: false,
  };
  const completed = !current.completed;
  const nextProgress = {
    position: current.position || 0,
    duration: current.duration || 0,
    completed,
    updatedAt: Date.now(),
  };

  state.progress[key] = nextProgress;
  // O servidor deriva a chave (`<libId>\0<rel>`) a partir do path relativo e
  // da biblioteca — envia o rel, não a chave composta. `explicitToggle` marca
  // esta como a ação explícita do usuário que pode regredir `completed` de
  // true para false (o ✓); qualquer outro save normal nunca pode.
  const body = {
    path: lessonPath,
    position: nextProgress.position,
    duration: nextProgress.duration,
    completed,
    explicitToggle: true,
    requestId: newRequestId(),
  };
  if (isExternalLib(lesson.libId)) body.libraryId = lesson.libId;
  fetch("/api/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});

  updateProgressUI();
  renderTree(state.currentCourseNode, false);
  if (state.currentVideoNode && state.currentVideoNode.path === lessonPath) {
    updateLessonCompleteButton(state.currentVideoNode);
  }
}

function toggleFolderExpansion(el, slot) {
  const p = decodeURIComponent(el.dataset.folder);
  const body = slot.querySelector(
    `.tree-folder-children[data-folder-body="${el.dataset.folder}"]`,
  );
  const isOpen = el.classList.toggle("open");
  body.classList.toggle("open", isOpen);
  el.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) expandedFolders.add(p);
  else expandedFolders.delete(p);
  // Acordeão: com a preferência ativa, abrir um módulo (nível 1) fecha os
  // demais módulos abertos do mesmo curso.
  if (isOpen && getSettings().closeOtherModules && el.dataset.depth === "1") {
    closeOtherModules(el, slot);
  }
}

function closeOtherModules(openedEl, slot) {
  slot
    .querySelectorAll('.tree-folder-head[data-depth="1"].open')
    .forEach((other) => {
      if (other === openedEl) return;
      other.classList.remove("open");
      other.setAttribute("aria-expanded", "false");
      expandedFolders.delete(decodeURIComponent(other.dataset.folder));
      const otherBody = slot.querySelector(
        `.tree-folder-children[data-folder-body="${other.dataset.folder}"]`,
      );
      if (otherBody) otherBody.classList.remove("open");
    });
}

function attachTreeHandlers(slot) {
  slot.querySelectorAll(".tree-folder-head").forEach((el) => {
    el.addEventListener("click", () => toggleFolderExpansion(el, slot));
    // Teclado: Enter/Space alterna a expansão, como o clique.
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleFolderExpansion(el, slot);
      }
    });
  });
  slot.querySelectorAll(".tree-lesson").forEach((el) => {
    el.addEventListener("click", () => {
      // Tocar numa aula fecha o drawer mobile. Navegar re-renderiza e fecha
      // igual; este close cobre também o caso de tocar na aula já ativa.
      closeMobileDrawer();
      navigateToLesson(decodeURIComponent(el.dataset.lesson));
    });
  });
  slot.querySelectorAll(".check").forEach((el) => {
    el.addEventListener("click", (event) => {
      toggleLessonCompleted(decodeURIComponent(el.dataset.lesson), event);
    });
  });
  slot
    .querySelectorAll(".tree-lesson, .tree-folder-head")
    .forEach((el) => {
      el.addEventListener("mouseenter", () => startTitleMarquee(el));
      el.addEventListener("mouseleave", () => stopTitleMarquee(el));
    });
}

// Marquee: anima o título apenas quando ele não cabe no item
function getTitleWindow(row) {
  return row.classList.contains("tree-folder-head")
    ? row.querySelector(".folder-title")
    : row.querySelector(".lesson-title");
}

function getTitleInner(row) {
  return row.classList.contains("tree-folder-head")
    ? row.querySelector(".folder-title-inner")
    : row.querySelector(".lesson-title-inner");
}

function startTitleMarquee(row) {
  const inner = getTitleInner(row);
  const win = getTitleWindow(row);
  if (!inner || !win) return;
  row.classList.add("marquee");
  const style = window.getComputedStyle(win);
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  const contentWidth = win.clientWidth - padLeft - padRight;
  const textWidth = inner.scrollWidth;
  const overflow = textWidth - contentWidth;
  if (overflow <= 1) {
    row.classList.remove("marquee");
    return;
  }
  inner.style.setProperty("--marquee-tx", `${-overflow}px`);
  inner.style.setProperty(
    "--marquee-dur",
    `${Math.min(12, 5 + overflow / 60)}s`,
  );
}

function stopTitleMarquee(row) {
  row.classList.remove("marquee");
}

function renderTree(course, resetExpanded) {
  if (resetExpanded) {
    expandedFolders = new Set();
    if (state.currentVideoNode) {
      const ancestors =
        findAncestorFolders(course, state.currentVideoNode.path) || [];
      ancestors.forEach((p) => expandedFolders.add(p));
    }
  }
  const slot = document.getElementById("tree-slot");
  if (!slot) return;
  slot.innerHTML = renderFolderChildren(course);
  attachTreeHandlers(slot);
}

function updateProgressUI() {
  const slot = document.getElementById("tree-slot");
  // No touch não existe :hover, então a guarda antiga re-renderizava a árvore
  // a cada timeupdate (~5s) mesmo com o drawer aberto — o innerHTML resetava
  // o scroll do usuário no meio da leitura da lista. Enquanto o drawer mobile
  // está aberto, o re-render da árvore é pausado (o cabeçalho do sidebar — %,
  // contadores — continua atualizando); a lista volta a atualizar quando o
  // drawer fecha ou ao trocar de aula (o setDrawerOpen ao abrir já refresca).
  const view = document.querySelector(".course-view");
  const drawerOpen = !!(view && view.classList.contains("drawer-open"));
  if (!slot || (!slot.matches(":hover") && !drawerOpen)) {
    renderTree(state.currentCourseNode, false);
  }
  const stats = getNodeProgressStats(state.currentCourseNode, progFor);
  const pct = stats.pct;
  const titleEl = document.querySelector(".sidebar-title .pct");
  if (titleEl) titleEl.textContent = `${pct}%`;
  const progressFill = document.getElementById("course-progress-fill");
  if (progressFill) progressFill.style.width = `${pct}%`;
  const progressCount = document.getElementById("course-progress-count");
  if (progressCount)
    progressCount.textContent = `${stats.done}/${stats.total} aulas concluídas`;
  const progressWatch = document.getElementById("course-progress-watch");
  if (progressWatch)
    progressWatch.textContent = `${formatDuration(stats.watchedSeconds)} assistidos`;
  updateLessonCompleteButton();
}

// Player ativo (para o `beforeunload` único registrar a posição atual).
let currentVideoEl = null;
let currentVideoPersist = null;
// Flush de unload via sendBeacon (sobrevive ao fechamento da página, quando o
// fetch do `persist` seria abortado pelo navegador).
let currentVideoBeacon = null;
// Guarda contra disparos duplicados do fallback de compatibilidade.
let fallbackPreparing = false;

function setupVideoTracking(video) {
  const el = document.getElementById("video-el");
  if (!el) return;
  currentVideoEl = el;
  const saved = progFor(video);
  // Retoma também vídeos marcados como concluídos pelo ✓ (a posição real é
  // preservada). Concluídos por `ended` (position == duration) voltam ao
  // início para reassistir.
  if (
    saved &&
    saved.position > 3 &&
    saved.position < (saved.duration || Infinity) - 2
  ) {
    el.addEventListener(
      "loadedmetadata",
      () => {
        // Na versão transcodificada o fallback cuida da própria retomada
        // (aguarda o trecho virar buffered; seek prematuro falharia).
        if (el.dataset.fallback === "1") return;
        // Nunca buscar até o fim: seek para/ além da duração dispara
        // `ended` falso (auto-avanço sem terminar o vídeo).
        el.currentTime = Math.min(
          saved.position,
          Math.max(0, (el.duration || saved.position) - 1),
        );
      },
      { once: true },
    );
  }

  let lastSaved = 0;
  let wasPlaying = false;
  // Computa o payload de progresso com as mesmas regras de não-perda (posição
  // zerada não apaga progresso válido, auto-conclusão >95%, reassistir não
  // remove conclusão). Reutilizado pelo save normal (fetch) e pelo flush de
  // unload (sendBeacon) para nunca divergirem.
  const progressPayload = (forceCompleted) => {
    const duration = el.duration || (saved && saved.duration) || 0;
    const autoCompleted = duration > 0 && el.currentTime / duration > 0.95;
    const completed = forceCompleted || autoCompleted;
    let position = completed ? duration : el.currentTime;
    const wasCompleted = !!(saved && saved.completed);
    if (wasCompleted && !completed) {
      // Reassistir parcialmente um vídeo já concluído não remove a conclusão;
      // para desmarcar, use o ✓ na árvore de aulas.
      position = Math.max(position, saved.position || 0);
    } else if (!completed && position < 1 && saved && (saved.position || 0) > 1) {
      return null; // posição zerada não apaga progresso válido
    } else if (!completed && position < 1 && duration <= 0) {
      return null; // ainda sem metadados: nada a gravar
    }
    const nextCompleted = completed || wasCompleted;
    // O servidor deriva a chave (`<libId>\0<rel>`) a partir do path relativo e
    // da biblioteca — envia o rel, não a chave composta.
    const body = {
      path: video.path,
      position,
      duration,
      completed: nextCompleted,
      requestId: newRequestId(),
    };
    if (isExternalLib(video.libId)) body.libraryId = video.libId;
    return body;
  };

  const persist = (forceCompleted) => {
    const payload = progressPayload(forceCompleted);
    if (!payload) return;
    state.progress[progKey(video.path, video.libId)] = {
      position: payload.position,
      duration: payload.duration,
      completed: payload.completed,
      updatedAt: Date.now(),
    };
    fetch("/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (res.ok) {
          hideProgressSaveWarning();
        } else {
          // 4xx/5xx do servidor também conta como falha (o save não chegou
          // ao disco) — era invisível antes.
          reportProgressSaveError(new Error("HTTP " + res.status));
        }
      })
      .catch((err) => reportProgressSaveError(err));
  };
  currentVideoPersist = persist;

  // Flush confiável no unload: sendBeacon envia mesmo quando a página está
  // sendo fechada/trocada (o fetch seria abortado). Disparado no beforeunload
  // e no visibilitychange para hidden.
  const persistBeacon = (forceCompleted) => {
    const payload = progressPayload(forceCompleted);
    if (!payload) return;
    try {
      navigator.sendBeacon(
        "/api/progress",
        new Blob([JSON.stringify(payload)], { type: "application/json" }),
      );
    } catch {}
  };
  currentVideoBeacon = persistBeacon;

  el.addEventListener("timeupdate", () => {
    if (el.currentTime - lastSaved > 5) {
      lastSaved = el.currentTime;
      persist(false);
      updateProgressUI();
    }
  });
  el.addEventListener("pause", () => {
    persist(false);
    updateProgressUI();
  });
  el.addEventListener("playing", () => {
    wasPlaying = true;
    setPlayerStatus("");
    hidePreparingBadge();
    el.removeAttribute("data-fallback");
    el.removeAttribute("data-retry-original");
  });
  el.addEventListener("error", () => {
    // Erro na versão transcodificada: o transcode pode ter ficado enfileirado
    // (404 transitório) ou o job falhou de fato — "Tentar novamente" repete o
    // fallback (spec 25, sem loading infinito). O retry do ORIGINAL é tratado
    // à parte, porque voltar ao original é só para quando o fallback nunca
    // funcionou.
    if (el.dataset.fallback === "1") {
      setPlayerStatus(
        "Não foi possível reproduzir a versão compatível deste vídeo.",
        () => {
          el.removeAttribute("data-fallback");
          el.removeAttribute("data-resume");
          fallbackPreparing = false;
          prepareTranscoded(video, el, saved);
        },
      );
      hidePreparingBadge();
      return;
    }
    // O original falhou de novo após um retry: aqui o fallback não é opção
    // (ou o servidor mandou voltar), mostra erro com tentativa original.
    if (el.dataset.retryOriginal === "1") {
      setPlayerStatus(
        "Não foi possível reproduzir este arquivo: o navegador não suporta este formato/codec.",
        () => retryOriginal(el, video),
      );
      hidePreparingBadge();
      return;
    }
    if (fallbackPreparing) return;
    fallbackPreparing = true;
    setPlayerStatus("");
    prepareTranscoded(video, el, saved);
  });
  el.addEventListener("ended", () => {
    persist(true);
    updateProgressUI();
    // `ended` só dispara com reprodução real; sem fallback não há seek
    // espúrio — avançar exige o vídeo ter sido de fato assistido.
    if (!wasPlaying) return;
    const idx = state.flatVideos.indexOf(video);
    const next = state.flatVideos[idx + 1];
    if (next) navigateToLesson(next.path);
  });
}

function setPlayerStatus(text, retry) {
  const el = document.getElementById("player-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("show", !!text);
  if (retry && text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "player-status-retry";
    btn.textContent = "Tentar novamente";
    btn.addEventListener("click", retry);
    el.appendChild(btn);
  }
}

// ---------- Fallback de compatibilidade (transcoding) ----------
// Quando o formato original falha no <video>, o servidor provê uma versão
// MP4/H.264/AAC. O MESMO elemento é reutilizado (preserva o GainNode/Web Audio
// e os listeners de progresso); o transcode pode estar em andamento, então o
// arquivo é servido em crescimento e a posição é retomada quando o trecho
// correspondente virar reproduzível (spec 26/27).
function retryOriginal(el, video) {
  setPlayerStatus("");
  hidePreparingBadge();
  el.removeAttribute("data-fallback");
  el.dataset.retryOriginal = "1";
  el.src = mediaUrl(video.path, video.libId);
  el.load();
}

function canResumeAt(el, target) {
  if (Number.isFinite(el.duration) && el.duration > 0 && target < el.duration) {
    return true;
  }
  for (let i = 0; i < el.buffered.length; i++) {
    if (el.buffered.start(i) <= target && target <= el.buffered.end(i)) {
      return true;
    }
  }
  return false;
}

async function prepareTranscoded(video, el, saved) {
  showPreparingBadge();
  const fail = (message) => {
    hidePreparingBadge();
    setPlayerStatus(message || "Não foi possível preparar a versão compatível deste vídeo.", () => retryOriginal(el, video));
  };
  try {
    const res = await fetch(`/api/video/fallback?path=${encodeURIComponent(video.path)}${libQuery(video)}`);
    const data = await res.json().catch(() => null);
    if (!data) throw new Error("no response");
    if (data.error) return fail(data.message);
    if (data.compatible) {
      // O servidor (ffprobe) diz que o original é reproduzível: tenta de novo.
      hidePreparingBadge();
      el.src = mediaUrl(video.path, video.libId);
      el.load();
      return;
    }

    const wasPlaying = !el.paused && !el.ended;
    const resumeAt =
      saved && saved.position > 3 && saved.position < (saved.duration || Infinity) - 2
        ? saved.position
        : 0;

    el.dataset.fallback = "1";
    el.dataset.resume = String(resumeAt);

    // Retoma assim que o trecho virar buffered (transcode em andamento) e
    // garante volume/mute/ganho após a troca de fonte (spec 27).
    const onReady = () => {
      // Listener órfão (falha → retry do original): não age mais.
      if (el.dataset.fallback !== "1" || el.dataset.retryOriginal === "1") return;
      const target = parseFloat(el.dataset.resume || "0") || 0;
      if (target > 0 && canResumeAt(el, target)) {
        try {
          el.currentTime = target;
        } catch {}
        el.removeAttribute("data-resume");
        applyVolumePrefs(el);
        if (wasPlaying) {
          resumeAudio();
          el.play().catch(() => {});
        }
        hidePreparingBadge();
        el.removeEventListener("loadedmetadata", onReady);
        el.removeEventListener("progress", onReady);
      } else if (target === 0) {
        applyVolumePrefs(el);
        if (wasPlaying) {
          resumeAudio();
          el.play().catch(() => {});
        }
        hidePreparingBadge();
        el.removeEventListener("loadedmetadata", onReady);
        el.removeEventListener("progress", onReady);
      }
    };
    el.addEventListener("loadedmetadata", onReady);
    el.addEventListener("progress", onReady);
    el.addEventListener("playing", () => hidePreparingBadge(), { once: true });

    el.src = data.url;
    el.load();
  } catch {
    fail();
  } finally {
    fallbackPreparing = false;
  }
}

function showPreparingBadge() {
  const badge = document.getElementById("player-preparing");
  if (badge) badge.hidden = false;
}

function hidePreparingBadge() {
  const badge = document.getElementById("player-preparing");
  if (badge) badge.hidden = true;
}

// BUG-006: observabilidade de falha ao salvar progresso. Antes o fetch era
// engolido em silêncio (.catch(() => {})); agora uma falha loga um warn
// throttled no console e liga um badge discreto no player. O retry é
// implícito: o próximo save (timeupdate com throttle de 5s) re-tenta e
// desliga o badge quando volta a funcionar. Nada bloqueia a reprodução.
let progressSaveWarnAt = 0;
function reportProgressSaveError(err) {
  const now = Date.now();
  if (now - progressSaveWarnAt > 15000) {
    progressSaveWarnAt = now;
    console.warn("[PROGRESSO] falha ao salvar progresso:", err);
  }
  const badge = document.getElementById("progress-save-warning");
  if (badge) badge.hidden = false;
}
function hideProgressSaveWarning() {
  const badge = document.getElementById("progress-save-warning");
  if (badge) badge.hidden = true;
}

// Aplica a velocidade salva ao elemento e sincroniza o seletor. Browsers
// resetam `playbackRate` para 1 ao carregar novo recurso (src/load), por
// isso é reaplicada a cada carregamento de metadados.
function applySavedSpeed(videoEl) {
  const savedSpeed = parseFloat(
    localStorage.getItem("course-player-speed") || "1",
  );
  const rate = Number.isFinite(savedSpeed) && savedSpeed > 0 ? savedSpeed : 1;
  if (videoEl && videoEl.playbackRate !== rate) videoEl.playbackRate = rate;
  updateSpeedLabel(videoEl);
}

// ---------- Ícones SVG dos controles do player ----------
function svgIcon(paths, size = 18) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="currentColor" aria-hidden="true">${paths}</svg>`;
}
const ICON_PLAY = svgIcon('<path d="M8 5v14l11-7z"/>');
const ICON_PAUSE = svgIcon('<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>');
const ICON_PLAY_CENTER = svgIcon('<path d="M8 5v14l11-7z"/>', 30);
const ICON_VOLUME_UP = svgIcon('<path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.47 4.47 0 0 0 16.5 12zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>');
const ICON_VOLUME_DOWN = svgIcon('<path d="M18.5 12A4.5 4.5 0 0 0 16 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM9 4.27L5.27 8H1v8h4l5 5V4.27z"/>');
const ICON_VOLUME_MUTED = svgIcon('<path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>');
const ICON_FULLSCREEN = svgIcon('<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>');
const ICON_FULLSCREEN_EXIT = svgIcon('<path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/>');
// Modo teatro (monitor): alterna entre a experiência de tela ampla e a normal.
const ICON_THEATER = svgIcon('<path d="M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l1.6 2.5h-3.2L13 17H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm0 2v8h16V7H4z"/>');
// Sumário (lista): abre/fecha o painel lateral do curso no modo teatro.
const ICON_SUMMARY = svgIcon('<path d="M4 6h9v2H4V6zm0 5h9v2H4v-2zm0 5h9v2H4v-2zm12-10h2v2h-2V6zm2 5h-2v2h2v-2zm0 5h-2v2h2v-2z"/>');
// Legendas: ícone do botão CC (barra do player); o status é um dot anexo.
const ICON_SUBTITLE = svgIcon('<path d="M4 6h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-4l-2 2.5L12 19H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm2 4v2h4v-2H6zm6 0v2h6v-2h-6zM6 14v2h3v-2H6z"/>');
// ⋮ (mais opções): abre o menu de ações avançadas (teatro, sumário).
const ICON_MORE = svgIcon('<path d="M12 7.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>');

function volumeIcon(state) {
  if (state === 0) return ICON_VOLUME_MUTED;
  if (state >= 1) return ICON_VOLUME_UP;
  return ICON_VOLUME_DOWN;
}

// ---------- Volume e ganho extra (Web Audio) ----------
// Volume 0–100% usa video.volume; acima de 100% o excesso vem de um GainNode
// (100% = 1.0, 200% = 2.0). Um único AudioContext por página, reutilizado
// entre aulas; apenas o MediaElementAudioSourceNode é recriado quando o
// elemento <video> muda. Nunca usa video.volume > 1.
let audioCtx = null;
let gainNode = null;
let sourceNode = null;
let sourceEl = null;

// Todos os navegadores modernos têm Web Audio, mas o badge "EXTRA" não pode
// mentir caso o AudioContext esteja indisponível.
const WEB_AUDIO_OK = !!(window.AudioContext || window.webkitAudioContext);

const VOLUME_KEY = "course-player-volume"; // 0–100 (volume nativo)
const GAIN_KEY = "course-player-gain"; // 100–200 (ganho extra via Web Audio)
const MUTED_KEY = "course-player-muted"; // "1"|"0" (estado de mudo)

function getMutedPref() {
  return localStorage.getItem(MUTED_KEY) === "1";
}

function setMutedPref(muted) {
  localStorage.setItem(MUTED_KEY, muted ? "1" : "0");
}

function getVolumePrefs() {
  const volume = parseFloat(localStorage.getItem(VOLUME_KEY) || "100");
  const gain = parseFloat(localStorage.getItem(GAIN_KEY) || "100");
  return {
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(100, volume)) : 100,
    gain: Number.isFinite(gain) ? Math.max(100, Math.min(200, gain)) : 100,
  };
}

function setVolumePrefs(base, gainPct) {
  localStorage.setItem(VOLUME_KEY, String(Math.round(base)));
  localStorage.setItem(GAIN_KEY, String(Math.round(gainPct)));
}

function ensureAudioGraph(videoEl) {
  if (!videoEl) return;
  const prefs = getVolumePrefs();
  // Sem ganho extra (gain <= 100%) o elemento segue roteado direto, sem
  // AudioContext — evita custo e problemas de autoplay policy.
  if (prefs.gain <= 100) return;
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    audioCtx = new Ctor();
    gainNode = audioCtx.createGain();
    gainNode.gain.value = prefs.gain / 100;
    gainNode.connect(audioCtx.destination);
    // O contexto nasce suspenso; se o vídeo já está tocando, retomá-lo aqui
    // evita silêncio até o próximo play/pause (chamada normalmente dentro de
    // um gesto do usuário — ex.: arrastar "Ganho extra" — então resume() ok).
    resumeAudio();
  } else if (gainNode) {
    gainNode.gain.value = prefs.gain / 100;
  }
  // Troca de aula: o elemento mudou → recria apenas o source para ele.
  if (sourceEl !== videoEl) {
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {}
      sourceNode = null;
    }
    try {
      sourceNode = audioCtx.createMediaElementSource(videoEl);
      sourceNode.connect(gainNode);
      sourceEl = videoEl;
    } catch (err) {
      sourceNode = null;
      sourceEl = null;
    }
  }
}

async function resumeAudio() {
  if (audioCtx && audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch {}
  }
}

function detachAudioSource(videoEl) {
  // Aceita chamada sem argumento (troca de rota em route()): apenas zera as
  // referências ao source antigo. O elemento foi destruído pelo re-render,
  // então o disconnect já é desnecessário; o próximo ensureAudioGraph recria
  // o source para o novo elemento.
  if (videoEl && sourceEl === videoEl && sourceNode) {
    try {
      sourceNode.disconnect();
    } catch {}
  }
  sourceNode = null;
  sourceEl = null;
}

function applyVolumePrefs(videoEl) {
  if (!videoEl) return;
  const prefs = getVolumePrefs();
  videoEl.volume = Math.min(1, prefs.volume / 100);
  // Restaura o estado de mudo do usuário (persistido em localStorage, fora do
  // arquivo de progresso das aulas — preferências de volume não se misturam
  // com os dados de progresso).
  videoEl.muted = getMutedPref();
  ensureAudioGraph(videoEl);
  updateVolumeUI(videoEl);
}

function updateVolumeUI(videoEl) {
  const btn = document.getElementById("pc-vol-btn");
  if (!btn) return;
  const label = document.getElementById("pc-vol-label");
  const badge = document.getElementById("pc-extra-badge");
  const icon = document.getElementById("pc-vol-icon");
  const prefs = getVolumePrefs();
  // Sem suporte a Web Audio o ganho extra não é aplicado na prática; mostra
  // só o volume nativo para o badge/label não prometerem um boost inexistente.
  const gainFactor = WEB_AUDIO_OK ? prefs.gain / 100 : 1;
  const eff = (videoEl ? videoEl.volume : 1) * gainFactor;
  const pct = Math.round(eff * 100);
  // O rótulo mostra o volume EFETIVO (volume nativo × ganho). Já o badge
  // "EXTRA" acompanha o slider de ganho (ativo quando >100%), independente do
  // volume base: se o usuário puser 150% de ganho com volume 50%, o resultado
  // é 75% — honesto no rótulo, mas o EXTRA continua indicando que o ganho
  // extra está engajado (antes, esse caso não mostrava indicação nenhuma).
  const extraActive = WEB_AUDIO_OK && prefs.gain > 100;
  if (label) {
    label.textContent = `${pct}%`;
    // Densidade: em volume efetivo 100% (sem ganho extra) o 🔊 sozinho basta;
    // o percentual aparece só quando difere (volume reduzido ou ganho aplicado).
    label.hidden = pct === 100;
  }
  if (badge) {
    if (extraActive) {
      badge.hidden = false;
      badge.textContent = "EXTRA";
      badge.title = `Ganho extra ativo — ${prefs.gain}% (${prefs.gain - 100}% acima do normal)`;
    } else {
      badge.hidden = true;
      badge.textContent = "";
    }
  }
  btn.classList.toggle("extra", extraActive);
  if (icon) {
    const muted = videoEl ? videoEl.muted : false;
    const vol = videoEl ? videoEl.volume : 1;
    icon.innerHTML = volumeIcon(muted || vol <= 0.001 ? 0 : vol >= 1 ? 1 : 2);
  }
  const extra = WEB_AUDIO_OK && prefs.gain > 100 ? prefs.gain - 100 : 0;
  btn.setAttribute(
    "aria-label",
    `Volume ${pct}%${extra > 0 ? `, ganho extra de ${extra}%` : ""}${
      videoEl && videoEl.muted ? ", mutado" : ""
    }`,
  );
}

function updateSpeedLabel(videoEl) {
  const btn = document.getElementById("pc-speed-btn");
  if (!btn) return;
  const rate = (videoEl && videoEl.playbackRate) || 1;
  const text = `${rate % 1 ? rate.toFixed(2).replace(/0$/, "") : rate}×`;
  btn.textContent = text;
  btn.setAttribute("aria-label", `Velocidade de reprodução ${text}`);
  const menu = document.getElementById("pc-speed-menu");
  if (menu) {
    menu.querySelectorAll(".pc-speed-item").forEach((item) => {
      const r = parseFloat(item.dataset.rate);
      item.classList.toggle("active", Math.abs(r - rate) < 0.01);
    });
  }
}

async function togglePlay(videoEl) {
  if (!videoEl) return;
  if (videoEl.paused) {
    ensureAudioGraph(videoEl);
    await resumeAudio();
    videoEl.play().catch(() => {});
  } else {
    videoEl.pause();
  }
}

function closePlayerPopovers() {
  let closed = false;
  const volPop = document.getElementById("pc-vol-pop");
  const volBtn = document.getElementById("pc-vol-btn");
  const speedMenu = document.getElementById("pc-speed-menu");
  const speedBtn = document.getElementById("pc-speed-btn");
  const ccMenu = document.getElementById("pc-cc-menu");
  const ccBtn = document.getElementById("pc-cc-btn");
  const moreMenu = document.getElementById("pc-more-menu");
  const moreBtn = document.getElementById("pc-more-btn");
  if (volPop && !volPop.hidden) {
    volPop.hidden = true;
    volBtn?.setAttribute("aria-expanded", "false");
    closed = true;
  }
  if (speedMenu && !speedMenu.hidden) {
    speedMenu.hidden = true;
    speedBtn?.setAttribute("aria-expanded", "false");
    closed = true;
  }
  if (ccMenu && !ccMenu.hidden) {
    ccMenu.hidden = true;
    ccBtn?.setAttribute("aria-expanded", "false");
    closed = true;
  }
  if (moreMenu && !moreMenu.hidden) {
    moreMenu.hidden = true;
    moreBtn?.setAttribute("aria-expanded", "false");
    closed = true;
  }
  return closed;
}

function renderPlayerAndLesson() {
  const wrap = document.getElementById("player-wrap");
  const header = document.getElementById("lesson-header");
  const materialsSlot = document.getElementById("materials-slot");
  const video = state.currentVideoNode;

  if (!video) {
    wrap.innerHTML = `<div class="player-placeholder">Este curso ainda não possui vídeos.</div>`;
    header.innerHTML = "";
    materialsSlot.innerHTML = "";
    return;
  }

  const idx = state.flatVideos.indexOf(video);
  const prev = state.flatVideos[idx - 1];
  const next = state.flatVideos[idx + 1];
  // Obs.: não há player anterior a limpar aqui — renderCourse() já substituiu
  // o DOM (app.innerHTML) e route() salvou a posição + liberou o source antes
  // do re-render; ensureAudioGraph() recria o source para o novo elemento.

  const speedOptions = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
    .map(
      (r) =>
        `<button type="button" class="pc-speed-item" data-rate="${r}">${r}×</button>`,
    )
    .join("");

  wrap.innerHTML = `
    <video id="video-el" playsinline preload="auto" src="${mediaUrl(video.path, video.libId)}"></video>
    <div class="subtitle-overlay" id="subtitle-overlay" hidden>
      <span class="subtitle-overlay-text">
        <span class="subtitle-grip" aria-hidden="true"></span>
        <span class="subtitle-overlay-inner"></span>
      </span>
    </div>
    <div class="player-preparing" id="player-preparing" hidden>
      <span class="pc-preparing-spinner"></span>
      <span>Preparando compatibilidade...</span>
    </div>
    <div class="player-substatus" id="player-substatus" hidden>
      <span class="pc-preparing-spinner"></span>
      <span id="player-substatus-text">Gerando legenda…</span>
    </div>
    <div class="player-status" id="player-status"></div>
    <div class="player-progress-warning" id="progress-save-warning" hidden>
      <span>⚠ Falha ao salvar progresso</span>
    </div>
    <div class="player-ui" id="player-ui">
      <button class="pc-center hidden" id="pc-play-center" type="button" aria-label="Reproduzir">${ICON_PLAY_CENTER}</button>
      <div class="pc-bottom" id="pc-bottom">
        <div class="pc-progress">
          <input type="range" class="pc-seek" id="pc-seek" min="0" max="1000" step="1" value="0"
                 aria-label="Posição do vídeo" aria-valuetext="0:00" />
          <div class="pc-bar pc-bar-buffered" id="pc-buffered"></div>
          <div class="pc-bar pc-bar-played" id="pc-played"></div>
        </div>
        <div class="pc-row">
          <button class="pc-btn pc-play" id="pc-play" type="button" aria-label="Reproduzir">${ICON_PLAY}</button>
          <span class="pc-time" id="pc-time">0:00 / 0:00</span>
          <span class="pc-spacer"></span>
          <div class="pc-secondary">
            <div class="pc-group pc-group-vol">
              <button class="pc-btn pc-vol-btn" id="pc-vol-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Volume 100%">
                <span class="pc-vol-icon" id="pc-vol-icon">${ICON_VOLUME_UP}</span>
                <span class="pc-vol-label" id="pc-vol-label" hidden>100%</span>
                <span class="pc-extra-badge" id="pc-extra-badge" hidden></span>
              </button>
              <div class="pc-pop pc-vol-pop" id="pc-vol-pop" hidden>
                <label class="pc-slider-row">
                  <span class="pc-slider-name">Volume</span>
                  <input type="range" class="pc-slider" id="pc-vol" min="0" max="100" step="1" value="100" aria-label="Volume" />
                  <span class="pc-slider-val" id="pc-vol-val">100%</span>
                </label>
                <label class="pc-slider-row">
                  <span class="pc-slider-name">Ganho extra</span>
                  <input type="range" class="pc-slider" id="pc-gain" min="100" max="200" step="5" value="100" aria-label="Ganho extra acima de 100%" />
                  <span class="pc-slider-val" id="pc-gain-val">100%</span>
                </label>
                <p class="pc-vol-warn" id="pc-vol-warn" hidden>Volume acima do normal pode causar distorção.</p>
              </div>
            </div>
            <div class="pc-group pc-group-speed">
              <button class="pc-btn pc-speed-btn" id="pc-speed-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Velocidade de reprodução 1×">1×</button>
              <div class="pc-pop pc-speed-menu" id="pc-speed-menu" hidden>${speedOptions}</div>
            </div>
            <div class="pc-group pc-group-cc">
              <button class="pc-btn pc-cc-btn" id="pc-cc-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Legendas" title="Legendas">
                ${ICON_SUBTITLE}
                <span class="pc-cc-dot" id="pc-cc-dot" hidden></span>
              </button>
              <div class="pc-pop pc-cc-menu" id="pc-cc-menu" hidden>
                <div class="pc-menu-group">
                  <span class="pc-menu-label">Idioma</span>
                  <div class="pc-cc-langs" id="pc-cc-langs"></div>
                </div>
                <div class="pc-menu-group pc-menu-sep"></div>
                <div class="pc-menu-group">
                  <button type="button" class="pc-menu-item pc-cc-action" id="pc-cc-action" hidden></button>
                  <span class="pc-cc-status" id="pc-cc-status"></span>
                </div>
              </div>
            </div>
            <button class="pc-btn" id="pc-fullscreen" type="button" aria-label="Tela cheia">${ICON_FULLSCREEN}</button>
            <div class="pc-group pc-group-more">
              <button class="pc-btn pc-more-btn" id="pc-more-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Mais opções" title="Mais opções">${ICON_MORE}</button>
              <div class="pc-pop pc-more-menu" id="pc-more-menu" hidden>
                <button type="button" class="pc-menu-item" data-more="tutor">✨ Tutor IA</button>
                <button type="button" class="pc-menu-item" data-more="theater">Modo teatro</button>
                <button type="button" class="pc-menu-item" data-more="summary">Resumo da aula</button>
                <button type="button" class="pc-menu-item pc-more-narrow" data-more="subtitle-style">Aparência da legenda</button>
                <div class="pc-menu-group pc-more-narrow">
                  <span class="pc-menu-label">Velocidade</span>
                  ${speedOptions}
                </div>
                <div class="pc-menu-group pc-more-narrow" id="pc-more-cc-group">
                  <span class="pc-menu-label">Legendas</span>
                  <div class="pc-cc-langs" id="pc-more-cc-langs"></div>
                  <button type="button" class="pc-menu-item pc-cc-action" id="pc-more-cc-action" hidden></button>
                  <span class="pc-cc-status" id="pc-more-cc-status"></span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const breadcrumb = video.path.split("/").slice(0, -1).join(" / ");
  // Breadcrumb com truncamento inteligente: o prefixo (curso/módulos) encolhe
  // com "…", a última pasta (da aula) fica sempre visível; o caminho completo
  // vai no title para o hover. Nunca força o layout lateralmente.
  const crumbParts = video.path.split("/").slice(0, -1);
  const crumbLeaf = crumbParts.pop() || "";
  // Mobile (<600px): o breadcrumb mostra só o último segmento do prefixo com
  // "…" na frente (ex.: "… / 04 - Projetos / 01 - Introdução ao projeto") —
  // ocupa menos espaço vertical/horizontal. O path real não muda e o caminho
  // completo continua no title do elemento.
  const narrowHeader = window.matchMedia("(max-width: 600px)").matches;
  const showFullPrefix = !narrowHeader || crumbParts.length <= 1;
  const crumbPrefix = showFullPrefix
    ? crumbParts.join(" / ")
    : crumbParts[crumbParts.length - 1];
  const crumbLead =
    showFullPrefix || !crumbParts.length ? "" : "… / ";
  const breadcrumbHtml =
    (crumbPrefix
      ? `<span class="breadcrumb-prefix">${escapeHtml(crumbLead + crumbPrefix)}</span><span class="breadcrumb-sep"> / </span>`
      : ``) + `<span class="breadcrumb-leaf">${escapeHtml(crumbLeaf)}</span>`;
  const p = progFor(video);
  const isDone = !!(p && p.completed);
  header.innerHTML = `
    <div class="lesson-title-row">
      <div class="lesson-title-block">
        <h2 title="${escapeHtml(lessonTitle(video))}">${escapeHtml(lessonTitle(video))}</h2>
        <div class="breadcrumb" title="${escapeHtml(breadcrumb)}">${breadcrumbHtml}</div>
      </div>
      <button id="lesson-sidebar-toggle" class="secondary-btn lesson-sidebar-toggle" type="button" aria-expanded="false" title="Abrir a lista de aulas" aria-label="Abrir a lista de aulas">☰ Aulas</button>
    </div>
    <div class="player-controls">
      <div class="nav-buttons">
        <button id="prev-btn" class="btn-nav" ${prev ? "" : "disabled"} title="Aula anterior">‹ Anterior</button>
        <button id="toggle-lesson-complete-btn" class="btn-nav btn-complete ${isDone ? "is-completed" : ""}" type="button" aria-label="${isDone ? "Desmarcar aula como concluída" : "Marcar aula como concluída"}" title="${isDone ? "Desmarcar aula como concluída" : "Marcar aula como concluída"}">
          <span class="complete-icon" aria-hidden="true">${isDone ? "✓" : "○"}</span>
          <span class="complete-text">${isDone ? "Concluída" : "Concluir"}</span>
        </button>
        <button id="next-btn" class="btn-nav" ${next ? "" : "disabled"} title="Próxima aula">Próxima ›</button>
      </div>
      <button id="tutor-btn" class="secondary-btn tutor-btn" title="Tirar dúvidas com o Tutor IA">✨ Tutor IA</button>
      <button id="subtitle-style-btn" class="secondary-btn" title="Personalizar a aparência da legenda">Aa Aparência</button>
    </div>
    <div class="subtitle-style-panel" id="subtitle-style-panel" hidden>
      <h4>Aparência da legenda</h4>
      <div class="ssp-row">
        <label>Tamanho</label>
        <span class="ssp-size">
          <button type="button" data-size="sm">P</button>
          <button type="button" data-size="md">M</button>
          <button type="button" data-size="lg">G</button>
        </span>
      </div>
      <div class="ssp-row">
        <label>Cor do texto</label>
        <input type="color" id="ssp-text" value="#ffffff">
      </div>
      <div class="ssp-row">
        <label>Fundo</label>
        <span style="display:flex;gap:6px;align-items:center">
          <select id="ssp-bg">
            <option value="none">Sem fundo</option>
            <option value="black">Preto 60%</option>
            <option value="white">Branco 65%</option>
            <option value="custom">Personalizado…</option>
          </select>
          <input type="color" id="ssp-bg-custom" value="#000000" title="Cor personalizada do fundo" hidden>
        </span>
      </div>
      <div class="ssp-row">
        <label>Espaçamento</label>
        <span style="display:flex;gap:8px;align-items:center">
          <input type="range" id="ssp-spacing" min="1" max="1.8" step="0.05" value="1.3">
          <span id="ssp-spacing-val" style="min-width:28px;text-align:right">1.3</span>
        </span>
      </div>
      <div class="ssp-row">
        <label>Contorno</label>
        <input type="checkbox" id="ssp-shadow" checked>
      </div>
      <div class="ssp-row ssp-row-pos">
        <label>Posição</label>
        <button type="button" id="ssp-reset-pos">Restaurar posição padrão</button>
      </div>
      <p class="ssp-hint">Arraste a legenda dentro do vídeo para reposicionar (como no YouTube).</p>
      <div class="ssp-actions">
        <button type="button" id="ssp-reset">Restaurar padrão</button>
      </div>
    </div>`;

  wireSubtitleStylePanel(wrap);

  const parentFolder = findParentFolder(state.currentCourseNode, video.path);
  const files = parentFolder
    ? parentFolder.children.filter((c) => c.type === "file")
    : [];
  materialsSlot.innerHTML = files.length
    ? `
      <div class="materials">
        <h3>Materiais da aula</h3>
        ${files.map((f) => `<a href="${mediaUrl(f.path, f.libId)}" target="_blank" rel="noopener">📎 ${escapeHtml(f.name)}</a>`).join("")}
      </div>`
    : "";

  document
    .getElementById("prev-btn")
    ?.addEventListener("click", () => prev && navigateToLesson(prev.path));
  document
    .getElementById("toggle-lesson-complete-btn")
    ?.addEventListener("click", () => toggleLessonCompleted(video.path));
  document
    .getElementById("next-btn")
    ?.addEventListener("click", () => next && navigateToLesson(next.path));
  document
    .getElementById("tutor-btn")
    ?.addEventListener("click", () => toggleTutorDrawer(video));

  // Drawer mobile: abre/fecha pelo botão "☰ Aulas" e fecha ao tocar o backdrop.
  document
    .getElementById("lesson-sidebar-toggle")
    ?.addEventListener("click", () => toggleDrawer());
  document
    .getElementById("sidebar-backdrop")
    ?.addEventListener("click", () => closeMobileDrawer());

  const videoEl = document.getElementById("video-el");
  if (videoEl) {
    applySavedSpeed(videoEl);
    setupVideoTracking(video);
    applyVolumePrefs(videoEl);
    wirePlayerUI(videoEl);
    // Sincroniza o Tutor IA com a nova aula ativa caso esteja aberto
    if (tutorState.open) {
      tutorState.currentVideo = video;
      updateTutorContextMeta(video, true);
      renderTutorMessages(video);
    }
    // Legendas por IA: NUNCA bloqueia a reprodução. O vídeo toca primeiro;
    // o badge de status é discreto (sem modal). No modo editor, o overlay de
    // preview é de responsabilidade do editor (overlayOwnedByEditor) — o
    // setup só cuida do badge/geração e não sobrescreve a cópia de trabalho.
    setupPlayerSubtitles(videoEl, video, { overlayOwnedByEditor: subtitleEditorMode });
  }
}

function wirePlayerUI(videoEl) {
  const wrap = document.getElementById("player-wrap");
  const playBtn = document.getElementById("pc-play");
  const centerBtn = document.getElementById("pc-play-center");
  const seek = document.getElementById("pc-seek");
  const playedEl = document.getElementById("pc-played");
  const bufferedEl = document.getElementById("pc-buffered");
  const timeEl = document.getElementById("pc-time");
  const volBtn = document.getElementById("pc-vol-btn");
  const volPop = document.getElementById("pc-vol-pop");
  const volRange = document.getElementById("pc-vol");
  const gainRange = document.getElementById("pc-gain");
  const volVal = document.getElementById("pc-vol-val");
  const gainVal = document.getElementById("pc-gain-val");
  const volWarn = document.getElementById("pc-vol-warn");
  const speedBtn = document.getElementById("pc-speed-btn");
  const speedMenu = document.getElementById("pc-speed-menu");
  const fullscreenBtn = document.getElementById("pc-fullscreen");
  const ccBtn = document.getElementById("pc-cc-btn");
  const ccMenu = document.getElementById("pc-cc-menu");
  const moreBtn = document.getElementById("pc-more-btn");
  const moreMenu = document.getElementById("pc-more-menu");
  if (!videoEl || !wrap) return;

  const fmtClock = (s) => {
    const total = Math.max(0, Math.floor(Number.isFinite(s) ? s : 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    if (h > 0)
      return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    return `${m}:${String(sec).padStart(2, "0")}`;
  };

  const closePopovers = () => {
    if (volPop) volPop.hidden = true;
    if (speedMenu) speedMenu.hidden = true;
    if (ccMenu) ccMenu.hidden = true;
    if (moreMenu) moreMenu.hidden = true;
    if (volBtn) volBtn.setAttribute("aria-expanded", "false");
    if (speedBtn) speedBtn.setAttribute("aria-expanded", "false");
    if (ccBtn) ccBtn.setAttribute("aria-expanded", "false");
    if (moreBtn) moreBtn.setAttribute("aria-expanded", "false");
  };

  const setSliderFill = (el, val, min, max) => {
    if (!el) return;
    const pct = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
    el.style.setProperty("--fill", `${pct}%`);
  };

  const updateSeekUI = () => {
    const dur = Number.isFinite(videoEl.duration) ? videoEl.duration : 0;
    const cur = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
    if (seek) {
      if (dur > 0) {
        seek.value = String(Math.round((cur / dur) * 1000));
        seek.setAttribute("aria-valuetext", fmtClock(cur));
      } else {
        seek.value = "0";
        seek.setAttribute("aria-valuetext", "0:00");
      }
    }
    if (playedEl)
      playedEl.style.width =
        dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%";
    if (timeEl) timeEl.textContent = `${fmtClock(cur)} / ${fmtClock(dur)}`;
  };

  const updateBuffered = () => {
    if (!bufferedEl) return;
    let pct = 0;
    if (videoEl.buffered && videoEl.buffered.length) {
      const dur = videoEl.duration;
      if (dur > 0) {
        pct = Math.min(
          100,
          (videoEl.buffered.end(videoEl.buffered.length - 1) / dur) * 100,
        );
      }
    }
    bufferedEl.style.width = `${pct}%`;
  };

  const updatePlayIcons = () => {
    if (!playBtn || !centerBtn) return;
    const paused = videoEl.paused;
    const label = paused ? "Reproduzir" : "Pausar";
    playBtn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
    playBtn.setAttribute("aria-label", label);
    centerBtn.setAttribute("aria-label", label);
    centerBtn.classList.toggle("hidden", !paused);
    if (paused) showControls();
  };

  // --- autohide (somente desktop com mouse; nunca com popover aberto) ---
  const canAutoHide = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  let hideTimer = null;
  const isPopoverOpen = () =>
    (volPop && !volPop.hidden) ||
    (speedMenu && !speedMenu.hidden) ||
    (ccMenu && !ccMenu.hidden) ||
    (moreMenu && !moreMenu.hidden);
  const showControls = () => {
    wrap.classList.remove("pc-idle");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
  };
  const scheduleHide = () => {
    if (!canAutoHide || videoEl.paused || isPopoverOpen()) return;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!videoEl.paused && !isPopoverOpen()) wrap.classList.add("pc-idle");
    }, 2500);
  };
  // Interação (mouse, toque, foco) mostra a barra E reinicia o timer de
  // ocultação — depois que o usuário para, a barra volta a sumir no idle.
  const wakeControls = () => {
    showControls();
    scheduleHide();
  };
  wrap.addEventListener("mousemove", wakeControls);
  wrap.addEventListener("touchstart", wakeControls, { passive: true });
  wrap.addEventListener("mouseleave", scheduleHide);
  wrap.addEventListener("focusin", wakeControls);
  // --- fim autohide ---

  const refreshWarn = () => {
    if (!volWarn) return;
    const prefs = getVolumePrefs();
    const gainFactor = WEB_AUDIO_OK ? prefs.gain / 100 : 1;
    volWarn.hidden = videoEl.volume * gainFactor <= 1;
  };

  const applyVolumeFromPrefs = () => {
    const prefs = getVolumePrefs();
    if (volRange) {
      volRange.value = String(prefs.volume);
      setSliderFill(volRange, prefs.volume, 0, 100);
    }
    if (gainRange) {
      gainRange.value = String(prefs.gain);
      setSliderFill(gainRange, prefs.gain, 100, 200);
    }
    if (volVal) volVal.textContent = `${prefs.volume}%`;
    if (gainVal) gainVal.textContent = `${prefs.gain}%`;
    updateVolumeUI(videoEl);
    refreshWarn();
  };

  // --- eventos ---
  if (playBtn) playBtn.addEventListener("click", () => togglePlay(videoEl));
  if (centerBtn) centerBtn.addEventListener("click", () => togglePlay(videoEl));
  // Clique em área vazia do vídeo também alterna play/pause.
  wrap.addEventListener("click", (e) => {
    // Soltar a legenda arrastada dispara um `click` sintético que não pode
    // virar play/pause (o arraste é uma ação do usuário sobre a legenda).
    if (subtitleDragSuppressClick) {
      subtitleDragSuppressClick = false;
      return;
    }
    if (e.target.closest(".player-ui")) return;
    togglePlay(videoEl);
  });

  if (seek) {
    seek.addEventListener("input", () => {
      const dur = videoEl.duration;
      if (Number.isFinite(dur) && dur > 0) {
        videoEl.currentTime = (seek.valueAsNumber / 1000) * dur;
      }
      seek.setAttribute("aria-valuetext", fmtClock(videoEl.currentTime));
    });
  }

  if (volBtn) {
    volBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = volPop.hidden;
      closePopovers();
      volPop.hidden = !willOpen;
      volBtn.setAttribute("aria-expanded", String(!willOpen));
      if (!willOpen) volRange?.focus();
    });
  }
  if (volRange) {
    volRange.addEventListener("input", () => {
      // Arrastar o volume desfaz o mute (padrão de players de mídia) e
      // sincroniza o estado persistido de mudo.
      if (videoEl.muted) {
        videoEl.muted = false;
        setMutedPref(false);
      }
      videoEl.volume = volRange.valueAsNumber / 100;
      if (volVal) volVal.textContent = `${volRange.value}%`;
      setSliderFill(volRange, volRange.valueAsNumber, 0, 100);
      setVolumePrefs(volRange.valueAsNumber, getVolumePrefs().gain);
      updateVolumeUI(videoEl);
      refreshWarn();
    });
  }
  if (gainRange) {
    gainRange.addEventListener("input", () => {
      const gain = gainRange.valueAsNumber;
      if (gainVal) gainVal.textContent = `${gain}%`;
      setSliderFill(gainRange, gain, 100, 200);
      setVolumePrefs(getVolumePrefs().volume, gain);
      if (gain > 100) ensureAudioGraph(videoEl);
      if (gainNode) gainNode.gain.value = gain / 100;
      updateVolumeUI(videoEl);
      refreshWarn();
    });
  }

  if (speedBtn && speedMenu) {
    speedBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = speedMenu.hidden;
      closePopovers();
      speedMenu.hidden = !willOpen;
      speedBtn.setAttribute("aria-expanded", String(!willOpen));
    });
  }
  if (ccBtn && ccMenu) {
    ccBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = ccMenu.hidden;
      closePopovers();
      ccMenu.hidden = !willOpen;
      ccBtn.setAttribute("aria-expanded", String(!willOpen));
    });
  }
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = moreMenu.hidden;
      closePopovers();
      moreMenu.hidden = !willOpen;
      moreBtn.setAttribute("aria-expanded", String(!willOpen));
    });
  }
  // Velocidade: um único binding para os itens dos dois menus (barra + ⋮),
  // assim o .pc-speed-item do menu ⋮ não fica órfão de handler.
  wrap.querySelectorAll(".pc-speed-item").forEach((item) => {
    item.addEventListener("click", () => {
      const rate = parseFloat(item.dataset.rate);
      videoEl.playbackRate = rate;
      localStorage.setItem("course-player-speed", String(rate));
      updateSpeedLabel(videoEl);
      closePopovers();
    });
  });
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener("click", () =>
      togglePlayerFullscreen(videoEl),
    );
  }
  // Delegation do player: ações avançadas (⋮) e do menu CC. Alternar teatro/
  // sumário não re-renderiza o player (o vídeo segue tocando sem reiniciar).
  wrap.addEventListener("click", (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      e.stopPropagation();
      if (more.dataset.more === "tutor") toggleTutorDrawer(state.currentVideoNode);
      else if (more.dataset.more === "theater") toggleTheaterMode();
      else if (more.dataset.more === "summary") toggleSummaryPanel();
      else if (more.dataset.more === "subtitle-style") toggleSubtitleStylePanel();
      closePopovers();
      return;
    }
    const cc = e.target.closest("[data-cc]");
    if (!cc) return;
    e.stopPropagation();
    if (cc.dataset.cc === "action") {
      requestSubtitleGenerate();
      closePopovers();
    } else if (cc.dataset.cc === "off") {
      setSubtitleEnabled(false);
      closePopovers();
    } else if (cc.dataset.cc === "lang-source") {
      setSubtitleLang(null);
      closePopovers();
    } else if (cc.dataset.cc && cc.dataset.cc.indexOf("lang-") === 0) {
      setSubtitleLang(cc.dataset.cc.slice(5));
      closePopovers();
    }
  });

  // Obs.: timeupdate NÃO rearma o timer de ocultação — se rearmasse a cada
  // tick (~250ms), a barra nunca chegaria a sumir durante a reprodução. O
  // timer só é rearmado por interação do usuário (wakeControls) e no `playing`.
  videoEl.addEventListener("timeupdate", updateSeekUI);
  videoEl.addEventListener("durationchange", updateSeekUI);
  videoEl.addEventListener("loadedmetadata", updateSeekUI);
  videoEl.addEventListener("progress", updateBuffered);
  videoEl.addEventListener("playing", () => {
    updatePlayIcons();
    scheduleHide();
  });
  videoEl.addEventListener("pause", updatePlayIcons);
  videoEl.addEventListener("volumechange", () => updateVolumeUI(videoEl));

  applyVolumeFromPrefs();
  updateSeekUI();
  updatePlayIcons();
  updateSpeedLabel(videoEl);
  // Estado inicial dos botões de teatro/sumário e das classes do layout.
  applyViewModeToDOM();
}

// ---------- Legendas por IA (estágio 6) ----------
// Integração NÃO-bloqueante com o player: o vídeo toca primeiro; quando a
// legenda está pronta, o texto é exibido no overlay .subtitle-overlay (nunca
// via <track>). Se o modo de geração for automático e não houver legenda,
// dispara a geração em segundo plano. O status aparece num badge discreto
// (nunca um modal): "Legenda disponível", "Gerando legenda…", "Legenda
// indisponível" ou "Erro ao gerar".
let subtitlePollTimer = null;
// Último idioma cujo overlay foi carregado (por aula); muda ⇒ recarrega mesmo
// com `overlayLoaded` ligado (troca de idioma no menu CC).
let subtitleLastLoadedLang = null;
// Guarda de P1: só antecipa a próxima aula uma vez por montagem do player
// (o backend já dedupa, mas isto evita POSTs repetidos a cada sondagem).
let subtitlePregenNextPath = null;
// Editor de legendas: modo ativo (rota ?editSubtitles=1), hash de restauração
// e supressão da guarda suja (evita loop ao restaurar o hash no cancelamento).
let subtitleEditorMode = false;
let editorActiveHash = "";
let dirtyGuardSuppressed = false;

// ==========================================================================
// Overlay de legendas — estado + geometria.
// ==========================================================================
// Estado do overlay da aula atual. `segments` é a cópia de trabalho servida
// pelo backend (fonte: edição manual > processed > VTT do curso; nunca raw).
// `frame`/`fontPx`/`bottomInset` são recalculados em resize/fullscreen/idle.
const subtitleState = {
  hash: null,
  rel: null,
  libId: null,
  ready: false,
  source: null, // 'edited' | 'processed' | 'vtt' | 'translated' | null
  edited: false,
  staleSource: false,
  segments: [],
  currentIndex: -1,
  frame: null, // {left,top,width,height} relativo ao player-wrap
  fontPx: 0,
  bottomInset: 0,
  // Estado exibido no botão CC (barra): 'ready' | 'stale' | 'generating' |
  // 'waiting' | 'failed' | 'unavailable' | null. Preferência Ligado/Desativado
  // (localStorage) decide se o overlay aparece mesmo com legenda pronta.
  ccKind: null,
  enabled: true,
  // Idiomas (preenchidos pela sondagem do status): `lang` = idioma ativo
  // (null = original), `sourceLang` = língua-fonte da transcrição, `targetLang`
  // = idioma-alvo de tradução configurado, `canTranslate` = LLM habilitado.
  lang: null,
  sourceLang: null,
  targetLang: null,
  canTranslate: false,
  // Posição arrastável da legenda (como no YouTube): normalizada e por aula —
  // `pos.v` = fração da altura do quadro medida da base (0 = padrão, 1 = topo),
  // `pos.h` = fração horizontal do centro (0.5 = centro). null = padrão.
  // Reiniciada a cada aula (setupPlayerSubtitles), como o YouTube.
  pos: null,
  // Percentual real do job ativo (progresso do whisper via -pp), p/ o badge.
  percent: null,
};

// ---------------------------------------------------------------------------
// Botão CC + menu (legendas). O status é "exibido" pelo dot do botão e pelos
// itens do menu — nenhum badge flutuante sobre o vídeo (reduz densidade).
// A preferência Ligado/Desativado fica no localStorage (nunca no servidor).
// ---------------------------------------------------------------------------
const SUBTITLES_ENABLED_KEY = "course-player-subtitles-enabled";
// Idioma de exibição escolhido (localStorage, padrão global): "original" ou um
// id de idioma de tradução (ex. "pt"). O id exibido cai para "original" quando
// a aula não oferece tradução (língua-fonte == alvo ou sem LLM).
const SUBTITLES_LANG_KEY = "course-player-subtitles-lang";
// Nomes curtos (sem "Brasil" etc.) para o menu CC não alargar; o idioma-fonte
// aparece como "Original (<nome>)".
const SUBTITLE_LANG_NAMES = {
  auto: "Detecção automática",
  pt: "Português",
  en: "Inglês",
  es: "Espanhol",
  fr: "Francês",
  de: "Alemão",
  it: "Italiano",
  nl: "Holandês",
  ja: "Japonês",
  ko: "Coreano",
  zh: "Chinês",
  ru: "Russo",
};
function subtitleLangName(id) {
  return SUBTITLE_LANG_NAMES[id] || id || "Original";
}
function getSubtitleLang() {
  const v = localStorage.getItem(SUBTITLES_LANG_KEY) || "original";
  return /^[a-z]{2,10}$/.test(v) ? v : null;
}

function getSubtitleEnabled() {
  return localStorage.getItem(SUBTITLES_ENABLED_KEY) !== "0";
}
function setSubtitleEnabled(v) {
  subtitleState.enabled = !!v;
  try {
    localStorage.setItem(SUBTITLES_ENABLED_KEY, v ? "1" : "0");
  } catch {}
  applySubtitleVisibility();
  syncSubtitleCcUi();
  if (v && typeof subtitleCheckApi === "function") subtitleCheckApi();
}

// Troca o idioma de exibição da legenda da aula atual (null = original, ou o
// id do idioma-alvo de tradução). Selecionar um idioma liga as legendas. A
// sondagem (check) recarrega o overlay e dispara a geração da tradução se
// preciso — sem nunca bloquear a reprodução.
function setSubtitleLang(lang) {
  subtitleState.lang = lang || null;
  try {
    localStorage.setItem(SUBTITLES_LANG_KEY, subtitleState.lang || "original");
  } catch {}
  setSubtitleEnabled(true);
  syncSubtitleCcUi();
  if (typeof subtitleCheckApi === "function") subtitleCheckApi();
  applySubtitleVisibility();
}

// Mostra/esconde o overlay conforme prontidão + preferência, sem recarregar os
// segmentos — apenas reaplica a geometria quando volta a exibir.
function applySubtitleVisibility() {
  const overlay = document.getElementById("subtitle-overlay");
  if (!overlay) return;
  const show = subtitleState.ready && subtitleState.enabled;
  overlay.hidden = !show;
  if (show) {
    wireSubtitleGeometry();
    const v = document.getElementById("video-el");
    if (v) {
      updateSubtitleOverlay(typeof v.currentTime === "number" ? v.currentTime : 0);
    }
  } else {
    teardownSubtitleGeometry();
  }
}

// Re-aplica o estado do botão CC, do dot de status e dos itens dos menus
// (CC na barra e grupo "Legendas" do ⋮ no mobile). Texto longo só em tooltip/aria.
function syncSubtitleCcUi() {
  const kind = subtitleState.ccKind || null;
  const enabled = subtitleState.enabled !== false;
  const btn = document.getElementById("pc-cc-btn");
  const dot = document.getElementById("pc-cc-dot");
  let cls = "";
  let title = "Legendas";
  if (kind === "ready" || kind === "stale") {
    if (enabled) {
      cls = "is-ready";
      title =
        kind === "stale"
          ? "Legenda de vídeo alterado — regenerar para atualizar"
          : "Legendas disponíveis";
    } else {
      cls = "is-off";
      title = "Legendas desativadas";
    }
  } else if (kind === "generating") {
    cls = "is-generating";
    title = "Gerando legendas…";
  } else if (kind === "waiting") {
    cls = "is-waiting";
    title = "Legenda aguardando a fonte do vídeo";
  } else if (kind === "failed") {
    cls = "is-failed";
    title = "Falha ao gerar legendas — menu permite tentar de novo";
  } else if (kind === "unavailable") {
    cls = "is-off";
    title = "Legendas indisponíveis — o menu permite gerar";
  } else if (kind === "no-translate") {
    cls = "is-off";
    title = "Tradução indisponível — configure um LLM na Central de IA";
  } else if (kind === "off") {
    cls = "is-off";
    title = "Legendas desativadas";
  }
  if (btn) {
    btn.classList.remove("is-ready", "is-generating", "is-waiting", "is-failed", "is-off");
    if (cls) btn.classList.add(cls);
    btn.setAttribute("aria-label", title);
    btn.title = title;
  }
  if (dot) {
    // Com legendas desativadas o botão fica limpo (is-off), sem dot — a não ser
    // que um job ainda rode (gerando/aguardando/falha), que continua informado.
    const active = ["ready", "stale", "generating", "waiting", "failed"].includes(kind);
    const showDot =
      active &&
      (enabled || kind === "generating" || kind === "waiting" || kind === "failed");
    dot.hidden = !showDot;
    dot.textContent = kind === "failed" || kind === "waiting" ? "!" : "";
  }
  // Seletor de idioma (Original / <tradução> / Desativado) — montado nos dois
  // menus (barra e ⋮ mobile). `activeLang` = idioma ativo; quando o escolhido
  // é a língua-fonte ou a tradução não está disponível, o "Original" é o ativo.
  const activeLang =
    subtitleState.lang &&
    subtitleState.targetLang &&
    subtitleState.lang === subtitleState.targetLang &&
    subtitleState.targetLang !== subtitleState.sourceLang
      ? subtitleState.lang
      : null;
  const srcLabel =
    "Original" +
    (subtitleState.sourceLang
      ? ` (${escapeHtml(subtitleLangName(subtitleState.sourceLang))})`
      : "");
  const isSrcActive = enabled && activeLang === null;
  const isTrActive = (t) => enabled && activeLang === t;
  const isOffActive = !enabled;

  const langItems = [
    `<button type="button" class="pc-menu-item${isSrcActive ? " is-active" : ""}" data-cc="lang-source" aria-pressed="${isSrcActive}">${escapeHtml(srcLabel)}</button>`,
  ];
  if (
    subtitleState.targetLang &&
    subtitleState.targetLang !== subtitleState.sourceLang
  ) {
    const t = subtitleState.targetLang;
    langItems.push(
      `<button type="button" class="pc-menu-item${isTrActive(t) ? " is-active" : ""}" data-cc="lang-${escapeHtml(t)}" aria-pressed="${isTrActive(t)}">${escapeHtml(subtitleLangName(t))}</button>`,
    );
  }
  langItems.push(
    `<button type="button" class="pc-menu-item${isOffActive ? " is-active" : ""}" data-cc="off" aria-pressed="${isOffActive}">Desativado</button>`,
  );
  const langsHtml = langItems.join("");
  ["pc-cc-langs", "pc-more-cc-langs"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && el.innerHTML !== langsHtml) el.innerHTML = langsHtml;
  });
  // Ação contextual (Gerar/Regenerar) e linha de status.
  const statusEls = [
    document.getElementById("pc-cc-status"),
    document.getElementById("pc-more-cc-status"),
  ].filter(Boolean);
  const actionEls = [
    document.getElementById("pc-cc-action"),
    document.getElementById("pc-more-cc-action"),
  ].filter(Boolean);
  let statusText = "";
  let actionText = "";
  let showAction = false;
  if (kind === "generating") statusText = "Gerando legenda…";
  else if (kind === "waiting") statusText = "Aguardando o dispositivo…";
  else if (kind === "no-translate") statusText = "Tradução indisponível — configure um LLM";
  else if (kind === "failed") {
    statusText = "Erro ao gerar — tente novamente";
    actionText = "Gerar legenda";
    showAction = true;
  } else if (kind === "unavailable") {
    actionText = "Gerar legenda";
    showAction = true;
  } else if (kind === "ready" || kind === "stale") {
    actionText = "Regenerar";
    showAction = true;
  }
  statusEls.forEach((el) => {
    el.textContent = statusText;
    el.hidden = !statusText;
  });
  actionEls.forEach((el) => {
    el.textContent = actionText;
    el.hidden = !showAction;
  });
  updateSubtitleBadge();
}

// Badge não-bloqueante sobre o player: feedback VISÍVEL de que a legenda está
// sendo gerada (ou aguardando a fonte) — o dot do botão CC sozinho era sutil
// demais. Some quando pronto/falha/desativado. Reusa o spinner do transcode.
function updateSubtitleBadge() {
  const badge = document.getElementById("player-substatus");
  if (!badge) return;
  const kind = subtitleState.ccKind || null;
  let msg = "";
  if (kind === "generating") {
    const isTranslation =
      subtitleState.lang &&
      subtitleState.targetLang &&
      subtitleState.lang === subtitleState.targetLang &&
      subtitleState.targetLang !== subtitleState.sourceLang;
    msg = isTranslation ? "Traduzindo…" : "Gerando legenda…";
    if (typeof subtitleState.percent === "number") {
      msg += " " + Math.round(subtitleState.percent) + "%";
    }
  } else if (kind === "waiting") {
    msg = "Aguardando o dispositivo…";
  }
  badge.hidden = !msg;
  const textEl = badge.querySelector("#player-substatus-text");
  if (textEl && textEl.textContent !== msg) textEl.textContent = msg;
}

// Dispara a geração/regeneração da legenda da aula atual a partir do menu CC.
// O backend dedupa; `force` regenera do zero quando já existe ou falhou.
let subtitleGenerateApi = null; // preenchido em setupPlayerSubtitles
// Re-sondagem do status (usado por setSubtitleLang ao trocar o idioma).
let subtitleCheckApi = null; // preenchido em setupPlayerSubtitles
function requestSubtitleGenerate() {
  if (subtitleGenerateApi) subtitleGenerateApi();
}

// ---------------------------------------------------------------------------
// Aparência da legenda (personalização, mantendo o visual padrão por default).
// Preferência local (localStorage), mesmo padrão dos demais controles do player.
// ---------------------------------------------------------------------------
const SUBTITLE_STYLE_KEY = "course-player-subtitle-style";
const SUBTITLE_STYLE_DEFAULT = {
  size: "md", // 'sm' | 'md' | 'lg' — escala sobre a fonte base proporcional ao quadro
  textColor: "#ffffff",
  bg: "none", // 'none' | 'black' | 'white' | 'custom'
  bgCustom: "#000000",
  spacing: 1.3, // line-height (espaço entre linhas)
  shadow: true, // contorno preto (legibilidade)
};
const SUBTITLE_STYLE_SCALE = { sm: 0.85, md: 1, lg: 1.25 };

function loadSubtitleStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem(SUBTITLE_STYLE_KEY) || "null");
    return { ...SUBTITLE_STYLE_DEFAULT, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch {
    return { ...SUBTITLE_STYLE_DEFAULT };
  }
}
function saveSubtitleStyle(style) {
  try {
    localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(style));
  } catch {}
}

// Aplica o estilo (vars CSS) a um overlay. Chamado na montagem e a cada
// mudança das opções (efeito ao vivo no player e no preview do editor).
function applySubtitleStyle(overlay) {
  if (!overlay) return;
  const s = loadSubtitleStyle();
  const bg =
    s.bg === "black"
      ? "rgba(0,0,0,0.6)"
      : s.bg === "white"
        ? "rgba(255,255,255,0.65)"
        : s.bg === "custom"
          ? s.bgCustom
          : "transparent";
  overlay.style.setProperty("--st-text-color", s.textColor);
  overlay.style.setProperty("--st-bg-color", bg);
  overlay.style.setProperty("--st-line-height", String(s.spacing));
  overlay.style.setProperty(
    "--st-shadow",
    s.shadow ? "0 1px 3px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.55)" : "none",
  );
}

// Sincroniza o painel de aparência com o estilo salvo.
function syncSubtitleStylePanel(panel) {
  if (!panel) return;
  const s = loadSubtitleStyle();
  panel.querySelectorAll(".ssp-size button").forEach((b) => {
    if (b.dataset.size === s.size) b.setAttribute("data-active", "");
    else b.removeAttribute("data-active");
  });
  const text = panel.querySelector("#ssp-text");
  if (text) text.value = /^#[0-9a-f]{6}$/i.test(s.textColor) ? s.textColor : "#ffffff";
  const bg = panel.querySelector("#ssp-bg");
  if (bg) bg.value = s.bg;
  const bgCustom = panel.querySelector("#ssp-bg-custom");
  if (bgCustom) {
    bgCustom.hidden = s.bg !== "custom";
    bgCustom.value = /^#[0-9a-f]{6}$/i.test(s.bgCustom) ? s.bgCustom : "#000000";
  }
  const spacing = panel.querySelector("#ssp-spacing");
  if (spacing) spacing.value = String(s.spacing);
  const spacingVal = panel.querySelector("#ssp-spacing-val");
  if (spacingVal) spacingVal.textContent = String(s.spacing);
  const shadow = panel.querySelector("#ssp-shadow");
  if (shadow) shadow.checked = !!s.shadow;
}

// Aplica uma mudança de aparência ao vivo (overlay + painel + preferência).
function applySubtitleStyleChange(panel) {
  const s = loadSubtitleStyle();
  const sizeBtn = panel.querySelector(".ssp-size button[data-active]");
  if (sizeBtn) s.size = sizeBtn.dataset.size;
  const text = panel.querySelector("#ssp-text");
  if (text) s.textColor = text.value;
  const bg = panel.querySelector("#ssp-bg");
  if (bg) s.bg = bg.value;
  const bgCustom = panel.querySelector("#ssp-bg-custom");
  if (bgCustom) s.bgCustom = bgCustom.value;
  const spacing = panel.querySelector("#ssp-spacing");
  if (spacing) s.spacing = Number(spacing.value);
  const shadow = panel.querySelector("#ssp-shadow");
  if (shadow) s.shadow = shadow.checked;
  saveSubtitleStyle(s);
  applySubtitleStyle(document.getElementById("subtitle-overlay"));
  applySubtitleGeometry();
  syncSubtitleStylePanel(panel);
}

// Abre o painel de aparência da legenda. No desktop ele ancora no botão
// "Aa Aparência" (absolute dentro do .lesson-header); no mobile (<600px) o
// botão sai da toolbar e o acesso vira o item ⋮ > Aparência da legenda —
// o painel abre centralizado na tela (position: fixed, via CSS).
function subtitleStyleOpen() {
  const panel = document.getElementById("subtitle-style-panel");
  const btn = document.getElementById("subtitle-style-btn");
  if (!panel) return;
  if (window.matchMedia("(max-width: 600px)").matches) {
    // Centralizado fixo: o CSS posiciona; limpa o top/left inline para o
    // position:fixed da media query valer.
    panel.style.top = "";
    panel.style.left = "";
    panel.hidden = false;
    return;
  }
  const br = btn.getBoundingClientRect();
  // offsetWidth/offsetHeight são 0 enquanto o painel está [hidden]
  // (display:none) — sem esse fallback a largura 0 fazia o painel abrir com
  // a borda esquerda na borda direita do botão e transbordar a viewport.
  const pw = panel.offsetWidth || 250;
  const ph = panel.offsetHeight || 240;
  // Posição desejada no viewport, clampada para nunca gerar overflow
  // horizontal/vertical, qualquer que seja a largura da janela.
  const topVp = Math.max(8, Math.min(br.bottom + 6, window.innerHeight - ph - 8));
  const leftVp = Math.max(8, Math.min(br.right - pw, window.innerWidth - pw - 8));
  // O painel é absolute dentro do .lesson-header (position: relative): a
  // posição viewport é convertida para o sistema de coordenadas do anchor.
  const ar = panel.parentElement.getBoundingClientRect();
  panel.style.top = Math.round(topVp - ar.top) + "px";
  panel.style.left = Math.round(leftVp - ar.left) + "px";
  panel.hidden = false;
}

function subtitleStyleClose() {
  const panel = document.getElementById("subtitle-style-panel");
  if (panel) panel.hidden = true;
}

function toggleSubtitleStylePanel() {
  const panel = document.getElementById("subtitle-style-panel");
  if (!panel) return;
  if (panel.hidden) subtitleStyleOpen();
  else subtitleStyleClose();
}

// Botão "Aa Aparência" no player (desktop) + item ⋮ > Aparência da legenda
// (mobile): abrem um popover com as opções de personalização da legenda
// (tamanho, cor do texto, fundo, espaçamento, contorno). Persistido em
// localStorage; aplicado ao vivo no player e no preview do editor. Fecha com
// clique fora ou Esc.
function wireSubtitleStylePanel(wrap) {
  const btn = document.getElementById("subtitle-style-btn");
  const panel = document.getElementById("subtitle-style-panel");
  if (!btn || !panel) return;
  syncSubtitleStylePanel(panel);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSubtitleStylePanel();
  });
  // Controles do painel
  panel.querySelectorAll(".ssp-size button").forEach((b) => {
    b.addEventListener("click", () => {
      panel.querySelectorAll(".ssp-size button").forEach((x) => x.removeAttribute("data-active"));
      b.setAttribute("data-active", "");
      applySubtitleStyleChange(panel);
    });
  });
  panel.querySelector("#ssp-text")?.addEventListener("input", () => applySubtitleStyleChange(panel));
  panel.querySelector("#ssp-bg")?.addEventListener("change", () => {
    panel.querySelector("#ssp-bg-custom").hidden =
      panel.querySelector("#ssp-bg").value !== "custom";
    applySubtitleStyleChange(panel);
  });
  panel.querySelector("#ssp-bg-custom")?.addEventListener("input", () => applySubtitleStyleChange(panel));
  panel.querySelector("#ssp-spacing")?.addEventListener("input", () => {
    const val = panel.querySelector("#ssp-spacing-val");
    if (val) val.textContent = panel.querySelector("#ssp-spacing").value;
    applySubtitleStyleChange(panel);
  });
  panel.querySelector("#ssp-shadow")?.addEventListener("change", () => applySubtitleStyleChange(panel));
  panel.querySelector("#ssp-reset")?.addEventListener("click", () => {
    localStorage.removeItem(SUBTITLE_STYLE_KEY);
    syncSubtitleStylePanel(panel);
    applySubtitleStyle(document.getElementById("subtitle-overlay"));
    applySubtitleGeometry();
  });
  panel.querySelector("#ssp-reset-pos")?.addEventListener("click", () => {
    subtitleState.pos = null;
    applySubtitleGeometry();
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) subtitleStyleClose();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") subtitleStyleClose();
  });
}

// Instâncias de observadores do overlay (uma por montagem do player).
let subtitleGeoRO = null;
let subtitleIdleMO = null;
let subtitleGeoListeners = []; // [{target,type,fn}]

// Piso da fonte da legenda: no mobile (≤640px) o quadro em retrato é pequeno
// (~170–200px de altura), e o piso de 12px renderizava texto miúdo. Um piso
// maior mantém a legenda legível sem mudar o desktop (onde o quadro é alto e
// o valor proporcional domina). "sm"/"md"/"lg" continuam escalando este piso
// em applySubtitleGeometry.
function subtitleMinFontPx() {
  return window.matchMedia("(max-width: 640px)").matches ? 14 : 12;
}

// Quadro REAL do vídeo dentro do player-wrap: object-fit: contain letterboxa o
// vídeo dentro do elemento <video> (que ocupa 100% do wrap). O quadro renderado
// é o retângulo centralizado por contain — é a ele que a legenda deve se ancorar.
// ---------------------------------------------------------------------------
// Tutor IA Integrado ao Player (chat contextualizado, streaming SSE, markdown)
// ---------------------------------------------------------------------------

function renderMarkdownToHtml(markdown) {
  if (typeof LocalPlayerScope !== "undefined" && typeof LocalPlayerScope.renderMarkdownToHtml === "function") {
    return LocalPlayerScope.renderMarkdownToHtml(markdown);
  }
  return escapeHtml(markdown || "");
}

const tutorState = {
  open: false,
  loadingContext: false,
  streaming: false,
  currentVideo: null,
  activeTab: "chat", // "chat" | "quiz" | "flashcards"
  historyByPath: new Map(), // videoPath -> [{ role, content, error?: boolean }]
  contextMetaByPath: new Map(), // videoPath -> contextMeta
  quizByPath: new Map(), // videoPath -> { quiz, currentIndex, answers: Map, finished: bool, loading: bool, error: null }
  flashcardsByPath: new Map(), // videoPath -> { flashcards, currentIndex, flipped: bool, mastery: Map, loading: bool, error: null }
  abortController: null,
};

function getTutorHistory(videoPath) {
  if (!tutorState.historyByPath.has(videoPath)) {
    tutorState.historyByPath.set(videoPath, []);
  }
  return tutorState.historyByPath.get(videoPath);
}

function getTutorQuizState(videoPath) {
  if (!tutorState.quizByPath.has(videoPath)) {
    tutorState.quizByPath.set(videoPath, {
      quiz: null,
      currentIndex: 0,
      answers: new Map(),
      finished: false,
      loading: false,
      error: null,
    });
  }
  return tutorState.quizByPath.get(videoPath);
}

function getTutorFlashcardsState(videoPath) {
  if (!tutorState.flashcardsByPath.has(videoPath)) {
    tutorState.flashcardsByPath.set(videoPath, {
      flashcards: null,
      currentIndex: 0,
      flipped: false,
      mastery: new Map(),
      loading: false,
      error: null,
    });
  }
  return tutorState.flashcardsByPath.get(videoPath);
}

function initTutorDrawer(video) {
  const slot = document.getElementById("tutor-drawer-slot");
  if (!slot) return;

  const currentLessonTitle = video ? escapeHtml(lessonTitle(video)) : "Aula atual";

  slot.innerHTML = `
    <aside class="tutor-drawer" id="tutor-drawer" hidden aria-label="Tutor IA">
      <div class="tutor-drag-handle" aria-hidden="true"></div>
      <div class="tutor-header">
        <div class="tutor-header-main">
          <div class="tutor-sparkle-badge" aria-hidden="true">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2l2.4 6.8L21 11l-6.6 2.2L12 20l-2.4-6.8L3 11l6.6-2.2z"/>
            </svg>
          </div>
          <div class="tutor-header-meta">
            <div class="tutor-header-title-row">
              <span class="tutor-title-main">Tutor IA</span>
              <span class="tutor-status-badge" id="tutor-context-chip" title="Contexto da aula">
                <span class="tutor-context-dot"></span>
                <span class="tutor-context-label" id="tutor-context-label">Contexto</span>
              </span>
            </div>
            <div class="tutor-lesson-badge" id="tutor-lesson-badge" title="${currentLessonTitle}">
              ${currentLessonTitle}
            </div>
          </div>
        </div>
        <div class="tutor-header-actions">
          <button type="button" class="tutor-icon-btn" id="tutor-new-chat" title="Limpar e reiniciar" aria-label="Limpar">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
            <span class="tutor-btn-label" id="tutor-reset-btn-label">Novo</span>
          </button>
          <button type="button" class="tutor-icon-btn tutor-close-btn" id="tutor-close" aria-label="Fechar Tutor IA" title="Fechar (Esc)">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      <!-- Barra de Abas -->
      <div class="tutor-tab-bar" role="tablist">
        <button type="button" class="tutor-tab-btn ${tutorState.activeTab === 'chat' ? 'active' : ''}" data-tab="chat" role="tab" aria-selected="${tutorState.activeTab === 'chat'}">
          <span>💬</span> <span>Chat</span>
        </button>
        <button type="button" class="tutor-tab-btn ${tutorState.activeTab === 'quiz' ? 'active' : ''}" data-tab="quiz" role="tab" aria-selected="${tutorState.activeTab === 'quiz'}">
          <span>📝</span> <span>Quiz</span>
        </button>
        <button type="button" class="tutor-tab-btn ${tutorState.activeTab === 'flashcards' ? 'active' : ''}" data-tab="flashcards" role="tab" aria-selected="${tutorState.activeTab === 'flashcards'}">
          <span>🗂️</span> <span>Flashcards</span>
        </button>
      </div>

      <!-- View: Chat -->
      <div class="tutor-view-container" id="tutor-view-chat" ${tutorState.activeTab === 'chat' ? '' : 'hidden'}>
        <div class="tutor-messages" id="tutor-messages" role="log" aria-live="polite"></div>
        <div class="tutor-input-container">
          <div class="tutor-input-wrap">
            <textarea class="tutor-textarea" id="tutor-input" rows="1" placeholder="Tire sua dúvida sobre esta aula…"></textarea>
            <button type="button" class="tutor-send-btn" id="tutor-send-btn" title="Enviar pergunta" aria-label="Enviar pergunta">
              <span id="tutor-send-icon">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              </span>
            </button>
          </div>
          <div class="tutor-input-footer">
            <span>Shift + Enter para quebrar linha · Enter para enviar</span>
          </div>
        </div>
      </div>

      <!-- View: Quiz -->
      <div class="tutor-view-container" id="tutor-view-quiz" ${tutorState.activeTab === 'quiz' ? '' : 'hidden'}>
        <div class="tutor-quiz-view" id="tutor-quiz-container"></div>
      </div>

      <!-- View: Flashcards -->
      <div class="tutor-view-container" id="tutor-view-flashcards" ${tutorState.activeTab === 'flashcards' ? '' : 'hidden'}>
        <div class="tutor-fc-view" id="tutor-fc-container"></div>
      </div>
    </aside>`;

  wireTutorDrawerEvents(video);
  if (video) {
    updateTutorContextMeta(video);
  }
}

function switchTutorTab(tabName, video) {
  tutorState.activeTab = tabName;
  const currentVid = video || tutorState.currentVideo;

  document.querySelectorAll(".tutor-tab-btn").forEach((btn) => {
    const isAct = btn.dataset.tab === tabName;
    btn.classList.toggle("active", isAct);
    btn.setAttribute("aria-selected", String(isAct));
  });

  const chatView = document.getElementById("tutor-view-chat");
  const quizView = document.getElementById("tutor-view-quiz");
  const fcView = document.getElementById("tutor-view-flashcards");

  if (chatView) chatView.hidden = tabName !== "chat";
  if (quizView) quizView.hidden = tabName !== "quiz";
  if (fcView) fcView.hidden = tabName !== "flashcards";

  const resetLabel = document.getElementById("tutor-reset-btn-label");
  if (resetLabel) {
    resetLabel.textContent = tabName === "chat" ? "Novo" : "Reiniciar";
  }

  if (tabName === "chat" && currentVid) {
    renderTutorMessages(currentVid);
  } else if (tabName === "quiz" && currentVid) {
    renderTutorQuiz(currentVid);
  } else if (tabName === "flashcards" && currentVid) {
    renderTutorFlashcards(currentVid);
  }
}

function wireTutorDrawerEvents(video) {
  const drawer = document.getElementById("tutor-drawer");
  const closeBtn = document.getElementById("tutor-close");
  const backdrop = document.getElementById("tutor-backdrop");
  const newChatBtn = document.getElementById("tutor-new-chat");
  const sendBtn = document.getElementById("tutor-send-btn");
  const input = document.getElementById("tutor-input");
  const messagesEl = document.getElementById("tutor-messages");

  if (closeBtn) closeBtn.addEventListener("click", () => closeTutorDrawer());
  if (backdrop) backdrop.addEventListener("click", () => closeTutorDrawer());

  document.querySelectorAll(".tutor-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchTutorTab(btn.dataset.tab, tutorState.currentVideo || video);
    });
  });

  if (newChatBtn) {
    newChatBtn.addEventListener("click", () => {
      const vid = tutorState.currentVideo || video;
      if (!vid) return;
      if (tutorState.activeTab === "chat") {
        if (tutorState.streaming) stopTutorStreaming();
        tutorState.historyByPath.set(vid.path, []);
        renderTutorMessages(vid);
      } else if (tutorState.activeTab === "quiz") {
        restartQuiz(vid);
      } else if (tutorState.activeTab === "flashcards") {
        restartFlashcards(vid);
      }
    });
  }

  if (input) {
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = Math.min(180, Math.max(38, input.scrollHeight)) + "px";
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        triggerTutorSend(tutorState.currentVideo || video);
      }
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      if (tutorState.streaming) {
        stopTutorStreaming();
      } else {
        triggerTutorSend(tutorState.currentVideo || video);
      }
    });
  }

  if (messagesEl) {
    messagesEl.addEventListener("click", (e) => {
      // Botão de copiar código
      const copyBtn = e.target.closest(".tutor-code-copy-btn");
      if (copyBtn) {
        const card = copyBtn.closest(".tutor-code-card");
        const code = card?.querySelector("code")?.textContent || "";
        if (code) {
          navigator.clipboard.writeText(code).then(() => {
            const textSpan = copyBtn.querySelector(".tutor-copy-text");
            if (textSpan) textSpan.textContent = "Copiado!";
            copyBtn.classList.add("copied");
            setTimeout(() => {
              if (textSpan) textSpan.textContent = "Copiar";
              copyBtn.classList.remove("copied");
            }, 2000);
          });
        }
        return;
      }

      // Pílula de sugestão rápida
      const pill = e.target.closest(".tutor-suggestion-pill");
      if (pill && pill.dataset.prompt) {
        sendTutorMessage(tutorState.currentVideo || video, pill.dataset.prompt);
        return;
      }

      // Timestamp interativo
      const timeBtn = e.target.closest(".tutor-timestamp-btn");
      if (timeBtn && timeBtn.dataset.time) {
        const seconds = parseFloat(timeBtn.dataset.time);
        const videoEl = document.getElementById("video-el");
        if (videoEl && !isNaN(seconds)) {
          videoEl.currentTime = seconds;
          videoEl.play().catch(() => {});

          timeBtn.classList.add("clicked");
          setTimeout(() => timeBtn.classList.remove("clicked"), 800);

          // Fecha o chat automaticamente para dar foco total ao vídeo
          closeTutorDrawer();
        }
        return;
      }
    });
  }
}

async function updateTutorContextMeta(video, forceRefresh = false) {
  if (!video) return;
  const chip = document.getElementById("tutor-context-chip");
  const label = document.getElementById("tutor-context-label");
  const badge = document.getElementById("tutor-lesson-badge");
  if (badge) badge.textContent = lessonTitle(video);

  if (!forceRefresh && tutorState.contextMetaByPath.has(video.path)) {
    const cached = tutorState.contextMetaByPath.get(video.path);
    if (cached && cached.hasTranscription) {
      applyTutorContextMetaUI(cached);
      return;
    }
  }

  try {
    const url = `/api/tutor/context?path=${encodeURIComponent(video.path)}&libraryId=${encodeURIComponent(video.libId || "")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Context fetch failed");
    const data = await res.json();
    tutorState.contextMetaByPath.set(video.path, data);
    applyTutorContextMetaUI(data);
  } catch (err) {
    if (label) label.textContent = "Contexto ativo";
  }
}

function applyTutorContextMetaUI(data) {
  const chip = document.getElementById("tutor-context-chip");
  const label = document.getElementById("tutor-context-label");
  if (!chip || !label || !data) return;

  const parts = [];
  if (data.hasTranscription) {
    parts.push("Transcrição");
  } else {
    parts.push("Sem transcrição");
  }
  if (data.materialsCount > 0) {
    parts.push(`${data.materialsCount} ${data.materialsCount === 1 ? "mat." : "mats."}`);
  }
  label.textContent = parts.join(" · ");
  chip.classList.toggle("has-transcription", !!data.hasTranscription);

  const tooltip = data.hasTranscription
    ? `Contexto ativo: Transcrição e ${data.materialsCount} materiais indexados.`
    : `Contexto parcial: Transcrição não encontrada. O tutor usará o título e materiais da aula.`;
  chip.setAttribute("title", tooltip);
}

function openTutorDrawer(video) {
  tutorState.currentVideo = video;
  let drawer = document.getElementById("tutor-drawer");
  if (!drawer) {
    initTutorDrawer(video);
    drawer = document.getElementById("tutor-drawer");
  } else {
    wireTutorDrawerEvents(video);
  }
  const bd = document.getElementById("tutor-backdrop");
  if (drawer) {
    drawer.hidden = false;
    drawer.removeAttribute("hidden");
  }
  if (bd) {
    bd.hidden = false;
    bd.removeAttribute("hidden");
  }
  document.body.classList.add("tutor-open");
  tutorState.open = true;

  switchTutorTab(tutorState.activeTab || "chat", video);
  updateTutorContextMeta(video);

  if (tutorState.activeTab === "chat") {
    const input = document.getElementById("tutor-input");
    if (input) setTimeout(() => input.focus(), 100);
  }
}

function closeTutorDrawer() {
  const drawer = document.getElementById("tutor-drawer");
  const backdrop = document.getElementById("tutor-backdrop");
  if (drawer) {
    drawer.hidden = true;
    drawer.setAttribute("hidden", "");
  }
  if (backdrop) {
    backdrop.hidden = true;
    backdrop.setAttribute("hidden", "");
  }
  document.body.classList.remove("tutor-open");
  tutorState.open = false;
}

function toggleTutorDrawer(video) {
  if (tutorState.open) {
    closeTutorDrawer();
  } else {
    openTutorDrawer(video);
  }
}

// --- Controlador de Quiz Interativo ----------------------------------------

function renderTutorQuiz(video) {
  const container = document.getElementById("tutor-quiz-container");
  if (!container || !video) return;

  const st = getTutorQuizState(video.path);

  if (st.loading) {
    container.innerHTML = `
      <div class="tutor-quiz-hero">
        <div class="tutor-quiz-hero-badge" style="animation: tutorBlink 1.2s infinite ease-in-out;">
          <span>⏳</span>
        </div>
        <h4 class="tutor-quiz-hero-title">Gerando Quiz com IA...</h4>
        <p class="tutor-quiz-hero-desc">Analisando o conteúdo, transcrição e conceitos da aula para elaborar as questões.</p>
      </div>`;
    return;
  }

  if (st.error) {
    container.innerHTML = `
      <div class="tutor-quiz-hero">
        <div class="tutor-quiz-hero-badge" style="background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.4); color: #ef4444;">
          <span>⚠️</span>
        </div>
        <h4 class="tutor-quiz-hero-title">Erro ao Gerar Quiz</h4>
        <p class="tutor-quiz-hero-desc">${escapeHtml(st.error)}</p>
        <button type="button" class="tutor-study-gen-btn" id="tutor-quiz-retry-btn">
          <span>Tentar Novamente</span>
        </button>
      </div>`;
    const retryBtn = document.getElementById("tutor-quiz-retry-btn");
    if (retryBtn) retryBtn.addEventListener("click", () => generateTutorQuiz(video));
    return;
  }

  if (!st.quiz || !st.quiz.questions || st.quiz.questions.length === 0) {
    container.innerHTML = `
      <div class="tutor-quiz-hero">
        <div class="tutor-quiz-hero-badge">
          <span>📝</span>
        </div>
        <h4 class="tutor-quiz-hero-title">Quiz de Fixação da Aula</h4>
        <p class="tutor-quiz-hero-desc">Teste seus conhecimentos respondendo a questões de múltipla escolha geradas automaticamente a partir desta aula.</p>
        <div class="tutor-study-config-row">
          <label for="tutor-quiz-count">Quantidade de perguntas:</label>
          <select id="tutor-quiz-count" class="tutor-study-select">
            <option value="3">3 questões</option>
            <option value="5" selected>5 questões</option>
            <option value="10">10 questões</option>
          </select>
        </div>
        <div>
          <button type="button" class="tutor-study-gen-btn" id="tutor-quiz-start-btn">
            <span>✨ Gerar Quiz da Aula</span>
          </button>
        </div>
      </div>`;
    const startBtn = document.getElementById("tutor-quiz-start-btn");
    if (startBtn) {
      startBtn.addEventListener("click", () => {
        const countSel = document.getElementById("tutor-quiz-count");
        const count = countSel ? Number(countSel.value) || 5 : 5;
        generateTutorQuiz(video, count);
      });
    }
    return;
  }

  // Quiz concluído (Tela de pontuação final)
  if (st.finished) {
    const total = st.quiz.questions.length;
    let correctCount = 0;
    st.quiz.questions.forEach((q) => {
      if (st.answers.get(q.id) === q.correctIndex) correctCount++;
    });
    const pct = Math.round((correctCount / total) * 100);

    let feedbackMsg = "Excelente desempenho! Você dominou o conteúdo desta aula com maestria.";
    if (pct < 50) {
      feedbackMsg = "Vale a pena rever os trechos da aula para reforçar os pontos onde você teve dúvidas.";
    } else if (pct < 80) {
      feedbackMsg = "Bom trabalho! Você compreendeu a maior parte dos conceitos da aula.";
    }

    container.innerHTML = `
      <div class="tutor-quiz-summary">
        <div class="tutor-quiz-score-circle" style="--pct: ${pct};">
          <span class="tutor-quiz-score-num">${pct}%</span>
        </div>
        <h4 class="tutor-quiz-sum-title">${correctCount} de ${total} Acertos</h4>
        <p class="tutor-quiz-sum-desc">${feedbackMsg}</p>
        <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
          <button type="button" class="tutor-icon-btn" id="tutor-quiz-redo-btn" style="padding: 10px 18px; font-size: 14.5px;">
            <span>🔄 Refazer Quiz</span>
          </button>
          <button type="button" class="tutor-study-gen-btn" id="tutor-quiz-new-btn" style="padding: 10px 18px; font-size: 14.5px;">
            <span>✨ Gerar Novas Questões</span>
          </button>
        </div>
      </div>`;

    const redoBtn = document.getElementById("tutor-quiz-redo-btn");
    if (redoBtn) {
      redoBtn.addEventListener("click", () => {
        st.currentIndex = 0;
        st.answers.clear();
        st.finished = false;
        renderTutorQuiz(video);
      });
    }

    const newBtn = document.getElementById("tutor-quiz-new-btn");
    if (newBtn) {
      newBtn.addEventListener("click", () => {
        generateTutorQuiz(video, st.quiz.questions.length);
      });
    }
    return;
  }

  // Pergunta Ativa
  const q = st.quiz.questions[st.currentIndex];
  const total = st.quiz.questions.length;
  const progressPct = Math.round(((st.currentIndex + 1) / total) * 100);
  const selectedAnswer = st.answers.get(q.id);
  const hasAnswered = selectedAnswer !== undefined;

  const letters = ["A", "B", "C", "D"];

  let optionsHtml = "";
  q.options.forEach((opt, idx) => {
    let optClass = "";
    if (hasAnswered) {
      if (idx === q.correctIndex) {
        optClass = "correct";
      } else if (idx === selectedAnswer) {
        optClass = "incorrect";
      }
    }

    optionsHtml += `
      <button type="button" class="tutor-quiz-opt-btn ${optClass}" data-opt="${idx}" ${hasAnswered ? "disabled" : ""}>
        <span class="tutor-quiz-opt-letter">${letters[idx] || (idx + 1)}</span>
        <span class="tutor-quiz-opt-text">${escapeHtml(opt)}</span>
      </button>`;
  });

  let explanationHtml = "";
  if (hasAnswered) {
    const isCorrect = selectedAnswer === q.correctIndex;
    explanationHtml = `
      <div class="tutor-quiz-explanation ${isCorrect ? 'is-correct' : 'is-incorrect'}">
        <h5 class="tutor-quiz-exp-title">
          <span>${isCorrect ? '✅ Resposta Correta!' : '❌ Resposta Incorreta'}</span>
        </h5>
        <p class="tutor-quiz-exp-text">${renderMarkdownToHtml(q.explanation)}</p>
      </div>`;
  }

  const isLast = st.currentIndex === total - 1;

  container.innerHTML = `
    <div class="tutor-quiz-header">
      <div class="tutor-quiz-progress-track">
        <div class="tutor-quiz-progress-fill" style="width: ${progressPct}%;"></div>
      </div>
      <span class="tutor-quiz-counter">Questão ${st.currentIndex + 1} de ${total}</span>
    </div>

    <div class="tutor-quiz-question-box">
      <p class="tutor-quiz-question-text">${escapeHtml(q.question)}</p>
    </div>

    <div class="tutor-quiz-options" id="tutor-quiz-options">
      ${optionsHtml}
    </div>

    ${explanationHtml}

    ${hasAnswered ? `
      <div class="tutor-quiz-actions">
        <button type="button" class="tutor-quiz-next-btn" id="tutor-quiz-next-btn">
          <span>${isLast ? 'Ver Resultado' : 'Próxima Questão'}</span>
          <span>→</span>
        </button>
      </div>
    ` : ''}`;

  // Liga clique nas alternativas
  if (!hasAnswered) {
    container.querySelectorAll(".tutor-quiz-opt-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const optIndex = parseInt(btn.dataset.opt, 10);
        st.answers.set(q.id, optIndex);
        renderTutorQuiz(video);
      });
    });
  } else {
    const nextBtn = document.getElementById("tutor-quiz-next-btn");
    if (nextBtn) {
      nextBtn.addEventListener("click", () => {
        if (isLast) {
          st.finished = true;
        } else {
          st.currentIndex++;
        }
        renderTutorQuiz(video);
      });
    }
  }
}

async function generateTutorQuiz(video, count = 5) {
  if (!video) return;
  const st = getTutorQuizState(video.path);
  st.loading = true;
  st.error = null;
  st.quiz = null;
  st.currentIndex = 0;
  st.answers.clear();
  st.finished = false;
  renderTutorQuiz(video);

  try {
    const res = await fetch("/api/study/quiz", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: video.path,
        libraryId: video.libId || "",
        count,
      }),
    });

    if (!res.ok) {
      let errMsg = `Erro HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.error) errMsg = j.error;
      } catch {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    if (!data.ok || !data.quiz) throw new Error(data.error || "Estrutura de quiz inválida.");

    st.quiz = data.quiz;
    st.currentIndex = 0;
    st.answers.clear();
    st.finished = false;
  } catch (err) {
    st.error = err.message || "Falha ao gerar o quiz.";
  } finally {
    st.loading = false;
    renderTutorQuiz(video);
  }
}

function restartQuiz(video) {
  const st = getTutorQuizState(video.path);
  st.quiz = null;
  st.currentIndex = 0;
  st.answers.clear();
  st.finished = false;
  st.error = null;
  renderTutorQuiz(video);
}

// --- Controlador de Flashcards 3D ------------------------------------------

function renderTutorFlashcards(video) {
  const container = document.getElementById("tutor-fc-container");
  if (!container || !video) return;

  const st = getTutorFlashcardsState(video.path);

  if (st.loading) {
    container.innerHTML = `
      <div class="tutor-quiz-hero">
        <div class="tutor-quiz-hero-badge" style="animation: tutorBlink 1.2s infinite ease-in-out;">
          <span>⏳</span>
        </div>
        <h4 class="tutor-quiz-hero-title">Gerando Flashcards com IA...</h4>
        <p class="tutor-quiz-hero-desc">Extraindo termos-chave, conceitos e exemplos práticos da aula para memorização ativa.</p>
      </div>`;
    return;
  }

  if (st.error) {
    container.innerHTML = `
      <div class="tutor-quiz-hero">
        <div class="tutor-quiz-hero-badge" style="background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.4); color: #ef4444;">
          <span>⚠️</span>
        </div>
        <h4 class="tutor-quiz-hero-title">Erro ao Gerar Flashcards</h4>
        <p class="tutor-quiz-hero-desc">${escapeHtml(st.error)}</p>
        <button type="button" class="tutor-study-gen-btn" id="tutor-fc-retry-btn">
          <span>Tentar Novamente</span>
        </button>
      </div>`;
    const retryBtn = document.getElementById("tutor-fc-retry-btn");
    if (retryBtn) retryBtn.addEventListener("click", () => generateTutorFlashcards(video));
    return;
  }

  if (!st.flashcards || !st.flashcards.cards || st.flashcards.cards.length === 0) {
    container.innerHTML = `
      <div class="tutor-quiz-hero">
        <div class="tutor-quiz-hero-badge">
          <span>🗂️</span>
        </div>
        <h4 class="tutor-quiz-hero-title">Flashcards Interativos</h4>
        <p class="tutor-quiz-hero-desc">Pratique memorização ativa com cartões 3D baseados nos conceitos e códigos essenciais desta aula.</p>
        <div class="tutor-study-config-row">
          <label for="tutor-fc-count">Quantidade de cartões:</label>
          <select id="tutor-fc-count" class="tutor-study-select">
            <option value="5">5 cartões</option>
            <option value="8" selected>8 cartões</option>
            <option value="12">12 cartões</option>
          </select>
        </div>
        <div>
          <button type="button" class="tutor-study-gen-btn" id="tutor-fc-start-btn">
            <span>✨ Gerar Flashcards da Aula</span>
          </button>
        </div>
      </div>`;
    const startBtn = document.getElementById("tutor-fc-start-btn");
    if (startBtn) {
      startBtn.addEventListener("click", () => {
        const countSel = document.getElementById("tutor-fc-count");
        const count = countSel ? Number(countSel.value) || 8 : 8;
        generateTutorFlashcards(video, count);
      });
    }
    return;
  }

  const cards = st.flashcards.cards;
  const total = cards.length;
  const card = cards[st.currentIndex];

  container.innerHTML = `
    <div class="tutor-fc-stage">
      <div class="tutor-fc-card ${st.flipped ? 'flipped' : ''}" id="tutor-fc-card-el" title="Clique ou pressione Espaço para virar">
        <!-- Frente -->
        <div class="tutor-fc-face tutor-fc-front">
          <div class="tutor-fc-tag-row">
            <span class="tutor-fc-tag">${escapeHtml(card.tag || 'Conceito')}</span>
            <span class="tutor-fc-flip-hint">↺ Clique para virar</span>
          </div>
          <div class="tutor-fc-content">
            ${escapeHtml(card.front)}
          </div>
          <div class="tutor-fc-hint-box" ${card.hint ? '' : 'hidden'}>
            💡 <strong>Dica:</strong> ${escapeHtml(card.hint || '')}
          </div>
        </div>

        <!-- Verso -->
        <div class="tutor-fc-face tutor-fc-back">
          <div class="tutor-fc-tag-row">
            <span class="tutor-fc-tag">${escapeHtml(card.tag || 'Resposta')}</span>
            <span class="tutor-fc-flip-hint">↺ Clique para virar</span>
          </div>
          <div class="tutor-fc-content">
            ${renderMarkdownToHtml(card.back)}
          </div>
          <div style="font-size: 11.5px; color: var(--text-dim); text-align: right;">
            Como foi sua recordação?
          </div>
        </div>
      </div>
    </div>

    <!-- Barra de Autoavaliação -->
    <div class="tutor-fc-rating-bar">
      <button type="button" class="tutor-fc-rate-btn tutor-fc-rate-hard" data-rate="hard" title="Não lembrei bem">
        <span>🔴 Difícil</span>
      </button>
      <button type="button" class="tutor-fc-rate-btn tutor-fc-rate-med" data-rate="medium" title="Lembrei com esforço">
        <span>🟡 Médio</span>
      </button>
      <button type="button" class="tutor-fc-rate-btn tutor-fc-rate-easy" data-rate="easy" title="Lembrei facilmente">
        <span>🟢 Fácil</span>
      </button>
    </div>

    <!-- Navegação -->
    <div class="tutor-fc-nav">
      <button type="button" class="tutor-fc-nav-btn" id="tutor-fc-prev" ${st.currentIndex === 0 ? 'disabled' : ''}>
        <span>← Anterior</span>
      </button>
      <span class="tutor-fc-counter">${st.currentIndex + 1} / ${total}</span>
      <button type="button" class="tutor-fc-nav-btn" id="tutor-fc-next" ${st.currentIndex === total - 1 ? 'disabled' : ''}>
        <span>Próximo →</span>
      </button>
    </div>`;

  // Flip ao clicar no cartão
  const cardEl = document.getElementById("tutor-fc-card-el");
  if (cardEl) {
    cardEl.addEventListener("click", () => {
      st.flipped = !st.flipped;
      cardEl.classList.toggle("flipped", st.flipped);
    });
  }

  // Navegação anterior/próximo
  const prevBtn = document.getElementById("tutor-fc-prev");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (st.currentIndex > 0) {
        st.currentIndex--;
        st.flipped = false;
        renderTutorFlashcards(video);
      }
    });
  }

  const nextBtn = document.getElementById("tutor-fc-next");
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (st.currentIndex < total - 1) {
        st.currentIndex++;
        st.flipped = false;
        renderTutorFlashcards(video);
      }
    });
  }

  // Autoavaliação e avanço
  container.querySelectorAll(".tutor-fc-rate-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      st.mastery.set(card.id, btn.dataset.rate);
      if (st.currentIndex < total - 1) {
        st.currentIndex++;
        st.flipped = false;
        renderTutorFlashcards(video);
      } else {
        // Ao concluir o último cartão, mostra feedback sutil
        btn.style.transform = "scale(1.08)";
        setTimeout(() => {
          st.currentIndex = 0;
          st.flipped = false;
          renderTutorFlashcards(video);
        }, 500);
      }
    });
  });
}

async function generateTutorFlashcards(video, count = 8) {
  if (!video) return;
  const st = getTutorFlashcardsState(video.path);
  st.loading = true;
  st.error = null;
  st.flashcards = null;
  st.currentIndex = 0;
  st.flipped = false;
  st.mastery.clear();
  renderTutorFlashcards(video);

  try {
    const res = await fetch("/api/study/flashcards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: video.path,
        libraryId: video.libId || "",
        count,
      }),
    });

    if (!res.ok) {
      let errMsg = `Erro HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.error) errMsg = j.error;
      } catch {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    if (!data.ok || !data.flashcards) throw new Error(data.error || "Estrutura de flashcards inválida.");

    st.flashcards = data.flashcards;
    st.currentIndex = 0;
    st.flipped = false;
    st.mastery.clear();
  } catch (err) {
    st.error = err.message || "Falha ao gerar os flashcards.";
  } finally {
    st.loading = false;
    renderTutorFlashcards(video);
  }
}

function restartFlashcards(video) {
  const st = getTutorFlashcardsState(video.path);
  st.flashcards = null;
  st.currentIndex = 0;
  st.flipped = false;
  st.mastery.clear();
  st.error = null;
  renderTutorFlashcards(video);
}

// Atalhos globais de teclado quando o Tutor IA está aberto
document.addEventListener("keydown", (e) => {
  if (!tutorState.open || !tutorState.currentVideo) return;
  const activeEl = document.activeElement;
  const isTyping = activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA");

  // Tecla Esc fecha o drawer (se não estiver com foco em elemento que consuma)
  if (e.key === "Escape") {
    closeTutorDrawer();
    return;
  }

  if (isTyping) return;

  // Atalhos no Flashcards
  if (tutorState.activeTab === "flashcards") {
    const st = getTutorFlashcardsState(tutorState.currentVideo.path);
    if (!st.flashcards || !st.flashcards.cards || st.flashcards.cards.length === 0) return;

    if (e.code === "Space") {
      e.preventDefault();
      st.flipped = !st.flipped;
      const cardEl = document.getElementById("tutor-fc-card-el");
      if (cardEl) cardEl.classList.toggle("flipped", st.flipped);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (st.currentIndex > 0) {
        st.currentIndex--;
        st.flipped = false;
        renderTutorFlashcards(tutorState.currentVideo);
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (st.currentIndex < st.flashcards.cards.length - 1) {
        st.currentIndex++;
        st.flipped = false;
        renderTutorFlashcards(tutorState.currentVideo);
      }
    }
  }
});

function renderTutorMessages(video) {
  const container = document.getElementById("tutor-messages");
  if (!container || !video) return;

  const history = getTutorHistory(video.path);
  if (!history || history.length === 0) {
    container.innerHTML = `
      <div class="tutor-empty-state">
        <div class="tutor-empty-badge">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 10v6M2 10l10-5 10 5-10 5z"/>
            <path d="M6 12v5c0 2 3 3 6 3s6-1 6-3v-5"/>
          </svg>
        </div>
        <h4 class="tutor-empty-title">Como posso ajudar seus estudos?</h4>
        <p class="tutor-empty-desc">Estou pronto para tirar dúvidas, resumir conteúdos, explicar conceitos difíceis ou analisar comandos desta aula.</p>
        <div class="tutor-suggestions">
          <button type="button" class="tutor-suggestion-pill" data-prompt="Faça um resumo estruturado dos pontos principais desta aula.">
            <span class="tutor-sug-icon">💡</span>
            <div class="tutor-sug-text">
              <span class="tutor-sug-title">Resumo dos pontos principais</span>
              <span class="tutor-sug-sub">Visão geral dos tópicos abordados</span>
            </div>
          </button>
          <button type="button" class="tutor-suggestion-pill" data-prompt="Explique o conceito principal ensinado nesta aula com exemplos práticos.">
            <span class="tutor-sug-icon">🔍</span>
            <div class="tutor-sug-text">
              <span class="tutor-sug-title">Explicar conceito principal</span>
              <span class="tutor-sug-sub">Explicação didática com exemplos práticos</span>
            </div>
          </button>
          <button type="button" class="tutor-suggestion-pill" data-prompt="Quais são os passos práticos ou códigos ensinados nesta aula?">
            <span class="tutor-sug-icon">💻</span>
            <div class="tutor-sug-text">
              <span class="tutor-sug-title">Passo a passo ou códigos</span>
              <span class="tutor-sug-sub">Implementação técnica e comandos</span>
            </div>
          </button>
        </div>
      </div>`;
    return;
  }

  let html = "";
  for (const msg of history) {
    if (msg.role === "user") {
      html += `
        <div class="tutor-msg tutor-msg-user">
          <div class="tutor-msg-bubble">${escapeHtml(msg.content)}</div>
        </div>`;
    } else {
      const formatted = renderMarkdownToHtml(msg.content);
      html += `
        <div class="tutor-msg tutor-msg-assistant">
          <div class="tutor-avatar" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2l2.4 6.8L21 11l-6.6 2.2L12 20l-2.4-6.8L3 11l6.6-2.2z"/>
            </svg>
          </div>
          <div class="tutor-msg-bubble ${msg.error ? "tutor-msg-error" : ""}">
            ${formatted}
          </div>
        </div>`;
    }
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

function triggerTutorSend(video) {
  const input = document.getElementById("tutor-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  sendTutorMessage(video, text);
}

async function sendTutorMessage(video, text) {
  if (!video || !text || tutorState.streaming) return;

  const history = getTutorHistory(video.path);
  history.push({ role: "user", content: text });

  const assistantMsg = { role: "assistant", content: "" };
  history.push(assistantMsg);

  renderTutorMessages(video);

  const container = document.getElementById("tutor-messages");
  const sendBtn = document.getElementById("tutor-send-btn");
  const sendIcon = document.getElementById("tutor-send-icon");
  if (sendBtn && sendIcon) {
    sendBtn.classList.add("streaming");
    sendIcon.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
        <rect x="4" y="4" width="16" height="16" rx="2"/>
      </svg>`;
    sendBtn.title = "Interromper resposta";
  }

  tutorState.streaming = true;
  tutorState.abortController = new AbortController();

  const assistantBubbles = container.querySelectorAll(".tutor-msg-assistant .tutor-msg-bubble");
  const currentBubble = assistantBubbles[assistantBubbles.length - 1];
  if (currentBubble) {
    currentBubble.innerHTML = `<span class="tutor-typing-dots"><span></span><span></span><span></span></span>`;
  }

  try {
    const payload = {
      path: video.path,
      libraryId: video.libId || "",
      messages: history.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    };

    const res = await fetch("/api/tutor/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: tutorState.abortController.signal,
    });

    if (!res.ok) {
      let errDetail = `Erro HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.error) errDetail = j.error;
      } catch {}
      throw new Error(errDetail);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = "";
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":") || !trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") break;

        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.error) {
            throw new Error(parsed.error);
          }
          if (parsed.status === "searching") {
            if (currentBubble && !accumulatedText) {
              currentBubble.innerHTML = `<div class="tutor-tool-status"><span class="tutor-tool-spinner"></span> Pesquisando na Web...</div>`;
            }
          } else if (parsed.status === "reading") {
            if (currentBubble && !accumulatedText) {
              currentBubble.innerHTML = `<div class="tutor-tool-status"><span class="tutor-tool-spinner"></span> Consultando fontes da Web...</div>`;
            }
          }
          if (parsed.content) {
            accumulatedText += parsed.content;
            assistantMsg.content = accumulatedText;
            if (currentBubble) {
              const isNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 140;
              currentBubble.innerHTML = renderMarkdownToHtml(accumulatedText) + '<span class="tutor-cursor"></span>';
              if (isNearBottom) {
                container.scrollTop = container.scrollHeight;
              }
            }
          }
        } catch (jsonErr) {
          if (jsonErr.message && !jsonErr.message.includes("JSON")) {
            throw jsonErr;
          }
        }
      }
    }

    if (currentBubble) {
      currentBubble.innerHTML = renderMarkdownToHtml(accumulatedText);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      if (!assistantMsg.content) {
        assistantMsg.content = "*(Resposta interrompida)*";
      }
    } else {
      assistantMsg.content = `⚠️ **Não foi possível obter a resposta:** ${escapeHtml(err.message || "Erro de conexão")}`;
      assistantMsg.error = true;
    }
    if (currentBubble) {
      currentBubble.innerHTML = renderMarkdownToHtml(assistantMsg.content);
      if (assistantMsg.error) currentBubble.classList.add("tutor-msg-error");
    }
  } finally {
    tutorState.streaming = false;
    tutorState.abortController = null;
    if (sendBtn && sendIcon) {
      sendBtn.classList.remove("streaming");
      sendIcon.innerHTML = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"></line>
          <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>`;
      sendBtn.title = "Enviar pergunta";
    }
    const input = document.getElementById("tutor-input");
    if (input) input.focus();
  }
}

function stopTutorStreaming() {
  if (tutorState.abortController) {
    tutorState.abortController.abort();
    tutorState.streaming = false;
  }
}

function computeSubtitleGeometry(videoEl, wrap) {
  const wrapRect = wrap.getBoundingClientRect();
  const box = videoEl.getBoundingClientRect();
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  // Altura da barra de controles: quando pc-idle (opacity 0) os controles não
  // "existem" visualmente → a legenda desce até perto da base do quadro.
  const bottomBar = document.getElementById("pc-bottom");
  let ctrlH = 0;
  if (bottomBar && !wrap.classList.contains("pc-idle")) {
    ctrlH = bottomBar.getBoundingClientRect().height;
  }
  // Sem metadados ainda (videoWidth 0): usa o box do wrap como quadro
  // provisório — nunca renderiza a legenda solta no topo. O repositionamento
  // real acontece via loadedmetadata/ResizeObserver quando os metadados chegam.
  if (!vw || !vh) {
    const fw = box.width;
    const fh = box.height;
    return {
      frame: {
        left: box.left - wrapRect.left,
        top: box.top - wrapRect.top,
        width: fw,
        height: fh,
      },
      fontPx: Math.max(subtitleMinFontPx(), Math.min(36, Math.round(fh * 0.04))),
      bottomInset: ctrlH > 0 ? ctrlH + Math.max(6, Math.round(fh * 0.02)) : Math.max(6, Math.round(fh * 0.02)),
    };
  }
  // object-fit: contain → escala única que cabe dentro do box; o resto é
  // letterbox. O quadro real é o retângulo centralizado por essa escala.
  const scale = Math.min(box.width / vw, box.height / vh);
  const fw = vw * scale;
  const fh = vh * scale;
  const fl = box.left + (box.width - fw) / 2;
  const ft = box.top + (box.height - fh) / 2;
  // Fonte proporcional ao quadro (padrão sutil ≈ 4% da altura), com clamp.
  // A preferência de "Tamanho" (sm/md/lg) escala este valor em
  // applySubtitleGeometry — a base aqui é sempre a do tamanho "Normal".
  const fontPx = Math.max(subtitleMinFontPx(), Math.min(36, Math.round(fh * 0.04)));
  const margin = Math.max(6, Math.round(fh * 0.02));
  const bottomInset = ctrlH > 0 ? ctrlH + margin : margin;
  return {
    frame: {
      left: fl - wrapRect.left,
      top: ft - wrapRect.top,
      width: fw,
      height: fh,
    },
    fontPx,
    bottomInset,
  };
}

// Aplica a geometria ao overlay (posição, tamanho, fonte, base da legenda).
// Reaplica também as vars de aparência (font-size respeita a preferência de
// tamanho sm/md/lg sobre a base proporcional ao quadro).
function applySubtitleGeometry() {
  const overlay = document.getElementById("subtitle-overlay");
  const videoEl = document.getElementById("video-el");
  const wrap = document.getElementById("player-wrap");
  const textEl = overlay && overlay.querySelector(".subtitle-overlay-text");
  if (!overlay || !videoEl || !wrap || !textEl || overlay.hidden) return;
  applySubtitleStyle(overlay);
  const g = computeSubtitleGeometry(videoEl, wrap);
  const scale = SUBTITLE_STYLE_SCALE[loadSubtitleStyle().size] || 1;
  const fontPx = Math.max(12, Math.round(g.fontPx * scale));
  subtitleState.frame = g.frame;
  subtitleState.fontPx = fontPx;
  subtitleState.bottomInset = g.bottomInset;
  overlay.style.left = g.frame.left + "px";
  overlay.style.top = g.frame.top + "px";
  overlay.style.width = g.frame.width + "px";
  overlay.style.height = g.frame.height + "px";
  overlay.style.fontSize = fontPx + "px";
  // Posição arrastável (YouTube): `pos` normalizada vira inset real, clampada
  // para a legenda nunca sair do quadro nem ficar ATRÁS da barra de controles
  // (o mínimo é o inset padrão, que já descola da barra). Sem `pos` → padrão.
  let bottomInset = g.bottomInset;
  let hOff = 0;
  if (subtitleState.pos) {
    const fh = g.frame.height;
    const fw = g.frame.width;
    const minInset = g.bottomInset; // nunca abaixo da barra de controles
    const maxV = Math.max(minInset, fh - fontPx * 1.3 - 6);
    bottomInset = Math.min(maxV, Math.max(minInset, subtitleState.pos.v * fh));
    // Laterais: o texto inteiro (largura real medida) fica dentro do quadro,
    // respeitando o padding de 3% do overlay — nunca atrás do player.
    const tw = Math.min(textEl.offsetWidth || 0, fw * 0.94);
    const minHOff = fw * 0.03 - fw / 2 + tw / 2;
    const maxHOff = fw * 0.97 - fw / 2 - tw / 2;
    hOff = (subtitleState.pos.h - 0.5) * fw;
    hOff = Math.max(minHOff, Math.min(maxHOff, hOff));
  }
  textEl.style.marginBottom = bottomInset + "px";
  textEl.style.transform = hOff ? `translateX(${hOff}px)` : "none";
}

// Remove observadores/listeners da montagem anterior (re-render troca o DOM).
function teardownSubtitleGeometry() {
  if (subtitleGeoRO) {
    subtitleGeoRO.disconnect();
    subtitleGeoRO = null;
  }
  if (subtitleIdleMO) {
    subtitleIdleMO.disconnect();
    subtitleIdleMO = null;
  }
  for (const l of subtitleGeoListeners) {
    l.target.removeEventListener(l.type, l.fn);
  }
  subtitleGeoListeners = [];
  teardownSubtitleDrag();
}

// Observa o que muda a geometria: resize do video/wrap/barra (ResizeObserver),
// a classe pc-idle (MutationObserver — controles aparecem/somem) e
// fullscreen/resize (eventos globais). No-op quando o overlay está oculto.
function wireSubtitleGeometry() {
  teardownSubtitleGeometry();
  applySubtitleGeometry();
  const videoEl = document.getElementById("video-el");
  const wrap = document.getElementById("player-wrap");
  const bottomBar = document.getElementById("pc-bottom");
  if (!videoEl || !wrap) return;
  if (typeof ResizeObserver !== "undefined") {
    subtitleGeoRO = new ResizeObserver(applySubtitleGeometry);
    subtitleGeoRO.observe(videoEl);
    subtitleGeoRO.observe(wrap);
    if (bottomBar) subtitleGeoRO.observe(bottomBar);
  }
  if (typeof MutationObserver !== "undefined") {
    subtitleIdleMO = new MutationObserver(applySubtitleGeometry);
    subtitleIdleMO.observe(wrap, { attributes: true, attributeFilter: ["class"] });
  }
  const addL = (target, type, fn) => {
    target.addEventListener(type, fn);
    subtitleGeoListeners.push({ target, type, fn });
  };
  addL(document, "fullscreenchange", applySubtitleGeometry);
  addL(window, "resize", applySubtitleGeometry);
  wireSubtitleDrag();
}

// ---------------------------------------------------------------------------
// Arraste da legenda (como no YouTube): pegar o TEXTO da legenda e mover para
// qualquer ponto dentro do quadro. A posição é normalizada (frações do quadro)
// e por aula (reset no setupPlayerSubtitles) — reposiciona corretamente em
// resize/fullscreen. `pos` fica em memória (não é preferência persistida).
// ---------------------------------------------------------------------------
let subtitleDragPointerId = null;
let subtitleDragStart = null; // {x, y, v, h}
let subtitleDragMoved = false;
let subtitleDragFn = null; // {target, onDown, onMove, onUp}
// Suprime o `click` que o navegador dispara logo após um ARRASTE real (o
// soltar não pode virar play/pause). Click simples continua alternando.
let subtitleDragSuppressClick = false;

function teardownSubtitleDrag() {
  if (subtitleDragFn) {
    subtitleDragFn.target.removeEventListener("pointerdown", subtitleDragFn.onDown);
    if (subtitleDragPointerId !== null) {
      subtitleDragFn.target.removeEventListener("pointermove", subtitleDragFn.onMove);
      subtitleDragFn.target.removeEventListener("pointerup", subtitleDragFn.onUp);
      subtitleDragFn.target.removeEventListener("pointercancel", subtitleDragFn.onUp);
    }
    subtitleDragFn.target.classList.remove("dragging");
    subtitleDragFn = null;
  }
  subtitleDragPointerId = null;
  subtitleDragStart = null;
  subtitleDragMoved = false;
  subtitleDragSuppressClick = false;
}

function wireSubtitleDrag() {
  teardownSubtitleDrag();
  const textEl = document.querySelector(".subtitle-overlay-text");
  if (!textEl) return;
  const frame = () => subtitleState.frame;

  const onDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const fr = frame();
    if (!fr) return;
    // Início = posição atual (padrão ou já arrastada), em frações do quadro.
    let baseV = 0;
    let baseH = 0.5;
    if (subtitleState.pos) {
      baseV = subtitleState.pos.v;
      baseH = subtitleState.pos.h;
    } else {
      baseV = Math.min(1, (subtitleState.bottomInset || 0) / fr.height);
    }
    e.preventDefault();
    e.stopPropagation();
    subtitleDragPointerId = e.pointerId;
    subtitleDragStart = { x: e.clientX, y: e.clientY, v: baseV, h: baseH };
    subtitleDragMoved = false;
    textEl.classList.add("dragging");
    try {
      textEl.setPointerCapture(e.pointerId);
    } catch {}
    textEl.addEventListener("pointermove", onMove);
    textEl.addEventListener("pointerup", onUp);
    textEl.addEventListener("pointercancel", onUp);
  };

  const onMove = (e) => {
    if (e.pointerId !== subtitleDragPointerId) return;
    const fr = frame();
    const start = subtitleDragStart;
    if (!fr || !start) return;
    e.preventDefault();
    if (
      Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3
    ) {
      subtitleDragMoved = true;
    }
    const fh = fr.height;
    const fw = fr.width;
    // dy positivo = arrastou para cima (aumenta a distância da base).
    const dy = start.y - e.clientY;
    const dx = e.clientX - start.x;
    const insetPx = start.v * fh + dy;
    // Mínimo = inset padrão (descola a barra de controles) — a legenda nunca
    // pode ficar atrás do player. Máximo = texto inteiro dentro do quadro.
    const minInset = subtitleState.bottomInset || 6;
    const maxInset = Math.max(minInset, fh - subtitleState.fontPx * 1.3 - 6);
    const v = Math.min(1, Math.max(0, Math.min(maxInset, Math.max(minInset, insetPx)) / fh));
    const h = Math.min(0.95, Math.max(0.05, start.h + dx / fw));
    subtitleState.pos = { v, h };
    applySubtitleGeometry();
  };

  const onUp = (e) => {
    if (e.pointerId !== subtitleDragPointerId) return;
    subtitleDragPointerId = null;
    subtitleDragStart = null;
    textEl.classList.remove("dragging");
    try {
      textEl.releasePointerCapture(e.pointerId);
    } catch {}
    textEl.removeEventListener("pointermove", onMove);
    textEl.removeEventListener("pointerup", onUp);
    textEl.removeEventListener("pointercancel", onUp);
    // Arraste real: o `click` que vem a seguir não pode alternar play/pause.
    if (subtitleDragMoved) {
      subtitleDragSuppressClick = true;
      setTimeout(() => {
        subtitleDragSuppressClick = false;
      }, 80);
    }
    subtitleDragMoved = false;
  };

  subtitleDragFn = { target: textEl, onDown, onMove, onUp };
  textEl.addEventListener("pointerdown", onDown);
}

// Segmento ativo para o instante t (busca binária sobre start; segmentos são
// não-sobrepostos e ordenados). Retorna -1 fora de qualquer segmento.
function findSubtitleSegment(segments, t) {
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (ans >= 0 && t < segments[ans].end) return ans;
  return -1;
}

// Atualiza SÓ o texto da legenda ativa no timeupdate. Quando o segmento muda,
// troca o conteúdo do span existente — nunca re-renderiza o overlay inteiro.
function updateSubtitleOverlay(time) {
  // Ligado/Desativado também vale aqui: com legenda desativada o overlay nunca
  // re-exibe sozinho (quem re-exibe é applySubtitleVisibility ao ligar).
  if (!subtitleState.segments.length || subtitleState.enabled === false) return;
  const overlay = document.getElementById("subtitle-overlay");
  const inner = overlay && overlay.querySelector(".subtitle-overlay-inner");
  if (!overlay || !inner) return;
  const idx = findSubtitleSegment(subtitleState.segments, time);
  subtitleState.currentIndex = idx;
  if (idx < 0) {
    if (!overlay.hidden) overlay.hidden = true;
    return;
  }
  const text = subtitleState.segments[idx].text;
  if (!overlay.hidden && inner.textContent === text) return; // segmento igual
  inner.textContent = text;
  overlay.hidden = false;
}

// Carrega o documento editável do backend e liga o overlay à reprodução.
// Usa /api/subtitles/editor (fonte: edited > processed > vtt; nunca raw).
async function loadSubtitleOverlay(videoEl, rel, libId, lang) {
  let doc;
  try {
    let url = "/api/subtitles/editor?path=" + encodeURIComponent(rel) + libQuery({ libId });
    if (lang) url += "&lang=" + encodeURIComponent(lang);
    const res = await fetch(url);
    if (!res.ok) return false;
    doc = await res.json();
  } catch {
    return false;
  }
  const segs = Array.isArray(doc.segments) ? doc.segments : [];
  subtitleState.hash = doc.hash || subtitleState.hash;
  subtitleState.rel = rel;
  subtitleState.libId = libId || null;
  subtitleState.ready = doc.ready === true && segs.length > 0;
  subtitleState.source = doc.source || null;
  subtitleState.edited = doc.edited === true;
  subtitleState.staleSource = doc.staleSource === true;
  subtitleState.segments = subtitleState.ready ? segs : [];
  subtitleState.currentIndex = -1;
  const overlay = document.getElementById("subtitle-overlay");
  const inner = overlay && overlay.querySelector(".subtitle-overlay-inner");
  if (overlay && inner) inner.textContent = "";
  if (!subtitleState.ready) {
    teardownSubtitleGeometry();
    return false;
  }
  // Exibe respeitando a preferência Ligado/Desativado (localStorage); quando
  // desativada, o overlay fica oculto mas o estado ready continua (dot CC).
  applySubtitleVisibility();
  // Metadados chegam depois do overlay às vezes; repositiona quando carregar.
  if (!videoEl.videoWidth) {
    videoEl.addEventListener(
      "loadedmetadata",
      applySubtitleGeometry,
      { once: true },
    );
  }
  return true;
}

async function setupPlayerSubtitles(videoEl, video, opts) {
  const editorOwns = !!(opts && opts.overlayOwnedByEditor);
  if (subtitlePollTimer) {
    clearInterval(subtitlePollTimer);
    subtitlePollTimer = null;
  }
  subtitlePregenNextPath = null;
  teardownSubtitleGeometry();
  // Zera o estado do overlay e do botão CC (nova aula); a preferência
  // Ligado/Desativado e o idioma vêm do localStorage.
  subtitleState.hash = null;
  subtitleState.rel = null;
  subtitleState.ready = false;
  subtitleState.source = null;
  subtitleState.edited = false;
  subtitleState.staleSource = false;
  subtitleState.segments = [];
  subtitleState.currentIndex = -1;
  subtitleState.ccKind = null;
  subtitleState.enabled = getSubtitleEnabled();
  subtitleState.lang = getSubtitleLang();
  subtitleState.sourceLang = null;
  subtitleState.targetLang = null;
  subtitleState.canTranslate = false;
  subtitleState.libId = video.libId || null;
  subtitleState.pos = null; // posição arrastável volta ao padrão a cada aula
  subtitleState.percent = null;
  subtitleGenerateApi = null;
  subtitleCheckApi = null;
  subtitleLastLoadedLang = null;
  const overlayEl = document.getElementById("subtitle-overlay");
  if (overlayEl) overlayEl.hidden = true;
  syncSubtitleCcUi();
  // Sem Whisper configurado ⇒ esconde o botão CC (e o grupo "Legendas" do
  // menu ⋮) já no início, evitando o "flash" antes da primeira sondagem. A
  // sondagem em check() confirma pelo canGenerate do servidor.
  const ccGroupEl = document.querySelector(".pc-group-cc");
  const moreCcGroupEl = document.getElementById("pc-more-cc-group");
  if (ccGroupEl) ccGroupEl.style.display = subtitleGenerateEnabled ? "" : "none";
  if (moreCcGroupEl) moreCcGroupEl.style.display = subtitleGenerateEnabled ? "" : "none";

  const stopPolling = () => {
    if (subtitlePollTimer) {
      clearInterval(subtitlePollTimer);
      subtitlePollTimer = null;
    }
  };
  const rel = video.path;
  // Idioma efetivo: a seleção cai para "original" quando o idioma escolhido é
  // a própria língua-fonte, quando a tradução está desabilitada ou quando o
  // idioma-alvo mudou (o backend também trata assim).
  const effectiveLang = () =>
    subtitleState.lang &&
    subtitleState.targetLang &&
    subtitleState.lang === subtitleState.targetLang &&
    subtitleState.targetLang !== subtitleState.sourceLang
      ? subtitleState.lang
      : null;
  const langQuery = () => {
    const l = effectiveLang();
    return l ? "&lang=" + encodeURIComponent(l) : "";
  };
  // Ação do menu CC (Gerar/Regenerar): registrada para o delegation do player.
  // Força regeneração quando já existe ou falhou; re-sonda até ficar pronta.
  subtitleGenerateApi = () => {
    const force = stReady || stFailed ? "&force=1" : "";
    subtitleState.ccKind = "generating";
    syncSubtitleCcUi();
    fetch(
      "/api/subtitles/generate?path=" +
        encodeURIComponent(rel) +
        libQuery(video) +
        langQuery() +
        "&priority=0" +
        force,
      { method: "POST" },
    ).catch(() => {});
    if (!subtitlePollTimer) subtitlePollTimer = setInterval(check, 2500);
  };
  // Converte o estado sondado em exibição do botão CC (dot + tooltip + menu).
  const setCc = (kind) => {
    subtitleState.ccKind = kind;
    syncSubtitleCcUi();
  };
  let st = null;
  let stReady = false;
  let stFailed = false;
  // Evita refetch do editor a cada sondagem quando a legenda já está pronta.
  let overlayLoaded = false;
  // Esconde o overlay quando a legenda some/invalida (ex.: regeneração).
  const hideOverlay = () => {
    subtitleState.segments = [];
    subtitleState.ready = false;
    const o = document.getElementById("subtitle-overlay");
    if (o) o.hidden = true;
    teardownSubtitleGeometry();
  };

  const check = async () => {
    try {
      const res = await fetch(
        "/api/subtitles/status?path=" +
          encodeURIComponent(rel) +
          libQuery(video) +
          langQuery(),
      );
      if (!res.ok) throw new Error("http " + res.status);
      st = await res.json();
      // Progresso real do job (whisper -pp) para o badge "Gerando legenda…".
      subtitleState.percent = typeof st.percent === "number" ? st.percent : null;
      // Língua-fonte real e possibilidade de tradução vêm da sondagem; o
      // seletor de idioma do menu CC é montado a partir deles.
      if (st.language) subtitleState.sourceLang = st.language;
      subtitleState.targetLang =
        st.translation && st.translation.enabled
          ? st.translation.targetLanguage || null
          : null;
      subtitleState.canTranslate = !!st.canTranslate;
      // Sem Whisper/LLM configurado ⇒ o controle CC não tem o que fazer (gerar
      // nem regenerar) e fica oculto — mesmo se sobrar uma legenda pronta de
      // geração anterior; sem o pipeline o menu só teria ações mortas.
      const showCc = !!st.canGenerate || !!st.canTranslate;
      if (ccGroupEl) ccGroupEl.style.display = showCc ? "" : "none";
      if (moreCcGroupEl) moreCcGroupEl.style.display = showCc ? "" : "none";
    } catch {
      return; // API indisponível: silencioso — nunca bloqueia a reprodução.
    }
    // Troca de idioma: recarrega o overlay mesmo com `overlayLoaded` ligado.
    const effLang = effectiveLang();
    if (overlayLoaded && effLang !== subtitleLastLoadedLang) overlayLoaded = false;
    subtitleLastLoadedLang = effLang;
    // Sem legenda pronta → overlay oculto; se voltar a ficar pronta depois
    // (ex.: regeneração), refetch no próximo poll (overlayLoaded é resetado).
    if (!st.ready) {
      if (overlayLoaded) overlayLoaded = false;
      hideOverlay();
    }
    if (st.ready) {
      stReady = true;
      stFailed = false;
      if (editorOwns) {
        // Modo editor: o overlay/segments pertencem ao editor (preview ao
        // vivo). Aqui só o botão CC; sem carregar o overlay.
        setCc("ready");
        stopPolling();
        maybePregenNextLesson();
        return;
      }
      // Overlay custom no lugar do <track>: carrega o documento editável do
      // backend (edited > processed > vtt > traduzido; nunca raw) e liga à
      // reprodução.
      if (!overlayLoaded) {
        overlayLoaded = true;
        loadSubtitleOverlay(videoEl, rel, video.libId, effLang).then((ok) => {
          if (!ok) return;
          // timeupdate SÓ atualiza o texto do segmento ativo — sem re-render.
          videoEl.addEventListener("timeupdate", () =>
            updateSubtitleOverlay(videoEl.currentTime),
          );
          const stale = subtitleState.staleSource;
          setCc(stale ? "stale" : "ready");
        });
      } else {
        // Overlay já carregado (ex.: regeneração): atualiza o estado do CC
        // sem recarregar os segmentos — sem isto o botão ficava preso em
        // "Gerando legenda…" mesmo com a legenda pronta de novo.
        setCc(subtitleState.staleSource ? "stale" : "ready");
      }
      stopPolling();
      maybePregenNextLesson();
      return;
    }
    const active = [
      "queued", "extracting", "transcribing", "processing", "correcting", "formatting",
      "translating",
    ].includes(st.status);
    if (active) {
      stReady = false;
      stFailed = false;
      setCc("generating");
      maybePregenNextLesson();
      return; // continua a sondar
    }
    // Dispositivo desmontado/desconectado: a geração aguarda a fonte voltar.
    // O servidor re-enfileira sozinho; aqui só informamos e continuamos a
    // sondar (não vira erro, não para a UI).
    if (st.status === "waiting-source") {
      stReady = false;
      stFailed = false;
      setCc("waiting");
      return; // continua a sondar até o servidor retomar
    }
    if (st.status === "failed") {
      stReady = false;
      stFailed = true;
      setCc("failed");
      stopPolling();
      return;
    }
    // Tradução selecionada sem legenda original: encadeia a transcrição (P0)
    // primeiro — quando a original estiver pronta, o próprio backend/frontend
    // dispara a tradução. A seleção explícita gera sob demanda (independe do
    // generateMode).
    if (st.needTranscription) {
      if (st.canGenerateSource) {
        stReady = false;
        stFailed = false;
        setCc("generating");
        fetch(
          "/api/subtitles/generate?path=" + encodeURIComponent(rel) + libQuery(video),
          { method: "POST" },
        ).catch(() => {});
        return; // continua a sondar
      }
      stReady = false;
      stFailed = false;
      setCc("unavailable");
      stopPolling();
      return;
    }
    if (effLang && st.canGenerate) {
      stReady = false;
      stFailed = false;
      setCc("generating");
      fetch(
        "/api/subtitles/generate?path=" +
          encodeURIComponent(rel) +
          libQuery(video) +
          langQuery() +
          "&priority=0",
        { method: "POST" },
      ).catch(() => {});
      return; // continua a sondar até a tradução ficar pronta
    }
    // Tradução selecionada mas sem LLM configurado: informa sem oferecer ação
    // morta (o botão CC indica indisponível, sem job inútil na fila).
    if (effLang && !st.canTranslate) {
      stReady = false;
      stFailed = false;
      setCc("no-translate");
      stopPolling();
      return;
    }
    // Sem legenda e sem job: gera automaticamente quando o modo permitir;
    // senão o botão CC indica indisponibilidade (sem modal, sem ruído).
    if (st.canGenerate && st.generateMode === "auto") {
      stReady = false;
      stFailed = false;
      setCc("generating");
      fetch(
        "/api/subtitles/generate?path=" +
          encodeURIComponent(rel) +
          libQuery(video),
        { method: "POST" },
      ).catch(() => {});
      return; // continua a sondar até ficar pronta
    }
    stReady = false;
    stFailed = false;
    setCc("unavailable");
    stopPolling();
  };

  // P1: antecipa a próxima aula quando o config permitir e a aula atual já tem
  // legenda pronta ou está gerando. O backend dedupa/promove — nunca cria job
  // duplicado; `skipIfReady` evita ruído "cache encontrado" na fila.
  const maybePregenNextLesson = () => {
    if (!st || st.pregenNextLesson !== true) return;
    if (!st.ready && !["queued", "extracting", "transcribing", "processing", "correcting", "formatting", "translating"].includes(st.status)) return;
    const idx = state.flatVideos.indexOf(video);
    const next = idx >= 0 ? state.flatVideos[idx + 1] : null;
    if (!next) return;
    if (subtitlePregenNextPath === next.path) return; // já enfileirado nesta montagem
    subtitlePregenNextPath = next.path;
    fetch(
      "/api/subtitles/generate?path=" +
        encodeURIComponent(next.path) +
        libQuery(next) +
        "&priority=1&skipIfReady=1",
      { method: "POST" },
    ).catch(() => {});
  };

  subtitleCheckApi = check;

  await check();
  if (!subtitlePollTimer) subtitlePollTimer = setInterval(check, 2500);
}

// ==========================================================================
// Editor de legendas (estilo YouTube).
// ==========================================================================
// Estado global do editor. `segments` é a cópia de trabalho; o overlay de
// preview aponta para a MESMA referência (subtitleState.segments) para que a
// legenda seja pré-visualizada em tempo real, sem salvar.
const editor = {
  open: false,
  rel: null,
  hash: null,
  version: 0,
  source: null,
  correctedByLlm: false,
  segments: [],
  duration: 0,
  dirty: false,
  currentIndex: -1,
  userScrolledAt: 0,
  undoStack: [],
  redoStack: [],
  idCounter: 0,
  videoEl: null,
  pollTimer: null,
  saveInFlight: false,
};

// --- Tempo: formatar/parsear "m:ss.mmm" (aceita vírgula) ou segundos soltos ---
function fmtClock2(s) {
  if (!Number.isFinite(s) || s < 0) s = 0;
  let m = Math.floor(s / 60);
  let sec = s - m * 60;
  let mm = Math.floor(sec);
  let ms = Math.round((sec - mm) * 1000);
  if (ms === 1000) {
    ms = 0;
    mm += 1;
    if (mm === 60) {
      mm = 0;
      m += 1;
    }
  }
  return m + ":" + String(mm).padStart(2, "0") + "." + String(ms).padStart(3, "0");
}
function parseClock2(str) {
  if (typeof str !== "string") return null;
  const t = str.trim().replace(",", ".");
  const m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(t);
  if (m) {
    const min = Number(m[1]);
    const sec = Number(m[2]);
    if (sec >= 60) return null;
    const frac = m[3] ? Number("0." + m[3].padEnd(3, "0")) : 0;
    return min * 60 + sec + frac;
  }
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

function editorMaxId(segments) {
  let max = 0;
  for (const s of segments) {
    const n = /^s(\d+)$/.exec(s.id || "");
    if (n) max = Math.max(max, Number(n[1]));
  }
  return max;
}

// --- Entrada / carregamento -----------------------------------------------
function renderSubtitleEditor(videoEl, video) {
  editor.open = true;
  editor.videoEl = videoEl;
  editor.rel = video.path;
  editorActiveHash = location.hash;
  editor.segments = [];
  editor.dirty = false;
  editor.undoStack = [];
  editor.redoStack = [];
  editor.currentIndex = -1;
  if (editor.pollTimer) {
    clearInterval(editor.pollTimer);
    editor.pollTimer = null;
  }
  const slot = document.getElementById("subtitle-editor-slot");
  if (!slot) return;
  slot.innerHTML = `
    <div class="subtitle-editor" id="subtitle-editor">
      <div class="se-toolbar">
        <span class="se-title">Editor de legendas</span>
        <span class="se-dirty" id="se-dirty">carregando…</span>
        <div class="se-actions">
          <button class="secondary-btn" id="se-add" hidden>＋ Adicionar</button>
          <button class="secondary-btn" id="se-save" hidden>💾 Salvar</button>
          <button class="secondary-btn" id="se-undo" hidden title="Desfazer (Ctrl+Z)">↩ Desfazer</button>
          <button class="secondary-btn" id="se-redo" hidden title="Refazer (Ctrl+Y)">↪ Refazer</button>
          <button class="secondary-btn" id="se-export-vtt" hidden>Exportar VTT</button>
          <button class="secondary-btn" id="se-export-srt" hidden>Exportar SRT</button>
          <button class="secondary-btn" id="se-ai" hidden>✨ Corrigir com IA</button>
          <button class="secondary-btn" id="se-regen" hidden>Regenerar</button>
          <button class="secondary-btn" id="se-close">✕ Fechar editor</button>
        </div>
      </div>
      <div class="se-body" id="se-body">
        <div class="se-loading" id="se-loading">Carregando documento…</div>
      </div>
      <div class="se-toast" id="se-toast"></div>
    </div>`;

  const closeBtn = document.getElementById("se-close");
  if (closeBtn) closeBtn.addEventListener("click", editorToggleMode);
  // Ações da toolbar (botões criados ocultos; só o fechar fica visível).
  document.getElementById("se-add")?.addEventListener("click", () => {
    editorAddAfter(editor.currentIndex >= 0 ? editor.currentIndex : editor.segments.length - 1);
  });
  document.getElementById("se-save")?.addEventListener("click", editorSave);
  document.getElementById("se-undo")?.addEventListener("click", editorUndo);
  document.getElementById("se-redo")?.addEventListener("click", editorRedo);
  document.getElementById("se-export-vtt")?.addEventListener("click", () => editorExport("vtt"));
  document.getElementById("se-export-srt")?.addEventListener("click", () => editorExport("srt"));
  document.getElementById("se-ai")?.addEventListener("click", editorAiCorrect);
  document.getElementById("se-regen")?.addEventListener("click", editorRegenerate);
  editorLoadDoc();
}

// Toggle do modo editor via hash (mesma aula, com/sem ?editSubtitles=1).
function editorToggleMode() {
  if (!state.currentCourseNode || !state.currentVideoNode) return;
  const base =
    "/course/" +
    encodeURIComponent(state.currentCourseNode.path) +
    "?lesson=" +
    encodeURIComponent(state.currentVideoNode.path);
  location.hash = subtitleEditorMode ? base : base + "&editSubtitles=1";
}

// --- Carregamento do documento (edited > processed > vtt; nunca raw) ------
async function editorLoadDoc() {
  const res = await fetch(
    "/api/subtitles/editor?path=" + encodeURIComponent(editor.rel),
  );
  const doc = await res.json().catch(() => null);
  if (!res.ok || !doc) {
    editorShowMessage("Erro ao carregar o documento de legendas.");
    return;
  }
  if (editor.pollTimer) {
    clearInterval(editor.pollTimer);
    editor.pollTimer = null;
  }
  if (!doc.ready) {
    editorShowUnavailable(doc);
    return;
  }
  editor.hash = doc.hash;
  editor.version = doc.version;
  editor.source = doc.source;
  editor.correctedByLlm = doc.correctedByLlm === true;
  editor.segments = doc.segments.map((s) => ({
    id: s.id,
    start: s.start,
    end: s.end,
    text: s.text,
  }));
  editor.idCounter = editorMaxId(editor.segments);
  editor.dirty = false;
  // Preview no overlay: aponta para a MESMA referência (edição ao vivo).
  subtitleState.segments = editor.segments;
  subtitleState.ready = editor.segments.length > 0;
  wireSubtitleGeometry();
  const dur = editor.videoEl && Number.isFinite(editor.videoEl.duration)
    ? editor.videoEl.duration
    : editor.segments.length
      ? editor.segments[editor.segments.length - 1].end + 1
      : 1;
  editor.duration = dur;
  editorBuildReadyUI(doc);
  wireEditorVideoHooks();
  const t = editor.videoEl ? editor.videoEl.currentTime : 0;
  updateSubtitleOverlay(t);
  editorOnTime(t);
}

// Estado sem legenda pronta: mensagem + geração (e polling de status).
function editorShowUnavailable(doc) {
  const body = document.getElementById("se-body");
  if (!body) return;
  let msg = "Este vídeo ainda não possui legenda.";
  if (doc.status === "failed" || doc.error) msg = "Erro ao gerar a legenda.";
  else if (["queued", "extracting", "transcribing", "processing", "correcting", "formatting"].includes(doc.status)) {
    msg = "Legenda em geração…";
  }
  body.innerHTML = `
    <div class="se-unavailable">
      <p>${escapeHtml(msg)}</p>
      ${doc.canGenerate ? `<button class="secondary-btn" id="se-gen-btn">Gerar legenda</button>` : ""}
    </div>`;
  const gen = document.getElementById("se-gen-btn");
  if (gen) {
    gen.addEventListener("click", () => {
      gen.disabled = true;
      gen.textContent = "Enfileirando…";
      fetch("/api/subtitles/generate?path=" + encodeURIComponent(editor.rel), {
        method: "POST",
      })
        .then(async (r) => {
          if (r.ok) {
            gen.textContent = "Gerando…";
            editorStartPoll();
          } else {
            gen.textContent = "Falhou";
          }
        })
        .catch(() => (gen.textContent = "Falhou"));
    });
  }
  if (doc.canGenerate || ["queued", "extracting", "transcribing", "processing", "correcting", "formatting"].includes(doc.status)) {
    editorStartPoll();
  }
}

function editorStartPoll() {
  if (editor.pollTimer) return;
  editor.pollTimer = setInterval(async () => {
    const res = await fetch(
      "/api/subtitles/status?path=" + encodeURIComponent(editor.rel),
    );
    const st = await res.json().catch(() => null);
    if (!st) return;
    if (st.ready) {
      clearInterval(editor.pollTimer);
      editor.pollTimer = null;
      editorLoadDoc();
    } else if (st.status === "failed") {
      clearInterval(editor.pollTimer);
      editor.pollTimer = null;
      editorShowUnavailable(st);
    }
  }, 2500);
}

function editorShowMessage(html) {
  const body = document.getElementById("se-body");
  if (body) body.innerHTML = `<div class="se-unavailable"><p>${html}</p></div>`;
}

// --- UI pronta: toolbar + timeline + lista --------------------------------
function editorBuildReadyUI(doc) {
  const setVisible = (id, show) => {
    const el = document.getElementById(id);
    if (el) el.hidden = !show;
  };
  setVisible("se-add", true);
  setVisible("se-save", true);
  setVisible("se-undo", true);
  setVisible("se-redo", true);
  setVisible("se-export-vtt", true);
  setVisible("se-export-srt", true);
  setVisible("se-regen", true);
  // Botão de IA: mostra sempre; o backend recusa educadamente se desabilitado.
  setVisible("se-ai", true);

  const body = document.getElementById("se-body");
  body.innerHTML = `
    <div class="se-timeline-wrap">
      <div class="se-timeline" id="se-timeline"></div>
    </div>
    <div class="se-list" id="se-list"></div>`;

  // Listeners (delegação — sobrevivem a re-render da lista).
  const list = document.getElementById("se-list");
  list.addEventListener("click", (e) => {
    const row = e.target.closest(".se-row");
    if (!row) return;
    const i = Number(row.dataset.idx);
    if (e.target.closest("button[data-act]")) {
      const act = e.target.closest("button[data-act]").dataset.act;
      editorHandleAct(act, i);
      return;
    }
    if (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT") return;
    editorSeekTo(editor.segments[i].start);
  });
  list.addEventListener("input", (e) => {
    if (!e.target.classList.contains("se-text")) return;
    const row = e.target.closest(".se-row");
    if (!row) return;
    const i = Number(row.dataset.idx);
    editor.segments[i].text = e.target.value;
    editorMarkDirty(true);
  });
  list.addEventListener("change", (e) => {
    if (e.target.classList.contains("se-start") || e.target.classList.contains("se-end")) {
      const row = e.target.closest(".se-row");
      if (!row) return;
      editorCommitTimeInput(Number(row.dataset.idx), e.target);
    }
  });
  // Snapshot no focus (captura o estado pré-edição p/ undo) + pause de
  // auto-scroll quando o usuário rola a lista.
  list.addEventListener("focusin", (e) => {
    if (e.target.classList.contains("se-text") || e.target.classList.contains("se-start") || e.target.classList.contains("se-end")) {
      editorSnapshot();
    }
  });
  list.addEventListener("wheel", () => (editor.userScrolledAt = Date.now()), { passive: true });
  list.addEventListener("touchmove", () => (editor.userScrolledAt = Date.now()), { passive: true });

  const timeline = document.getElementById("se-timeline");
  timeline.addEventListener("click", (e) => {
    const block = e.target.closest(".se-tl-block");
    if (block) {
      editorSeekTo(editor.segments[Number(block.dataset.idx)].start);
      return;
    }
    // clique no ruler → seek pela proporção
    const rect = timeline.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    editorSeekTo(ratio * editor.duration);
  });

  renderEditorList();
  renderEditorTimeline();
  editorUpdateUndoRedo();
  editorMarkDirty(false);
  updateEditorHighlight();
  editorUpdateMeta(doc);
}

function editorUpdateMeta(doc) {
  const el = document.getElementById("se-info");
  const holder = document.querySelector(".se-statusbar");
  if (!holder) {
    // statusbar é criada no render; inserimos ao lado do dirty
    const dirty = document.getElementById("se-dirty");
    if (dirty) dirty.title = `Fonte: ${doc.source || "?"} · versão ${editor.version}${editor.correctedByLlm ? " · corrigido por IA" : ""}${doc.edited ? " · editado manualmente" : ""}`;
  }
}

function renderEditorList() {
  const list = document.getElementById("se-list");
  if (!list) return;
  const rows = editor.segments
    .map((s, i) => {
      const startVal = escapeHtml(fmtClock2(s.start));
      const endVal = escapeHtml(fmtClock2(s.end));
      return `
      <div class="se-row" data-idx="${i}">
        <div class="se-row-num">${i + 1}</div>
        <div class="se-row-time">
          <div class="se-time-inputs">
            <input class="se-start" type="text" inputmode="decimal" value="${startVal}" aria-label="Início" />
            <button type="button" class="se-set" data-act="set-start" title="Marcar início na posição atual">início</button>
          </div>
          <div class="se-time-inputs">
            <input class="se-end" type="text" inputmode="decimal" value="${endVal}" aria-label="Fim" />
            <button type="button" class="se-set" data-act="set-end" title="Marcar fim na posição atual">fim</button>
          </div>
        </div>
        <div class="se-row-tools">
          <button type="button" data-act="nudge-b1" title="Recuar 1s">−1s</button>
          <button type="button" data-act="nudge-b05" title="Recuar 0.5s">−0.5s</button>
          <button type="button" data-act="nudge-f05" title="Avançar 0.5s">+0.5s</button>
          <button type="button" data-act="nudge-f1" title="Avançar 1s">+1s</button>
          <button type="button" data-act="split" title="Dividir na posição atual">dividir</button>
          ${i + 1 < editor.segments.length ? `<button type="button" data-act="merge" title="Juntar com o próximo">juntar</button>` : ""}
          <button type="button" data-act="del" class="se-danger" title="Apagar segmento">apagar</button>
        </div>
        <textarea class="se-text" rows="2" placeholder="Texto da legenda">${escapeHtml(s.text)}</textarea>
      </div>`;
    })
    .join("");
  list.innerHTML = rows || `<div class="se-empty">Nenhum segmento. Use ＋ Adicionar.</div>`;
}

function renderEditorTimeline() {
  const tl = document.getElementById("se-timeline");
  if (!tl) return;
  const dur = editor.duration > 0 ? editor.duration : 1;
  const blocks = editor.segments
    .map((s, i) => {
      const left = Math.max(0, (s.start / dur) * 100);
      const width = Math.max(((s.end - s.start) / dur) * 100, 0.25);
      return `<div class="se-tl-block" data-idx="${i}" style="left:${left}%;width:${width}%" title="${escapeHtml(s.text)}"></div>`;
    })
    .join("");
  tl.innerHTML = `<div class="se-tl-now" id="se-tl-now"></div>${blocks}`;
  updateEditorPlayhead();
}

function updateEditorPlayhead() {
  const now = document.getElementById("se-tl-now");
  if (!now) return;
  const dur = editor.duration > 0 ? editor.duration : 1;
  const t = editor.videoEl ? editor.videoEl.currentTime : 0;
  now.style.left = Math.min(100, Math.max(0, (t / dur) * 100)) + "%";
}

// Destaque do segmento atual SEM re-render: só alterna classes nos nós
// existentes e rola a linha ativa para a vista (com pausa quando o usuário
// rola a lista manualmente).
function updateEditorHighlight() {
  const idx = editor.currentIndex;
  document.querySelectorAll(".se-row").forEach((row) => {
    row.classList.toggle("active", Number(row.dataset.idx) === idx);
  });
  document.querySelectorAll(".se-tl-block").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.idx) === idx);
  });
  if (idx >= 0) {
    const row = document.querySelector('.se-row[data-idx="' + idx + '"]');
    if (row && Date.now() - editor.userScrolledAt > 3000) {
      row.scrollIntoView({ block: "nearest" });
    }
  }
}

// Hooks no <video>: timeupdate só alterna classes/overlay — nunca re-render.
function wireEditorVideoHooks() {
  const v = editor.videoEl;
  if (!v) return;
  const onTime = () => {
    const t = v.currentTime;
    updateSubtitleOverlay(t);
    editor.currentIndex = findSubtitleSegment(editor.segments, t);
    updateEditorHighlight();
    updateEditorPlayhead();
  };
  v.addEventListener("timeupdate", onTime);
  v.addEventListener("loadedmetadata", () => {
    if (Number.isFinite(v.duration) && v.duration > 0) editor.duration = v.duration;
    renderEditorTimeline();
  });
}

function editorOnTime(t) {
  editor.currentIndex = findSubtitleSegment(editor.segments, t);
  updateEditorHighlight();
  updateEditorPlayhead();
}

function editorSeekTo(t) {
  const v = editor.videoEl;
  if (!v) return;
  const max = Number.isFinite(v.duration) ? v.duration : t;
  v.currentTime = Math.max(0, Math.min(max, t));
}

// --- Ações de mutação -----------------------------------------------------
function editorHandleAct(act, i) {
  switch (act) {
    case "set-start": editorSnapshot(); editorSetStart(i); break;
    case "set-end": editorSnapshot(); editorSetEnd(i); break;
    case "nudge-b1": editorSnapshot(); editorNudge(i, -1); break;
    case "nudge-b05": editorSnapshot(); editorNudge(i, -0.5); break;
    case "nudge-f05": editorSnapshot(); editorNudge(i, 0.5); break;
    case "nudge-f1": editorSnapshot(); editorNudge(i, 1); break;
    case "split": editorSnapshot(); editorSplit(i); break;
    case "merge": editorSnapshot(); editorMerge(i); break;
    case "del": editorSnapshot(); editorDelete(i); break;
  }
}

// Snapshot de undo: captura o estado atual ANTES da mutação.
function editorSnapshot() {
  editor.undoStack.push(editor.segments.map((s) => ({ ...s })));
  if (editor.undoStack.length > 60) editor.undoStack.shift();
  editor.redoStack.length = 0;
  editorUpdateUndoRedo();
}

function editorRestore(snapshot) {
  editor.segments = snapshot;
  editor.idCounter = editorMaxId(editor.segments);
  subtitleState.segments = editor.segments;
  subtitleState.ready = editor.segments.length > 0;
  renderEditorList();
  renderEditorTimeline();
  editorMarkDirty(true);
  editorUpdateUndoRedo();
  updateEditorHighlight();
}

function editorUndo() {
  const snap = editor.undoStack.pop();
  if (!snap) return;
  editor.redoStack.push(editor.segments.map((s) => ({ ...s })));
  editorRestore(snap);
}
function editorRedo() {
  const snap = editor.redoStack.pop();
  if (!snap) return;
  editor.undoStack.push(editor.segments.map((s) => ({ ...s })));
  editorRestore(snap);
}
function editorUpdateUndoRedo() {
  const u = document.getElementById("se-undo");
  const r = document.getElementById("se-redo");
  if (u) u.disabled = editor.undoStack.length === 0;
  if (r) r.disabled = editor.redoStack.length === 0;
}

function editorMarkDirty(d) {
  editor.dirty = d;
  const el = document.getElementById("se-dirty");
  if (el) {
    el.textContent = d ? "● alterações não salvas" : "salvo";
    el.classList.toggle("se-dirty-on", d);
  }
  const save = document.getElementById("se-save");
  if (save) save.disabled = !d;
}

function editorSetStart(i) {
  const seg = editor.segments[i];
  if (!seg) return;
  const t = editor.videoEl ? editor.videoEl.currentTime : seg.start;
  seg.start = Math.round(Math.min(t, seg.end - 0.05) * 1000) / 1000;
  editorMarkDirty(true);
  editorSyncRow(i);
  renderEditorTimeline();
}
function editorSetEnd(i) {
  const seg = editor.segments[i];
  if (!seg) return;
  const t = editor.videoEl ? editor.videoEl.currentTime : seg.end;
  seg.end = Math.round(Math.max(t, seg.start + 0.05) * 1000) / 1000;
  editorMarkDirty(true);
  editorSyncRow(i);
  renderEditorTimeline();
}
function editorNudge(i, delta) {
  const seg = editor.segments[i];
  if (!seg) return;
  let s = seg.start + delta;
  let e = seg.end + delta;
  if (s < 0) {
    e -= s;
    s = 0;
  }
  if (Number.isFinite(editor.duration) && editor.duration > 0 && e > editor.duration) {
    s -= e - editor.duration;
    e = editor.duration;
    if (s < 0) s = 0;
  }
  if (e - s < 0.05) return;
  seg.start = Math.round(s * 1000) / 1000;
  seg.end = Math.round(e * 1000) / 1000;
  editorMarkDirty(true);
  editorSyncRow(i);
  renderEditorTimeline();
}
function editorCommitTimeInput(i, input) {
  const seg = editor.segments[i];
  if (!seg) return;
  const val = parseClock2(input.value);
  const isStart = input.classList.contains("se-start");
  const cur = isStart ? seg.start : seg.end;
  if (val === null) {
    input.value = fmtClock2(cur);
    return;
  }
  if (isStart) {
    seg.start = Math.round(Math.min(val, seg.end - 0.05) * 1000) / 1000;
  } else {
    seg.end = Math.round(Math.max(val, seg.start + 0.05) * 1000) / 1000;
  }
  input.value = fmtClock2(isStart ? seg.start : seg.end);
  editorMarkDirty(true);
  renderEditorTimeline();
}
// Re-sincroniza os inputs da linha (após nudge/set) sem re-render da lista.
function editorSyncRow(i) {
  const row = document.querySelector('.se-row[data-idx="' + i + '"]');
  if (!row) return;
  const seg = editor.segments[i];
  const s = row.querySelector(".se-start");
  const e = row.querySelector(".se-end");
  if (s) s.value = fmtClock2(seg.start);
  if (e) e.value = fmtClock2(seg.end);
}

function editorSplit(i) {
  const seg = editor.segments[i];
  if (!seg) return;
  let t = editor.videoEl ? editor.videoEl.currentTime : (seg.start + seg.end) / 2;
  const cut = Math.min(Math.max(t, seg.start + 0.05), seg.end - 0.05);
  const a = { id: seg.id, start: seg.start, end: cut, text: seg.text };
  editor.idCounter += 1;
  const b = { id: "s" + editor.idCounter, start: cut, end: seg.end, text: seg.text };
  editor.segments.splice(i, 1, a, b);
  editorMarkDirty(true);
  renderEditorList();
  renderEditorTimeline();
  const ta = document.querySelector('.se-row[data-idx="' + (i + 1) + '"] .se-text');
  if (ta) ta.focus();
}
function editorMerge(i) {
  if (i < 0 || i + 1 >= editor.segments.length) return;
  const a = editor.segments[i];
  const b = editor.segments[i + 1];
  editor.segments[i] = {
    id: a.id,
    start: a.start,
    end: b.end,
    text: (a.text + " " + b.text).trim(),
  };
  editor.segments.splice(i + 1, 1);
  editorMarkDirty(true);
  renderEditorList();
  renderEditorTimeline();
}
function editorDelete(i) {
  editor.segments.splice(i, 1);
  editorMarkDirty(true);
  renderEditorList();
  renderEditorTimeline();
}
function editorAddAfter(i) {
  editorSnapshot();
  const last = editor.segments[editor.segments.length - 1];
  let start = i >= 0 && editor.segments[i] ? editor.segments[i].end : last ? last.end : 0;
  let end = start + 2;
  const next = i >= 0 ? editor.segments[i + 1] : null;
  if (next && next.start > start && next.start - start >= 0.05 && next.start < end) {
    end = Math.round((next.start - 0.05) * 1000) / 1000;
  }
  if (end - start < 0.05) end = start + 2;
  editor.idCounter += 1;
  const seg = { id: "s" + editor.idCounter, start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: "" };
  editor.segments.splice(i + 1, 0, seg);
  editorMarkDirty(true);
  renderEditorList();
  renderEditorTimeline();
  const ta = document.querySelector('.se-row[data-idx="' + (i + 1) + '"] .se-text');
  if (ta) ta.focus();
}

// --- Persistência / export / IA -------------------------------------------
async function editorSave() {
  if (editor.saveInFlight) return;
  const saveBtn = document.getElementById("se-save");
  if (!editor.segments.length) return;
  // Validação local (o servidor valida de novo).
  for (let i = 0; i < editor.segments.length; i++) {
    const s = editor.segments[i];
    if (!s.id || !(s.end - s.start >= 0.05)) {
      editorShowMessage("Segmento " + (i + 1) + " inválido (fim deve ser maior que início).");
      return;
    }
  }
  editor.saveInFlight = true;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Salvando…";
  }
  try {
    const res = await fetch(
      "/api/subtitles/save?path=" + encodeURIComponent(editor.rel),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segments: editor.segments, version: editor.version }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      editorShowConflict(data.error);
      return;
    }
    if (!res.ok) {
      editorShowMessage("Falha ao salvar: " + escapeHtml(data.error || "erro desconhecido"));
      return;
    }
    editor.version = data.version;
    editorMarkDirty(false);
    editorUpdateUndoRedo();
    editorShowToast("Salvo · versão " + data.version);
  } finally {
    editor.saveInFlight = false;
    if (saveBtn) {
      saveBtn.textContent = "💾 Salvar";
      saveBtn.disabled = !editor.dirty;
    }
  }
}

function editorShowConflict(msg) {
  // openConfirmDialog escapa o message — passar a string crua (sem pré-escape).
  openConfirmDialog({
    title: "Conflito de edição",
    message: msg || "Esta legenda foi alterada em outra aba. Recarregue o editor antes de salvar.",
    confirmLabel: "Recarregar editor",
    cancelLabel: "Manter minhas edições",
    danger: false,
    onConfirm: () => {
      editorLoadDoc();
    },
  });
}

function editorExport(format) {
  const a = document.createElement("a");
  a.href =
    "/api/subtitles/export?path=" +
    encodeURIComponent(editor.rel) +
    "&format=" +
    encodeURIComponent(format);
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function editorAiCorrect() {
  if (!editor.segments.length) return;
  const aiBtn = document.getElementById("se-ai");
  const original = aiBtn ? aiBtn.textContent : "";
  if (aiBtn) {
    aiBtn.disabled = true;
    aiBtn.textContent = "Corrigindo…";
  }
  try {
    const res = await fetch(
      "/api/subtitles/ai-corrections?path=" + encodeURIComponent(editor.rel),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: editor.segments.map((s) => ({ id: s.id, text: s.text })),
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      editorShowMessage("IA: " + escapeHtml(data.error || "erro desconhecido"));
      return;
    }
    if (!data.applied || !Array.isArray(data.corrections) || !data.corrections.length) {
      editorShowToast("IA: nada a corrigir.");
      return;
    }
    editorSnapshot();
    const byId = new Map();
    for (const c of data.corrections) byId.set(c.id, c.text);
    let n = 0;
    for (const s of editor.segments) {
      if (byId.has(s.id) && typeof byId.get(s.id) === "string" && byId.get(s.id) !== s.text) {
        s.text = byId.get(s.id);
        n++;
      }
    }
    editorMarkDirty(true);
    renderEditorList();
    editorShowToast("IA: " + n + " segmento(s) corrigido(s).");
  } finally {
    if (aiBtn) {
      aiBtn.disabled = false;
      aiBtn.textContent = original;
    }
  }
}

function editorRegenerate() {
  openConfirmDialog({
    title: "Regenerar legenda",
    message:
      "Uma nova transcrição substituirá a legenda atual. Suas edições manuais serão preservadas em backup (data/subtitles/backup/). Continuar?",
    confirmLabel: "Regenerar",
    cancelLabel: "Cancelar",
    danger: true,
    onConfirm: () => {
      editor.segments = [];
      editor.dirty = false;
      editorMarkDirty(false);
      const body = document.getElementById("se-body");
      if (body) body.innerHTML = `<div class="se-loading">Gerando nova legenda…</div>`;
      fetch("/api/subtitles/generate?path=" + encodeURIComponent(editor.rel) + "&force=1", {
        method: "POST",
      })
        .then(() => editorStartPoll())
        .catch(() => editorShowMessage("Falha ao iniciar a regeneração."));
    },
  });
}

function editorShowToast(text) {
  const t = document.getElementById("se-toast");
  if (t) {
    t.textContent = text;
    t.classList.add("show");
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove("show"), 2600);
  }
}

function navigateToLesson(lessonPath) {
  const video = state.flatVideos.find((v) => v.path === lessonPath);
  if (!video) return;
  location.hash = courseHref(state.currentCourseNode, lessonPath);
}

function changePlaybackSpeed(videoEl, delta) {
  const steps = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const current = videoEl.playbackRate || 1;
  let idx = steps.findIndex((v) => Math.abs(v - current) < 0.01);
  if (idx === -1) {
    idx = steps.reduce(
      (best, value, i) =>
        Math.abs(value - current) < Math.abs(steps[best] - current) ? i : best,
      0,
    );
  }
  const nextIdx = Math.max(0, Math.min(steps.length - 1, idx + delta));
  const nextRate = steps[nextIdx];
  videoEl.playbackRate = nextRate;
  localStorage.setItem("course-player-speed", String(nextRate));
  updateSpeedLabel(videoEl);
}

async function togglePlayerFullscreen(videoEl) {
  const playerWrap = document.getElementById("player-wrap");
  const fullscreenEl = document.fullscreenElement;
  if (fullscreenEl) {
    await document.exitFullscreen().catch(() => {});
    return;
  }

  if (playerWrap && playerWrap.requestFullscreen) {
    await playerWrap.requestFullscreen().catch(() => {});
    return;
  }

  // iOS < 16.4 não tem Element.requestFullscreen; o único caminho é o
  // fullscreen nativo do <video> (webkitEnterFullscreen), que degrada para os
  // controles nativos (sem overlay/legenda) — melhor do que o botão não fazer
  // nada. Navegadores modernos nunca chegam aqui.
  if (videoEl && videoEl.webkitEnterFullscreen) {
    try {
      videoEl.webkitEnterFullscreen();
    } catch {}
    return;
  }

  if (videoEl && videoEl.requestFullscreen) {
    await videoEl.requestFullscreen().catch(() => {});
  }
}

function registerShortcuts() {
  buildShortcutMap();
  document.addEventListener("keydown", (event) => {
    // Captura de atalho ativa na Settings: o listener dedicado cuida da tecla.
    if (captureState) return;

    const target = event.target;
    const tag = target && target.tagName ? target.tagName.toLowerCase() : "";
    const isTypingContext =
      target &&
      (target.isContentEditable ||
        tag === "input" ||
        tag === "textarea" ||
        tag === "select");

    // Enquanto um diálogo de confirmação está aberto, os atalhos globais são
    // suspensos para não navegar por trás do modal (o modal tem seu próprio
    // teclado: Esc fecha).
    if (document.querySelector(".modal-overlay")) return;

    // Esc fecha os popovers do player (volume/velocidade), o drawer do tutor e o drawer mobile
    // antes de qualquer outra ação global.
    if (event.key === "Escape") {
      if (tutorState && tutorState.open) {
        closeTutorDrawer();
        event.preventDefault();
        return;
      }
      if (closePlayerPopovers() || closeMobileDrawer()) {
        event.preventDefault();
        return;
      }
    }

    // Enquanto o Tutor IA estiver aberto, suspende TODOS os atalhos globais do player
    // para não interferir na experiência de uso e navegação do chat.
    if (tutorState && tutorState.open) return;

    // Atalhos são teclas únicas: eventos com Ctrl/Alt/Cmd não disparam
    // (preserva os atalhos do navegador, ex.: Ctrl+N/P/H). Shift é aceito —
    // a comparação é case-insensitive (Shift+M ≡ M).
    if (event.ctrlKey || event.altKey || event.metaKey) return;

    const action = actionForKey(event.key);
    if (!action) return;

    // Busca: foca o campo (só fora de contexto de digitação).
    if (action === "search") {
      if (!isTypingContext) {
        event.preventDefault();
        document.getElementById("search-input")?.focus();
      }
      return;
    }

    if (isTypingContext) return;

    // Ações de navegação funcionam mesmo sem o player carregado.
    if (action === "home") {
      event.preventDefault();
      location.hash = "/";
      return;
    }

    if (action === "next") {
      const idx = state.flatVideos.indexOf(state.currentVideoNode);
      const next = state.flatVideos[idx + 1];
      if (next) {
        event.preventDefault();
        navigateToLesson(next.path);
      }
      return;
    }

    if (action === "prev") {
      const idx = state.flatVideos.indexOf(state.currentVideoNode);
      const prev = state.flatVideos[idx - 1];
      if (prev) {
        event.preventDefault();
        navigateToLesson(prev.path);
      }
      return;
    }

    // Modo Teatro ↔ Modo Normal (só faz sentido na tela do curso).
    if (action === "theater") {
      if (!document.querySelector(".course-view")) return;
      event.preventDefault();
      toggleTheaterMode();
      return;
    }

    const videoEl = document.getElementById("video-el");
    if (!videoEl) return;

    switch (action) {
      case "playpause": {
        // Foco num botão/input do player: "Espaço" deixa o controle agir
        // (ativação nativa do botão) para não haver play/pause duplicado.
        if (
          event.key === " " &&
          target &&
          target.closest &&
          target.closest("#player-ui") &&
          (tag === "button" || tag === "input")
        )
          return;
        event.preventDefault();
        togglePlay(videoEl);
        break;
      }
      case "back5":
        event.preventDefault();
        videoEl.currentTime = Math.max(0, videoEl.currentTime - 5);
        break;
      case "fwd5": {
        event.preventDefault();
        const maxTime = Number.isFinite(videoEl.duration)
          ? videoEl.duration
          : videoEl.currentTime + 5;
        videoEl.currentTime = Math.min(maxTime, videoEl.currentTime + 5);
        break;
      }
      case "back10":
        event.preventDefault();
        videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
        break;
      case "fwd10": {
        event.preventDefault();
        const maxTime = Number.isFinite(videoEl.duration)
          ? videoEl.duration
          : videoEl.currentTime + 10;
        videoEl.currentTime = Math.min(maxTime, videoEl.currentTime + 10);
        break;
      }
      case "mute":
        event.preventDefault();
        videoEl.muted = !videoEl.muted;
        setMutedPref(videoEl.muted);
        updateVolumeUI(videoEl);
        break;
      case "speedDown":
        event.preventDefault();
        changePlaybackSpeed(videoEl, -1);
        break;
      case "speedUp":
        event.preventDefault();
        changePlaybackSpeed(videoEl, 1);
        break;
      case "fullscreen":
        event.preventDefault();
        togglePlayerFullscreen(videoEl);
        break;
    }
  });
}

// Listener de captura de atalho (aba Configurações): ativo somente enquanto
// captureState existir. Ambos os listeners ficam em document, então o handler
// global verifica captureState logo no início (a captura também chama
// preventDefault/stopPropagation).
function registerShortcutCaptureListener() {
  document.addEventListener("keydown", (event) => {
    if (!captureState) return;
    event.preventDefault();
    event.stopPropagation();

    const action = captureState.action;

    // Esc cancela a captura e mantém o atalho anterior.
    if (event.key === "Escape") {
      stopCapture();
      return;
    }

    // Modificadores puros e Tab não são atalhos válidos (Tab navega o foco).
    if (
      event.key === "Shift" ||
      event.key === "Control" ||
      event.key === "Alt" ||
      event.key === "Meta" ||
      event.key === "CapsLock" ||
      event.key === "Tab"
    ) {
      return;
    }

    const key = event.key;
    const conflict = actionForKey(key);
    if (conflict && conflict !== action) {
      const msg = captureState.row.querySelector(".shortcut-msg");
      if (msg) {
        msg.hidden = false;
        msg.textContent = `Tecla já usada em ${SHORTCUT_LABELS[conflict]}.`;
        msg.classList.add("error");
      }
      // Sai da captura mantendo o atalho anterior (a mensagem de erro fica).
      stopCapture(true);
      return;
    }

    setShortcut(action, key);
    buildShortcutMap();
    stopCapture();
  });
}

// Breadcrumb clicável de um caminho de pasta: Home › TI › Python. Cada ancestral
// vira um link #/topic/<path>; a Home linka para #/. Usa os mesmos estilos do
// breadcrumb do player (prefixo truncável + separadores + folha).
function topicBreadcrumb(path, libId) {
  const parts = path.split("/");
  let html = `<a class="breadcrumb-link" href="#/">Home</a>`;
  let acc = "";
  const libPrefix = isExternalLib(libId) ? encodeURIComponent(libId) + "/" : "";
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part;
    const isLast = part === parts[parts.length - 1];
    html += `<span class="breadcrumb-sep"> › </span>`;
    html += isLast
      ? `<span class="breadcrumb-leaf">${escapeHtml(part)}</span>`
      : `<a class="breadcrumb-link" href="#/topic/${libPrefix}${encodeURIComponent(acc)}">${escapeHtml(part)}</a>`;
  }
  return html;
}

// Visão de tópico: lista os filhos (sub-tópicos e cursos) num grid, sem abrir o
// player. Não mostra favoritos nem progresso (v1 só contagens — §13 do prompt).
function renderTopic(app, topicPath, libId) {
  const node = findNodeByPath(libTree(libId), topicPath);
  if (!node || node.type !== "topic") {
    renderCourse(app, topicPath, null, false, libId);
    return;
  }
  state.currentCourseNode = null;
  state.flatVideos = [];
  const children = node.children || [];
  // Escopo contextual do tópico (CURRENT_TOPIC subtree only, recursivo):
  // "Continuar assistindo" e "Seu progresso" só enxergam cursos DENTRO deste
  // tópico — tópicos irmãos, cursos da Home e outras bibliotecas ficam de fora.
  const scopeCourses = collectCoursesInScope(node);
  const scopeSummary = getLibraryProgressSummary(scopeCourses, progFor);
  const topContinue = buildContinueItems(scopeCourses, progFor);
  let html = `
    <div class="topic-view">
      <div class="topic-breadcrumb">${topicBreadcrumb(topicPath, libId)}</div>
      <h1 class="topic-title" title="${escapeHtml(topicTitle(node))}">${escapeHtml(topicTitle(node))}</h1>`;
  if (topContinue.length) {
    html += renderContinueSection(topContinue, scopeSummary);
  }
  if (scopeCourses.length) {
    html += renderProgressSection(scopeSummary, scopeCourses.length);
  }
  if (!children.length) {
    html += `<div class="empty-state">Tópico vazio.</div>`;
  } else {
    // Tópico, por construção, só tem pastas como filhas (sub-tópicos e cursos).
    // Defensivo: se houver vídeo/material direto, renderiza como lista simples
    // em vez de card.
    const folders = children.filter(
      (c) => c.type === "folder" || c.type === "topic",
    );
    const loose = children.filter((c) => c.type !== "folder");
    if (folders.length) {
      html += `<div class="course-grid">`;
      for (const child of folders) {
        html += renderNodeCard(child);
      }
      html += `</div>`;
    }
    if (loose.length) {
      html += `<ul class="topic-loose">`;
      for (const item of loose) {
        html += `<li><a href="${mediaUrl(item.path, item.libId)}" target="_blank" rel="noopener">${escapeHtml(item.name)}</a></li>`;
      }
      html += `</ul>`;
    }
  }
  html += `</div>`;
  app.innerHTML = html;
  bindProgressToggle();
}

function renderCourse(app, coursePath, lessonPath, editMode, libId) {
  // Editor de legendas desativado: ignora ?editSubtitles=1 e nunca entra em modo editor.
  subtitleEditorMode = false;
  // Resolve por path na árvore da biblioteca inteira (não só top-level) —
  // habilita cursos aninhados em tópicos. Um nó com type==="topic" delega a
  // renderTopic (links velhos #/course/<topicPath> degradam bem).
  const node = findNodeByPath(libTree(libId), coursePath);
  if (!node || (node.type !== "folder" && node.type !== "topic")) {
    app.innerHTML = `<div class="empty-state">Curso não encontrado.</div>`;
    return;
  }
  if (node.type === "topic") {
    renderTopic(app, coursePath, libId);
    return;
  }
  const course = node;

  state.currentCourseNode = course;
  state.flatVideos = flattenVideos(course);

  let video = lessonPath
    ? state.flatVideos.find((v) => v.path === lessonPath)
    : null;
  if (!video) {
    // Retoma a última aula em andamento (a mais recente por updatedAt),
    // mesmo que haja aulas anteriores ainda não concluídas.
    const inProgress = state.flatVideos
      .filter((v) => {
        const p = progFor(v);
        return p && p.position > 5 && !p.completed;
      })
      .sort(
        (a, b) =>
          (progFor(b).updatedAt || 0) - (progFor(a).updatedAt || 0),
      );
    video =
      inProgress[0] ||
      state.flatVideos.find((v) => {
        const p = progFor(v);
        return !(p && p.completed);
      }) ||
      state.flatVideos[0] ||
      null;
  }
  state.currentVideoNode = video;

  const stats = getNodeProgressStats(course, progFor);
  const pct = stats.pct;

  // Modo de visualização persistido aplicado no render (troca de aula mantém
  // teatro/normal e o estado do sumário).
  const theater = getViewMode() === "theater";
  const summaryOpen = theater && getSummaryOpen();

  // "Gerar legendas" só existe quando o Whisper está configurado — sem
  // binário/modelo o botão não apareceria nem faria nada.
  const courseSubtitleBtn = subtitleGenerateEnabled
    ? `<button class="secondary-btn" id="generate-course-subtitles">Gerar legendas</button>`
    : "";

  app.innerHTML = `
    <div class="back-link" id="back-link">← Voltar aos cursos</div>
    <div class="course-view drawer-host ${theater ? "theater" : ""} ${summaryOpen ? "summary-open" : ""}">
      <div class="player-col">
        <div class="course-toolbar">
          <div class="course-toolbar-title">${escapeHtml(courseTitle(course))}</div>
          <div class="course-toolbar-actions">
            <button class="secondary-btn" id="toggle-fav-course">${isFavorite(course.path, course.libId) ? "★ Favorito" : "☆ Favoritar"}</button>
            ${courseSubtitleBtn}
            <button class="secondary-btn" id="clear-course-progress">Limpar progresso do curso</button>
          </div>
        </div>
        <div class="player-wrap" id="player-wrap"></div>
        <div class="lesson-header" id="lesson-header"></div>
        <div id="materials-slot"></div>
        <div id="subtitle-editor-slot"></div>
      </div>
      <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
      <div class="sidebar">
        <div class="sidebar-header">
          <div class="sidebar-title"><span class="sidebar-course-name">${escapeHtml(courseTitle(course))}</span> <span class="pct">${pct}%</span></div>
          <button class="sidebar-close-btn" id="sidebar-close-btn" aria-label="Fechar lista de aulas" title="Fechar (Esc)" type="button">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div class="sidebar-progress">
          <div class="progress-bar sidebar-progress-bar"><div class="progress-bar-fill" id="course-progress-fill" style="width:${pct}%"></div></div>
          <div class="sidebar-progress-meta">
            <span id="course-progress-count">${stats.done}/${stats.total} aulas concluídas</span>
            <span id="course-progress-watch">${formatDuration(stats.watchedSeconds)} assistidos</span>
          </div>
        </div>
        <div id="tree-slot"></div>
      </div>
    </div>
    <div id="tutor-drawer-slot"></div>
    <div class="tutor-backdrop" id="tutor-backdrop" hidden></div>`;

  document.getElementById("back-link").addEventListener("click", () => {
    location.hash = "/";
  });
  document
    .getElementById("sidebar-close-btn")
    ?.addEventListener("click", () => closeMobileDrawer());
  document
    .getElementById("toggle-fav-course")
    ?.addEventListener("click", () => {
      toggleFavorite(course.path, course.libId);
      route();
    });
  document
    .getElementById("clear-course-progress")
    ?.addEventListener("click", () => {
      openConfirmDialog({
        title: "Limpar progresso do curso",
        message:
          "Todo o progresso salvo para este curso será removido: posição dos vídeos, aulas concluídas e tempo assistido. Esta ação não pode ser desfeita.",
        confirmLabel: "Limpar",
        cancelLabel: "Cancelar",
        danger: true,
        onConfirm: () => clearProgress(course.path, course.libId),
      });
    });
  document
    .getElementById("generate-course-subtitles")
    ?.addEventListener("click", async () => {
      const btn = document.getElementById("generate-course-subtitles");
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Enfileirando…";
      try {
        const res = await fetch(
          "/api/subtitles/generate-course?path=" + encodeURIComponent(course.path) + libQuery(course),
          { method: "POST" },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "generate-course failed");
        btn.textContent = `${data.enqueued} enfileirados · ${data.skipped} já prontos`;
        window.setTimeout(() => {
          btn.disabled = false;
          btn.textContent = original;
        }, 2500);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Falhou";
        window.setTimeout(() => {
          btn.textContent = original;
        }, 3000);
      }
    });
  renderTree(course, true);
  renderPlayerAndLesson();
}

// ---------- Roteamento ----------
function route() {
  // Guarda de "alterações não salvas" do editor: se a navegação tentar sair
  // de um editor sujo, o hash é restaurado para o editor e o usuário decide.
  // (location.hash já mudou quando o hashchange dispara; restaurar re-renderiza
  // o editor e a confirmação decide o destino final.)
  if (!dirtyGuardSuppressed && subtitleEditorMode && editor.dirty && editor.open) {
    const pending = location.hash;
    dirtyGuardSuppressed = true;
    location.hash = editorActiveHash || pending;
    openConfirmDialog({
      title: "Alterações não salvas",
      message:
        "Você editou legendas que ainda não foram salvas. Descartar essas alterações e sair?",
      confirmLabel: "Descartar e sair",
      cancelLabel: "Continuar editando",
      danger: true,
      onConfirm: () => {
        dirtyGuardSuppressed = false;
        editor.dirty = false;
        location.hash = pending;
      },
      onCancel: () => {
        dirtyGuardSuppressed = false;
      },
    });
    return;
  }
  dirtyGuardSuppressed = false;

  // Troca de rota/aula: salva a posição do vídeo atual e libera o source Web
  // Audio ANTES de o DOM ser substituído — este é o último momento em que o
  // elemento <video> antigo ainda existe (o render seguinte o destrói via
  // app.innerHTML). Sem isso, trocar de aula enquanto toca perderia até 5s
  // de posição (o próximo salvar só ocorreria no pause/beforeunload).
  if (currentVideoPersist) {
    try {
      currentVideoPersist(false);
    } catch {}
  }
  detachAudioSource();
  fallbackPreparing = false;

  const app = document.getElementById("app");
  const hash = location.hash.slice(1) || "/";
  if (hash.startsWith("/course/") || hash.startsWith("/topic/")) {
    // #/course/<path> (curso) e #/topic/<path> (tópico) caem no mesmo parse;
    // renderCourse decide pelo type do nó (topic → renderTopic).
    const prefix = hash.startsWith("/course/") ? "/course/" : "/topic/";
    const rest = hash.slice(prefix.length);
    const [nodePathEnc, query] = rest.split("?");
    // Prefixo de biblioteca (legado): o primeiro segmento pode ser um id de
    // biblioteca não-padrão. O path restante vem 100% encoded (nunca `/` cru),
    // então um `/` real separa o id do path.
    let libId = null;
    let pathEnc = nodePathEnc;
    const slashIdx = nodePathEnc.indexOf("/");
    if (slashIdx !== -1) {
      const first = decodeURIComponent(nodePathEnc.slice(0, slashIdx));
      if (getLibById(first)) {
        libId = first;
        pathEnc = nodePathEnc.slice(slashIdx + 1);
      }
    }
    const nodePath = decodeURIComponent(pathEnc);
    let lessonPath = null;
    let editMode = false;
    if (query) {
      const params = new URLSearchParams(query);
      if (params.get("lesson"))
        lessonPath = decodeURIComponent(params.get("lesson"));
      editMode = params.get("editSubtitles") === "1";
    }
    renderCourse(app, nodePath, lessonPath, editMode, libId);
  } else if (hash === "/settings" || hash.startsWith("/settings/")) {
    // #/settings → "Geral"; #/settings/<cat> → categoria específica.
    renderSettings(app);
  } else {
    renderHome(app);
  }
}

async function init() {
  await loadAll();
  route();
  window.addEventListener("hashchange", route);
  window.addEventListener("beforeunload", () => {
    if (currentVideoBeacon) currentVideoBeacon(false);
  });
  // Salva ao trocar de aba/esconder a página — mais confiável que só
  // beforeunload em navegadores modernos, e cobre o fechamento sem perder o
  // último estado (o fetch do `persist` seria abortado no unload).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && currentVideoBeacon) {
      currentVideoBeacon(false);
    }
  });
  registerShortcutCaptureListener();
  registerShortcuts();

  // Fecha os popovers do player (volume/velocidade/CC/⋮) ao clicar/tocar fora.
  document.addEventListener("pointerdown", (e) => {
    const volPop = document.getElementById("pc-vol-pop");
    const volBtn = document.getElementById("pc-vol-btn");
    const speedMenu = document.getElementById("pc-speed-menu");
    const speedBtn = document.getElementById("pc-speed-btn");
    const ccMenu = document.getElementById("pc-cc-menu");
    const ccBtn = document.getElementById("pc-cc-btn");
    const moreMenu = document.getElementById("pc-more-menu");
    const moreBtn = document.getElementById("pc-more-btn");
    if (volPop && !volPop.hidden && !e.target.closest(".pc-group-vol")) {
      volPop.hidden = true;
      volBtn?.setAttribute("aria-expanded", "false");
    }
    if (speedMenu && !speedMenu.hidden && !e.target.closest(".pc-group-speed")) {
      speedMenu.hidden = true;
      speedBtn?.setAttribute("aria-expanded", "false");
    }
    if (ccMenu && !ccMenu.hidden && !e.target.closest(".pc-group-cc")) {
      ccMenu.hidden = true;
      ccBtn?.setAttribute("aria-expanded", "false");
    }
    if (moreMenu && !moreMenu.hidden && !e.target.closest(".pc-group-more")) {
      moreMenu.hidden = true;
      moreBtn?.setAttribute("aria-expanded", "false");
    }
  });

  // Mantém o ícone de fullscreen sincronizado (entrar/sair).
  document.addEventListener("fullscreenchange", () => {
    const btn = document.getElementById("pc-fullscreen");
    if (btn) {
      const active = !!document.fullscreenElement;
      btn.innerHTML = active ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN;
      btn.setAttribute("aria-label", active ? "Sair da tela cheia" : "Tela cheia");
    }
    document.getElementById("player-wrap")?.classList.remove("pc-idle");
  });

  document.getElementById("settings-btn")?.addEventListener("click", () => {
    location.hash = "/settings";
  });

  const searchInput = document.getElementById("search-input");
  searchInput.addEventListener("input", () => {
    if (!location.hash || location.hash === "#/")
      renderHome(document.getElementById("app"));
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (location.hash && location.hash !== "#/") return;
    const first = state.lastSearchResults[0];
    if (!first) return;
    event.preventDefault();
    if (first.type === "topic") {
      location.hash = topicRoute({ path: first.path, libId: first.libId });
    } else if (first.lessonPath) {
      location.hash = courseRoute({ path: first.coursePath, libId: first.libId }) + `?lesson=${encodeURIComponent(first.lessonPath)}`;
    } else {
      location.hash = courseRoute({ path: first.coursePath, libId: first.libId });
    }
  });
  document.getElementById("rescan-btn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "⟳ Atualizando...";
    await fetch("/api/rescan", { method: "POST" });
    await loadAll();
    route();
    e.target.disabled = false;
    e.target.textContent = "⟳ Atualizar";
  });
}

init();
