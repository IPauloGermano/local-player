// Player de Vídeo: Controles Customizados, Web Audio GainNode, Tracking e Fallback de Transcoding
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
const ICON_PAUSE_CENTER = svgIcon('<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>', 30);
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

// ---------- Pipeline de Áudio Nativo (Web Audio API) ----------
// Pipeline inteligente permanente e transparente:
// videoEl -> sourceNode -> DynamicsCompressorNode -> GainNode -> destination
// - DynamicsCompressorNode (Normalizador nativo): atenua picos e equilibra falas
//   baixas automaticamente em todas as aulas, sem intervenção do usuário.
// - GainNode: controla o volume base (0–100%) e amplifica ganho extra (100–200%).
// Cadeia DSP de Processamento Vocal e Normalização Profunda (Broadcast Vocal DSP):
// videoEl -> sourceNode -> highPassFilter -> presenceFilter -> preGainNode -> compressorNode -> gainNode -> limiterNode -> destination
// 1. highPassFilter (85 Hz): elimina sub-graves inaudíveis (vibração de mesa, ar, hum 60 Hz) e libera potência para a fala.
// 2. presenceFilter (3.0 kHz, +3.5 dB): realça consoantes e inteligibilidade fonética da voz humana.
// 3. preGainNode (+6.8 dB / ~2.2x): pré-amplifica sinais gravados com ganho de entrada fraco.
// 4. compressorNode (-34 dB): puxa vozes distantes e uniformiza a dinâmica das aulas.
// 5. gainNode: volume do usuário (0–100%) e ganho manual ampliado até 300%.
// 6. limiterNode (-1 dBFS): barreira true-peak que elimina qualquer risco de distorção ou clipping.
let audioCtx = null;
let highPassFilter = null;
let presenceFilter = null;
let preGainNode = null;
let compressorNode = null;
let gainNode = null;
let limiterNode = null;
let sourceNode = null;
let sourceEl = null;

const WEB_AUDIO_OK = !!(window.AudioContext || window.webkitAudioContext);

const VOLUME_KEY = "course-player-volume"; // 0–100 (volume nativo)
const GAIN_KEY = "course-player-gain"; // 100–300 (ganho extra ampliado via Web Audio)
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
    gain: Number.isFinite(gain) ? Math.max(100, Math.min(300, gain)) : 100,
  };
}

function setVolumePrefs(base, gainPct) {
  localStorage.setItem(VOLUME_KEY, String(Math.round(base)));
  localStorage.setItem(GAIN_KEY, String(Math.round(gainPct)));
}

