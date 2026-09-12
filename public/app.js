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
  collectOrphanRecords,
} = window.LocalPlayerScope;

// Limite de cards de "Continuar assistindo": limitado a no máximo 4 cards.
function continueLimit() {
  return 4;
}

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
let favorites = new Set();
try {
  const rawFavs = localStorage.getItem("course-favorites");
  if (rawFavs) {
    const list = JSON.parse(rawFavs);
    if (Array.isArray(list)) {
      favorites = new Set(
        list.map((k) => (typeof k === "string" && k.includes("\0") ? k : DEFAULT_LIB_ID + "\0" + k)),
      );
    }
  }
} catch {
  favorites = new Set();
}

function isFavorite(path, libId) {
  if (!path) return false;
  return favorites.has(progKey(path, libId));
}

function toggleFavorite(path, libId) {
  if (!path) return;
  const key = progKey(path, libId);
  if (favorites.has(key)) favorites.delete(key);
  else favorites.add(key);
  try {
    localStorage.setItem("course-favorites", JSON.stringify([...favorites]));
  } catch (err) {
    console.warn("Falha ao persistir favoritos no localStorage:", err);
  }
}

function favButtonHtml(path, libId) {
  const on = isFavorite(path, libId);
  return `<button class="fav-btn ${on ? "on" : ""}" type="button" data-fav="${encodeURIComponent(path || "")}" data-lib="${encodeURIComponent(libId || "")}" title="${on ? "Remover dos favoritos" : "Favoritar curso"}" aria-label="${on ? "Remover dos favoritos" : "Favoritar curso"}">${on ? "★" : "☆"}</button>`;
}

// Modo da seção "Seu progresso" (expandida/compacta), persistido no
// localStorage. Padrão: compacta em qualquer resolução.
const PROGRESS_MODE_KEY = "course-player-progress-mode";

