// Pós-processamento determinístico de legendas
const SUBTITLE_CUE_MAX_CHARS = 150; // ~2 linhas de legenda
const SUBTITLE_MERGE_GAP_S = 1.0; // mescla se o intervalo for pequeno
const SUBTITLE_MIN_CUE_S = 0.5; // garante end > start

function cleanCueText(text) {
  let t = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "";
  t = t.replace(/\s+([,.;:!?])/g, "$1"); // espaço antes de pontuação
  t = t.replace(/([.,;:])([A-Za-zÀ-ÿ0-9])/g, "$1 $2"); // espaço após pontuação
  return t;
}

function capitalizeSentence(text) {
  const parts = text.match(/[^.!?]+[.!?]*/g);
  if (!parts) return text.charAt(0).toUpperCase() + text.slice(1);
  return parts
    .map((p) => {
      const t = p.trim();
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : p;
    })
    .join(" ");
}

async function postprocessSegments(rawSegments, cfg = {}) {
  const opts = cfg.postprocessing || {};
  const capitalize = opts.capitalize !== false;
  const canMerge = opts.segment !== false;

  let cues = [];
  for (const s of rawSegments || []) {
    if (!s || !Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
    const text = cleanCueText(s.text);
    if (!text) continue;
    let start = Math.max(0, Number(s.start));
    let end = Math.max(0, Number(s.end));
    if (end <= start) end = start + SUBTITLE_MIN_CUE_S;
    cues.push({ start, end, text });
  }

  if (canMerge && cues.length) {
    const merged = [];
    for (const cue of cues) {
      const last = merged[merged.length - 1];
      if (
        last &&
        cue.start - last.end <= SUBTITLE_MERGE_GAP_S &&
        (last.text + " " + cue.text).length <= SUBTITLE_CUE_MAX_CHARS
      ) {
        last.text = last.text + " " + cue.text;
        last.end = cue.end;
      } else {
        merged.push({ ...cue });
      }
    }
    cues = merged;
  }

  const split = [];
  for (const cue of cues) {
    const words = cue.text.split(/\s+/);
    if (words.length <= 14 && cue.text.length <= SUBTITLE_CUE_MAX_CHARS) {
      split.push(cue);
      continue;
    }
    const half = Math.max(1, Math.ceil(words.length / 2));
    const part1 = words.slice(0, half).join(" ");
    const part2 = words.slice(half).join(" ");
    const mid = (cue.start + cue.end) / 2;
    split.push({ ...cue, text: part1, end: mid });
    split.push({ ...cue, text: part2, start: mid });
  }

  return split
    .filter((c) => c.text.trim())
    .map((c, i) => {
      let start = Math.max(0, Number(c.start) || 0);
      let end = Math.max(0, Number(c.end) || 0);
      if (end <= start) end = start + SUBTITLE_MIN_CUE_S;
      const text = c.text.trim();
      return {
        id: "s" + (i + 1),
        start,
        end,
        text: capitalize ? capitalizeSentence(text) : text,
      };
    });
}

module.exports = {
  SUBTITLE_CUE_MAX_CHARS,
  SUBTITLE_MERGE_GAP_S,
  SUBTITLE_MIN_CUE_S,
  cleanCueText,
  capitalizeSentence,
  postprocessSegments,
};
