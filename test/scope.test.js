// Testes do ESCOPO CONTEXTUAL de "Seu progresso" e "Continuar assistindo"
// (feature de Home/tópicos). node:test + node:assert (stdlib).
//
// Exercita as funções PURAS de public/scope.js (sem DOM): escopo por SEGMENTOS
// de path real, coleção de cursos por escopo (raiz = todos / tópico = subárvore),
// cursos diretos da raiz e "Continuar assistindo" (uma aula por curso, regras de
// progresso preservadas). A agregação do resumo "Seu progresso" roda sobre o
// conjunto devolvido por collectCoursesInScope — validar o conjunto valida o
// escopo. Rodar: node --test test/scope.test.js
const test = require("node:test");
const assert = require("node:assert");
const {
  isDescendantPath,
  flattenVideos,
  collectCoursesInScope,
  collectDirectCourses,
  buildContinueItems,
  getNodeProgressStats,
  getLibraryProgressSummary,
} = require("../public/scope.js");

// ---- Fixtures ---------------------------------------------------------------

// Espelha a regra do scan: curso = pasta "folder" cujo pai é a raiz ou um tópico
// (módulos = "folder" dentro de "folder"). Tópico = "topic".
const video = (path) => ({ type: "video", path });
const folder = (path, children = []) => ({ type: "folder", path, children });
const topic = (path, children = []) => ({ type: "topic", path, children });

function buildTree() {
  return {
    path: "",
    children: [
      topic("TI", [
        topic("TI/Programação", [
          topic("TI/Programação/Python", [
            folder("TI/Programação/Python/Curso Python", [
              video("TI/Programação/Python/Curso Python/Aula 01.mp4"),
              video("TI/Programação/Python/Curso Python/Aula 02.mp4"),
            ]),
          ]),
          topic("TI/Programação/Java", [
            folder("TI/Programação/Java/Curso Java", [
              video("TI/Programação/Java/Curso Java/Aula 01.mp4"),
            ]),
          ]),
        ]),
        topic("TI/Linux", [
          folder("TI/Linux/Curso Linux", [
            video("TI/Linux/Curso Linux/Aula 01.mp4"),
            video("TI/Linux/Curso Linux/Aula 02.mp4"),
          ]),
        ]),
      ]),
      topic("Design", [
        topic("Design/Photoshop", [
          folder("Design/Photoshop/Curso Photoshop", [
            video("Design/Photoshop/Curso Photoshop/Aula 01.mp4"),
          ]),
        ]),
      ]),
      folder("Curso Raiz", [video("Curso Raiz/Aula 01.mp4")]),
      folder("Curso Raiz2", [video("Curso Raiz2/Aula 01.mp4")]),
    ],
  };
}

function findNodeByPath(root, targetPath) {
  if (!root || !Array.isArray(root.children)) return null;
  if (root.path === targetPath) return root;
  for (const child of root.children) {
    const found = findNodeByPath(child, targetPath);
    if (found) return found;
  }
  return null;
}

// Progresso artificial (chave = path real da aula). Position/duration/completed/
// updatedAt — mesmas regras que o app preserva.
function progressFor(entries) {
  return (videoNode) => entries[videoNode.path] || null;
}

// Aulas com progresso dentro de um conjunto de cursos (flattenVideos + mapa).
function lessonsWithProgress(courses, progressMap) {
  const out = [];
  for (const c of courses) {
    for (const v of flattenVideos(c)) {
      if (progressMap[v.path]) out.push({ course: c, video: v });
    }
  }
  return out;
}

// ---- isDescendantPath (path REAL, por segmentos) -----------------------------

test("escopo: isDescendantPath separa por segmentos (TI ≠ TI2, Curso ≠ Curso2)", () => {
  // Descendentes verdadeiros.
  assert.strictEqual(isDescendantPath("TI/Aula.mp4", "TI"), true);
  assert.strictEqual(isDescendantPath("TI/Programação/Python/x.mp4", "TI"), true);
  assert.strictEqual(isDescendantPath("TI/Programação", "TI/Programação"), true);
  // Igual conta como dentro do próprio escopo.
  assert.strictEqual(isDescendantPath("TI/Programação", "TI/Programação"), true);
  // Boundary: prefixo sem delimitador não alcança.
  assert.strictEqual(isDescendantPath("TI2/Aula.mp4", "TI"), false);
  assert.strictEqual(isDescendantPath("TI2/Programação/x.mp4", "TI/Programação"), false);
  assert.strictEqual(isDescendantPath("Curso2/Aula.mp4", "Curso"), false);
  assert.strictEqual(isDescendantPath("TIJava/Aula.mp4", "TI"), false);
  // Subpath em nível acima (candidato mais raso) não é descendente.
  assert.strictEqual(isDescendantPath("TI", "TI/Aula.mp4"), false);
});

