// Gerenciamento de Legendas, Overlay, Geometria e Arraste
// ---------- Legendas por IA (estágio 6) ----------
// Integração NÃO-bloqueante com o player: o vídeo toca primeiro; quando a
// legenda está pronta, o texto é exibido no overlay .subtitle-overlay (nunca
// via <track>). Se o modo de geração for automático e não houver legenda,
// dispara a geração em segundo plano. O status aparece num badge discreto
// (nunca um modal): "Legenda disponível", "Gerando legenda…", "Legenda
// indisponível" ou "Erro ao gerar".
let subtitlePollTimer = null;
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
var subtitleState = {
  hash: null,
  rel: null,
  libId: null,
  ready: false,
  source: null, // 'edited' | 'processed' | 'vtt' | null
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
  // Visibilidade das legendas (localStorage); sem seleção de idioma.
  // Posição arrastável da legenda (como no YouTube): normalizada e por aula —
  // `pos.v` = fração da altura do quadro medida da base (0 = padrão, 1 = topo),
  // `pos.h` = fração horizontal do centro (0.5 = centro). null = padrão.
  // Reiniciada a cada aula (setupPlayerSubtitles), como o YouTube.
  pos: null,
  // Percentual real do job ativo (progresso do whisper via -pp), p/ o badge.
  percent: null,
  originalSegments: [],
  selectedLang: "source", // "source" | "translated"
  targetLang: "pt",
  translations: [],
  llmAvailable: false,
  translating: false,
  translationError: null,
  targetLangReady: false,
  currentActionHandler: null,
};

// ---------------------------------------------------------------------------
// Botão CC + menu (legendas). O status é "exibido" pelo dot do botão e pelos
// itens do menu — nenhum badge flutuante sobre o vídeo (reduz densidade).
// A preferência Ligado/Desativado fica no localStorage (nunca no servidor).
// ---------------------------------------------------------------------------
const SUBTITLES_ENABLED_KEY = "course-player-subtitles-enabled";
const SUBTITLE_TARGET_LANG_KEY = "course-player-subtitle-target-lang";
const SUBTITLE_MODE_KEY = "course-player-subtitle-mode";

const SUBTITLE_LANG_LABELS = {
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

function getSubtitleTargetLang() {
  const v = localStorage.getItem(SUBTITLE_TARGET_LANG_KEY);
  if (v && SUBTITLE_LANG_LABELS[v]) return v;
  if (typeof subtitleState !== "undefined" && subtitleState.defaultTargetLang && SUBTITLE_LANG_LABELS[subtitleState.defaultTargetLang]) {
    return subtitleState.defaultTargetLang;
  }
  return "pt";
}

function setSubtitleTargetLang(lang) {
  if (!SUBTITLE_LANG_LABELS[lang]) return;
  try {
    localStorage.setItem(SUBTITLE_TARGET_LANG_KEY, lang);
  } catch {}
  subtitleState.targetLang = lang;
}

function getSubtitleMode() {
  return localStorage.getItem(SUBTITLE_MODE_KEY) === "translated" ? "translated" : "source";
}

function setSubtitleMode(mode) {
  try {
    localStorage.setItem(SUBTITLE_MODE_KEY, mode === "translated" ? "translated" : "source");
  } catch {}
}

// Parser VTT canônico compartilhado (public/scope.js, carregado antes deste
// script via <script src="/scope.js">) — sem duplicar a lógica aqui.
function parseVttSegments(vttText) {
  return LocalPlayerScope.parseVttSegments(vttText);
}

async function switchToTranslatedSegments(targetLang, rel, libId) {
  const hash = subtitleState.hash;
  if (!hash) return false;
  const relPath = rel || subtitleState.rel;
  const lib = libId || subtitleState.libId;
  const url =
    `/subtitles/${hash}-${targetLang}.vtt?rel=${encodeURIComponent(relPath)}` +
    libQuery({ libId: lib });
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const vttText = await res.text();
    const segs = parseVttSegments(vttText);
    if (segs && segs.length) {
      subtitleState.ready = true;
      subtitleState.segments = segs;
      subtitleState.selectedLang = "translated";
      setSubtitleMode("translated");
      subtitleState.currentIndex = -1;
      applySubtitleVisibility();
      syncSubtitleCcUi();
      const v = document.getElementById("video-el");
      if (v) updateSubtitleOverlay(typeof v.currentTime === "number" ? v.currentTime : 0);
      return true;
    }
  } catch {}
  return false;
}

function switchToOriginalSegments() {
  if (subtitleState.originalSegments && subtitleState.originalSegments.length) {
    subtitleState.segments = subtitleState.originalSegments;
  }
  subtitleState.selectedLang = "source";
  setSubtitleMode("source");
  subtitleState.currentIndex = -1;
  applySubtitleVisibility();
  syncSubtitleCcUi();
  const v = document.getElementById("video-el");
  if (v) updateSubtitleOverlay(typeof v.currentTime === "number" ? v.currentTime : 0);
}

async function requestSubtitleTranslate(targetLang, force = false) {
  const rel = subtitleState.rel;
  const libId = subtitleState.libId;
  if (!rel) return;
  const lang = targetLang || subtitleState.targetLang || getSubtitleTargetLang();

  if (!subtitleState.llmAvailable) {
    if (typeof showToast === "function") {
      showToast("Configure um provedor LLM em Configurações > Central de IA para traduzir legendas.");
    }
    subtitleState.translationError = "Configure um provedor LLM em Configurações > Inteligência Artificial > Provedores LLM.";
    syncSubtitleCcUi();
    return;
  }

  subtitleState.translating = true;
  subtitleState.translationError = null;
  syncSubtitleCcUi();

  try {
    const url = "/api/subtitles/translate" + (force ? "?force=1" : "");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: rel,
        targetLang: lang,
        ...(libId ? { libId } : {}),
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.ok === false)) {
      subtitleState.translating = false;
      let errStr = (data && data.error) || "Falha ao traduzir legenda";
      if (res.status === 429 || (data && data.retryAfterMs)) {
        const secs = Math.ceil(((data && data.retryAfterMs) || 5000) / 1000);
        errStr = `rate_limit_429:${secs}`;
      }
      subtitleState.translationError = errStr;
      syncSubtitleCcUi();
      return;
    }

    subtitleState.translating = false;
    subtitleState.targetLangReady = true;
    const availItem = subtitleState.translations.find((t) => t.lang === lang);
    if (availItem) availItem.ready = true;
    else subtitleState.translations.push({ lang, ready: true });

    if (Array.isArray(data.segments) && data.segments.length) {
      subtitleState.segments = data.segments;
      subtitleState.selectedLang = "translated";
      setSubtitleMode("translated");
      subtitleState.currentIndex = -1;
      setSubtitleEnabled(true);
      applySubtitleVisibility();
      const v = document.getElementById("video-el");
      if (v) updateSubtitleOverlay(typeof v.currentTime === "number" ? v.currentTime : 0);
    } else {
      await switchToTranslatedSegments(lang, rel, libId);
    }
    syncSubtitleCcUi();
  } catch (err) {
    subtitleState.translating = false;
    subtitleState.translationError = (err && err.message) || "Erro de conexão ao traduzir legenda";
    syncSubtitleCcUi();
  }
}

