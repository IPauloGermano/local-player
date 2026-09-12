// Tutor IA Integrado ao Player (chat contextualizado, streaming SSE, markdown)
// ---------------------------------------------------------------------------

function renderMarkdownToHtml(markdown) {
  if (typeof LocalPlayerScope !== "undefined" && typeof LocalPlayerScope.renderMarkdownToHtml === "function") {
    return LocalPlayerScope.renderMarkdownToHtml(markdown);
  }
  return escapeHtml(markdown || "");
}

// Baixa um texto como arquivo no navegador (sem backend): cria um Blob,
// gera URL temporária e dispara um <a download>. Usado pelos botões
// "⬇ .md / .txt" de cada resposta do assistente.
function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
  }
  return Promise.resolve(fallbackCopyText(text));
}

function fallbackCopyText(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

var _lastDownloadTime = 0;
function downloadTutorFile(filename, text, mime) {
  const now = Date.now();
  if (now - _lastDownloadTime < 1000) return;
  _lastDownloadTime = now;
  try {
    const blob = new Blob([text], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch {}
}

// Detecta pedido explícito de bloco/arquivo md ou txt na mensagem do
// usuário (ex.: "mande em bloco md", "exporta em txt", "me dá em markdown").
// Só nesses casos a resposta seguinte exibe os botões ⬇ .md/.txt.
function tutorExplicitDownloadRequest(userText) {
  const t = String(userText || "").toLowerCase();
  if (!/\b(md|markdown|txt|texto puro)\b/.test(t)) return false;
  return /mande|manda|mandar|gere|gerar|exporte|exportar|baixe|baixar|download|salve|salvar|envi[ea]|enviar|coloque|coloca|trag[ao]|traz|quero|me d[áaàe]|bloco|arquivo|ficheiro|como md|como txt|em md|em txt|em markdown|em texto/i.test(t);
}

function tutorSlug(text) {
  return (text || "tutor")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40) || "tutor";
}

// Conversão simples de markdown para texto puro (para o download .txt):
// remove cercas, títulos, ênfases, links e tags, preservando o conteúdo.
function tutorMarkdownToText(md) {
  let t = String(md || "");
  t = t.replace(/^```.*$/gm, "");
  t = t.replace(/^#{1,6}\s+/gm, "");
  t = t.replace(/^>\s?/gm, "");
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/\*\*([^*]+)\*\*/g, "$1");
  t = t.replace(/__([^_]+)__/g, "$1");
  t = t.replace(/`([^`]*)`/g, "$1");
  t = t.replace(/<[^>]+>/g, "");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim() + "\n";
}

function downloadTutorMessage(video, index, format) {
  if (!video) return;
  const history = getTutorHistory(video.path);
  const msg = history && history[index];
  if (!msg || msg.role !== "assistant" || !msg.content || !msg.content.trim()) return;
  const base = tutorSlug(typeof lessonTitle === "function" ? lessonTitle(video) : "") + "-tutor-" + (index + 1);
  if (format === "txt") {
    downloadTutorFile(base + ".txt", tutorMarkdownToText(msg.content), "text/plain");
  } else {
    downloadTutorFile(base + ".md", msg.content.trim() + "\n", "text/markdown");
  }
}

var tutorState = {

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
  if (!drawer || drawer.dataset.wired === "true") return;
  drawer.dataset.wired = "true";

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
        e.preventDefault();
        e.stopPropagation();
        if (copyBtn.disabled) return;
        copyBtn.disabled = true;
        const card = copyBtn.closest(".tutor-code-card");
        const code = card?.querySelector("code")?.textContent || "";
        if (code) {
          copyTextToClipboard(code).then(() => {
            const textSpan = copyBtn.querySelector(".tutor-copy-text");
            if (textSpan) textSpan.textContent = "Copiado!";
            copyBtn.classList.add("copied");
            setTimeout(() => {
              if (textSpan) textSpan.textContent = "Copiar";
              copyBtn.classList.remove("copied");
              copyBtn.disabled = false;
            }, 2000);
          }).catch(() => {
            copyBtn.disabled = false;
          });
        } else {
          copyBtn.disabled = false;
        }
        return;
      }

      // Botão de copiar mensagem (usuário ou assistente)
      const copyMsgBtn = e.target.closest("[data-tutor-copy]");
      if (copyMsgBtn && copyMsgBtn.dataset.tutorCopy !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        if (copyMsgBtn.disabled) return;
        copyMsgBtn.disabled = true;
        const vid = tutorState.currentVideo || video;
        const history = getTutorHistory(vid ? vid.path : "");
        const idx = parseInt(copyMsgBtn.dataset.tutorCopy, 10);
        const msg = history[idx];
        if (msg && msg.content) {
          copyTextToClipboard(msg.content).then(() => {
            const span = copyMsgBtn.querySelector("span");
            const prevText = span ? span.textContent : "Copiar";
            if (span) span.textContent = "Copiado!";
            copyMsgBtn.classList.add("copied");
            setTimeout(() => {
              if (span) span.textContent = prevText;
              copyMsgBtn.classList.remove("copied");
              copyMsgBtn.disabled = false;
            }, 2000);
          }).catch(() => {
            copyMsgBtn.disabled = false;
          });
        } else {
          copyMsgBtn.disabled = false;
        }
        return;
      }

      // Botão de download da resposta (.md / .txt)
      const dlBtn = e.target.closest("[data-tutor-dl]");
      if (dlBtn && dlBtn.dataset.tutorMsg !== undefined) {
        e.preventDefault();
        e.stopPropagation();
        if (dlBtn.disabled) return;
        dlBtn.disabled = true;
        const vid = tutorState.currentVideo || video;
        const format = dlBtn.dataset.tutorDl;
        downloadTutorMessage(vid, parseInt(dlBtn.dataset.tutorMsg, 10), format);
        const span = dlBtn.querySelector("span");
        const prevText = span ? span.textContent : format.toUpperCase();
        if (span) span.textContent = "Baixado!";
        dlBtn.classList.add("copied");
        setTimeout(() => {
          if (span) span.textContent = prevText;
          dlBtn.classList.remove("copied");
          dlBtn.disabled = false;
        }, 1500);
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

      // Botão de buscar vídeo alternativo no card de vídeo embed
      const altBtn = e.target.closest(".tutor-video-alt-btn");
      if (altBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (altBtn.disabled) return;

        const card = altBtn.closest(".tutor-video-card");
        if (!card) return;

        const currentId = card.dataset.videoId || "";
        const topic = card.dataset.topic || (tutorState.currentVideo ? lessonTitle(tutorState.currentVideo) : "");

        handleVideoCardAlternative(card, currentId, topic);
        return;
      }
    });
  }
}

async function handleVideoCardAlternative(card, currentId, topic) {
  if (!card) return;
  const actions = card.querySelector(".tutor-video-actions");
  const footer = card.querySelector(".tutor-video-footer");
  const targetHost = actions || footer;
  const altBtn = card.querySelector(".tutor-video-alt-btn");
  if (altBtn) altBtn.disabled = true;

  const prevActionsHtml = targetHost ? targetHost.innerHTML : "";
  if (targetHost) {
    targetHost.innerHTML = `<span class="tutor-video-loading"><span class="tutor-tool-spinner"></span> Buscando...</span>`;
  }

  try {
    const vidPath = tutorState.currentVideo ? tutorState.currentVideo.path : "";
    const libId = tutorState.currentVideo ? (tutorState.currentVideo.libId || "") : "";
    const url = `/api/tutor/video/search?query=${encodeURIComponent(topic)}&excludeId=${encodeURIComponent(currentId)}&lessonPath=${encodeURIComponent(vidPath)}&libraryId=${encodeURIComponent(libId)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("Falha na busca de alternativas.");
    const data = await res.json();
    const alternatives = (data && data.videos) ? data.videos : [];
    const nextVideo = alternatives.find((v) => v.id !== currentId) || alternatives[0];

    if (!nextVideo) {
      if (targetHost) {
        targetHost.innerHTML = `<span class="tutor-video-no-alt">Sem alternativas no momento</span>`;
        setTimeout(() => { if (targetHost) targetHost.innerHTML = prevActionsHtml; }, 3000);
      }
      return;
    }

    card.dataset.videoId = nextVideo.id;
    card.dataset.videoUrl = nextVideo.url;
    card.dataset.topic = nextVideo.title;

    const titleEl = card.querySelector(".tutor-video-title");
    if (titleEl) {
      titleEl.textContent = nextVideo.title;
      titleEl.title = nextVideo.title;
    }

    const extBtn = card.querySelector(".tutor-video-external-btn");
    if (extBtn) {
      extBtn.href = nextVideo.url;
    }

    const iframe = card.querySelector(".tutor-video-iframe");
    if (iframe) {
      iframe.src = `https://www.youtube-nocookie.com/embed/${nextVideo.id}?enablejsapi=1&rel=0&modestbranding=1`;
      iframe.title = nextVideo.title;
    }

    if (actions) {
      actions.innerHTML = `
        <span class="tutor-video-replaced-badge" title="Vídeo alternativo carregado">✓ Trocado</span>
        <button type="button" class="tutor-video-alt-btn" data-video-alt="${nextVideo.id}" title="Buscar outro vídeo sobre este tema">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          <span>Trocar</span>
        </button>
        <a href="${nextVideo.url}" target="_blank" rel="noopener noreferrer" class="tutor-video-external-btn" title="Abrir no YouTube">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          <span>YouTube</span>
        </a>`;
      setTimeout(() => {
        const badge = actions.querySelector(".tutor-video-replaced-badge");
        if (badge) badge.remove();
      }, 3500);
    } else if (footer) {
      footer.innerHTML = `
        <span class="tutor-video-replaced-badge">✓ Trocado</span>
        <button type="button" class="tutor-video-alt-btn" data-video-alt="${nextVideo.id}" title="Buscar outro vídeo sobre este tema">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          <span>Trocar</span>
        </button>`;
      setTimeout(() => {
        const badge = footer.querySelector(".tutor-video-replaced-badge");
        if (badge) badge.remove();
      }, 3500);
    }
  } catch (err) {
    if (targetHost) {
      targetHost.innerHTML = `<span class="tutor-video-error">${escapeHtml(err.message || "Erro")}</span>`;
      setTimeout(() => { if (targetHost) targetHost.innerHTML = prevActionsHtml; }, 3000);
    }
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
  let lastUserText = "";
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg.role === "user") {
      lastUserText = msg.content || "";
      html += `
        <div class="tutor-msg tutor-msg-user">
          <div class="tutor-msg-main">
            <div class="tutor-msg-bubble">${escapeHtml(msg.content)}</div>
            <div class="tutor-msg-actions">
              <button type="button" class="tutor-dl-btn" data-tutor-copy="${i}" title="Copiar minha mensagem" aria-label="Copiar mensagem">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copiar</span>
              </button>
            </div>
          </div>
        </div>`;
    } else {
      const formatted = renderMarkdownToHtml(msg.content);
      const downloadable = !msg.error && msg.content && msg.content.trim()
        && tutorExplicitDownloadRequest(lastUserText);
      html += `
        <div class="tutor-msg tutor-msg-assistant">
          <div class="tutor-avatar" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2l2.4 6.8L21 11l-6.6 2.2L12 20l-2.4-6.8L3 11l6.6-2.2z"/>
            </svg>
          </div>
          <div class="tutor-msg-main">
          <div class="tutor-msg-bubble ${msg.error ? "tutor-msg-error" : ""}">
            ${formatted}
          </div>
          ${!msg.error && msg.content ? `
          <div class="tutor-msg-actions">
            <button type="button" class="tutor-dl-btn" data-tutor-copy="${i}" title="Copiar resposta" aria-label="Copiar resposta">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copiar</span>
            </button>
            ${downloadable ? `
            <button type="button" class="tutor-dl-btn" data-tutor-dl="md" data-tutor-msg="${i}" title="Baixar esta resposta em Markdown (.md)" aria-label="Baixar em Markdown">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>MD</span>
            </button>
            <button type="button" class="tutor-dl-btn" data-tutor-dl="txt" data-tutor-msg="${i}" title="Baixar esta resposta em texto puro (.txt)" aria-label="Baixar em texto puro">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>TXT</span>
            </button>` : ""}
          </div>` : ""}
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
          } else if (parsed.status === "searching_video") {
            if (currentBubble && !accumulatedText) {
              currentBubble.innerHTML = `<div class="tutor-tool-status"><span class="tutor-tool-spinner"></span> Buscando vídeos recomendados...</div>`;
            }
          } else if (parsed.status === "verifying_video") {
            if (currentBubble && !accumulatedText) {
              currentBubble.innerHTML = `<div class="tutor-tool-status"><span class="tutor-tool-spinner"></span> Verificando disponibilidade do vídeo...</div>`;
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

    // Re-render completo (inclui os botões ⬇ .md/.txt da resposta).
    renderTutorMessages(video);
  } catch (err) {
    if (err.name === "AbortError") {
      if (!assistantMsg.content) {
        assistantMsg.content = "*(Resposta interrompida)*";
      }
    } else {
      assistantMsg.content = `⚠️ **Não foi possível obter a resposta:** ${escapeHtml(err.message || "Erro de conexão")}`;
      assistantMsg.error = true;
    }
    renderTutorMessages(video);
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

window.tutorState = tutorState;
window.renderMarkdownToHtml = renderMarkdownToHtml;
window.getTutorHistory = getTutorHistory;
window.getTutorQuizState = getTutorQuizState;
window.getTutorFlashcardsState = getTutorFlashcardsState;
window.openTutorDrawer = openTutorDrawer;
window.closeTutorDrawer = closeTutorDrawer;
window.toggleTutorDrawer = toggleTutorDrawer;
window.renderTutorMessages = renderTutorMessages;
window.sendTutorMessage = sendTutorMessage;
window.handleVideoCardAlternative = handleVideoCardAlternative;

// Monitora eventos do player do YouTube para detectar e substituir automaticamente vídeos indisponíveis
if (typeof window !== "undefined" && !window._tutorYtListenerInstalled) {
  window._tutorYtListenerInstalled = true;
  window.addEventListener("message", (event) => {
    try {
      if (!event.origin || (!event.origin.includes("youtube.com") && !event.origin.includes("youtube-nocookie.com"))) {
        return;
      }
      let data = event.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch {}
      }
      if (!data) return;

      // Códigos de erro do YouTube:
      // 100: vídeo removido ou privado
      // 101/150: incorporação bloqueada pelo proprietário
      // 2/5: erro de parâmetros ou player HTML5
      const isError = data.event === "onError" || (data.info && [2, 5, 100, 101, 150].includes(Number(data.info)));
      if (isError) {
        const iframes = document.querySelectorAll(".tutor-video-iframe");
        for (const ifr of iframes) {
          if (ifr.contentWindow === event.source) {
            const card = ifr.closest(".tutor-video-card");
            if (card && !card.dataset.replacing) {
              card.dataset.replacing = "true";
              const currentId = card.dataset.videoId || "";
              const topic = card.dataset.topic || (tutorState.currentVideo ? lessonTitle(tutorState.currentVideo) : "");
              const titleEl = card.querySelector(".tutor-video-title");
              if (titleEl) {
                titleEl.innerHTML = `<span style="color:#f87171">⚠️ Vídeo indisponível — substituindo automaticamente...</span>`;
              }
              handleVideoCardAlternative(card, currentId, topic).finally(() => {
                delete card.dataset.replacing;
              });
              break;
            }
          }
        }
      }
    } catch {}
  });
}