// ---- collectCoursesInScope: escopo da raiz vs tópicos ------------------------

test("escopo: raiz = todos os cursos (inclui aninhados em tópicos); tópico = subárvore only", () => {
  const tree = buildTree();
  const paths = (nodes) => nodes.map((n) => n.path).sort();

  // Home (raiz): TODOS os cursos, em qualquer tópico/profundidade.
  assert.deepStrictEqual(paths(collectCoursesInScope(tree)), [
    "Curso Raiz",
    "Curso Raiz2",
    "Design/Photoshop/Curso Photoshop",
    "TI/Linux/Curso Linux",
    "TI/Programação/Java/Curso Java",
    "TI/Programação/Python/Curso Python",
  ]);

  // TI: só a subárvore de TI (nada de Design nem da raiz).
  assert.deepStrictEqual(paths(collectCoursesInScope(findNodeByPath(tree, "TI"))), [
    "TI/Linux/Curso Linux",
    "TI/Programação/Java/Curso Java",
    "TI/Programação/Python/Curso Python",
  ]);

  // TI/Programação (aninhado): só o que está abaixo de Programação.
  assert.deepStrictEqual(paths(collectCoursesInScope(findNodeByPath(tree, "TI/Programação"))), [
    "TI/Programação/Java/Curso Java",
    "TI/Programação/Python/Curso Python",
  ]);

  // TI/Programação/Python (folha): só Python.
  assert.deepStrictEqual(paths(collectCoursesInScope(findNodeByPath(tree, "TI/Programação/Python"))), [
    "TI/Programação/Python/Curso Python",
  ]);

  // Design: nada de TI nem da raiz.
  assert.deepStrictEqual(paths(collectCoursesInScope(findNodeByPath(tree, "Design"))), [
    "Design/Photoshop/Curso Photoshop",
  ]);

  // Escopo inexistente → vazio, sem exceção.
  assert.deepStrictEqual(collectCoursesInScope(null), []);
  assert.deepStrictEqual(collectCoursesInScope(findNodeByPath(tree, "Não/Existe")), []);
});

test("escopo: cursos diretos da Home excluem tópicos; e tópico não muda isso", () => {
  const tree = buildTree();
  const direct = collectDirectCourses(tree);
  // Só os filhos "folder" da raiz — "Curso Raiz" e "Curso Raiz2"; nada de TI/Design.
  assert.deepStrictEqual(direct.map((n) => n.path).sort(), ["Curso Raiz", "Curso Raiz2"]);
  // Sem cursos diretos → lista vazia (a Home oculta o bloco nesse caso).
  const onlyTopics = { path: "", children: [topic("TI", []), topic("Design", [])] };
  assert.deepStrictEqual(collectDirectCourses(onlyTopics), []);
});

test("escopo: nomes parecidos não são confundidos (Curso X vs Curso X2 em escopos)", () => {
  const tree = {
    path: "",
    children: [
      topic("TI", [folder("TI/Curso X", [video("TI/Curso X/Aula.mp4")])]),
      folder("Curso X", [video("Curso X/Aula.mp4")]),
      folder("Curso X2", [video("Curso X2/Aula.mp4")]),
    ],
  };
  const scopedTi = collectCoursesInScope(findNodeByPath(tree, "TI"));
  assert.deepStrictEqual(scopedTi.map((n) => n.path), ["TI/Curso X"]);
  // Tópicos de mesmo nome em paths diferentes (item 11): escopos independentes.
  const twoTrees = {
    path: "",
    children: [
      topic("A/Python", [folder("A/Python/Curso 1", [video("A/Python/Curso 1/a.mp4")])]),
      topic("B/Python", [folder("B/Python/Curso 2", [video("B/Python/Curso 2/a.mp4")])]),
    ],
  };
  assert.deepStrictEqual(
    collectCoursesInScope(findNodeByPath(twoTrees, "A/Python")).map((n) => n.path),
    ["A/Python/Curso 1"],
  );
  assert.deepStrictEqual(
    collectCoursesInScope(findNodeByPath(twoTrees, "B/Python")).map((n) => n.path),
    ["B/Python/Curso 2"],
  );
});