async function fetchSubtitleTranslations(rel, libId) {
  try {
    const res = await fetch(
      "/api/subtitles/translations?path=" +
        encodeURIComponent(rel) +
        libQuery({ libId }),
    );
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.hash) subtitleState.hash = data.hash;
    subtitleState.sourceLanguage = data.sourceLanguage || "pt";
    subtitleState.llmAvailable = !!data.llmAvailable;
    subtitleState.translationEnabled = data.enabled !== false;
    subtitleState.configuredModel = data.configuredModel || "";
    subtitleState.defaultTargetLang = data.defaultTargetLang || "pt";
    subtitleState.translations = Array.isArray(data.available) ? data.available : [];
    if (!localStorage.getItem(SUBTITLE_TARGET_LANG_KEY) && data.defaultTargetLang) {
      subtitleState.targetLang = data.defaultTargetLang;
    }
    const target = subtitleState.targetLang || getSubtitleTargetLang();
    const item = subtitleState.translations.find((t) => t.lang === target);
    subtitleState.targetLangReady = !!(item && item.ready);

    if (getSubtitleMode() === "translated" && subtitleState.targetLangReady && subtitleState.ready) {
      await switchToTranslatedSegments(target, rel, libId);
    }

    syncSubtitleCcUi();
  } catch {}
}

async function onSubtitleTargetLangChange(newLang) {
  if (!SUBTITLE_LANG_LABELS[newLang]) return;
  setSubtitleTargetLang(newLang);
  const item = subtitleState.translations.find((t) => t.lang === newLang);
  subtitleState.targetLangReady = !!(item && item.ready);
  if (subtitleState.selectedLang === "translated") {
    if (subtitleState.targetLangReady) {
      await switchToTranslatedSegments(newLang);
    } else {
      switchToOriginalSegments();
    }
  }
  // O select acabou de ser usado (dropdown já fechou): tira o foco para que
  // o sync abaixo aplique o HTML atualizado em vez de pular por foco ativo.
  const ae = document.activeElement;
  if (ae && ae.classList && ae.classList.contains("pc-cc-target-select")) ae.blur();
  syncSubtitleCcUi();
}

function selectSubtitleOriginal() {
  switchToOriginalSegments();
  setSubtitleEnabled(true);
}

function selectSubtitleTranslation() {
  const target = subtitleState.targetLang || getSubtitleTargetLang();
  if (subtitleState.targetLangReady) {
    switchToTranslatedSegments(target);
    setSubtitleEnabled(true);
  } else {
    requestSubtitleTranslate(target, false);
  }
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
    // que um job ainda rode (gerando/aguardando/falha) ou tradução ativa, que continua informado.
    const active =
      ["ready", "stale", "generating", "waiting", "failed"].includes(kind) ||
      subtitleState.translating ||
      !!subtitleState.translationError;
    const showDot =
      active &&
      (enabled ||
        kind === "generating" ||
        kind === "waiting" ||
        kind === "failed" ||
        subtitleState.translating ||
        !!subtitleState.translationError);
    dot.hidden = !showDot;
    dot.textContent =
      kind === "failed" || kind === "waiting" || subtitleState.translationError ? "!" : "";
  }
  // Seletor (Original / <Nome do idioma> / Desativado) — montado nos dois menus (barra e ⋮ mobile).
  const targetLang = subtitleState.targetLang || getSubtitleTargetLang();
  const targetLangLabel = SUBTITLE_LANG_LABELS[targetLang] || targetLang;

  const isTranslatedActive = enabled && subtitleState.selectedLang === "translated";
  const isSrcActive = enabled && !isTranslatedActive;
  const isOffActive = !enabled;

  const langItems = [
    `<button type="button" class="pc-menu-item${isSrcActive ? " is-active" : ""}" data-cc="lang-source" aria-pressed="${isSrcActive}">Original</button>`,
  ];

  if (subtitleState.translationEnabled !== false && (subtitleState.llmAvailable || subtitleState.targetLangReady)) {
    langItems.push(
      `<button type="button" class="pc-menu-item${isTranslatedActive ? " is-active" : ""}" data-cc="lang-translated" aria-pressed="${isTranslatedActive}">${targetLangLabel}</button>`,
    );
  }

  langItems.push(
    `<button type="button" class="pc-menu-item${isOffActive ? " is-active" : ""}" data-cc="off" aria-pressed="${isOffActive}">Desativado</button>`,
  );

  if (subtitleState.translationEnabled !== false) {
    const optionsHtml = Object.entries(SUBTITLE_LANG_LABELS)
      .map(
        ([code, name]) =>
          `<option value="${code}"${code === targetLang ? " selected" : ""}>${name}</option>`,
      )
      .join("");

    const targetSelectHtml = `
      <div class="pc-cc-target-wrap" style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;margin-top:4px;border-top:1px solid rgba(255,255,255,0.08);gap:8px;">
        <span style="font-size:11px;color:var(--text-dim);white-space:nowrap;">Traduzir para</span>
        <select class="pc-cc-target-select tutor-study-select" style="font-size:11.5px;padding:2px 6px;height:26px;border-radius:6px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:#fff;cursor:pointer;max-width:110px;" aria-label="Idioma de tradução">
          ${optionsHtml}
        </select>
      </div>
    `;
    langItems.push(targetSelectHtml);
  }

  const langsHtml = langItems.join("");
  ["pc-cc-langs", "pc-more-cc-langs"].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.innerHTML === langsHtml) return;
    // Não destrói o <select> enquanto ele tem foco/aberto: trocar innerHTML
    // fecharia o dropdown no meio da escolha (sync roda a cada sondagem).
    // A sincronização acontece na próxima chamada após o blur/troca.
    if (el.contains(document.activeElement)) return;
    el.innerHTML = langsHtml;
  });
  // Formata mensagens de erro de legenda para exibição amigável e resolutiva
  function formatSubtitleErrorMessage(error) {
    if (!error) return "Erro ao gerar legenda. Clique em 'Tentar novamente'.";
    const err = String(error).trim();
    if (err.startsWith("rate_limit_429:")) {
      const secs = err.split(":")[1] || "5";
      return `Limite do provedor atingido — aguarde ~${secs}s e tente novamente.`;
    }
    if (err.includes("429") || err.includes("Limite") || err.includes("rate limit") || err.includes("Too Many Requests")) {
      return "Limite do provedor atingido — aguarde e tente novamente.";
    }
    if (err.includes("Nenhum provedor de IA configurado")) {
      return "Nenhum provedor LLM configurado. Acesse Configurações → Central de IA.";
    }
    if (err.includes("sem legenda original")) {
      return "Gere a legenda original antes de solicitar a tradução.";
    }
    if (err.includes("Binário do Whisper") || err.includes("binary_not_installed")) {
      return "Whisper não instalado. Configure o executável em Configurações → Central de IA.";
    }
    if (err.includes("Modelo do Whisper") || err.includes("model_not_installed")) {
      return "Modelo do Whisper não instalado. Baixe o modelo em Configurações → Central de IA.";
    }
    if (err.includes("Transcrição desabilitada")) {
      return "A transcrição está desativada. Ative em Configurações → Central de IA.";
    }
    if (err.includes("não possui faixa de áudio") || err.includes("vazio")) {
      return "O vídeo não possui áudio audível para gerar legendas.";
    }
    if (err.includes("Espaço insuficiente")) {
      return err;
    }
    if (err.includes("Tempo limite")) {
      return "Tempo limite de processamento excedido. Clique em 'Tentar novamente'.";
    }
    if (err.includes("FFmpeg") || err.includes("ffmpeg")) {
      return `Falha no FFmpeg: ${err}. Verifique se o FFmpeg está instalado.`;
    }
    if (err.includes("fora da biblioteca")) {
      return "O arquivo do vídeo está fora do diretório da biblioteca.";
    }
    if (err.includes("não encontrado")) {
      return "Arquivo de vídeo não encontrado no disco.";
    }
    return `Erro: ${err}. Clique em 'Tentar novamente'.`;
  }

  // Ação contextual (Gerar/Regenerar/Traduzir) e linha de status.
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
  let actionHandler = "generate";
  let isError = kind === "failed";

  if (subtitleState.translating) {
    statusText = "Gerando tradução via IA…";
    actionText = "Traduzindo…";
    showAction = true;
    actionHandler = "none";
  } else if (subtitleState.translationError) {
    statusText = formatSubtitleErrorMessage(subtitleState.translationError);
    actionText = "Tentar novamente";
    showAction = true;
    actionHandler = "retry-translate";
    isError = true;
  } else if (kind === "generating") {
    statusText = "Gerando legenda…";
  } else if (kind === "waiting") {
    statusText = "Aguardando o dispositivo…";
  } else if (kind === "failed") {
    const errorDetail = subtitleState.lastError || "";
    statusText = formatSubtitleErrorMessage(errorDetail);
    actionText = "Tentar novamente";
    showAction = true;
    actionHandler = "retry-generate";
  } else if (kind === "unavailable") {
    actionText = "Gerar legenda";
    showAction = true;
    actionHandler = "generate";
  } else if (kind === "ready" || kind === "stale") {
    if (subtitleState.staleSource && subtitleState.selectedLang === "translated") {
      statusText = "Legenda original alterada — regenerar tradução";
      actionText = "Regenerar tradução";
      showAction = true;
      actionHandler = "force-translate";
    } else if (!subtitleState.targetLangReady) {
      actionText = `Traduzir para ${targetLangLabel}`;
      showAction = true;
      actionHandler = "translate";
    } else if (subtitleState.selectedLang === "translated") {
      actionText = "Regenerar tradução";
      showAction = true;
      actionHandler = "force-translate";
    } else if (subtitleState.canGenerate !== false) {
      actionText = "Regenerar";
      showAction = true;
      actionHandler = "generate";
    }
  }

  subtitleState.currentActionHandler = actionHandler;

  statusEls.forEach((el) => {
    el.textContent = statusText;
    el.hidden = !statusText;
    el.classList.toggle("is-error", isError);
    if (isError) el.title = statusText;
    else el.removeAttribute("title");
  });
  actionEls.forEach((el) => {
    el.textContent = actionText;
    el.hidden = !showAction;
  });
  updateSubtitleBadge();
}