function getProgressMode() {
  const saved = localStorage.getItem(PROGRESS_MODE_KEY);
  if (saved === "expanded" || saved === "compact") return saved;
  return "compact";
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

// Atalhos de teclado (mapas e configurações) movidos para public/js/shortcuts.js

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
    // no-store: a árvore muda a cada rescan e nunca pode vir do cache.
    fetch("/api/tree", { cache: "no-store" }),
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
  // coursePath null = limpar tudo com all: true explícito; senão limpa o escopo da aula.
  const body = coursePath != null ? { coursePath } : { all: true, coursePath: null };
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
  fetch("/api/transcode/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
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

// Configurações e Central de IA movidos para public/js/settings.js

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
  const isCompleted = stats.total > 0 && stats.done === stats.total;
  const coverImage = node.coverImage ? mediaUrl(node.coverImage, node.libId) : null;
  const href = courseRoute(node);
  return `
    <div class="course-card ${isCompleted ? "is-completed" : ""}">
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

// Seção "Continuar assistindo": cabeçalho + cards.
function renderContinueSection(items, summary) {
  let html = `
    <section class="home-section">
      <div class="section-head">
        <div>
          <h2 class="section-heading">Continuar assistindo</h2>
          <p class="section-subtitle">Retome de onde parou</p>
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
  // Histórico de arquivos movidos/renomeados/removidos entra na conta (nunca
  // some); o sufixo deixa explícito de onde vem a diferença.
  const orphanSuffix = summary.orphanLessons
    ? ` · ${summary.orphanLessons} de arquivo${summary.orphanLessons === 1 ? "" : "s"} movido${summary.orphanLessons === 1 ? "" : "s"}`
    : "";
  const lessonsSub = summary.orphanLessons
    ? `de ${summary.totalLessons} aulas (inclui movidas/renomeadas)`
    : `de ${summary.totalLessons} na biblioteca`;
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
          <div class="progress-summary-meta">${summary.doneLessons} aulas concluídas · ${summary.startedCourses} cursos ativos · ${watchedLabel} estudadas${orphanSuffix}</div>
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
            <div class="progress-stat-sub">${lessonsSub}</div>
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
  // Órfãos (histórico de arquivos movidos/renomeados/removidos, sem nó na
  // árvore — ex.: pasta renomeada) entram nos dois resumos: nada estudado
  // fica invisível.
  const videoKeys = new Set();
  for (const c of allCourses) {
    for (const v of flattenVideos(c)) videoKeys.add(progKey(v.path, v.libId));
  }
  const orphans = collectOrphanRecords(
    state.progress,
    videoKeys,
    libs.map((l) => l.id),
  );
  const continueSummary = getLibraryProgressSummary(allCourses, progFor, orphans);
  const progressScope = directCourses.length ? directCourses : allCourses;
  const librarySummary = getLibraryProgressSummary(progressScope, progFor, orphans);
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
  const topContinue = buildContinueItems(allCourses, progFor, continueLimit());

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
    const unavailableLibs = (state.libraries || []).filter(
      (l) => l.enabled !== false && (l.status === "unavailable" || l.status === "error"),
    );
    if (unavailableLibs.length > 0 && !libs.length) {
      html += `<div class="empty-state" style="border: 1px solid rgba(234, 179, 8, 0.35); background: rgba(234, 179, 8, 0.08); border-radius: 10px; padding: 24px; text-align: center; margin: 20px 0;">
        <div style="font-size: 1.15rem; font-weight: 600; margin-bottom: 8px; color: #eab308;">⚠ Biblioteca indisponível</div>
        <p style="margin-bottom: 14px; opacity: 0.85;">O dispositivo ou pasta onde seus cursos estão armazenados não está acessível no momento.</p>
        <a href="#/settings" class="btn btn--primary" style="display: inline-block; text-decoration: none; padding: 8px 18px; border-radius: 6px; font-weight: 500;">Configurações → Bibliotecas</a>
      </div>`;
    } else if (!libs.length) {
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
      e.preventDefault();
      e.stopPropagation();
      const favPath = el.dataset.fav ? decodeURIComponent(el.dataset.fav) : null;
      const favLib = el.dataset.lib ? decodeURIComponent(el.dataset.lib) : "";
      if (favPath) {
        toggleFavorite(favPath, favLib);
        renderHome(app);
      }
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
      const isCompleted = stats.total > 0 && stats.done === stats.total;
      const isOpen = expandedFolders.has(child.path);
      // data-depth permite ao CSS diferenciar módulo (1) de submódulo (2+) e
      // capar a indentação em níveis profundos. Tabindex/role/aria-expanded
      // tornam a pasta operável por teclado.
      html += `
        <div class="tree-folder ${isCompleted ? "completed" : ""}">
          <div class="tree-folder-head ${isOpen ? "open" : ""} ${isCompleted ? "completed" : ""}" data-folder="${encodeURIComponent(child.path)}" data-depth="${Math.min(depth, 4)}" role="button" tabindex="0" aria-expanded="${isOpen}">
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

  const libId =
    lesson.libId ||
    (state.currentCourseNode && state.currentCourseNode.libId) ||
    DEFAULT_LIB_ID;
  const key = progKey(lessonPath, libId);
  const current = state.progress[key] || {
    position: 0,
    duration: 0,
    completed: false,
  };
  const completed = !current.completed;

  const isCurrentActive =
    state.currentVideoNode && state.currentVideoNode.path === lessonPath;
  const videoEl = isCurrentActive ? document.getElementById("video-el") : null;
  const dur =
    videoEl && Number.isFinite(videoEl.duration) && videoEl.duration > 0
      ? videoEl.duration
      : current.duration || 0;
  let pos =
    videoEl && Number.isFinite(videoEl.currentTime) && videoEl.currentTime > 0
      ? videoEl.currentTime
      : current.position || 0;
  if (completed && dur > 0 && pos < 1) {
    pos = dur;
  }

  const nextProgress = {
    position: pos,
    duration: dur,
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
  if (isExternalLib(libId)) body.libraryId = libId;
  fetch("/api/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((res) => {
      if (res.ok) {
        hideProgressSaveWarning();
      } else {
        reportProgressSaveError(new Error("HTTP " + res.status));
      }
    })
    .catch((err) => reportProgressSaveError(err));

  updateProgressUI();
  renderTree(state.currentCourseNode, false);
  if (isCurrentActive) {
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
  const initialSaved = progFor(video);
  // Retoma também vídeos marcados como concluídos pelo ✓ (a posição real é
  // preservada). Concluídos por `ended` (position == duration) voltam ao
  // início para reassistir.
  if (
    initialSaved &&
    initialSaved.position > 3 &&
    initialSaved.position < (initialSaved.duration || Infinity) - 2
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
          initialSaved.position,
          Math.max(0, (el.duration || initialSaved.position) - 1),
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
    const current = progFor(video);
    const duration =
      (Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0) ||
      (current && current.duration) ||
      (initialSaved && initialSaved.duration) ||
      0;
    const autoCompleted = duration > 0 && el.currentTime / duration > 0.95;
    const completed = forceCompleted || autoCompleted;
    let position = completed ? duration : el.currentTime;
    const wasCompleted = !!(current && current.completed);
    if (wasCompleted && !completed) {
      // Reassistir parcialmente um vídeo já concluído não remove a conclusão;
      // para desmarcar, use o ✓ na árvore de aulas.
      position = Math.max(position, (current && current.position) || 0);
    } else if (!completed && position < 1 && current && (current.position || 0) > 1) {
      return null; // posição zerada não apaga progresso válido
    } else if (!completed && position < 1 && duration <= 0) {
      return null; // ainda sem metadados: nada a gravar
    }
    const nextCompleted = completed || wasCompleted;
    // O servidor deriva a chave (`<libId>\0<rel>`) a partir do path relativo e
    // da biblioteca — envia o rel, não a chave composta.
    const libId =
      video.libId ||
      (state.currentCourseNode && state.currentCourseNode.libId) ||
      DEFAULT_LIB_ID;
    const body = {
      path: video.path,
      position,
      duration,
      completed: nextCompleted,
      requestId: newRequestId(),
    };
    if (isExternalLib(libId)) body.libraryId = libId;
    return body;
  };

  const persist = (forceCompleted) => {
    const payload = progressPayload(forceCompleted);
    if (!payload) return;
    const libId =
      video.libId ||
      (state.currentCourseNode && state.currentCourseNode.libId) ||
      DEFAULT_LIB_ID;
    state.progress[progKey(video.path, libId)] = {
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

// Player, Áudio, Tracking e Transcode movidos para public/js/player.js

// Atalhos de teclado (listener) movidos para public/js/shortcuts.js

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
  // Órfãos do próprio tópico (arquivo renomeado/movido dentro dele): contam
  // no resumo como histórico, com o mesmo conjunto de vídeos do escopo.
  const scopeKeys = new Set();
  for (const c of scopeCourses) {
    for (const v of flattenVideos(c)) scopeKeys.add(progKey(v.path, v.libId));
  }
  const scopeOrphans = collectOrphanRecords(
    state.progress,
    scopeKeys,
    [getLibById(libId) ? libId : DEFAULT_LIB_ID],
    topicPath,
  );
  const scopeSummary = getLibraryProgressSummary(scopeCourses, progFor, scopeOrphans);
  const topContinue = buildContinueItems(scopeCourses, progFor, continueLimit());
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
      const orderedFolders = folders.slice().sort(
        (a, b) => Number(isFavorite(b.path, b.libId)) - Number(isFavorite(a.path, a.libId)),
      );
      html += `<div class="course-grid">`;
      for (const child of orderedFolders) {
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
  app.querySelectorAll(".fav-btn").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const favPath = el.dataset.fav ? decodeURIComponent(el.dataset.fav) : null;
      const favLib = el.dataset.lib ? decodeURIComponent(el.dataset.lib) : "";
      if (favPath) {
        toggleFavorite(favPath, favLib);
        renderTopic(app, topicPath, libId);
      }
    });
  });
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
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      toggleFavorite(course.path, course.libId);
      const isFav = isFavorite(course.path, course.libId);
      const btn = document.getElementById("toggle-fav-course");
      if (btn) btn.textContent = isFav ? "★ Favorito" : "☆ Favoritar";
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

// Pós-rescan na página do curso: atualiza estado global + sidebar/progresso
// no lugar, SEM destruir o <video> em reprodução. Retorna false quando não
// há player montado ou o curso/aula sumiu do disco (o chamador faz route()
// total nesses casos).
function refreshCourseViewInPlace() {
  const videoEl = document.getElementById("video-el");
  const course = state.currentCourseNode;
  const video = state.currentVideoNode;
  if (!videoEl || !course || !video) return false;
  const newCourse = findNodeByPath(libTree(video.libId), course.path);
  if (!newCourse || newCourse.type !== "folder") return false;
  const newFlat = flattenVideos(newCourse);
  const newVideo = newFlat.find((v) => v.path === video.path);
  if (!newVideo) return false; // aula removida do disco: route() reseleciona
  // Mesmos path/libId em objetos frescos: <video>, src e closures de
  // tracking seguem válidos — nada é recriado, a reprodução continua.
  state.currentCourseNode = newCourse;
  state.flatVideos = newFlat;
  state.currentVideoNode = newVideo;
  const titleEl = document.querySelector(".course-toolbar-title");
  if (titleEl) titleEl.textContent = courseTitle(newCourse);
  renderTree(newCourse, false);
  updateProgressUI();
  return true;
}

// Toast transitório não-bloqueante para erros do rescan. Auto-remove.
function showRescanToast(message) {
  document.querySelector(".rescan-toast")?.remove();
  const el = document.createElement("div");
  el.className = "rescan-toast";
  el.setAttribute("role", "status");
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function initHeartbeat() {
  const ping = () => {
    fetch("/api/system/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).catch(() => {});
  };
  ping();
  setInterval(ping, 60000);
}

async function init() {
  initHeartbeat();
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

  // Rede de segurança universal para qualquer botão de favoritar (.fav-btn).
  document.addEventListener("click", (e) => {
    const favBtn = e.target.closest(".fav-btn");
    if (!favBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const favPath = favBtn.dataset.fav ? decodeURIComponent(favBtn.dataset.fav) : null;
    const favLib = favBtn.dataset.lib ? decodeURIComponent(favLib.dataset.lib) : "";
    if (!favPath) return;
    toggleFavorite(favPath, favLib);
    const on = isFavorite(favPath, favLib);
    favBtn.classList.toggle("on", on);
    favBtn.textContent = on ? "★" : "☆";
    favBtn.title = on ? "Remover dos favoritos" : "Favoritar curso";
    favBtn.setAttribute("aria-label", on ? "Remover dos favoritos" : "Favoritar curso");
    const hash = (location.hash || "").replace(/^#/, "");
    if (!hash || hash === "/") {
      const appEl = document.getElementById("app");
      if (appEl) renderHome(appEl);
    }
  });

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
  // Botão "⟳ Atualizar": rescan real no disco + re-render reativo SEM F5.
  // Usa currentTarget (o botão) — e.target pode ser o <span> interno do
  // ícone/rótulo, e mutar o span corrompia a estrutura do botão. Na página
  // do curso a sidebar é atualizada no lugar para não resetar o <video> em
  // reprodução; só há re-render total se o curso/aula sumiu do disco.
  let rescanning = false;
  document.getElementById("rescan-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (rescanning) return;
    rescanning = true;
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span class="rescan-icon" aria-hidden="true">⟳</span> <span class="rescan-label">Atualizando...</span>`;
    try {
      const res = await fetch("/api/rescan", {
        method: "POST",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadAll();
      if (!refreshCourseViewInPlace()) route();
      // Feedback transitório de sucesso (2s), sem bloquear a interface.
      btn.innerHTML = `<span class="rescan-icon" aria-hidden="true">✓</span> <span class="rescan-label">Atualizado!</span>`;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (err) {
      console.error("[rescan] falha ao atualizar:", err);
      showRescanToast("Falha ao atualizar a biblioteca. Tente novamente.");
    } finally {
      btn.innerHTML = originalHTML;
      btn.disabled = false;
      rescanning = false;
    }
  });
}

init();