test("escopo: módulos (pasta dentro de curso) ficam fora da coleção", () => {
  const tree = {
    path: "",
    children: [
      folder("Curso", [
        folder("Curso/Módulo 1", [video("Curso/Módulo 1/Aula 01.mp4")]),
      ]),
    ],
  };
  // "Curso" é o único curso; "Curso/Módulo 1" é módulo (não conta como curso).
  assert.deepStrictEqual(collectCoursesInScope(tree).map((n) => n.path), ["Curso"]);
});

// ---- buildContinueItems: regras preservadas ---------------------------------

test("continue: Home é GLOBAL (cursos de qualquer tópico); regras <=5s, concluído e 1 por curso", () => {
  const tree = buildTree();
  const progress = {
    "TI/Programação/Python/Curso Python/Aula 01.mp4": { position: 100, duration: 300, completed: false, updatedAt: 30 },
    "TI/Programação/Python/Curso Python/Aula 02.mp4": { position: 200, duration: 300, completed: false, updatedAt: 40 },
    "TI/Linux/Curso Linux/Aula 01.mp4": { position: 4, duration: 200, completed: false, updatedAt: 50 }, // <=5s → fora
    "TI/Programação/Java/Curso Java/Aula 01.mp4": { position: 50, duration: 200, completed: true, updatedAt: 60 }, // concluída → fora
    "Design/Photoshop/Curso Photoshop/Aula 01.mp4": { position: 80, duration: 200, completed: false, updatedAt: 70 },
    "Curso Raiz/Aula 01.mp4": { position: 20, duration: 200, completed: false, updatedAt: 10 },
  };
  // Home: raiz como escopo → qualquer curso em qualquer tópico aparece.
  const global = buildContinueItems(collectCoursesInScope(tree), progressFor(progress));
  const globalCourses = global.map((i) => i.course.path);
  // Python entra 1 vez (aula mais recente: Aula 02), Design e Curso Raiz também.
  assert.ok(globalCourses.includes("TI/Programação/Python/Curso Python"));
  assert.ok(globalCourses.includes("Design/Photoshop/Curso Photoshop"));
  assert.ok(globalCourses.includes("Curso Raiz"));
  const py = global.find((i) => i.course.path === "TI/Programação/Python/Curso Python");
  assert.strictEqual(py.video.path, "TI/Programação/Python/Curso Python/Aula 02.mp4");
  // Linux (<=5s) e Java (concluído) NÃO aparecem.
  assert.ok(!globalCourses.includes("TI/Linux/Curso Linux"));
  assert.ok(!globalCourses.includes("TI/Programação/Java/Curso Java"));
  // Ordenação por updatedAt desc.
  assert.deepStrictEqual(global.map((i) => i.progress.updatedAt), [70, 40, 10]);
});

test("continue: dentro de tópico é FILTRADO (só subárvore); aninhado refina", () => {
  const tree = buildTree();
  const progress = {
    "TI/Programação/Python/Curso Python/Aula 01.mp4": { position: 100, duration: 300, completed: false, updatedAt: 30 },
    "TI/Linux/Curso Linux/Aula 01.mp4": { position: 60, duration: 200, completed: false, updatedAt: 50 },
    "Design/Photoshop/Curso Photoshop/Aula 01.mp4": { position: 80, duration: 200, completed: false, updatedAt: 70 },
    "Curso Raiz/Aula 01.mp4": { position: 20, duration: 200, completed: false, updatedAt: 10 },
  };
  const inTi = buildContinueItems(collectCoursesInScope(findNodeByPath(tree, "TI")), progressFor(progress));
  const tiCourses = inTi.map((i) => i.course.path).sort();
  // Só cursos de TI — Photoshop e Curso Raiz ficam fora (global fica fora do tópico).
  assert.deepStrictEqual(tiCourses, ["TI/Linux/Curso Linux", "TI/Programação/Python/Curso Python"]);
  assert.ok(!tiCourses.includes("Design/Photoshop/Curso Photoshop"));
  assert.ok(!tiCourses.includes("Curso Raiz"));

  // Aninhado: TI/Programação → só Python (Linux está fora do sub-escopo).
  const inProg = buildContinueItems(collectCoursesInScope(findNodeByPath(tree, "TI/Programação")), progressFor(progress));
  assert.deepStrictEqual(inProg.map((i) => i.course.path), ["TI/Programação/Python/Curso Python"]);

  // Design → só Photoshop.
  const inDesign = buildContinueItems(collectCoursesInScope(findNodeByPath(tree, "Design")), progressFor(progress));
  assert.deepStrictEqual(inDesign.map((i) => i.course.path), ["Design/Photoshop/Curso Photoshop"]);
});