// Badge não-bloqueante sobre o player: feedback VISÍVEL de que a legenda está
// sendo gerada (ou aguardando a fonte) — o dot do botão CC sozinho era sutil
// demais. Some quando pronto/desativado; exibe aviso claro em falha.
function updateSubtitleBadge() {
  const badge = document.getElementById("player-substatus");
  if (!badge) return;
  const kind = subtitleState.ccKind || null;
  let msg = "";
  let isError = false;

  if (subtitleState.translating) {
    msg = "Gerando tradução…";
  } else if (subtitleState.translationError) {
    const err = String(subtitleState.translationError);
    if (err.startsWith("rate_limit_429:") || err.includes("429") || err.includes("Limite")) {
      msg = "⚠ Limite da IA atingido — abra o menu CC";
    } else {
      msg = "⚠ Falha na tradução — abra o menu CC para detalhes";
    }
    isError = true;
  } else if (kind === "generating") {
    msg = "Gerando legenda…";
    if (typeof subtitleState.percent === "number") {
      msg += " " + Math.round(subtitleState.percent) + "%";
    }
  } else if (kind === "waiting") {
    msg = "Aguardando o dispositivo…";
  } else if (kind === "failed") {
    const err = subtitleState.lastError || "";
    let shortReason = "Falha ao gerar legenda";
    if (err.includes("Binário") || err.includes("binary_not_installed")) {
      shortReason = "Whisper não instalado";
    } else if (err.includes("Modelo") || err.includes("model_not_installed")) {
      shortReason = "Modelo não instalado";
    } else if (err.includes("faixa de áudio")) {
      shortReason = "Vídeo sem áudio audível";
    } else if (err.includes("Espaço insuficiente")) {
      shortReason = "Espaço insuficiente em disco";
    } else if (err.includes("Tempo limite")) {
      shortReason = "Tempo limite excedido";
    }
    msg = `⚠ ${shortReason} — abra o menu CC para detalhes`;
    isError = true;
  }
  badge.classList.toggle("is-error", isError);
  badge.hidden = !msg;
  const textEl = badge.querySelector("#player-substatus-text");
  if (textEl && textEl.textContent !== msg) textEl.textContent = msg;
}

// Dispara a geração/regeneração da legenda da aula atual a partir do menu CC.
// O backend dedupa; `force` regenera do zero quando já existe ou falhou.
let subtitleGenerateApi = null; // preenchido em setupPlayerSubtitles
// Re-sondagem do status.
let subtitleCheckApi = null; // preenchido em setupPlayerSubtitles
function requestSubtitleGenerate() {
  if (subtitleState.currentActionHandler === "translate" || subtitleState.currentActionHandler === "retry-translate") {
    requestSubtitleTranslate(subtitleState.targetLang, false);
  } else if (subtitleState.currentActionHandler === "force-translate") {
    requestSubtitleTranslate(subtitleState.targetLang, true);
  } else if (subtitleGenerateApi) {
    subtitleGenerateApi();
  }
}

