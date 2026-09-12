// Escopo contextual de "Seu progresso" e "Continuar assistindo" (Home/tópicos)
// + predicados puros de navegação (sidebar de aulas).
//
// Funções PURAS de escopo/filtragem — sem DOM, sem estado, sem dependência de
// app.js. Compartilhadas entre Home e tópicos (nenhuma lógica duplicada) e
// testáveis em node (`require`). Carregado ANTES de app.js via <script> e
// exposto como `window.LocalPlayerScope`.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.LocalPlayerScope = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // O candidato está dentro do escopo do nó? Comparação por SEGMENTOS do path
  // REAL (nunca título): "TI/" não alcança "TI2/" nem "TIJava/...". O próprio
  // nó conta como dentro do próprio escopo.
  function isDescendantPath(candidate, scope) {
    if (candidate === scope) return true;
    const a = candidate.split("/");
    const b = scope.split("/");
    if (a.length <= b.length) return false;
    for (let i = 0; i < b.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Navegável na SIDEBAR de aulas? Só módulos/pastas de navegação e vídeos.
  // Arquivos/material (type "file") ficam de fora — aparecem apenas em
  // "Materiais da aula". Decisão por `type` (o scan já classifica), nunca por
  // extensão no frontend.
  function isSidebarNavigableNode(node) {
    return !!node && (node.type === "folder" || node.type === "topic" || node.type === "video");
  }

  // Todos os vídeos da subárvore do nó (desce em pastas E tópicos), recursivo.
  function flattenVideos(node, out) {
    out = out || [];
    if (node.type === "video") {
      out.push(node);
      return out;
    }
    if (node.type === "folder" || node.type === "topic") {
      for (const c of node.children || []) flattenVideos(c, out);
    }
    return out;
  }

  // Cursos no escopo de um nó (raiz da biblioteca ou tópico, profundidade
  // arbitrária): pastas do tipo "folder" cujo pai não é outra pasta de curso
  // (módulos de curso ficam de fora). Aplicada à raiz == TODOS os cursos;
  // a um tópico == somente a subárvore do tópico.
  function collectCoursesInScope(scopeNode) {
    const out = [];
    if (!scopeNode || !Array.isArray(scopeNode.children)) return out;
    const walk = (parent, parentType) => {
      for (const c of parent.children || []) {
        if (c.type === "folder") {
          if (parentType !== "folder") out.push(c);
          walk(c, c.type);
        } else if (c.type === "topic") {
          walk(c, c.type);
        }
      }
    };
    walk(scopeNode, "root");
    return out;
  }

  // Cursos DIRETOS da raiz de uma biblioteca (filhos "folder" da raiz). Usado
  // pela Home: "Seu progresso" só conta o que pertence diretamente à Home —
  // cursos dentro de tópicos ficam de fora deste bloco.
  function collectDirectCourses(tree) {
    return ((tree && tree.children) || []).filter((c) => c.type === "folder");
  }

  // "Continuar assistindo": no máximo uma aula por curso — a aula elegível com
  // updatedAt mais recente (agrupamento, não limite visual). Regras existentes
  // preservadas: aulas concluídas e com <=5s de progresso ficam fora. Ordenado
  // por updatedAt desc, limitado a `limit` (padrão 8 no PC; o app passa 4 no
  // mobile). `progressOf` é injetado (progFor no app; mapa fixo nos testes)
  // para manter a função pura.
  function buildContinueItems(courses, progressOf, limit = 8) {
    const items = [];
    for (const course of courses) {
      let best = null;
      for (const v of flattenVideos(course)) {
        const p = progressOf(v);
        if (!p || p.position <= 5 || p.completed) continue;
        if (!best || (p.updatedAt || 0) > (best.progress.updatedAt || 0)) {
          best = { course, video: v, progress: p };
        }
      }
      if (best) items.push(best);
    }
    items.sort((a, b) => (b.progress.updatedAt || 0) - (a.progress.updatedAt || 0));
    const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 8;
    return items.slice(0, n);
  }

  // Tempo efetivamente estudado de uma aula a partir do registro de progresso.
  // Aula CONCLUÍDA conta a duração inteira: registros concluídos podem ter
  // `position` zerado (✓ manual no sidebar, dados legados) e, nesse caso, a
  // posição subestima o tempo real de estudo. Aula em andamento conta a posição
  // atual, limitada à duração (posição nunca supera a duração). `progressOf` é
  // injetado (progFor no app; mapa fixo nos testes) para manter a função pura.
  function watchedSecondsOf(p) {
    const duration = Number(p.duration) || 0;
    const position = Number(p.position) || 0;
    if (p.completed) {
      return duration > 0 ? duration : Math.max(0, position);
    }
    return duration > 0
      ? Math.min(duration, Math.max(0, position))
      : Math.max(0, position);
  }

  // Estatísticas de progresso de uma subárvore (curso, tópico, raiz): total/
  // concluídas/em andamento, pct e o tempo estudado agregado (watchedSeconds).
  // Alimenta o card de curso, a sidebar e o resumo "Seu progresso".
  function getNodeProgressStats(node, progressOf) {
    const videos = flattenVideos(node, []);
    let done = 0;
    let inProgress = 0;
    let watchedSeconds = 0;

    for (const video of videos) {
      const p = progressOf(video);
      if (!p) continue;
      const played = watchedSecondsOf(p);
      watchedSeconds += played;
      if (p.completed) done += 1;
      else if (played > 5) inProgress += 1;
    }

    const total = videos.length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return { total, done, inProgress, watchedSeconds, pct };
  }

  // Resumo agregado de "Seu progresso" sobre um conjunto de cursos (escopo
  // direto da Home, global, ou subárvore de um tópico). `orphans` (opcional)
  // são registros de progresso de arquivos movidos/renomeados/removidos — sem
  // nó na árvore, mas com histórico real de estudo: entram em totais,
  // concluídas, tempo e pct (nunca em "cursos ativos", sem curso atribuível).
  // Registros zerados sem evidência de estudo ficam de fora.
  function getLibraryProgressSummary(courses, progressOf, orphans) {
    let totalLessons = 0;
    let doneLessons = 0;
    let inProgressLessons = 0;
    let watchedSeconds = 0;
    let startedCourses = 0;

    for (const course of courses) {
      const s = getNodeProgressStats(course, progressOf);
      totalLessons += s.total;
      doneLessons += s.done;
      inProgressLessons += s.inProgress;
      watchedSeconds += s.watchedSeconds;
      if (s.done > 0 || s.inProgress > 0) startedCourses += 1;
    }

    let orphanLessons = 0;
    for (const p of orphans || []) {
      if (!p || typeof p !== "object") continue;
      const played = watchedSecondsOf(p);
      if (!p.completed && played <= 0) continue;
      orphanLessons += 1;
      totalLessons += 1;
      watchedSeconds += played;
      if (p.completed) doneLessons += 1;
      else if (played > 5) inProgressLessons += 1;
    }

    const pct = totalLessons ? Math.round((doneLessons / totalLessons) * 100) : 0;
    return {
      totalLessons,
      doneLessons,
      inProgressLessons,
      watchedSeconds,
      startedCourses,
      orphanLessons,
      pct,
    };
  }

  // Registros de progresso "órfãos": com chave de biblioteca do escopo, mas
  // sem vídeo correspondente na árvore (pasta/arquivo renomeado, movido ou
  // removido). `videoKeys` tem as
  // chaves `<libId>\0<rel>` dos vídeos do escopo; `basePath` opcional restringe
  // aos órfãos de um tópico (comparação por segmentos, nunca prefixo cru).
  function collectOrphanRecords(progress, videoKeys, libIds, basePath) {
    const out = [];
    if (!progress || typeof progress !== "object") return out;
    const libs = new Set(Array.isArray(libIds) ? libIds : []);
    const keys = videoKeys instanceof Set ? videoKeys : new Set();
    const scope = typeof basePath === "string" ? basePath : "";
    for (const key of Object.keys(progress)) {
      const p = progress[key];
      if (!p || typeof p !== "object") continue;
      const sep = key.indexOf("\0");
      const libId = sep === -1 ? "default" : key.slice(0, sep);
      const rel = sep === -1 ? key : key.slice(sep + 1);
      if (!libs.has(libId)) continue;
      if (keys.has(key)) continue;
      if (scope && !(rel === scope || isDescendantPath(rel, scope))) continue;
      out.push(p);
    }
    return out;
  }

  // Busca um nó na árvore pelo seu caminho relativo.
  function findNodeByPath(root, targetPath) {
    if (!root) return null;
    if (root.path === targetPath) return root;
    if (!root.children) return null;
    for (const c of root.children) {
      const found = findNodeByPath(c, targetPath);
      if (found) return found;
    }
    return null;
  }

  // Busca a pasta pai de um nó na árvore.
  function findParentFolder(node, targetPath) {
    if (!node || !node.children) return null;
    for (const c of node.children) {
      if (c.path === targetPath) return node;
      if (c.children) {
        const found = findParentFolder(c, targetPath);
        if (found) return found;
      }
    }
    return null;
  }

  // Sanitização segura de URLs para links em Markdown (anti-XSS).
  function sanitizeLinkUrl(url) {
    if (typeof url !== "string") return "";
    const trimmed = url.trim();
    if (/^(?:https?:\/\/|mailto:|\/|#)/i.test(trimmed)) {
      return trimmed.replace(/[<>"']/g, (c) => {
        if (c === "<") return "&lt;";
        if (c === ">") return "&gt;";
        if (c === '"') return "&quot;";
        if (c === "'") return "&#39;";
        return c;
      });
    }
    return "";
  }

  // Sanitização de texto plano para prevenção de XSS.
  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Localiza a biblioteca KaTeX disponível no ambiente (Browser ou Node.js).
  function getKatex() {
    if (typeof katex !== "undefined" && katex && typeof katex.renderToString === "function") {
      return katex;
    }
    if (typeof globalThis !== "undefined" && globalThis.katex && typeof globalThis.katex.renderToString === "function") {
      return globalThis.katex;
    }
    if (typeof window !== "undefined" && window.katex && typeof window.katex.renderToString === "function") {
      return window.katex;
    }
    if (typeof require === "function") {
      try {
        const path = require("path");
        const k = require(path.join(__dirname, "vendor", "katex", "katex.min.js"));
        if (k && typeof k.renderToString === "function") return k;
      } catch {}
    }
    return null;
  }

  // Normaliza LaTeX para o KaTeX vendored (0.16.11): o KaTeX não suporta
  // separadores de coluna `@{...}` / `!{...}` no especificador do
  // `\begin{array}{...}` (ex.: `{r@{\quad}l}`, comum em contas armadas
  // geradas por LLMs) nem alinhamentos de posição `[t|b|c]` em array,
  // devolvendo `katex-error` com o fonte cru em vermelho ou bloco de código.
  // Mantém só o que o KaTeX entende (`l`, `c`, `r`, `|`, `:`); se nada
  // restar ou não for especificado, usa `c`. Converte também tabular -> array.
  // Idempotente e segura para chamar sempre antes de renderizar.
  function sanitizeLatexForKatex(latex) {
    if (typeof latex !== "string" || (!latex.includes("\\begin") && !latex.includes("\\end"))) return latex;
    let out = latex;
    // Converte ambiente tabular para array (KaTeX não implementa tabular nativo)
    out = out.replace(/\\begin\{tabular\}/g, "\\begin{array}").replace(/\\end\{tabular\}/g, "\\end{array}");

    return out.replace(/\\begin\{(array|alignedat|aligned)\}(?:\s*\[[^\]]*\])?(?:\s*\{([^{}]*(?:\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}[^{}]*)*)\})?/g, (match, env, spec) => {
      if (spec === undefined) {
        // Se \begin{array} foi emitido sem especificador de coluna {}, fornece {c} como padrão
        return env === "array" ? `\\begin{array}{c}` : `\\begin{${env}}`;
      }
      let s = String(spec);
      // Remove separadores @{...} (com múltiplos níveis de chaves aninhadas, ex.: @{\hspace{1cm}} ou @{\quad})
      s = s.replace(/@[ \t]*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g, "");
      // Remove separadores !{...} e modificadores >{...} <{...}
      s = s.replace(/[!><][ \t]*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g, "");
      // Remove colunas p{...}/m{...}/b{...} → trata como coluna centrada
      s = s.replace(/[pmb][ \t]*\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}/g, "c");
      // Expande *{n}{cols} → repete cols n vezes (ex.: *{2}{c} → cc)
      s = s.replace(/\*\s*\{(\d+)\}\s*\{([^{}]*)\}/g, (_, n, cols) => cols.repeat(Math.min(32, parseInt(n, 10) || 1)));
      // Mantém só alinhamentos que o KaTeX conhece (l, c, r, |, :)
      s = s.replace(/[^lcr|:]/g, "");
      if (!s) s = "c";
      return `\\begin{${env}}{${s}}`;
    });
  }

  // Converte formatos HH:MM:SS ou MM:SS em segundos (número).
  function parseTimestampToSeconds(ts) {
    if (!ts || typeof ts !== "string") return 0;
    const parts = ts.split(":").map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) {
      return parts[0] * 3600 + parts[1] * 60 + parts[2];
    }
    if (parts.length === 2) {
      return parts[0] * 60 + parts[1];
    }
    return 0;
  }

  // Extrai ID de 11 caracteres de URLs do YouTube (watch, youtu.be, embed)
  function extractYouTubeId(url) {
    if (!url || typeof url !== "string") return null;
    const trimmed = url.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
    const m = trimmed.match(/(?:youtube(?:-nocookie)?\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
    return m ? m[1] : null;
  }

  // Gera o HTML do card com player incorporado (embed) do YouTube
  function buildVideoEmbedCardHtml(opts) {
    const id = opts && opts.id;
    if (!id) return "";
    const rawUrl = opts.url || `https://www.youtube.com/watch?v=${id}`;
    const safeUrl = sanitizeLinkUrl(rawUrl) || `https://www.youtube.com/watch?v=${id}`;
    const rawTitle = opts.title || "Vídeo Recomendado";
    const cleanTitle = escapeHtml(rawTitle);
    const cleanTopic = escapeHtml(opts.topic || rawTitle);

    return (
      `<div class="tutor-video-card" data-video-id="${id}" data-video-url="${safeUrl}" data-topic="${cleanTopic}">` +
        `<div class="tutor-video-header">` +
          `<div class="tutor-video-badge">` +
            `<svg class="tutor-yt-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">` +
              `<path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>` +
            `</svg>` +
            `<span>Vídeo Recomendado</span>` +
          `</div>` +
          `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="tutor-video-external-btn" title="Abrir no YouTube">` +
            `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>` +
            `<span>Abrir</span>` +
          `</a>` +
        `</div>` +
        (cleanTitle ? `<div class="tutor-video-title">${cleanTitle}</div>` : "") +
        `<div class="tutor-video-player-wrap">` +
          `<iframe class="tutor-video-iframe" ` +
            `src="https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&rel=0&modestbranding=1" ` +
            `title="${cleanTitle}" ` +
            `frameborder="0" ` +
            `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" ` +
            `referrerpolicy="strict-origin-when-cross-origin" ` +
            `allowfullscreen ` +
            `loading="lazy"` +
          `></iframe>` +
        `</div>` +
        `<div class="tutor-video-footer">` +
          `<button type="button" class="tutor-video-alt-btn" data-video-alt="${id}" title="Buscar outro vídeo sobre este tema">` +
            `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>` +
            `<span>Buscar outro vídeo</span>` +
          `</button>` +
        `</div>` +
      `</div>`
    );
  }

  // Renderiza formatação inline (código, links, negrito, itálico).
  function renderInlineMarkdown(text) {
    if (!text || typeof text !== "string") return "";
    let out = text;
    out = out.replace(/`([^`\n]+)`/g, '<code class="tutor-inline-code">$1</code>');
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
      const safe = sanitizeLinkUrl(url);
      if (!safe) return label;
      const isYt = !!extractYouTubeId(url);
      const ytClass = isYt ? " tutor-link-video" : "";
      return `<a class="tutor-link${ytClass}" href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, prefix, url) => {
      const safe = sanitizeLinkUrl(url);
      if (!safe) return prefix + url;
      const isYt = !!extractYouTubeId(url);
      const ytClass = isYt ? " tutor-link-video" : "";
      return `${prefix}<a class="tutor-link${ytClass}" href="${safe}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    // Timestamps interativos (ex: 02:15, 1:23:45)
    out = out.replace(/(?<![a-zA-Z0-9\/=>:])\b((?:[0-9]{1,2}:)?[0-9]{1,2}:[0-9]{2})\b/g, (match) => {
      const secs = parseTimestampToSeconds(match);
      return `<button type="button" class="tutor-timestamp-btn" data-time="${secs}" title="Ir para este tempo">${match}</button>`;
    });

    out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(?<=^|[\s(])__([^_]+)__(?=[\s).,:;!?]|$)/g, "<strong>$1</strong>");
    out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    out = out.replace(/(?<=^|[\s(])_([^_]+)_(?=[\s).,:;!?]|$)/g, "<em>$1</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return out;
  }

  // Parser robusto de tabelas Markdown (GFM).
  function parseMarkdownTable(tableLines) {
    if (!Array.isArray(tableLines) || tableLines.length < 2) return null;
    const rawDelim = tableLines[1].trim();
    if (!/^\|?(\s*:?-{3,}:?\s*\|?)+\s*$/.test(rawDelim)) {
      return null;
    }

    const splitRow = (row) => {
      let r = row.trim();
      if (r.startsWith("|")) r = r.slice(1);
      if (r.endsWith("|")) r = r.slice(0, -1);
      return r.split("|").map((c) => c.trim());
    };

    const delimCells = splitRow(rawDelim);
    if (!delimCells.length) return null;

    const alignments = delimCells.map((c) => {
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      if (left && right) return "center";
      if (right) return "right";
      if (left) return "left";
      return "left";
    });

    const headerCells = splitRow(tableLines[0]);
    const headerHtml = headerCells
      .map((h, i) => {
        const align = alignments[i] || "left";
        return `<th style="text-align:${align}">${renderInlineMarkdown(h)}</th>`;
      })
      .join("");

    const bodyLines = tableLines.slice(2);
    const bodyRowsHtml = bodyLines
      .map((row) => {
        const cells = splitRow(row);
        const cellsHtml = cells
          .map((cell, i) => {
            const align = alignments[i] || "left";
            return `<td style="text-align:${align}">${renderInlineMarkdown(cell)}</td>`;
          })
          .join("");
        return `<tr>${cellsHtml}</tr>`;
      })
      .join("");

    return `<div class="tutor-table-wrap"><table class="tutor-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyRowsHtml}</tbody></table></div>`;
  }

  // Renderizador rico de Markdown com links clicáveis, tabelas, código e tipografia.
  function renderMarkdownToHtml(markdown) {
    if (!markdown || typeof markdown !== "string") return "";

    // 1. Isola blocos de código cercados (```) para preservar seu conteúdo cru
    const codeBlocks = [];
    let processed = markdown.replace(/```([a-zA-Z0-9_\-\.\+]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const placeholder = `\x00LPCODEBLOCK${codeBlocks.length}END\x00`;
      codeBlocks.push({ lang: (lang || "").trim() || "código", code: code.replace(/\n$/, "") });
      return placeholder;
    });

    // 1b. Isola fórmulas matemáticas LaTeX em bloco ($$...$$ e \[...\]) e inline ($...$ e \(...\))
    const mathItems = [];
    // Bloco: $$...$$
    processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (_, math) => {
      const placeholder = `\x00LPMATH${mathItems.length}END\x00`;
      mathItems.push({ block: true, content: math.trim() });
      return placeholder;
    });
    // Bloco: \[...\]
    processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_, math) => {
      const placeholder = `\x00LPMATH${mathItems.length}END\x00`;
      mathItems.push({ block: true, content: math.trim() });
      return placeholder;
    });
    // Inline: \(...\) (multilinha: contas armadas em array quebram linha)
    processed = processed.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
      const placeholder = `\x00LPMATH${mathItems.length}END\x00`;
      mathItems.push({ block: false, content: math.trim() });
      return placeholder;
    });
    // Inline: $...$ (com proteção anti-espaço no início e fim)
    processed = processed.replace(/(?<!\\)\$(?!\s)([^\$\n]+?)(?<!\s)\$/g, (_, math) => {
      const placeholder = `\x00LPMATH${mathItems.length}END\x00`;
      mathItems.push({ block: false, content: math.trim() });
      return placeholder;
    });
    // Ambientes LaTeX nus (sem $$/\(\) — alguns LLMs emitem o \begin{array}
    // puro em contas armadas): envolve como bloco para não vazar fonte crua.
    // Roda DEPOIS das extrações acima, então o que já estava delimitado virou
    // placeholder e não casa aqui (sem duplo-wrap).
    processed = processed.replace(/\\begin\{(array|tabular|matrix|bmatrix|pmatrix|vmatrix|Vmatrix|aligned|gathered|cases|split)\}[\s\S]*?\\end\{\1\}/g, (math) => {
      const placeholder = `\x00LPMATH${mathItems.length}END\x00`;
      mathItems.push({ block: true, content: math.trim() });
      return placeholder;
    });

    // 2. Isola código inline (`...`)
    const inlineCodes = [];
    processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
      const placeholder = `\x00LPINLINECODE${inlineCodes.length}END\x00`;
      inlineCodes.push(code);
      return placeholder;
    });

    // 3. Escapa HTML de todo o texto restante para prevenir XSS
    processed = String(processed)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

    // 4. Detecta e extrai tabelas em Markdown antes de processar links/inline
    const tables = [];
    const rawLines = processed.split("\n");
    const preTableLines = [];
    let inTable = false;
    let currentTableLines = [];

    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const isPipe = line.trim().includes("|");
      if (!inTable) {
        if (isPipe && i + 1 < rawLines.length && /^\|?(\s*:?-{3,}:?\s*\|?)+\s*$/.test(rawLines[i + 1].trim())) {
          inTable = true;
          currentTableLines = [line];
        } else {
          preTableLines.push(line);
        }
      } else {
        if (isPipe) {
          currentTableLines.push(line);
        } else {
          const tableHtml = parseMarkdownTable(currentTableLines);
          if (tableHtml) {
            const placeholder = `\x00LPTABLE${tables.length}END\x00`;
            tables.push(tableHtml);
            preTableLines.push(placeholder);
          } else {
            preTableLines.push(...currentTableLines);
          }
          inTable = false;
          currentTableLines = [];
          preTableLines.push(line);
        }
      }
    }
    if (inTable && currentTableLines.length >= 2) {
      const tableHtml = parseMarkdownTable(currentTableLines);
      if (tableHtml) {
        const placeholder = `\x00LPTABLE${tables.length}END\x00`;
        tables.push(tableHtml);
        preTableLines.push(placeholder);
      } else {
        preTableLines.push(...currentTableLines);
      }
    }

    // 5. Lexer e Parser de blocos estruturados
    const blocks = [];
    let currentPara = [];
    let currentList = null; // { type: 'ul' | 'ol', items: [] }
    let currentQuote = [];
    const embeddedVideoIds = new Set();

    function attachVideoCards(rawText) {
      if (!rawText || typeof rawText !== "string") return;
      // 1. Links markdown: [Label](https://...)
      const mdRegex = /\[([^\]\n]+)\]\((https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:youtube\.com|youtu\.be)\/[^)\s]+)\)/gi;
      let m;
      while ((m = mdRegex.exec(rawText)) !== null) {
        const label = m[1];
        const url = m[2];
        const id = extractYouTubeId(url);
        if (id && !embeddedVideoIds.has(id)) {
          embeddedVideoIds.add(id);
          blocks.push(buildVideoEmbedCardHtml({ id, url, title: label, topic: label }));
        }
      }
      // 2. URLs soltas: https://...
      const rawRegex = /(?:^|[\s(])(https?:\/\/(?:[a-zA-Z0-9-]+\.)?(?:youtube\.com|youtu\.be)\/[^\s<)]+)/gi;
      while ((m = rawRegex.exec(rawText)) !== null) {
        const url = m[1];
        const id = extractYouTubeId(url);
        if (id && !embeddedVideoIds.has(id)) {
          embeddedVideoIds.add(id);
          blocks.push(buildVideoEmbedCardHtml({ id, url, title: "Vídeo Recomendado", topic: "Vídeo" }));
        }
      }
    }

    function flushPara() {
      if (currentPara.length) {
        const text = currentPara.map(renderInlineMarkdown).join("<br>");
        blocks.push(`<p class="tutor-p">${text}</p>`);
        for (const rawLine of currentPara) {
          attachVideoCards(rawLine);
        }
        currentPara = [];
      }
    }

    function flushList() {
      if (currentList && currentList.items.length) {
        const tag = currentList.type === "ul" ? "ul" : "ol";
        const cls = currentList.type === "ul" ? "tutor-list" : "tutor-num-list";
        const itemCls = currentList.type === "ul" ? "tutor-list-item" : "tutor-num-item";
        const itemsHtml = currentList.items
          .map((it) => `<li class="${itemCls}${it.nested ? " tutor-list-nested" : ""}">${renderInlineMarkdown(it.text)}</li>`)
          .join("");
        blocks.push(`<${tag} class="${cls}">${itemsHtml}</${tag}>`);
        for (const it of currentList.items) {
          attachVideoCards(it.text);
        }
        currentList = null;
      }
    }

    function flushQuote() {
      if (currentQuote.length) {
        const text = currentQuote.map(renderInlineMarkdown).join("<br>");
        blocks.push(`<blockquote class="tutor-quote">${text}</blockquote>`);
        for (const rawLine of currentQuote) {
          attachVideoCards(rawLine);
        }
        currentQuote = [];
      }
    }

    for (const line of preTableLines) {
      const trimmed = line.trim();

      // Linha vazia: encerra blocos abertos
      if (!trimmed) {
        flushPara();
        flushList();
        flushQuote();
        continue;
      }

      // Placeholders isolados (blocos de código, tabelas, matemática)
      if (/^\x00LP(CODEBLOCK|TABLE|MATH)\d+END\x00$/.test(trimmed)) {
        flushPara();
        flushList();
        flushQuote();
        blocks.push(trimmed);
        continue;
      }

      // Linhas horizontais (---, ***, ___)
      if (/^(?:---|___|\*\*\*)\s*$/.test(trimmed)) {
        flushPara();
        flushList();
        flushQuote();
        blocks.push('<hr class="tutor-hr">');
        continue;
      }

      // Cabeçalhos (# ... ####)
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        flushPara();
        flushList();
        flushQuote();
        const level = headingMatch[1].length;
        const hTag = level === 1 ? "h3" : level === 2 ? "h4" : level === 3 ? "h5" : "h6";
        const hClass = `tutor-heading tutor-${hTag}`;
        blocks.push(`<${hTag} class="${hClass}">${renderInlineMarkdown(headingMatch[2])}</${hTag}>`);
        continue;
      }

      // Citações / Blockquotes (> texto ou &gt; texto)
      const quoteMatch = line.match(/^(?:>|&gt;)\s*(.*)$/);
      if (quoteMatch) {
        flushPara();
        flushList();
        currentQuote.push(quoteMatch[1]);
        continue;
      } else if (currentQuote.length) {
        flushQuote();
      }

      // Listas não-ordenadas (* item, - item, + item)
      const ulMatch = line.match(/^(\s*)(?:[\*\-]|\+)\s+(.+)$/);
      if (ulMatch) {
        flushPara();
        if (currentList && currentList.type !== "ul") flushList();
        if (!currentList) currentList = { type: "ul", items: [] };
        const indent = ulMatch[1].length;
        currentList.items.push({ text: ulMatch[2], nested: indent >= 2 });
        continue;
      }

      // Listas numeradas (1. item, 2) item)
      const olMatch = line.match(/^(\s*)\d+[\.\)]\s+(.+)$/);
      if (olMatch) {
        flushPara();
        if (currentList && currentList.type !== "ol") flushList();
        if (!currentList) currentList = { type: "ol", items: [] };
        const indent = olMatch[1].length;
        currentList.items.push({ text: olMatch[2], nested: indent >= 2 });
        continue;
      }

      // Se encontrou texto regular e havia uma lista aberta, fecha a lista
      flushList();

      // Texto de parágrafo regular
      currentPara.push(trimmed);
    }

    flushPara();
    flushList();
    flushQuote();

    let processedBlocks = blocks.join("\n");

    // 6. Restaura tabelas primeiro (assim células com código inline/matemática também são restauradas)
    processedBlocks = processedBlocks.replace(/\x00LPTABLE(\d+)END\x00/g, (_, idx) => {
      return tables[Number(idx)] || "";
    });

    // 7. Restaura código inline
    processedBlocks = processedBlocks.replace(/\x00LPINLINECODE(\d+)END\x00/g, (_, idx) => {
      const code = inlineCodes[Number(idx)] || "";
      const escaped = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return `<code class="tutor-inline-code">${escaped}</code>`;
    });

    // 8. Restaura fórmulas matemáticas (inline e bloco)
    const kLib = getKatex();
    processedBlocks = processedBlocks.replace(/\x00LPMATH(\d+)END\x00/g, (_, idx) => {
      const item = mathItems[Number(idx)];
      if (!item) return "";

      if (kLib && typeof kLib.renderToString === "function") {
        try {
          const source = sanitizeLatexForKatex(item.content);
          let rendered = kLib.renderToString(source, {
            displayMode: item.block,
            throwOnError: false,
            trust: false,
          });
          // Se mesmo sanitizado o KaTeX devolver erro (sintaxe inválida do
          // modelo), não exibe o fonte cru em vermelho: mostra como código.
          if (rendered.includes("katex-error")) {
            const safe = escapeHtml(item.content);
            return item.block
              ? `<div class="tutor-math-block"><code class="tutor-math">${safe}</code></div>`
              : `<code class="tutor-math tutor-math-inline">${safe}</code>`;
          }
          if (item.block) {
            return `<div class="tutor-math-block">${rendered}</div>`;
          }
          return rendered;
        } catch {
          // Fallback seguro caso a fórmula esteja incompleta durante o streaming
          const safe = escapeHtml(item.content);
          return item.block
            ? `<div class="tutor-math-block"><code class="tutor-math">${safe}</code></div>`
            : `<code class="tutor-math tutor-math-inline">${safe}</code>`;
        }
      }

      // Fallback sem KaTeX (ex: ambiente sem lib ou renderização textual pura)
      let math = escapeHtml(item.content)
        .replace(/\\rightarrow/g, "→")
        .replace(/\\leftarrow/g, "←")
        .replace(/\\Rightarrow/g, "⇒")
        .replace(/\\Leftarrow/g, "⇐")
        .replace(/\\leftrightarrow/g, "↔")
        .replace(/\\le\b|\\leq\b/g, "≤")
        .replace(/\\ge\b|\\geq\b/g, "≥")
        .replace(/\\ne\b|\\neq\b/g, "≠")
        .replace(/\\approx\b/g, "≈")
        .replace(/\\times\b/g, "×")
        .replace(/\\div\b/g, "÷")
        .replace(/\\pm\b/g, "±")
        .replace(/\\in\b/g, "∈")
        .replace(/\\infty\b/g, "∞");

      if (item.block) {
        return `<div class="tutor-math-block"><code class="tutor-math">${math}</code></div>`;
      }
      return `<code class="tutor-math tutor-math-inline">${math}</code>`;
    });

    // 9. Restaura blocos de código com botão de cópia rápida
    processedBlocks = processedBlocks.replace(/\x00LPCODEBLOCK(\d+)END\x00/g, (_, idx) => {
      const item = codeBlocks[Number(idx)];
      if (!item) return "";
      const cleanLang = item.lang
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const escapedCode = item.code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
      return `
        <div class="tutor-code-card">
          <div class="tutor-code-header">
            <span class="tutor-code-lang">${cleanLang}</span>
            <button type="button" class="tutor-code-copy-btn" title="Copiar código" aria-label="Copiar código">
              <svg class="tutor-copy-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              <span class="tutor-copy-text">Copiar</span>
            </button>
          </div>
          <pre class="tutor-code-content"><code>${escapedCode}</code></pre>
        </div>`;
    });

    return processedBlocks;
  }

  return {
    isDescendantPath,
    isSidebarNavigableNode,
    flattenVideos,
    collectCoursesInScope,
    collectDirectCourses,
    buildContinueItems,
    getNodeProgressStats,
    getLibraryProgressSummary,
    collectOrphanRecords,
    findNodeByPath,
    findParentFolder,
    sanitizeLinkUrl,
    parseMarkdownTable,
    parseTimestampToSeconds,
    renderMarkdownToHtml,
    extractYouTubeId,
    buildVideoEmbedCardHtml,
    escapeHtml,
    getKatex,
    sanitizeLatexForKatex,
  };
});