test("continue: limite de 8 itens e um por curso", () => {
  const progressMap = {};
  const children = [];
  for (let i = 0; i < 10; i++) {
    const coursePath = `Curso ${i}`;
    children.push(folder(coursePath, [video(`${coursePath}/Aula 01.mp4`)]));
    progressMap[`${coursePath}/Aula 01.mp4`] = { position: 10 + i, duration: 100, completed: false, updatedAt: i };
  }
  const tree = { path: "", children };
  const items = buildContinueItems(collectCoursesInScope(tree), progressFor(progressMap));
  assert.strictEqual(items.length, 8);
  // Ordenado por updatedAt desc (último curso = updatedAt mais alto vem primeiro).
  assert.strictEqual(items[0].course.path, "Curso 9");
});

// ---- "Seu progresso" filtrado (conjunto de cursos escopado) ------------------

test("progresso: filtrado por escopo — aulas de Design não contam dentro de TI", () => {
  const tree = buildTree();
  const progress = {
    "TI/Programação/Python/Curso Python/Aula 01.mp4": { position: 100, duration: 300, completed: true, updatedAt: 1 },
    "TI/Linux/Curso Linux/Aula 01.mp4": { position: 60, duration: 200, completed: false, updatedAt: 2 },
    "Design/Photoshop/Curso Photoshop/Aula 01.mp4": { position: 80, duration: 200, completed: false, updatedAt: 3 },
    "Curso Raiz/Aula 01.mp4": { position: 20, duration: 200, completed: false, updatedAt: 4 },
  };
  const scopedTi = lessonsWithProgress(collectCoursesInScope(findNodeByPath(tree, "TI")), progress);
  // Todas as aulas com progresso dentro de TI pertencem à subárvore de TI.
  assert.ok(scopedTi.every((x) => isDescendantPath(x.video.path, "TI")));
  assert.deepStrictEqual(
    scopedTi.map((x) => x.video.path).sort(),
    ["TI/Linux/Curso Linux/Aula 01.mp4", "TI/Programação/Python/Curso Python/Aula 01.mp4"],
  );
  // Conclusões e aulas em andamento contadas SÓ do escopo.
  assert.strictEqual(scopedTi.filter((x) => progress[x.video.path].completed).length, 1);
  assert.strictEqual(scopedTi.filter((x) => !progress[x.video.path].completed).length, 1);

  // Na Home (raiz), todos os cursos entram (global).
  const scopedHome = lessonsWithProgress(collectCoursesInScope(tree), progress);
  assert.strictEqual(scopedHome.length, 4);
});

