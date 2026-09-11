// Tutor IA Integrado ao Player (chat contextualizado, streaming SSE, markdown)
// ---------------------------------------------------------------------------

function renderMarkdownToHtml(markdown) {
  if (typeof LocalPlayerScope !== "undefined" && typeof LocalPlayerScope.renderMarkdownToHtml === "function") {
    return LocalPlayerScope.renderMarkdownToHtml(markdown);
  }
  return escapeHtml(markdown || "");
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
