// Ferramentas de Estudo Interativo: Quizzes e Flashcards 3D por IA
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
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
        <div class="tutor-quiz-progress-fill" style="--p: ${(progressPct / 100).toFixed(4)};"></div>
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
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
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

window.renderTutorQuiz = renderTutorQuiz;
window.generateTutorQuiz = generateTutorQuiz;
window.restartQuiz = restartQuiz;
window.renderTutorFlashcards = renderTutorFlashcards;
window.generateTutorFlashcards = generateTutorFlashcards;
window.restartFlashcards = restartFlashcards;