// ---- Cenário da auditoria de exibição (progresso aninhado em tópicos) -------
// Progresso persistido com chave `libId\0rel` para uma aula DENTRO de tópicos
// hierárquicos (TI → Python → Curso X). A UI deve encontrar o progresso:
//   Home (global) → "Continuar assistindo" acha a aula;
//   TI → "Seu progresso" (subárvore) acha o curso;
//   Python → "Seu progresso" (subárvore aninhada) acha o curso.
// E, com o curso AUSENTE da árvore, o progresso NÃO é descartado (só deixa de
// ser exibido) — a persistência é a fonte de verdade.
test("escopo: progresso aninhado em tópicos (chave libId\\0rel) é encontrado pela Home (global) e pelos tópicos (subárvore)", () => {
  const LIB = "libA";
  const tree = {
    path: "",
    children: [
      topic("TI", [
        topic("TI/Python", [
          folder("TI/Python/Curso X", [
            video("TI/Python/Curso X/Módulo 1/Aula 01.mp4"),
          ]),
        ]),
      ]),
      folder("Curso Direto", [video("Curso Direto/Aula 01.mp4")]),
    ],
  };
  // annotateLibId (simulado): cada nó carrega o libId da biblioteca.
  const annotate = (n) => {
    n.libId = LIB;
    for (const c of n.children || []) annotate(c);
  };
  annotate(tree);
  // progFor: chave = `<libId>\0<rel>` (mesmo contrato do app/servidor).
  const progress = {
    [LIB + "\0TI/Python/Curso X/Módulo 1/Aula 01.mp4"]: { position: 100, duration: 300, completed: false, updatedAt: 10 },
    [LIB + "\0Curso Direto/Aula 01.mp4"]: { position: 200, duration: 300, completed: false, updatedAt: 20 },
  };
  const progFor = (v) => progress[LIB + "\0" + v.path] || null;

  // Home (raiz = GLOBAL): a aula aninhada entra em "Continuar assistindo".
  const homeContinue = buildContinueItems(collectCoursesInScope(tree), progFor);
  const nested = homeContinue.find((i) => i.course.path === "TI/Python/Curso X");
  assert.ok(nested, "Home (global) encontra o curso aninhado em tópico");
  assert.strictEqual(nested.video.path, "TI/Python/Curso X/Módulo 1/Aula 01.mp4");
  assert.ok(homeContinue.some((i) => i.course.path === "Curso Direto"), "curso direto também entra");

  // TI: subárvore → "Seu progresso"/continue só do escopo de TI.
  const tiCourses = collectCoursesInScope(findNodeByPath(tree, "TI")).map((n) => n.path);
  assert.deepStrictEqual(tiCourses, ["TI/Python/Curso X"]);
  const tiContinue = buildContinueItems(collectCoursesInScope(findNodeByPath(tree, "TI")), progFor);
  assert.strictEqual(tiContinue[0].course.path, "TI/Python/Curso X", "TI encontra o curso aninhado");

  // Python (tópico aninhado): idem.
  const pyCourses = collectCoursesInScope(findNodeByPath(tree, "TI/Python")).map((n) => n.path);
  assert.deepStrictEqual(pyCourses, ["TI/Python/Curso X"]);
  const pyContinue = buildContinueItems(collectCoursesInScope(findNodeByPath(tree, "TI/Python")), progFor);
  assert.strictEqual(pyContinue[0].course.path, "TI/Python/Curso X", "Python encontra o curso");

  // Curso AUSENTE da árvore: o progresso NÃO é descartado (persistência
  // intocada); apenas deixa de ser exibido até o conteúdo voltar.
  const withoutCourse = {
    path: "",
    children: [topic("TI", [topic("TI/Python", [])]), folder("Curso Direto", [video("Curso Direto/Aula 01.mp4")])],
  };
  annotate(withoutCourse);
  const globalContinue = buildContinueItems(collectCoursesInScope(withoutCourse), progFor);
  assert.ok(!globalContinue.some((i) => i.course.path === "TI/Python/Curso X"), "curso ausente não é exibido");
  assert.ok(progress[LIB + "\0TI/Python/Curso X/Módulo 1/Aula 01.mp4"], "progresso persistido permanece (fonte de verdade)");

  // Home com raiz SEM curso direto (só tópicos): "Seu progresso" não fica
  // invisível — cai para o escopo GLOBAL (fallback do renderHome).
  const onlyTopics = {
    path: "",
    children: [topic("TI", [topic("TI/Python", [folder("TI/Python/Curso X", [video("TI/Python/Curso X/Módulo 1/Aula 01.mp4")])])])],
  };
  annotate(onlyTopics);
  const direct = collectDirectCourses(onlyTopics);
  const progressScope = direct.length ? direct : collectCoursesInScope(onlyTopics);
  assert.strictEqual(direct.length, 0, "sem curso direto na raiz");
  assert.strictEqual(progressScope.length, 1, "fallback usa o escopo global (curso em tópico contado)");
  assert.strictEqual(progressScope[0].path, "TI/Python/Curso X");
});

// ---- "Seu progresso": agregação de tempo estudado (watchedSeconds) ----------
// getNodeProgressStats/getLibraryProgressSummary são PURAS (progressOf injetado).
// REGRESSÃO corrigida: aulas CONCLUÍDAS com `position` zerada (✓ manual no
// sidebar ou dados legados) contribuíam ZERO para o tempo estudado — 27 aulas
// concluídas podiam renderizar "11 segundos". Aula concluída deve contar a
// DURAÇÃO completa do registro de progresso.

