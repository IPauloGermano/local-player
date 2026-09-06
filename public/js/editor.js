// ==========================================================================
// Editor de legendas (estilo YouTube).
// ==========================================================================
// Estado global do editor. `segments` é a cópia de trabalho; o overlay de
// preview aponta para a MESMA referência (subtitleState.segments) para que a
// legenda seja pré-visualizada em tempo real, sem salvar.
var editor = {

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
window.editor = editor;
window.openSubtitleEditor = openSubtitleEditor;
window.editorToggleMode = editorToggleMode;