// ---------------------------------------------------------------------------
// Aparência da legenda (personalização, mantendo o visual padrão por default).
// Preferência local (localStorage), mesmo padrão dos demais controles do player.
// Estrutura hierárquica e limpa inspirada no menu de opções do YouTube.
// ---------------------------------------------------------------------------
const SUBTITLE_STYLE_KEY = "course-player-subtitle-style";
const SUBTITLE_STYLE_DEFAULT = {
  fontFamily: "default",
  textColor: "#ffffff",
  size: "100%",
  bg: "none",
  bgCustom: "#000000",
  edge: "drop-shadow",
  spacing: 1.3,
  shadow: true,
};

const SUBTITLE_STYLE_SCALE = {
  "50%": 0.5,
  "75%": 0.75,
  "100%": 1.0,
  "150%": 1.5,
  "200%": 2.0,
  "300%": 3.0,
  sm: 0.85,
  md: 1.0,
  lg: 1.25,
};

const SUBTITLE_FONTS = [
  { id: "default", label: "Padrão (Sem serifa proporcional)", shortLabel: "Padrão", sampleFont: "system-ui, -apple-system, sans-serif" },
  { id: "monospace-sans", label: "Sem serifa monoespaçada", shortLabel: "Monoespaçada", sampleFont: "ui-monospace, monospace" },
  { id: "serif", label: "Proporcional com serifa", shortLabel: "Com serifa", sampleFont: "Georgia, 'Times New Roman', serif" },
  { id: "monospace-serif", label: "Monoespaçada com serifa", shortLabel: "Mono com serifa", sampleFont: "'Courier New', monospace" },
  { id: "casual", label: "Casual", shortLabel: "Casual", sampleFont: "'Comic Sans MS', cursive, sans-serif" },
  { id: "cursive", label: "Cursiva", shortLabel: "Cursiva", sampleFont: "'Brush Script MT', cursive" },
  { id: "small-caps", label: "Pequenas maiúsculas", shortLabel: "Pequenas maiúsc.", sampleFont: "sans-serif", smallCaps: true },
];

const SUBTITLE_TEXT_COLORS = [
  { id: "#ffffff", label: "Branco", color: "#ffffff" },
  { id: "#ffff00", label: "Amarelo", color: "#ffff00" },
  { id: "#00ff00", label: "Verde", color: "#00ff00" },
  { id: "#00ffff", label: "Ciano", color: "#00ffff" },
  { id: "#3b82f6", label: "Azul", color: "#3b82f6" },
  { id: "#ff00ff", label: "Magenta", color: "#ff00ff" },
  { id: "#ff3b30", label: "Vermelho", color: "#ff3b30" },
  { id: "#000000", label: "Preto", color: "#000000" },
];

const SUBTITLE_SIZES = [
  { id: "50%", label: "50%" },
  { id: "75%", label: "75%" },
  { id: "100%", label: "100% (Padrão)", shortLabel: "100%" },
  { id: "150%", label: "150%" },
  { id: "200%", label: "200%" },
  { id: "300%", label: "300%" },
];

const SUBTITLE_BGS = [
  { id: "none", label: "Sem fundo (0%)", shortLabel: "Sem fundo", color: "transparent" },
  { id: "black-60", label: "Preto 60% (Padrão)", shortLabel: "Preto 60%", color: "rgba(0, 0, 0, 0.6)" },
  { id: "black-80", label: "Preto 80%", shortLabel: "Preto 80%", color: "rgba(0, 0, 0, 0.8)" },
  { id: "black-100", label: "Preto 100%", shortLabel: "Preto 100%", color: "#000000" },
  { id: "white-65", label: "Branco 65%", shortLabel: "Branco 65%", color: "rgba(255, 255, 255, 0.65)" },
  { id: "blue-75", label: "Azul escuro 75%", shortLabel: "Azul escuro 75%", color: "rgba(15, 23, 42, 0.75)" },
];

const SUBTITLE_EDGES = [
  { id: "drop-shadow", label: "Sombra projetada (Padrão)", shortLabel: "Sombra projetada" },
  { id: "outline", label: "Contorno preto nítido", shortLabel: "Contorno nítido" },
  { id: "raised", label: "Borda chanfrada / Elevada", shortLabel: "Borda elevada" },
  { id: "depressed", label: "Borda rebaixada", shortLabel: "Borda rebaixada" },
  { id: "window", label: "Janela translúcida", shortLabel: "Janela translúcida" },
  { id: "none", label: "Nenhum", shortLabel: "Nenhum" },
];

function getSubtitleFontLabel(id) {
  const f = SUBTITLE_FONTS.find((x) => x.id === id);
  return f ? (f.shortLabel || f.label) : "Padrão";
}

function getSubtitleTextColorInfo(color) {
  const c = SUBTITLE_TEXT_COLORS.find((x) => x.id.toLowerCase() === (color || "").toLowerCase());
  if (c) return { label: c.label, swatch: c.color };
  return { label: "Personalizado", swatch: color || "#ffffff" };
}

function getSubtitleSizeLabel(size) {
  const s = SUBTITLE_SIZES.find((x) => x.id === size);
  return s ? (s.shortLabel || s.label) : (size || "100%");
}

function getSubtitleBgInfo(bg, bgCustom) {
  const b = SUBTITLE_BGS.find((x) => x.id === bg);
  if (b) return { label: b.shortLabel || b.label, swatch: b.color, transparent: b.id === "none" };
  if (bg === "custom") return { label: "Personalizado", swatch: bgCustom || "#000000", transparent: false };
  return { label: "Sem fundo", swatch: "transparent", transparent: true };
}

function getSubtitleEdgeLabel(edge) {
  const e = SUBTITLE_EDGES.find((x) => x.id === edge);
  return e ? (e.shortLabel || e.label) : "Sombra projetada";
}

function loadSubtitleStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem(SUBTITLE_STYLE_KEY) || "null");
    const merged = { ...SUBTITLE_STYLE_DEFAULT, ...(saved && typeof saved === "object" ? saved : {}) };
    if (merged.size === "sm") merged.size = "75%";
    else if (merged.size === "md") merged.size = "100%";
    else if (merged.size === "lg") merged.size = "150%";

    if (merged.bg === "black") merged.bg = "black-60";
    else if (merged.bg === "white") merged.bg = "white-65";

    if (!merged.edge) {
      merged.edge = merged.shadow === false ? "none" : "drop-shadow";
    }
    return merged;
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

  // 1. Cor do texto
  overlay.style.setProperty("--st-text-color", s.textColor || "#ffffff");

  // 2. Cor e opacidade do fundo
  let bg = "transparent";
  if (s.bg === "black-60" || s.bg === "black") bg = "rgba(0, 0, 0, 0.6)";
  else if (s.bg === "black-80") bg = "rgba(0, 0, 0, 0.8)";
  else if (s.bg === "black-100") bg = "#000000";
  else if (s.bg === "white-65" || s.bg === "white") bg = "rgba(255, 255, 255, 0.65)";
  else if (s.bg === "blue-75") bg = "rgba(15, 23, 42, 0.75)";
  else if (s.bg === "custom") bg = s.bgCustom || "#000000";
  overlay.style.setProperty("--st-bg-color", bg);

  // 3. Estilo de fonte
  let fontFam = "inherit";
  if (s.fontFamily === "monospace-sans") fontFam = "ui-monospace, 'Cascadia Code', 'SF Mono', monospace";
  else if (s.fontFamily === "serif") fontFam = "Georgia, 'Times New Roman', Times, serif";
  else if (s.fontFamily === "monospace-serif") fontFam = "'Courier New', Courier, monospace";
  else if (s.fontFamily === "casual") fontFam = "'Comic Sans MS', 'Segoe Print', cursive, sans-serif";
  else if (s.fontFamily === "cursive") fontFam = "'Brush Script MT', 'Segoe Script', cursive";
  else if (s.fontFamily === "default") fontFam = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  overlay.style.setProperty("--st-font-family", fontFam);
  overlay.style.setProperty("--st-font-variant", s.fontFamily === "small-caps" ? "small-caps" : "normal");

  // 4. Opacidade da janela / Contorno
  let shadow = "none";
  let windowBox = "none";
  const edge = s.edge || (s.shadow ? "drop-shadow" : "none");
  if (edge === "drop-shadow") {
    shadow = "0 1px 3px rgba(0, 0, 0, 0.85), 0 0 2px rgba(0, 0, 0, 0.55)";
  } else if (edge === "outline") {
    shadow = "-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 4px rgba(0, 0, 0, 0.85)";
  } else if (edge === "raised") {
    shadow = "1px 1px 0 rgba(0, 0, 0, 0.85), -1px -1px 0 rgba(255, 255, 255, 0.35)";
  } else if (edge === "depressed") {
    shadow = "-1px -1px 0 rgba(0, 0, 0, 0.85), 1px 1px 0 rgba(255, 255, 255, 0.35)";
  } else if (edge === "window") {
    shadow = "0 1px 2px rgba(0, 0, 0, 0.6)";
    windowBox = "0 0 0 6px rgba(0, 0, 0, 0.55)";
  }
  overlay.style.setProperty("--st-shadow", shadow);
  overlay.style.setProperty("--st-window-box", windowBox);

  // 5. Espaçamento
  overlay.style.setProperty("--st-line-height", String(s.spacing || 1.3));
}

let sspCurrentView = "root";

