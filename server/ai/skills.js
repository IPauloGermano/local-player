// Skills e Otimizadores de Contexto / Tokens (Caveman, RTK, Headroom, ADHD)

const TUTOR_TEXT_EXTS = new Set([
  ".txt", ".md", ".markdown", ".rst", ".json", ".js", ".mjs", ".cjs", ".ts",
  ".py", ".html", ".htm", ".css", ".sql", ".sh", ".bash", ".csv", ".tsv",
  ".java", ".c", ".cpp", ".h", ".hpp", ".cs", ".go", ".rs", ".php", ".rb",
  ".yaml", ".yml", ".xml", ".log", ".ini", ".env.example",
]);

// Skill 1: Caveman (juliusbrussee/caveman) — Redução drástica de tokens e concisão
function applyCavemanDirectives(systemPrompt, cavemanCfg) {
  if (!systemPrompt || !cavemanCfg || !cavemanCfg.enabled) return systemPrompt;
  let directive = "";

  if (cavemanCfg.mode === "caveman") {
    directive =
      "\n\n[DIRETIVA SKILL CAVEMAN ATIVA]:\n" +
      "- Fale em estilo direto, econômico e ultra-conciso (estilo caveman inteligente).\n" +
      "- Corte saudações, introduções, transições e cortesias desnecessárias. Responda direto ao ponto.\n" +
      "- ECONOMIA MÁXIMA DE TOKENS: elimine palavras supérfluas sem perder a essência do raciocínio didático.\n";
  } else if (cavemanCfg.mode === "concise") {
    directive =
      "\n\n[DIRETIVA SKILL MODO CONCISO ATIVA]:\n" +
      "- Seja altamente conciso, estruturado em tópicos objetivos e sem preâmbulos.\n" +
      "- Forneça respostas diretas e focadas na dúvida do aluno, economizando tokens.\n";
  } else if (cavemanCfg.mode === "custom" && cavemanCfg.customInstructions) {
    directive = `\n\n[DIRETIVA SKILL CAVEMAN CUSTOMIZADA]:\n${cavemanCfg.customInstructions.trim()}\n`;
  }

  if (cavemanCfg.preserveCode !== false) {
    directive += "- CÓDIGOS, COMANDOS E TERMOS TÉCNICOS DEVEM SER MANTIDOS 100% EXATOS, COMPLETOS E FUNCIONAIS.\n";
  }

  return systemPrompt + directive;
}

// Skill 2: RTK (rtk-ai/rtk) — Rust Token Killer / Filtragem de ruídos e logs em materiais
function applyRtkMaterialFiltering(text, ext, rtkCfg) {
  if (!text || !rtkCfg || !rtkCfg.enabled) return text;
  let lines = text.split(/\r?\n/);

  // 1. Remove separadores e divisores repetitivos em excesso
  if (rtkCfg.stripBoilerplate !== false) {
    const cleaned = [];
    let lastWasSep = false;
    for (const l of lines) {
      const isSep = /^[\s=\-_*~#]{5,}$/.test(l.trim());
      if (isSep) {
        if (!lastWasSep) cleaned.push(l);
        lastWasSep = true;
      } else {
        lastWasSep = false;
        cleaned.push(l);
      }
    }
    lines = cleaned;
  }

  // 2. Filtra ruídos de logs verbosos e stack traces repetitivos
  if (rtkCfg.filterLogs !== false && (ext === ".log" || ext === ".txt" || lines.length > 50)) {
    const filtered = [];
    let consecutiveNpmLog = 0;
    for (const l of lines) {
      const isVerboseLog = /^(npm (info|http|timing)|pip (debug|info)|downloading|extracting|\s+at\s+[\w\d_$./\\-]+:\d+:\d+)/i.test(l.trim());
      if (isVerboseLog) {
        consecutiveNpmLog++;
        if (consecutiveNpmLog <= 3) filtered.push(l);
        else if (consecutiveNpmLog === 4) filtered.push("... [RTK: logs repetitivos suprimidos] ...");
      } else {
        consecutiveNpmLog = 0;
        filtered.push(l);
      }
    }
    lines = filtered;
  }

  // 3. Limita o número de linhas por trecho de material preservando início e fim
  const maxLines = Number(rtkCfg.maxLinesPerSnippet) || 60;
  if (lines.length > maxLines) {
    const half = Math.floor(maxLines / 2);
    lines = [
      ...lines.slice(0, half),
      `... [RTK: ${lines.length - maxLines} linhas intermediárias suprimidas para economia de tokens] ...`,
      ...lines.slice(lines.length - half),
    ];
  }

  return lines.join("\n");
}

// Skill 3: Headroom (headroomlabs-ai/headroom) — Compressão de contexto e alinhamento de cache
function applyHeadroomContextCompression(text, ext, headroomCfg) {
  if (!text || !headroomCfg || !headroomCfg.enabled) return text;
  let result = text;

  // 1. SmartCrusher para JSON (minifica dados estruturados)
  if (headroomCfg.compressJson !== false && ext === ".json") {
    try {
      const parsed = JSON.parse(text);
      result = JSON.stringify(parsed);
    } catch {}
  }

  // 2. CodeCompressor (remove linhas em branco excessivas e trailing spaces)
  if (headroomCfg.compressCode !== false && TUTOR_TEXT_EXTS.has(ext) && ext !== ".md" && ext !== ".txt") {
    result = result
      .replace(/[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n");
  }

  return result;
}

// Skill 4: ADHD (ayghri/i-have-adhd, MIT) — Formato de resposta acionável.
// Não mexe no conteúdo didático: molda a APRESENTAÇÃO (ação primeiro,
// passos numerados, próximo passo concreto, sem preâmbulo/fechos).
function applyAdhdDirectives(systemPrompt, adhdCfg) {
  if (!systemPrompt || !adhdCfg || !adhdCfg.enabled) return systemPrompt;
  const directive =
    "\n\n[DIRETIVA SKILL ADHD ATIVA — formato de resposta acionável]:\n" +
    "- Comece pela resposta ou próxima ação (comando, caminho ou trecho essencial primeiro).\n" +
    "- Trabalhos com vários passos: numere, uma ação delimitada por passo.\n" +
    "- Termine com UM próximo passo concreto executável em menos de dois minutos.\n" +
    "- Suprima tangentes; resolva o assunto atual antes de levantar outro.\n" +
    "- Estimativas de tempo sempre em unidades concretas (minutos), nunca 'rapidinho'.\n" +
    "- Erros: informe local, causa e correção de forma objetiva, sem drama.\n" +
    "- Listas com no máximo 5 itens.\n" +
    "- Sem preâmbulo ('Ótima pergunta!'), sem recapitulação e sem fechos ('Espero ter ajudado').\n";
  return systemPrompt + directive;
}

module.exports = {
  TUTOR_TEXT_EXTS,
  applyCavemanDirectives,
  applyRtkMaterialFiltering,
  applyHeadroomContextCompression,
  applyAdhdDirectives,
};