test("progresso: tempo estudado conta a duração de aulas concluídas mesmo com position zerada", () => {
  const course = folder("Curso", [
    video("Curso/Aula 01.mp4"),
    video("Curso/Aula 02.mp4"),
    video("Curso/Aula 03.mp4"),
    video("Curso/Aula 04.mp4"),
  ]);
  const progress = {
    // Concluída via playback (position == duration) — registro bem-formado.
    "Curso/Aula 01.mp4": { position: 600, duration: 600, completed: true },
    // Concluída via ✓ manual / legado: position zerada, mas duração conhecida.
    "Curso/Aula 02.mp4": { position: 0, duration: 1323.05, completed: true },
    // Concluída sem nenhuma métrica de tempo (duration 0) → contribui 0.
    "Curso/Aula 03.mp4": { position: 0, duration: 0, completed: true },
    // Em andamento: conta a posição (limitada à duração).
    "Curso/Aula 04.mp4": { position: 120, duration: 600, completed: false },
  };
  const s = getNodeProgressStats(course, progressFor(progress));
  // 600 (A01) + 1323.05 (A02) + 0 (A03) + 120 (A04) = 2043.05.
  assert.ok(
    Math.abs(s.watchedSeconds - 2043.05) < 0.0001,
    `watchedSeconds=${s.watchedSeconds} deve ser 2043.05 (não só a posição da última)`,
  );
  assert.strictEqual(s.done, 3);
  assert.strictEqual(s.inProgress, 1);
  assert.strictEqual(s.total, 4);
  assert.strictEqual(s.pct, 75);
});

test("progresso: cenário do bug — 27 aulas concluídas com position zerada não viram poucos segundos", () => {
  const videos = [];
  const progress = {};
  for (let i = 1; i <= 27; i++) {
    const p = `Curso/Aula ${i}.mp4`;
    videos.push(video(p));
    progress[p] = { position: 0, duration: 300 + i, completed: true };
  }
  const course = folder("Curso", videos);
  const s = getNodeProgressStats(course, progressFor(progress));
  // Antes da correção, watchedSeconds era a soma das POSIÇÕES (todas 0) →
  // o frontend renderizaria "0s" apesar das 27 concluídas. Agora soma as durações.
  assert.ok(s.watchedSeconds > 27 * 300, `watchedSeconds=${s.watchedSeconds} deve somar as durações das 27 concluídas`);
  assert.strictEqual(s.done, 27);
});

test("progresso: sem progresso → zero; posição de em andamento limitada à duração", () => {
  const course = folder("Curso", [video("Curso/Aula 01.mp4")]);
  assert.strictEqual(getNodeProgressStats(course, () => null).watchedSeconds, 0);
  assert.strictEqual(getNodeProgressStats(course, progressFor({})).done, 0);

  const clamped = folder("Curso", [video("Curso/Aula 01.mp4")]);
  const over = getNodeProgressStats(
    clamped,
    progressFor({ "Curso/Aula 01.mp4": { position: 900, duration: 600, completed: false } }),
  );
  assert.strictEqual(over.watchedSeconds, 600, "posição acima da duração é limitada");

  const noDur = getNodeProgressStats(
    clamped,
    progressFor({ "Curso/Aula 01.mp4": { position: 30, duration: 0, completed: false } }),
  );
  assert.strictEqual(noDur.watchedSeconds, 30, "sem duração conta a posição");
});

test("progresso: agregação por escopo — startedCourses e isolamento entre cursos/tópicos", () => {
  const tree = buildTree();
  const progress = {
    "TI/Programação/Python/Curso Python/Aula 01.mp4": { position: 0, duration: 300, completed: true },
    "TI/Linux/Curso Linux/Aula 01.mp4": { position: 60, duration: 200, completed: false },
    "Design/Photoshop/Curso Photoshop/Aula 01.mp4": { position: 0, duration: 0, completed: true },
  };
  const scopedTi = getLibraryProgressSummary(
    collectCoursesInScope(findNodeByPath(tree, "TI")),
    progressFor(progress),
  );
  // Python concluída conta 300s; Linux em andamento conta 60s. Photoshop (Design) fica FORA do escopo TI.
  assert.strictEqual(scopedTi.doneLessons, 1);
  assert.strictEqual(scopedTi.inProgressLessons, 1);
  assert.strictEqual(scopedTi.startedCourses, 2);
  assert.strictEqual(scopedTi.watchedSeconds, 360);

  const global = getLibraryProgressSummary(collectCoursesInScope(tree), progressFor(progress));
  // Global inclui Design: 1 conclusão extra (pos=0, dur=0 → 0s de tempo).
  assert.strictEqual(global.doneLessons, 2);
  assert.strictEqual(global.startedCourses, 3);
  assert.strictEqual(global.watchedSeconds, 360);
});