function renderSubtitleStyleView(panel, view) {
  if (!panel) return;
  sspCurrentView = view || "root";
  const s = loadSubtitleStyle();
  const esc = typeof escapeHtml === "function" ? escapeHtml : (str) => String(str || "");

  if (sspCurrentView === "root") {
    const fontLabel = getSubtitleFontLabel(s.fontFamily);
    const textColorInfo = getSubtitleTextColorInfo(s.textColor);
    const sizeLabel = getSubtitleSizeLabel(s.size);
    const bgInfo = getSubtitleBgInfo(s.bg, s.bgCustom);
    const edgeLabel = getSubtitleEdgeLabel(s.edge);
    const hasCustomPos = subtitleState.pos != null;

    panel.innerHTML = `
      <div class="ssp-header">
        <button type="button" class="ssp-back-btn" id="ssp-close-btn" title="Fechar configurações de legendas" aria-label="Voltar e fechar configurações de legendas">
          <span class="ssp-back-arrow" aria-hidden="true">‹</span>
          <span class="ssp-header-title">Configurações de legendas</span>
        </button>
        <button type="button" class="ssp-close-icon-btn" id="ssp-x-btn" title="Fechar" aria-label="Fechar">✕</button>
      </div>

      <div class="ssp-menu-list">
        <button type="button" class="ssp-item" data-view="font" title="Alterar estilo de fonte">
          <span class="ssp-item-label">Estilo de fonte</span>
          <span class="ssp-item-value">
            <span class="ssp-value-text">${esc(fontLabel)}</span>
            <span class="ssp-chevron" aria-hidden="true">›</span>
          </span>
        </button>

        <button type="button" class="ssp-item" data-view="textColor" title="Alterar cor do texto">
          <span class="ssp-item-label">Cor do texto</span>
          <span class="ssp-item-value">
            <span class="ssp-swatch" style="background:${textColorInfo.swatch}"></span>
            <span class="ssp-value-text">${esc(textColorInfo.label)}</span>
            <span class="ssp-chevron" aria-hidden="true">›</span>
          </span>
        </button>

        <button type="button" class="ssp-item" data-view="size" title="Alterar tamanho da fonte">
          <span class="ssp-item-label">Tamanho da fonte</span>
          <span class="ssp-item-value">
            <span class="ssp-value-text">${esc(sizeLabel)}</span>
            <span class="ssp-chevron" aria-hidden="true">›</span>
          </span>
        </button>

        <button type="button" class="ssp-item" data-view="bg" title="Alterar cor e opacidade do fundo">
          <span class="ssp-item-label">Cor e Opacidade do fundo</span>
          <span class="ssp-item-value">
            <span class="ssp-swatch ${bgInfo.transparent ? "is-transparent" : ""}" style="${bgInfo.transparent ? "" : `background:${bgInfo.swatch}`}"></span>
            <span class="ssp-value-text">${esc(bgInfo.label)}</span>
            <span class="ssp-chevron" aria-hidden="true">›</span>
          </span>
        </button>

        <button type="button" class="ssp-item" data-view="edge" title="Alterar opacidade da janela e contorno">
          <span class="ssp-item-label">Opacidade da janela / Contorno</span>
          <span class="ssp-item-value">
            <span class="ssp-value-text">${esc(edgeLabel)}</span>
            <span class="ssp-chevron" aria-hidden="true">›</span>
          </span>
        </button>
      </div>

      <hr class="ssp-divider">

      <div class="ssp-footer">
        <div class="ssp-footer-actions">
          <button type="button" class="ssp-link-btn" id="ssp-reset-all" title="Restaurar opções padrão">Restaurar padrões</button>
          ${hasCustomPos ? `<button type="button" class="ssp-link-btn" id="ssp-reset-pos" title="Restaurar posição original da legenda">Restaurar posição</button>` : ""}
        </div>
        <p class="ssp-hint">Arraste a legenda dentro do vídeo para reposicionar.</p>
      </div>
    `;
    return;
  }

  if (sspCurrentView === "font") {
    panel.innerHTML = `
      <div class="ssp-header">
        <button type="button" class="ssp-back-btn" id="ssp-back-btn" title="Voltar para configurações de legendas" aria-label="Voltar">
          <span class="ssp-back-arrow" aria-hidden="true">‹</span>
          <span class="ssp-header-title">Estilo de fonte</span>
        </button>
        <button type="button" class="ssp-close-icon-btn" id="ssp-x-btn" title="Fechar" aria-label="Fechar">✕</button>
      </div>
      <div class="ssp-options-list">
        ${SUBTITLE_FONTS.map((item) => {
          const isSel = s.fontFamily === item.id;
          return `
            <button type="button" class="ssp-option-item ${isSel ? "is-selected" : ""}" data-font="${item.id}">
              <span class="ssp-option-left" style="font-family:${item.sampleFont}; ${item.smallCaps ? "font-variant:small-caps;" : ""}">
                <span class="ssp-option-label">${esc(item.label)}</span>
              </span>
              <span class="ssp-check" aria-hidden="true">${isSel ? "✓" : ""}</span>
            </button>
          `;
        }).join("")}
      </div>
    `;
    return;
  }

  if (sspCurrentView === "textColor") {
    const isCustom = !SUBTITLE_TEXT_COLORS.some((c) => c.id.toLowerCase() === s.textColor.toLowerCase());
    panel.innerHTML = `
      <div class="ssp-header">
        <button type="button" class="ssp-back-btn" id="ssp-back-btn" title="Voltar para configurações de legendas" aria-label="Voltar">
          <span class="ssp-back-arrow" aria-hidden="true">‹</span>
          <span class="ssp-header-title">Cor do texto</span>
        </button>
        <button type="button" class="ssp-close-icon-btn" id="ssp-x-btn" title="Fechar" aria-label="Fechar">✕</button>
      </div>
      <div class="ssp-options-list">
        ${SUBTITLE_TEXT_COLORS.map((item) => {
          const isSel = !isCustom && s.textColor.toLowerCase() === item.id.toLowerCase();
          return `
            <button type="button" class="ssp-option-item ${isSel ? "is-selected" : ""}" data-color="${item.id}">
              <span class="ssp-option-left">
                <span class="ssp-swatch" style="background:${item.color}"></span>
                <span class="ssp-option-label">${esc(item.label)}</span>
              </span>
              <span class="ssp-check" aria-hidden="true">${isSel ? "✓" : ""}</span>
            </button>
          `;
        }).join("")}
        <div class="ssp-custom-color-item">
          <button type="button" class="ssp-option-item ${isCustom ? "is-selected" : ""}" id="ssp-custom-text-btn">
            <span class="ssp-option-left">
              <span class="ssp-swatch" style="background:${isCustom ? s.textColor : "#ffffff"}"></span>
              <span class="ssp-option-label">Personalizado…</span>
            </span>
            <span class="ssp-check" aria-hidden="true">${isCustom ? "✓" : ""}</span>
          </button>
          <input type="color" id="ssp-text-color-input" value="${isCustom && /^#[0-9a-f]{6}$/i.test(s.textColor) ? s.textColor : "#ffffff"}" class="ssp-hidden-color-input">
        </div>
      </div>
    `;
    return;
  }

  if (sspCurrentView === "size") {
    panel.innerHTML = `
      <div class="ssp-header">
        <button type="button" class="ssp-back-btn" id="ssp-back-btn" title="Voltar para configurações de legendas" aria-label="Voltar">
          <span class="ssp-back-arrow" aria-hidden="true">‹</span>
          <span class="ssp-header-title">Tamanho da fonte</span>
        </button>
        <button type="button" class="ssp-close-icon-btn" id="ssp-x-btn" title="Fechar" aria-label="Fechar">✕</button>
      </div>
      <div class="ssp-options-list">
        ${SUBTITLE_SIZES.map((item) => {
          const isSel = s.size === item.id;
          return `
            <button type="button" class="ssp-option-item ${isSel ? "is-selected" : ""}" data-size="${item.id}">
              <span class="ssp-option-label">${esc(item.label)}</span>
              <span class="ssp-check" aria-hidden="true">${isSel ? "✓" : ""}</span>
            </button>
          `;
        }).join("")}
      </div>
    `;
    return;
  }

  if (sspCurrentView === "bg") {
    const isCustom = s.bg === "custom";
    panel.innerHTML = `
      <div class="ssp-header">
        <button type="button" class="ssp-back-btn" id="ssp-back-btn" title="Voltar para configurações de legendas" aria-label="Voltar">
          <span class="ssp-back-arrow" aria-hidden="true">‹</span>
          <span class="ssp-header-title">Cor e Opacidade do fundo</span>
        </button>
        <button type="button" class="ssp-close-icon-btn" id="ssp-x-btn" title="Fechar" aria-label="Fechar">✕</button>
      </div>
      <div class="ssp-options-list">
        ${SUBTITLE_BGS.map((item) => {
          const isSel = !isCustom && s.bg === item.id;
          const isTrans = item.id === "none";
          return `
            <button type="button" class="ssp-option-item ${isSel ? "is-selected" : ""}" data-bg="${item.id}">
              <span class="ssp-option-left">
                <span class="ssp-swatch ${isTrans ? "is-transparent" : ""}" style="${isTrans ? "" : `background:${item.color}`}"></span>
                <span class="ssp-option-label">${esc(item.label)}</span>
              </span>
              <span class="ssp-check" aria-hidden="true">${isSel ? "✓" : ""}</span>
            </button>
          `;
        }).join("")}
        <div class="ssp-custom-color-item">
          <button type="button" class="ssp-option-item ${isCustom ? "is-selected" : ""}" id="ssp-custom-bg-btn">
            <span class="ssp-option-left">
              <span class="ssp-swatch" style="background:${isCustom ? s.bgCustom : "#000000"}"></span>
              <span class="ssp-option-label">Personalizado…</span>
            </span>
            <span class="ssp-check" aria-hidden="true">${isCustom ? "✓" : ""}</span>
          </button>
          <input type="color" id="ssp-bg-color-input" value="${/^#[0-9a-f]{6}$/i.test(s.bgCustom) ? s.bgCustom : "#000000"}" class="ssp-hidden-color-input">
        </div>
      </div>
    `;
    return;
  }

  if (sspCurrentView === "edge") {
    panel.innerHTML = `
      <div class="ssp-header">
        <button type="button" class="ssp-back-btn" id="ssp-back-btn" title="Voltar para configurações de legendas" aria-label="Voltar">
          <span class="ssp-back-arrow" aria-hidden="true">‹</span>
          <span class="ssp-header-title">Opacidade da janela / Contorno</span>
        </button>
        <button type="button" class="ssp-close-icon-btn" id="ssp-x-btn" title="Fechar" aria-label="Fechar">✕</button>
      </div>
      <div class="ssp-options-list">
        ${SUBTITLE_EDGES.map((item) => {
          const isSel = s.edge === item.id;
          return `
            <button type="button" class="ssp-option-item ${isSel ? "is-selected" : ""}" data-edge="${item.id}">
              <span class="ssp-option-label">${esc(item.label)}</span>
              <span class="ssp-check" aria-hidden="true">${isSel ? "✓" : ""}</span>
            </button>
          `;
        }).join("")}
      </div>
    `;
    return;
  }
}

// Sincroniza o painel de aparência com o estilo salvo.
function syncSubtitleStylePanel(panel) {
  if (!panel) return;
  renderSubtitleStyleView(panel, sspCurrentView || "root");
}

