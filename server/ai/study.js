// Geradores de Estudo: Quizzes e Flashcards por IA

function extractAndParseJson(rawText) {
  if (typeof rawText !== "string") return null;
  let text = rawText.trim();

  // Remove blocos de markdown ```json ... ``` ou ``` ... ```
  const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (mdMatch) {
    text = mdMatch[1].trim();
  }

  // Tenta parse direto
  try {
    return JSON.parse(text);
  } catch (_) {}

  // Localiza delimitadores de objeto {...}
  const startObj = text.indexOf("{");
  const endObj = text.lastIndexOf("}");
  if (startObj !== -1 && endObj > startObj) {
    try {
      return JSON.parse(text.slice(startObj, endObj + 1));
    } catch (_) {}
  }

  // Localiza delimitadores de array [...]
  const startArr = text.indexOf("[");
  const endArr = text.lastIndexOf("]");
  if (startArr !== -1 && endArr > startArr) {
    try {
      return JSON.parse(text.slice(startArr, endArr + 1));
    } catch (_) {}
  }

  return null;
}

function buildQuizPrompt(context, count = 5, skillsCfg = null) {
  const num = Number(count);
  const qCount = Math.max(1, Math.min(15, isNaN(num) ? 5 : num));
  let prompt =
    `Você é um gerador especializado em criar Quizzes de múltipla escolha para fixação e avaliação de aprendizado.\n` +
    `Crie exatamente ${qCount} questões de múltipla escolha baseadas EXCLUSIVAMENTE no conteúdo da aula fornecido no contexto.\n\n` +
    `REGRAS DE CONTEÚDO:\n` +
    `1. Cada questão deve testar a compreensão de conceitos importantes, comandos, sintaxe ou lógica ensinada na aula.\n` +
    `2. Cada questão deve ter EXATAMENTE 4 opções de resposta plausíveis, sendo apenas 1 correta.\n` +
    `3. O campo 'correctIndex' deve ser um número inteiro de 0 a 3 indicando a posição da alternativa correta no array 'options'.\n` +
    `4. O campo 'explanation' deve explicar de forma clara e didática por que a alternativa correta é a certa e por que as outras estão incorretas.\n` +
    `5. NÃO invente informações fora do contexto da aula.\n\n` +
    `FORMATO DE RESPOSTA OBRIGATÓRIO (RESPONDA ESTRITAMENTE EM JSON VÁLIDO SEM NENHUM TEXTO ANTES OU DEPOIS):\n` +
    `{\n` +
    `  "title": "Quiz da Aula",\n` +
    `  "questions": [\n` +
    `    {\n` +
    `      "id": 1,\n` +
    `      "question": "Texto claro e direto da pergunta?",\n` +
    `      "options": ["Opção A", "Opção B", "Opção C", "Opção D"],\n` +
    `      "correctIndex": 0,\n` +
    `      "explanation": "Explicação detalhada da resposta correta."\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  if (skillsCfg?.caveman?.enabled && skillsCfg?.caveman?.applyToTutor !== false) {
    prompt += `\n\nDIRETIVA CAVEMAN: Seja ultra-direto e conciso nas perguntas e explicações, mantendo comandos e termos técnicos exatos.`;
  }

  return `${prompt}\n\n<untrusted_lesson_context>\n${context}\n</untrusted_lesson_context>`;
}

function buildFlashcardsPrompt(context, count = 8, skillsCfg = null) {
  const num = Number(count);
  const cCount = Math.max(1, Math.min(20, isNaN(num) ? 8 : num));
  let prompt =
    `Você é um gerador especializado em criar Flashcards didáticos e objetivos para memorização ativa e revisão espaçada.\n` +
    `Crie exatamente ${cCount} flashcards baseados EXCLUSIVAMENTE no conteúdo da aula fornecido no contexto.\n\n` +
    `REGRAS DE CONTEÚDO:\n` +
    `1. 'front': Deve ser uma pergunta direta, conceito-chave, problema ou termo que o aluno precisa recordar.\n` +
    `2. 'back': Deve ser a resposta clara, definição, código de exemplo ou explicação concisa do conceito.\n` +
    `3. 'tag': Categoria curta do cartão (ex: "Conceito", "Sintaxe", "Comando", "Prática", "Boas Práticas").\n` +
    `4. 'hint': Dica opcional ou mnemônica para auxiliar a recordação.\n` +
    `5. NÃO invente informações fora do contexto da aula.\n\n` +
    `FORMATO DE RESPOSTA OBRIGATÓRIO (RESPONDA ESTRITAMENTE EM JSON VÁLIDO SEM NENHUM TEXTO ANTES OU DEPOIS):\n` +
    `{\n` +
    `  "title": "Flashcards da Aula",\n` +
    `  "cards": [\n` +
    `    {\n` +
    `      "id": 1,\n` +
    `      "front": "Pergunta ou conceito no anverso?",\n` +
    `      "back": "Explicação, definição ou código no verso.",\n` +
    `      "tag": "Conceito",\n` +
    `      "hint": "Dica de recordação (opcional)"\n` +
    `    }\n` +
    `  ]\n` +
    `}`;

  if (skillsCfg?.caveman?.enabled && skillsCfg?.caveman?.applyToTutor !== false) {
    prompt += `\n\nDIRETIVA CAVEMAN: Mantenha as respostas dos flashcards ultra-objetivas e diretas.`;
  }

  return `${prompt}\n\n<untrusted_lesson_context>\n${context}\n</untrusted_lesson_context>`;
}

function sanitizeQuizResult(raw, maxCount = 15) {
  if (!raw || typeof raw !== "object") return null;
  const questionsRaw = Array.isArray(raw.questions) ? raw.questions : (Array.isArray(raw) ? raw : []);
  if (!questionsRaw.length) return null;

  const validQuestions = [];
  for (let i = 0; i < questionsRaw.length && validQuestions.length < maxCount; i++) {
    const q = questionsRaw[i];
    if (!q || typeof q !== "object") continue;
    const questionText = typeof q.question === "string" ? q.question.trim() : "";
    if (!questionText) continue;

    const options = Array.isArray(q.options)
      ? q.options.filter((o) => typeof o === "string" && o.trim().length > 0).map((o) => o.trim())
      : [];
    if (options.length < 2) continue;

    let correctIndex = Number.isInteger(q.correctIndex) ? q.correctIndex : parseInt(q.correctIndex, 10);
    if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= options.length) {
      correctIndex = 0;
    }

    const explanation = typeof q.explanation === "string" ? q.explanation.trim() : "";

    validQuestions.push({
      id: validQuestions.length + 1,
      question: questionText,
      options,
      correctIndex,
      explanation: explanation || "A alternativa correta é a selecionada com base no conteúdo da aula.",
    });
  }

  if (!validQuestions.length) return null;

  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Quiz da Aula",
    questions: validQuestions,
  };
}

function sanitizeFlashcardsResult(raw, maxCount = 20) {
  if (!raw || typeof raw !== "object") return null;
  const cardsRaw = Array.isArray(raw.cards) ? raw.cards : (Array.isArray(raw) ? raw : []);
  if (!cardsRaw.length) return null;

  const validCards = [];
  for (let i = 0; i < cardsRaw.length && validCards.length < maxCount; i++) {
    const c = cardsRaw[i];
    if (!c || typeof c !== "object") continue;
    const front = typeof c.front === "string" ? c.front.trim() : "";
    const back = typeof c.back === "string" ? c.back.trim() : "";
    if (!front || !back) continue;

    const tag = typeof c.tag === "string" && c.tag.trim() ? c.tag.trim() : "Estudo";
    const hint = typeof c.hint === "string" ? c.hint.trim() : "";

    validCards.push({
      id: validCards.length + 1,
      front,
      back,
      tag,
      hint,
    });
  }

  if (!validCards.length) return null;

  return {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "Flashcards da Aula",
    cards: validCards,
  };
}

module.exports = {
  extractAndParseJson,
  buildQuizPrompt,
  buildFlashcardsPrompt,
  sanitizeQuizResult,
  sanitizeFlashcardsResult,
};
