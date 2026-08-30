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
  // por updatedAt desc, limitado a 8. `progressOf` é injetado (progFor no app;
  // mapa fixo nos testes) para manter a função pura.
  function buildContinueItems(courses, progressOf) {
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
    return items.slice(0, 8);
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
  // direto da Home, global, ou subárvore de um tópico).
  function getLibraryProgressSummary(courses, progressOf) {
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

    const pct = totalLessons ? Math.round((doneLessons / totalLessons) * 100) : 0;
    return {
      totalLessons,
      doneLessons,
      inProgressLessons,
      watchedSeconds,
      startedCourses,
      pct,
    };
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
  };
});