// Abre o painel de aparência da legenda. No desktop ele ancora no botão
// "Aa Aparência" (absolute dentro do .lesson-header); no mobile (<600px) o
// botão sai da toolbar e o acesso vira o item ⋮ > Aparência da legenda —
// o painel abre centralizado na tela (position: fixed, via CSS).
function subtitleStyleOpen() {
  const panel = document.getElementById("subtitle-style-panel");
  const btn = document.getElementById("subtitle-style-btn");
  if (!panel) return;
  sspCurrentView = "root";
  renderSubtitleStyleView(panel, "root");
  if (window.matchMedia("(max-width: 600px)").matches) {
    panel.style.top = "";
    panel.style.left = "";
    panel.hidden = false;
    return;
  }
  panel.hidden = false;
  const br = btn ? btn.getBoundingClientRect() : null;
  const pw = panel.offsetWidth || 300;
  const ph = panel.offsetHeight || 320;
  if (br && panel.parentElement) {
    const topVp = Math.max(8, Math.min(br.bottom + 6, window.innerHeight - ph - 8));
    const leftVp = Math.max(8, Math.min(br.right - pw, window.innerWidth - pw - 8));
    const ar = panel.parentElement.getBoundingClientRect();
    panel.style.top = Math.round(topVp - ar.top) + "px";
    panel.style.left = Math.round(leftVp - ar.left) + "px";
  }
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

let sspDocListenersAttached = false;

// Botão "Aa Aparência" no player (desktop) + item ⋮ > Aparência da legenda
// (mobile): abrem um popover com as opções de personalização da legenda
// estilo YouTube (fonte, cor, tamanho, fundo/opacidade, contorno). Persistido
// em localStorage; aplicado ao vivo no player. Fecha com clique fora ou Esc.
function wireSubtitleStylePanel(wrap) {
  const btn = document.getElementById("subtitle-style-btn");
  const panel = document.getElementById("subtitle-style-panel");
  if (!panel) return;

  renderSubtitleStyleView(panel, "root");

  if (btn) {
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleSubtitleStylePanel();
    };
  }

  // Cliques delegados no painel
  panel.onclick = (e) => {
    e.stopPropagation();

    // 1. Fechar menu (botão de voltar no menu raiz ou botão ✕)
    if (e.target.closest("#ssp-close-btn") || e.target.closest("#ssp-x-btn")) {
      subtitleStyleClose();
      return;
    }

    // 2. Botão de voltar do submenu -> retorna ao menu raiz
    if (e.target.closest("#ssp-back-btn")) {
      renderSubtitleStyleView(panel, "root");
      return;
    }

    // 3. Abrir submenu
    const menuItem = e.target.closest(".ssp-item[data-view]");
    if (menuItem) {
      renderSubtitleStyleView(panel, menuItem.dataset.view);
      return;
    }

    // 4. Selecionar fonte
    const fontItem = e.target.closest("[data-font]");
    if (fontItem) {
      const s = loadSubtitleStyle();
      s.fontFamily = fontItem.dataset.font;
      saveSubtitleStyle(s);
      applySubtitleStyle(document.getElementById("subtitle-overlay"));
      applySubtitleGeometry();
      renderSubtitleStyleView(panel, "root");
      return;
    }

    // 5. Selecionar cor pré-definida do texto
    const colorItem = e.target.closest("[data-color]");
    if (colorItem) {
      const s = loadSubtitleStyle();
      s.textColor = colorItem.dataset.color;
      saveSubtitleStyle(s);
      applySubtitleStyle(document.getElementById("subtitle-overlay"));
      applySubtitleGeometry();
      renderSubtitleStyleView(panel, "root");
      return;
    }

    // 6. Botão de cor personalizada do texto
    if (e.target.closest("#ssp-custom-text-btn")) {
      const input = panel.querySelector("#ssp-text-color-input");
      if (input) input.click();
      return;
    }

    // 7. Selecionar tamanho da fonte
    const sizeItem = e.target.closest("[data-size]");
    if (sizeItem) {
      const s = loadSubtitleStyle();
      s.size = sizeItem.dataset.size;
      saveSubtitleStyle(s);
      applySubtitleStyle(document.getElementById("subtitle-overlay"));
      applySubtitleGeometry();
      renderSubtitleStyleView(panel, "root");
      return;
    }

    // 8. Selecionar cor/opacidade pré-definida do fundo
    const bgItem = e.target.closest("[data-bg]");
    if (bgItem) {
      const s = loadSubtitleStyle();
      s.bg = bgItem.dataset.bg;
      saveSubtitleStyle(s);
      applySubtitleStyle(document.getElementById("subtitle-overlay"));
      applySubtitleGeometry();
      renderSubtitleStyleView(panel, "root");
      return;
    }

    // 9. Botão de cor personalizada do fundo
    if (e.target.closest("#ssp-custom-bg-btn")) {
      const input = panel.querySelector("#ssp-bg-color-input");
      if (input) input.click();
      return;
    }

    // 10. Selecionar opacidade da janela / contorno
    const edgeItem = e.target.closest("[data-edge]");
    if (edgeItem) {
      const s = loadSubtitleStyle();
      s.edge = edgeItem.dataset.edge;
      s.shadow = s.edge !== "none";
      saveSubtitleStyle(s);
      applySubtitleStyle(document.getElementById("subtitle-overlay"));
      applySubtitleGeometry();
      renderSubtitleStyleView(panel, "root");
      return;
    }

    // 11. Restaurar padrões
    if (e.target.closest("#ssp-reset-all")) {
      try { localStorage.removeItem(SUBTITLE_STYLE_KEY); } catch {}
      applySubtitleStyle(document.getElementById("subtitle-overlay"));
      applySubtitleGeometry();
      renderSubtitleStyleView(panel, "root");
      return;
    }

    // 12. Restaurar posição padrão
    if (e.target.closest("#ssp-reset-pos")) {
      subtitleState.pos = null;
      applySubtitleGeometry();
      renderSubtitleStyleView(panel, "root");
      return;
    }
  };

  // Inputs nativos de cor
  panel.oninput = (e) => {
    e.stopPropagation();
    if (e.target.id === "ssp-text-color-input") {
      const s = loadSubtitleStyle();
      s.textColor = e.target.value;
      saveSubtitleStyle(s);
      applySubtitleStyle(document.getElementById("subtitle-overlay"));
      applySubtitleGeometry();
    } else if (e.target.id === "ssp-bg-color-input") {
      const s = loadSubtitleStyle();
      s.bg = "custom";
      s.bgCustom = e.target.value;
      saveSubtitleStyle(s);
      applySubtitleStyle(document.getElementById("subtitle-overlay"));
      applySubtitleGeometry();
    }
  };
  panel.onchange = (e) => {
    e.stopPropagation();
    if (e.target.id === "ssp-text-color-input" || e.target.id === "ssp-bg-color-input") {
      renderSubtitleStyleView(panel, "root");
    }
  };

  if (!sspDocListenersAttached) {
    sspDocListenersAttached = true;
    document.addEventListener("click", (e) => {
      const p = document.getElementById("subtitle-style-panel");
      const b = document.getElementById("subtitle-style-btn");
      if (!p || p.hidden) return;
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.includes(p) || (b && path.includes(b))) return;
      if (p.contains(e.target) || (b && b.contains(e.target))) return;
      subtitleStyleClose();
    });
    document.addEventListener("keydown", (e) => {
      const p = document.getElementById("subtitle-style-panel");
      if (e.key === "Escape" && p && !p.hidden) {
        if (sspCurrentView !== "root") {
          renderSubtitleStyleView(p, "root");
        } else {
          subtitleStyleClose();
        }
      }
    });
  }
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
async function loadSubtitleOverlay(videoEl, rel, libId) {
  let doc;
  try {
    const url = "/api/subtitles/editor?path=" + encodeURIComponent(rel) + libQuery({ libId });
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
  subtitleState.originalSegments = subtitleState.segments;
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
  // Ligado/Desativado vem do localStorage.
  subtitleState.hash = null;
  subtitleState.rel = video.path;
  subtitleState.ready = false;
  subtitleState.source = null;
  subtitleState.edited = false;
  subtitleState.staleSource = false;
  subtitleState.segments = [];
  subtitleState.originalSegments = [];
  subtitleState.selectedLang = getSubtitleMode();
  subtitleState.targetLang = getSubtitleTargetLang();
  subtitleState.translations = [];
  subtitleState.llmAvailable = false;
  subtitleState.translating = false;
  subtitleState.translationError = null;
  subtitleState.targetLangReady = false;
  subtitleState.currentActionHandler = null;
  subtitleState.currentIndex = -1;
  subtitleState.ccKind = null;
  subtitleState.enabled = getSubtitleEnabled();
  subtitleState.libId = video.libId || null;
  subtitleState.pos = null; // posição arrastável volta ao padrão a cada aula
  subtitleState.percent = null;
  subtitleGenerateApi = null;
  subtitleCheckApi = null;
  fetchSubtitleTranslations(video.path, video.libId);
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
  // Ação do menu CC (Gerar/Regenerar): registrada para o delegation do player.
  // Força regeneração quando solicitado pelo usuário; cancela jobs órfãos e re-sonda até ficar pronta.
  subtitleGenerateApi = async () => {
    subtitleState.lastError = null;
    subtitleState.ccKind = "generating";
    syncSubtitleCcUi();
    try {
      const res = await fetch(
        "/api/subtitles/generate?path=" +
          encodeURIComponent(rel) +
          libQuery(video) +
          "&priority=0&force=1",
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || (data && data.ok === false)) {
        stReady = false;
        stFailed = true;
        subtitleState.lastError = (data && data.error) || "Falha ao iniciar geração de legendas";
        setCc("failed");
        stopPolling();
        return;
      }
    } catch (err) {
      stReady = false;
      stFailed = true;
      subtitleState.lastError = (err && err.message) || "Erro de conexão ao solicitar legendas";
      setCc("failed");
      stopPolling();
      return;
    }
    if (!subtitlePollTimer) subtitlePollTimer = setInterval(check, 2500);
    check().catch(() => {});
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
          libQuery(video),
      );
      if (!res.ok) throw new Error("http " + res.status);
      st = await res.json();
      if (st && st.hash) subtitleState.hash = st.hash;
      if (st && st.error) {
        subtitleState.lastError = st.error;
      }
      // Progresso real do job (whisper -pp) para o badge "Gerando legenda…".
      subtitleState.percent = typeof st.percent === "number" ? st.percent : null;
      subtitleState.canGenerate = !!st.canGenerate;
      // Sem Whisper configurado ⇒ o controle CC não tem o que GERAR e
      // fica oculto — EXCETO com legenda pronta: alternar Original/Desativado
      // de uma legenda existente sempre funciona (sem pipeline) e escondê-la
      // deixaria o usuário sem acesso às legendas que já tem.
      const showCc = !!st.canGenerate || !!st.ready;
      if (ccGroupEl) ccGroupEl.style.display = showCc ? "" : "none";
      if (moreCcGroupEl) moreCcGroupEl.style.display = showCc ? "" : "none";
    } catch {
      return; // API indisponível: silencioso — nunca bloqueia a reprodução.
    }
    // Sem legenda pronta → overlay oculto; se voltar a ficar pronta depois
    // (ex.: regeneração), refetch no próximo poll (overlayLoaded é resetado).
    // EXCEÇÃO: com segmentos válidos já carregados (ex.: original exibido
    // enquanto a tradução gera), mantém o texto visível — apagar deixaria a
    // tela sem legenda durante toda a geração e para sempre se ela falhar.
    if (!st.ready) {
      if (overlayLoaded) overlayLoaded = false;
      if (!subtitleState.segments.length) hideOverlay();
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
      // backend (edited > processed > vtt; nunca raw) e liga à reprodução.
      if (!overlayLoaded) {
        overlayLoaded = true;
        loadSubtitleOverlay(videoEl, rel, video.libId).then((ok) => {
          if (!ok) return;
          // timeupdate SÓ atualiza o texto do segmento ativo — sem re-render.
          videoEl.addEventListener("timeupdate", () =>
            updateSubtitleOverlay(videoEl.currentTime),
          );
          const stale = subtitleState.staleSource;
          setCc(stale ? "stale" : "ready");
          fetchSubtitleTranslations(rel, video.libId);
        });
      } else {
        // Overlay já carregado (ex.: regeneração): atualiza o estado do CC
        // sem recarregar os segmentos — sem isto o botão ficava preso em
        // "Gerando legenda…" mesmo com a legenda pronta de novo.
        setCc(subtitleState.staleSource ? "stale" : "ready");
        fetchSubtitleTranslations(rel, video.libId);
      }
      stopPolling();
      maybePregenNextLesson();
      return;
    }
    const active = [
      "queued", "extracting", "transcribing", "processing", "formatting",
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
      subtitleState.lastError = (st && st.error) || subtitleState.lastError || null;
      setCc("failed");
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
    if (!st.ready && !["queued", "extracting", "transcribing", "processing", "formatting"].includes(st.status)) return;
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

document.addEventListener("change", (e) => {
  const sel = e.target && e.target.closest && e.target.closest(".pc-cc-target-select");
  if (sel && typeof onSubtitleTargetLangChange === "function") {
    onSubtitleTargetLangChange(sel.value);
  }
});

window.subtitleState = subtitleState;
window.setupPlayerSubtitles = setupPlayerSubtitles;
window.applySubtitleGeometry = applySubtitleGeometry;
window.selectSubtitleOriginal = selectSubtitleOriginal;
window.selectSubtitleTranslation = selectSubtitleTranslation;
window.requestSubtitleTranslate = requestSubtitleTranslate;
window.getSubtitleTargetLang = getSubtitleTargetLang;
window.setSubtitleTargetLang = setSubtitleTargetLang;
window.onSubtitleTargetLangChange = onSubtitleTargetLangChange;