function ensureAudioGraph(videoEl) {
  if (!videoEl || !WEB_AUDIO_OK) return;
  const prefs = getVolumePrefs();
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    audioCtx = new Ctor();

    // 1. High-Pass Filter (85 Hz) — elimina ruídos graves indesejados e economiza potência
    highPassFilter = audioCtx.createBiquadFilter();
    highPassFilter.type = "highpass";
    highPassFilter.frequency.value = 85;
    highPassFilter.Q.value = 0.707;

    // 2. Presence Filter (3 kHz, +3.5 dB) — inteligibilidade e nitidez de consoantes da fala
    presenceFilter = audioCtx.createBiquadFilter();
    presenceFilter.type = "peaking";
    presenceFilter.frequency.value = 3000;
    presenceFilter.Q.value = 1.2;
    presenceFilter.gain.value = 3.5;

    // 3. Pré-amplificação de sinais fracos (+6.8 dB / ~2.2x)
    preGainNode = audioCtx.createGain();
    preGainNode.gain.value = 2.2;

    // 4. Normalizador de dinâmica profundo (-34 dB) — nivela vozes baixas e atenua picos
    compressorNode = audioCtx.createDynamicsCompressor();
    compressorNode.threshold.value = -34;
    compressorNode.knee.value = 30;
    compressorNode.ratio.value = 12;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.25;

    // 5. Volume do usuário e ganho extra até 300%
    gainNode = audioCtx.createGain();
    gainNode.gain.value = prefs.gain / 100;

    // 6. True-Peak Brickwall Limiter (-1 dBFS) — proteção absoluta contra clipping e distorção
    limiterNode = audioCtx.createDynamicsCompressor();
    limiterNode.threshold.value = -1.0;
    limiterNode.knee.value = 0;
    limiterNode.ratio.value = 20;
    limiterNode.attack.value = 0.001;
    limiterNode.release.value = 0.05;

    // Conexão sequencial da cadeia DSP:
    // highPass -> presence -> preGain -> compressor -> gain -> limiter -> destination
    highPassFilter.connect(presenceFilter);
    presenceFilter.connect(preGainNode);
    preGainNode.connect(compressorNode);
    compressorNode.connect(gainNode);
    gainNode.connect(limiterNode);
    limiterNode.connect(audioCtx.destination);

    resumeAudio();
  } else if (gainNode) {
    gainNode.gain.value = prefs.gain / 100;
  }

  // Troca de aula: o elemento mudou → conecta a fonte na entrada da cadeia DSP
  if (sourceEl !== videoEl) {
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {}
      sourceNode = null;
    }
    try {
      sourceNode = audioCtx.createMediaElementSource(videoEl);
      sourceNode.connect(highPassFilter || preGainNode || compressorNode || gainNode);
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
      <div class="pc-skip-flash" id="pc-skip-flash" hidden></div>
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
                  <input type="range" class="pc-slider" id="pc-gain" min="100" max="300" step="5" value="100" aria-label="Ganho extra acima de 100% (até 300%)" />
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
                  <button type="button" class="pc-menu-item pc-cc-action" id="pc-cc-action" data-cc="action" hidden></button>
                  <span class="pc-cc-status" id="pc-cc-status"></span>
                </div>
              </div>
            </div>
            <button class="pc-btn" id="pc-fullscreen" type="button" aria-label="Tela cheia">${ICON_FULLSCREEN}</button>
            <div class="pc-group pc-group-more">
              <button class="pc-btn pc-more-btn" id="pc-more-btn" type="button" aria-haspopup="true" aria-expanded="false" aria-label="Mais opções" title="Mais opções">${ICON_MORE}</button>
              <div class="pc-pop pc-more-menu" id="pc-more-menu" hidden>
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
                  <button type="button" class="pc-menu-item pc-cc-action" id="pc-more-cc-action" data-cc="action" hidden></button>
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
    // Pausado: botão central sempre com ícone de play. Tocando: não mexe no
    // ícone — o tap no centro pode ter exibido o pause temporário (some no
    // próximo pause/idle).
    if (paused) centerBtn.innerHTML = ICON_PLAY_CENTER;
    centerBtn.classList.toggle("hidden", !paused);
    if (paused) showControls();
  };

  // --- autohide (desktop e mobile durante a reprodução; nunca com popover
  // aberto nem pausado) ---
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
    if (videoEl.paused || isPopoverOpen()) return;
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
  // Toque: touchstart acorda; touchmove mantém aceso durante o arraste (ex.:
  // seek — sem isso a barra sumiria no meio do gesto e o polegar perderia o
  // pointer); touchend reinicia os 2,5s após soltar o dedo.
  wrap.addEventListener("touchstart", wakeControls, { passive: true });
  wrap.addEventListener("touchmove", wakeControls, { passive: true });
  wrap.addEventListener("touchend", wakeControls, { passive: true });
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
      setSliderFill(gainRange, prefs.gain, 100, 300);
    }
    if (volVal) volVal.textContent = `${prefs.volume}%`;
    if (gainVal) gainVal.textContent = `${prefs.gain}%`;
    updateVolumeUI(videoEl);
    refreshWarn();
  };

  // --- eventos ---
  if (playBtn) playBtn.addEventListener("click", () => togglePlay(videoEl));
  if (centerBtn) centerBtn.addEventListener("click", () => togglePlay(videoEl));
  // Toques no vídeo (touch): tap NUNCA alterna play/pause — só mostra os
  // controles. TOQUE DUPLO nas laterais avança/volta 10s (mesmo passo dos
  // atalhos j/l); duplo no centro só mantém a barra visível. O play/pause no
  // touch acontece SÓ nos botões (pc-play / pc-center). Clique com mouse
  // mantém o toggle clássico.
  const TAP_SLOP_PX = 12;
  const TAP_MAX_MS = 500;
  const DOUBLE_TAP_MS = 350;
  const SIDE_ZONE = 0.35;
  const TOUCH_SEEK_SECONDS = 10;
  let touchTapAt = 0;
  let tapTrack = null;
  let lastSideTap = null;
  let skipFlashTimer = null;
  const skipFlashEl = document.getElementById("pc-skip-flash");
  const showSkipFlash = (dir) => {
    if (!skipFlashEl) return;
    skipFlashEl.textContent = dir < 0 ? "−10 s" : "+10 s";
    skipFlashEl.dataset.side = dir < 0 ? "left" : "right";
    skipFlashEl.hidden = false;
    skipFlashEl.classList.remove("show");
    void skipFlashEl.offsetWidth;
    skipFlashEl.classList.add("show");
    if (skipFlashTimer) clearTimeout(skipFlashTimer);
    skipFlashTimer = setTimeout(() => {
      skipFlashEl.hidden = true;
    }, 700);
  };
  const seekTouch = (dir) => {
    if (dir < 0) {
      videoEl.currentTime = Math.max(0, videoEl.currentTime - TOUCH_SEEK_SECONDS);
    } else {
      const maxTime = Number.isFinite(videoEl.duration)
        ? videoEl.duration
        : videoEl.currentTime + TOUCH_SEEK_SECONDS;
      videoEl.currentTime = Math.min(maxTime, videoEl.currentTime + TOUCH_SEEK_SECONDS);
    }
    showSkipFlash(dir);
  };
  // --- toque LONGO (hold): 2× temporário; soltar volta à velocidade anterior.
  // Vale só com o vídeo tocando e fora de botões/menus, legenda arrastável e
  // overlay de erro. Não persiste preferência (só o menu de velocidade salva).
  const HOLD_MS = 400;
  const HOLD_SLOP_PX = 12;
  let holdTimer = null;
  let holdPointerId = null;
  let holdPrevRate = null;
  const holdEligible = (target) =>
    !target.closest(".player-ui") &&
    !target.closest(".subtitle-overlay-text") &&
    !target.closest(".player-status");
  const cancelHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    holdPointerId = null;
  };
  const endHoldSpeed = () => {
    cancelHold();
    if (holdPrevRate === null) return;
    videoEl.playbackRate = holdPrevRate;
    updateSpeedLabel(videoEl);
    holdPrevRate = null;
    if (skipFlashEl) {
      skipFlashEl.classList.remove("held");
      skipFlashEl.hidden = true;
    }
    wakeControls();
  };
  const engageHoldSpeed = () => {
    holdTimer = null;
    if (videoEl.paused || holdPrevRate !== null) return;
    holdPrevRate = videoEl.playbackRate || 1;
    videoEl.playbackRate = 2;
    updateSpeedLabel(videoEl);
    if (skipFlashEl) {
      if (skipFlashTimer) clearTimeout(skipFlashTimer);
      skipFlashEl.textContent = "2×";
      skipFlashEl.dataset.side = "center";
      skipFlashEl.hidden = false;
      skipFlashEl.classList.remove("show");
      skipFlashEl.classList.add("held");
    }
    wakeControls();
  };
  wrap.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    tapTrack = { x: e.clientX, y: e.clientY, t: Date.now() };
    // Toque LONGO: segurando no vídeo (fora de botões/legenda/erro) com o
    // vídeo tocando, arma o 2× temporário — soltar volta à velocidade
    // anterior. Não perturba um hold já engatado (multitoque).
    if (!videoEl.paused && holdPrevRate === null && holdEligible(e.target)) {
      cancelHold();
      holdPointerId = e.pointerId;
      holdTimer = setTimeout(engageHoldSpeed, HOLD_MS);
    }
  }, { passive: true });
  wrap.addEventListener("pointercancel", () => {
    tapTrack = null;
    endHoldSpeed();
  });
  // Rolagem/arraste antes de engatar cancela o hold (depois de engatado, só
  // soltar restaura — o gesto já virou 2×).
  wrap.addEventListener("pointermove", (e) => {
    if (holdPointerId === null || e.pointerId !== holdPointerId) return;
    if (holdPrevRate !== null || !tapTrack) return;
    const moved = Math.hypot(e.clientX - tapTrack.x, e.clientY - tapTrack.y);
    if (moved > HOLD_SLOP_PX) cancelHold();
  }, { passive: true });
  wrap.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    // Soltura do dedo do hold: restaura a velocidade (sem tap/seek/toggle).
    if (holdPointerId !== null && e.pointerId === holdPointerId) {
      const wasHeld = holdPrevRate !== null;
      endHoldSpeed();
      if (wasHeld) {
        touchTapAt = Date.now(); // suprime o click sintético
        return;
      }
      // Solto antes de engatar: segue o fluxo normal de tap abaixo.
    }
    const tr = tapTrack;
    tapTrack = null;
    if (!tr) return;
    if (e.target.closest(".player-ui")) return; // botões/menus: fluxo próprio
    if (e.target.closest(".subtitle-overlay-text")) {
      wakeControls(); // legenda arrastável: tap só acorda, sem seek
      return;
    }
    if (e.target.closest(".player-status")) return; // overlay de erro: fluxo próprio
    const moved = Math.hypot(e.clientX - tr.x, e.clientY - tr.y);
    if (moved > TAP_SLOP_PX || Date.now() - tr.t > TAP_MAX_MS) return; // arraste/scroll
    touchTapAt = Date.now();
    const r = wrap.getBoundingClientRect();
    const fx = r.width > 0 ? (e.clientX - r.left) / r.width : 0.5;
    const zone = fx < SIDE_ZONE ? -1 : fx > 1 - SIDE_ZONE ? 1 : 0;
    // Toque duplo no MESMO lado dentro da janela = seek; qualquer outro caso
    // (simples, centro, lados alternados) só mostra os controles.
    const now = Date.now();
    if (
      zone !== 0 &&
      lastSideTap &&
      lastSideTap.zone === zone &&
      now - lastSideTap.t < DOUBLE_TAP_MS
    ) {
      lastSideTap = null;
      seekTouch(zone);
    } else {
      lastSideTap = zone !== 0 ? { zone, t: now } : null;
    }
    wakeControls();
    // Tap no centro tocando: revela o botão central de PAUSE (funcional —
    // o clique dele pausa via handler próprio). Some no próximo pause/idle.
    if (zone === 0 && !videoEl.paused && centerBtn) {
      centerBtn.innerHTML = ICON_PAUSE_CENTER;
      centerBtn.classList.remove("hidden");
      centerBtn.setAttribute("aria-label", "Pausar");
    }
  });
  // Pressão longa no touch abre o menu nativo do navegador sobre o <video>
  // (copiar link/compartilhar/salvar) — o player tem gestos próprios (tap,
  // duplo-tap, hold 2×), então o menu nativo é suprimido aqui (vale também
  // para o botão direito no desktop sobre o player).
  wrap.addEventListener("contextmenu", (e) => e.preventDefault());
  // Clique em área vazia do vídeo com MOUSE alterna play/pause. Toques touch
  // caem aqui como click sintético: já tratados acima, sem toggle.
  wrap.addEventListener("click", (e) => {
    // Soltar a legenda arrastada dispara um `click` sintético que não pode
    // virar play/pause (o arraste é uma ação do usuário sobre a legenda).
    if (subtitleDragSuppressClick) {
      subtitleDragSuppressClick = false;
      return;
    }
    if (e.target.closest(".player-ui")) return;
    if (Date.now() - touchTapAt < 600) return;
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
      setSliderFill(gainRange, gain, 100, 300);
      setVolumePrefs(getVolumePrefs().volume, gain);
      ensureAudioGraph(videoEl);
      if (gainNode) gainNode.gain.value = gain / 100;
      updateVolumeUI(videoEl);
      refreshWarn();
    });
  }
  // Garante que qualquer reprodução inicialize o grafo e retome o áudio
  videoEl.addEventListener("play", () => {
    ensureAudioGraph(videoEl);
    resumeAudio();
  });

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
      if (more.dataset.more === "theater") toggleTheaterMode();
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
      setSubtitleEnabled(true);
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

// Legendas e Overlay movidos para public/js/subtitles.js

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

window.prepareTranscoded = prepareTranscoded;
window.setupAudioGain = setupAudioGain;
window.setAudioVolume = setAudioVolume;
window.syncVolumeUI = syncVolumeUI;
window.applyVolumePrefs = applyVolumePrefs;
window.setupPlayerControls = setupPlayerControls;
window.setupVideoTracking = setupVideoTracking;
window.navigateToLesson = navigateToLesson;
window.changePlaybackSpeed = changePlaybackSpeed;
window.togglePlayerFullscreen = togglePlayerFullscreen;
window.retryOriginal = retryOriginal;
