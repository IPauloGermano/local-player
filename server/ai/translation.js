// Tradução de Legendas via LLM (on-demand, por idioma)

const SUPPORTED_TARGET_LANGS = [
  "pt",
  "en",
  "es",
  "fr",
  "de",
  "it",
  "nl",
  "ja",
  "ko",
  "zh",
  "ru",
];

const TARGET_LANG_LABELS = {
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

function buildTranslatePrompt(sourceLang, targetLang, segments, customPrompt = "") {
  const srcLabel = TARGET_LANG_LABELS[sourceLang] || sourceLang || "idioma de origem";
  const tgtLabel = TARGET_LANG_LABELS[targetLang] || targetLang;
  const count = Array.isArray(segments) ? segments.length : 0;
  const payload = (Array.isArray(segments) ? segments : []).map((s) => ({
    id: String(s.id),
    text: typeof s.text === "string" ? s.text : "",
  }));

  const srcPart = sourceLang && targetLang && sourceLang !== targetLang ? ` do ${srcLabel}` : "";
  const customPart =
    customPrompt && typeof customPrompt === "string" && customPrompt.trim()
      ? `\nDIRETIVAS ADICIONAIS DO USUÁRIO:\n${customPrompt.trim()}\n`
      : "";

  return (
    `Você é um tradutor especializado em legendas para videoaulas e cursos técnicos.\n` +
    `Traduza os seguintes ${count} segmentos de legenda${srcPart} para o ${tgtLabel}.\n\n` +
    `REGRAS OBRIGATÓRIAS:\n` +
    `1. Responda ESTRITAMENTE com um array JSON no formato: [{"id": "s1", "text": "texto traduzido"}].\n` +
    `2. Mantenha correspondência 1:1 exata para cada ID recebido, na mesma ordem e sem omitir nenhum.\n` +
    `3. NÃO invente novos segmentos e NÃO remova nenhum segmento.\n` +
    `4. NÃO altere tempos ou IDs; mantenha rigorosamente cada "id" idêntico ao original.\n` +
    `5. Preserve nomes próprios, marcas, sintaxe de programação, nomes de bibliotecas, comandos de terminal e termos técnicos sem tradução inadequada.\n` +
    `6. Mantenha o texto natural, conciso e adequado à velocidade de leitura de legendas.\n` +
    `7. NÃO inclua nenhum texto, explicação ou bloco markdown antes ou depois do array JSON.\n` +
    customPart +
    `\n<segments_to_translate>\n` +
    JSON.stringify(payload) +
    `\n</segments_to_translate>`
  );
}

function sanitizeTranslationResult(raw, sourceSegments) {
  if (!Array.isArray(sourceSegments)) return [];
  if (!sourceSegments.length) return [];

  let list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    if (Array.isArray(raw.segments)) list = raw.segments;
    else if (Array.isArray(raw.translations)) list = raw.translations;
    else if (Array.isArray(raw.items)) list = raw.items;
    else if (Array.isArray(raw.data)) list = raw.data;
  }

  const byId = new Map();
  for (const item of list) {
    if (item && typeof item === "object" && item.id != null) {
      byId.set(String(item.id), item);
    }
  }

  return sourceSegments.map((srcSeg, idx) => {
    const segId = String(srcSeg.id);
    let item = byId.get(segId);
    if (!item && list[idx] && typeof list[idx] === "object") {
      item = list[idx];
    }

    let translatedText = "";
    if (item && typeof item.text === "string" && item.text.trim()) {
      translatedText = item.text.trim();
    } else {
      translatedText = typeof srcSeg.text === "string" ? srcSeg.text : "";
    }

    return {
      id: srcSeg.id,
      start: srcSeg.start,
      end: srcSeg.end,
      text: translatedText,
    };
  });
}

module.exports = {
  SUPPORTED_TARGET_LANGS,
  TARGET_LANG_LABELS,
  buildTranslatePrompt,
  sanitizeTranslationResult,
};
