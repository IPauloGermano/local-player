// Testes da SIDEBAR de aulas vs "Materiais da aula".
//
// Regra: a sidebar de navegação exibe APENAS módulos/pastas de navegação e
// vídeos/aulas. Arquivos/material (type "file") não aparecem como itens da
// sidebar — ficam exclusivamente na seção "Materiais da aula" (que segue
// filtrando `parentFolder.children` por `type === "file"` no frontend).
//
// A lista de navegação do player (`state.flatVideos` = `flattenVideos(course)`)
// já contém SOMENTE vídeos — é ela que dirige anterior/próxima/avanço automático
// pós-`ended`/retomada. Estes testes exercitam os predicados puros de
// `public/scope.js` que sustentam essa regra. Rodar:
//   node --test test/sidebar.test.js
const test = require("node:test");
const assert = require("node:assert");
const {
  isSidebarNavigableNode,
  flattenVideos,
  buildContinueItems,
} = require("../public/scope.js");

// ---- Fixtures ---------------------------------------------------------------
const video = (path) => ({ type: "video", path });
const folder = (path, children = []) => ({ type: "folder", path, children });
const file = (path) => ({ type: "file", path, name: path.split("/").pop() });

// Caso 1: Curso/Módulo/{Aula 01.mp4, Aula 01.pdf, Aula 01.zip}
function case1() {
  return folder("Curso", [
    folder("Curso/Módulo", [
      video("Curso/Módulo/Aula 01.mp4"),
      file("Curso/Módulo/Aula 01.pdf"),
      file("Curso/Módulo/Aula 01.zip"),
    ]),
  ]);
}

// Caso 2: {Aula 01.mp4, Aula 02.mp4, Aula 03.pdf, Aula 04.zip} na raiz do curso
function case2() {
  return folder("Curso", [
    video("Curso/Aula 01.mp4"),
    video("Curso/Aula 02.mp4"),
    file("Curso/Aula 03.pdf"),
    file("Curso/Aula 04.zip"),
  ]);
}

// ---- isSidebarNavigableNode -------------------------------------------------

test("sidebar: aceita só navegação (folder/topic/video) e rejeita material (file)", () => {
  assert.strictEqual(isSidebarNavigableNode({ type: "folder", path: "Módulo" }), true);
  assert.strictEqual(isSidebarNavigableNode({ type: "topic", path: "Tópico" }), true);
  assert.strictEqual(isSidebarNavigableNode({ type: "video", path: "Aula.mp4" }), true);
  // Arquivos de apoio (PDF/DOC/ZIP/XLS/PPT/TXT/imagens) NÃO navegam na sidebar.
  assert.strictEqual(isSidebarNavigableNode({ type: "file", path: "Aula.pdf" }), false);
  assert.strictEqual(isSidebarNavigableNode({ type: "file", path: "Exercícios.zip" }), false);
  assert.strictEqual(isSidebarNavigableNode({ type: "file", path: "imagem.png" }), false);
  assert.strictEqual(isSidebarNavigableNode(null), false);
  assert.strictEqual(isSidebarNavigableNode(undefined), false);
});

// ---- flattenVideos: a lista de navegação ignora materiais --------------------

test("sidebar: flattenVideos (lista do player) devolve só vídeos — PDF/ZIP ficam fora", () => {
  // Caso 1: Módulo com Aula 01.mp4 + pdf + zip → só o vídeo.
  const paths1 = flattenVideos(case1()).map((v) => v.path);
  assert.deepStrictEqual(paths1, ["Curso/Módulo/Aula 01.mp4"]);

  // Caso 2: 2 vídeos + 2 materiais na raiz → só os vídeos, na ordem.
  const paths2 = flattenVideos(case2()).map((v) => v.path);
  assert.deepStrictEqual(paths2, ["Curso/Aula 01.mp4", "Curso/Aula 02.mp4"]);
});

test("sidebar: próxima aula ignora materiais (Caso 3 e 4 — mesmo mecanismo)", () => {
  // "Próxima aula" = flatVideos[idx+1]. Com materiais no meio da listagem de
  // diretório, o próximo de Aula 01 é Aula 02, nunca o pdf.
  const flat = flattenVideos(case2());
  const idx = flat.findIndex((v) => v.path === "Curso/Aula 01.mp4");
  const next = flat[idx + 1];
  assert.strictEqual(next.path, "Curso/Aula 02.mp4");
  // Anterior de Aula 02 é Aula 01.
  const idx2 = flat.findIndex((v) => v.path === "Curso/Aula 02.mp4");
  assert.strictEqual(flat[idx2 - 1].path, "Curso/Aula 01.mp4");
  // ended → flatVideos[idx+1] também é Aula 02 (nunca material).
});

test("sidebar: material não vira aula nem item de progresso (Caso 5)", () => {
  const course = case2();
  // Progresso artificial gravado até para o path do pdf (defensivo: o servidor
  // pode receber o que for, mas o material nunca entra na navegação).
  const progress = {
    "Curso/Aula 01.mp4": { position: 60, duration: 300, completed: false, updatedAt: 2 },
    "Curso/Aula 03.pdf": { position: 50, duration: 300, completed: false, updatedAt: 99 },
  };
  const progOf = (v) => progress[v.path] || null;
  // Materiais não aparecem como item de "Continuar assistindo" nem contam:
  // só o vídeo entra (um por curso).
  const items = buildContinueItems([course], progOf);
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].video.path, "Curso/Aula 01.mp4");
});

// ---- Materiais continuam presentes na árvore (Caso 6) -----------------------

test("sidebar: materiais continuam na árvore para 'Materiais da aula'", () => {
  // A mudança é de APRESENTAÇÃO: o backend/nó mantém os arquivos. A seção
  // "Materiais da aula" continua achando-os no `children` da pasta da aula.
  const module = case1().children[0];
  const materials = module.children.filter((c) => c.type === "file").map((c) => c.path);
  assert.deepStrictEqual(materials, [
    "Curso/Módulo/Aula 01.pdf",
    "Curso/Módulo/Aula 01.zip",
  ]);
});
