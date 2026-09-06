// Gerenciamento e Captura de Atalhos de Teclado Configuráveis
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

var shortcutKeyToAction = {}; // tecla (lowercase) → ação
var captureState = null; // { action, row } durante captura na Settings

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

window.DEFAULT_SHORTCUTS = DEFAULT_SHORTCUTS;
window.SHORTCUT_LABELS = SHORTCUT_LABELS;
window.SHORTCUT_ORDER = SHORTCUT_ORDER;
window.shortcutKeyToAction = shortcutKeyToAction;
window.captureState = captureState;
window.getShortcuts = getShortcuts;
window.setShortcut = setShortcut;
window.buildShortcutMap = buildShortcutMap;
window.actionForKey = actionForKey;
window.shortcutLabel = shortcutLabel;
window.registerShortcuts = registerShortcuts;
