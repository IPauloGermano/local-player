// Gerenciamento de Legendas, Overlay, Geometria, Arraste e Tradução por IA
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
var subtitleState = {

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
  // Formata mensagens de erro de legenda para exibição amigável e resolutiva
  function formatSubtitleErrorMessage(error) {
    if (!error) return "Erro ao gerar legenda. Clique em 'Tentar novamente'.";
    const err = String(error).trim();
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
  const isError = kind === "failed";
  if (kind === "generating") statusText = "Gerando legenda…";
  else if (kind === "waiting") statusText = "Aguardando o dispositivo…";
  else if (kind === "no-translate") statusText = "Tradução indisponível — configure um LLM";
  else if (kind === "failed") {
    const errorDetail = subtitleState.lastError || "";
    statusText = formatSubtitleErrorMessage(errorDetail);
    actionText = "Tentar novamente";
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
  const isError = kind === "failed";
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
  }
  badge.classList.toggle("is-error", isError);
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
          langQuery() +
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
          libQuery(video) +
          langQuery(),
      );
      if (!res.ok) throw new Error("http " + res.status);
      st = await res.json();
      if (st && st.error) {
        subtitleState.lastError = st.error;
      }
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
      subtitleState.lastError = (st && st.error) || subtitleState.lastError || null;
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

// Subtitle Editor movido para public/js/editor.js

window.subtitleState = subtitleState;
window.setupPlayerSubtitles = setupPlayerSubtitles;
window.teardownPlayerSubtitles = teardownPlayerSubtitles;
window.applySubtitleGeometry = applySubtitleGeometry;
window.loadSubtitleStyle = loadSubtitleStyle;
window.saveSubtitleStyle = saveSubtitleStyle;
window.applySubtitleStyle = applySubtitleStyle;
