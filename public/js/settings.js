// Configurações do Player e Central de Inteligência Artificial
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
    </section>

    <!-- Atalhos no Sistema (Opcional) -->
    <section class="settings-card" aria-label="Atalhos do Sistema">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Atalho no Sistema Operacional</h2>
            <p class="settings-section-desc">Crie ou remova opcionalmente o atalho de 1 clique do Local Player na sua Área de Trabalho e no menu de aplicativos deste computador.</p>
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Atalho na Área de Trabalho e Menu</div>
          <div class="settings-row-desc" id="shortcut-status-desc">Opcional: crie o atalho apenas se desejar integrar o player a este computador.</div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="btn btn--secondary" id="btn-create-shortcut" type="button">Criar atalho</button>
          <button class="btn btn--secondary" id="btn-remove-shortcut" type="button">Remover</button>
        </div>
      </div>
    </section>

    <!-- Economia de Energia & Desligamento por Inatividade -->
    <section class="settings-card" aria-label="Economia de Energia">
      <div class="settings-card-head">
        <div class="settings-card-head-main">
          <div class="settings-card-badge">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="16" height="10" rx="2" ry="2"></rect><line x1="22" y1="11" x2="22" y2="13"></line><line x1="6" y1="11" x2="6" y2="13"></line><line x1="10" y1="11" x2="10" y2="13"></line></svg>
          </div>
          <div>
            <h2 class="settings-section-heading">Economia de Bateria e Energia</h2>
            <p class="settings-section-desc">Encerra o servidor automaticamente após um período sem nenhuma aba aberta nem jobs ativos em segundo plano.</p>
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div class="settings-row-text">
          <div class="settings-row-title">Desligamento automático por inatividade</div>
          <div class="settings-row-desc" id="idle-status-desc">O servidor encerra com segurança após o tempo configurado sem nenhuma aba aberta e sem jobs ativos.</div>
        </div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <select id="select-idle-timeout" class="topbar-search-input" style="width: auto; max-width: 220px; padding: 6px 12px; background: var(--bg-card); color: var(--text); border: 1px solid var(--border); border-radius: 8px; cursor: pointer;">
            <option value="15">15 minutos</option>
            <option value="30">30 minutos (recomendado)</option>
            <option value="60">1 hora</option>
            <option value="120">2 horas</option>
            <option value="0">Desativado</option>
          </select>
        </div>
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

  // Gerenciamento opcional de atalhos
  const createBtn = app.querySelector("#btn-create-shortcut");
  const removeBtn = app.querySelector("#btn-remove-shortcut");
  const statusDesc = app.querySelector("#shortcut-status-desc");

  fetch("/api/system/shortcut")
    .then((r) => r.json())
    .then((d) => {
      if (d && d.installed && statusDesc) {
        statusDesc.textContent = "Atalho atualmente instalado neste computador.";
      }
    })
    .catch(() => {});

  if (createBtn) {
    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      if (statusDesc) statusDesc.textContent = "Criando atalho...";
      try {
        const res = await fetch("/api/system/shortcut", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
        });
        const data = await res.json();
        if (statusDesc) {
          statusDesc.textContent = data.message || (data.ok ? "Atalho criado com sucesso!" : data.error);
        }
      } catch (err) {
        if (statusDesc) statusDesc.textContent = "Falha ao conectar com o servidor.";
      } finally {
        createBtn.disabled = false;
      }
    });
  }

  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      removeBtn.disabled = true;
      if (statusDesc) statusDesc.textContent = "Removendo atalho...";
      try {
        const res = await fetch("/api/system/shortcut", {
          method: "DELETE",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
        });
        const data = await res.json();
        if (statusDesc) {
          statusDesc.textContent = data.message || (data.ok ? "Atalhos removidos com sucesso." : data.error);
        }
      } catch (err) {
        if (statusDesc) statusDesc.textContent = "Falha ao conectar com o servidor.";
      } finally {
        removeBtn.disabled = false;
      }
    });
  }

  // Economia de Bateria / Desligamento por Inatividade
  const idleSelect = app.querySelector("#select-idle-timeout");
  const idleDesc = app.querySelector("#idle-status-desc");

  if (idleSelect) {
    fetch("/api/system/idle")
      .then((r) => r.json())
      .then((data) => {
        if (data && data.ok) {
          idleSelect.value = String(data.idleTimeoutMinutes);
          if (idleDesc) {
            if (data.idleTimeoutMinutes === 0) {
              idleDesc.textContent = "Desligamento automático desativado. O servidor continuará em execução mesmo sem abas abertas.";
            } else {
              idleDesc.textContent = `O servidor será encerrado após ${data.idleTimeoutMinutes} minutos sem nenhuma aba aberta e sem jobs ativos.`;
            }
          }
        }
      })
      .catch(() => {});

    idleSelect.addEventListener("change", async () => {
      const minutes = parseInt(idleSelect.value, 10);
      try {
        const res = await fetch("/api/system/idle", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
          body: JSON.stringify({ minutes }),
        });
        const data = await res.json();
        if (idleDesc) {
          if (minutes === 0) {
            idleDesc.textContent = "Desligamento automático desativado.";
          } else {
            idleDesc.textContent = `Desligamento automático configurado para ${minutes} minutos.`;
          }
        }
      } catch (err) {
        if (idleDesc) idleDesc.textContent = "Erro ao atualizar configuração de inatividade.";
      }
    });
  }
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
        `<button type="button" class="lib-btn" data-action="rescan"${lib.enabled === false ? " disabled" : ""}>Reescanear</button>`,
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
            const res = await fetch("/api/subtitles/clear", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ all: true }),
            });
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
        await fetch("/api/ai/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        });
        await loadAiData();
        aiState.editingProviderId = null;
        aiState.form = null;
        renderAiPanelInto(panel);
      },
    });
  });
}

window.renderSettings = renderSettings;
window.startCapture = startCapture;
window.stopCapture = stopCapture;
