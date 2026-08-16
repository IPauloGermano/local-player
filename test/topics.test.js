// Testes estruturais da regra de TÓPICOS por MARCADOR EXPLÍCITO.
// Usa node:test + node:assert (stdlib) — nenhuma dependência nova.
// Monta fixtures em fs.mkdtemp e chama scanDir diretamente (o boot real do
// servidor — porta + data/ — é pulado pelo guard require.main === module).
//
// Regra (sem inferência estrutural):
//   SE existir arquivo ".topic" dentro da pasta           → type = "topic"
//   SENÃO SE o nome real da pasta terminar com "(TP)"     → type = "topic"
//   SENÃO                                                  → folder (curso/módulo normal)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scanDir, resolveSafeRelPath, normalizeDisplayTitle } = require("../server.js");

// Cria a árvore de diretórios e retorna o nó raiz escaneado por scanDir.
// Dotfiles (como ".topic" e o antigo ".courseplayer/course") são gravados
// vazios — como o usuário os criaria na prática.
async function scanFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lp-topics-"));
  for (const f of files) {
    const abs = path.join(root, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, path.basename(f).startsWith(".") ? "" : "x");
  }
  return { root, tree: await scanDir(root, "") };
}

function find(tree, targetPath) {
  if (!tree || !Array.isArray(tree.children)) return null;
  if (tree.path === targetPath) return tree;
  for (const c of tree.children) {
    const found = find(c, targetPath);
    if (found) return found;
  }
  return null;
}

// 1. Arquivo ".topic" dentro da pasta declara TÓPICO
test(".topic marca a pasta como tópico", async () => {
  const { tree } = await scanFixture([
    "TI/.topic",
    "TI/Python/x.txt",
    "TI/Redes/x.txt",
  ]);
  const ti = find(tree, "TI");
  assert.strictEqual(ti.type, "topic");
  assert.strictEqual(ti.name, "TI");
});

// 2. Nome real terminando em "(TP)" declara TÓPICO (com espaço)
test("nome com sufixo (TP) vira tópico", async () => {
  const { tree } = await scanFixture(["1 Linguas (TP)/Inglês/x.txt"]);
  const node = find(tree, "1 Linguas (TP)");
  assert.strictEqual(node.type, "topic");
  // "(TP)" e a numeração inicial removidos SÓ do título de exibição; o name
  // original permanece.
  assert.strictEqual(node.name, "1 Linguas (TP)");
  assert.strictEqual(node.title, "Linguas");
});

// 3. "(TP)" sem espaço também vale: "1 Linguas(TP)"
test("sufixo (TP) sem espaço vale", async () => {
  const { tree } = await scanFixture(["1 Linguas(TP)/Espanhol/x.txt"]);
  assert.strictEqual(find(tree, "1 Linguas(TP)").type, "topic");
});

// 4. "(tp)" minúsculo também vale (case-insensitive)
test("sufixo (TP) é case-insensitive", async () => {
  const { tree } = await scanFixture(["1 linguas (tp)/x/x.txt"]);
  assert.strictEqual(find(tree, "1 linguas (tp)").type, "topic");
});

// 5. "TP" sem parênteses NÃO é tópico
test("Projeto TP não é tópico (sem parênteses)", async () => {
  const { tree } = await scanFixture(["Projeto TP/x.txt"]);
  assert.strictEqual(find(tree, "Projeto TP").type, "folder");
});

// 6. "(TP)" no início NÃO vale (só no final)
test("(TP) Curso não é tópico (marcador no início)", async () => {
  const { tree } = await scanFixture(["(TP) Curso/Módulo 1/aula.mp4"]);
  const node = find(tree, "(TP) Curso");
  assert.strictEqual(node.type, "folder");
  assert.strictEqual(find(tree, "(TP) Curso/Módulo 1").type, "folder");
});

// 7. "TP" solto no meio/fim sem parênteses NÃO é tópico
test("Curso TP e Aula TP avançado não são tópicos", async () => {
  const { tree } = await scanFixture([
    "Curso TP/aula.mp4",
    "Aula TP avançado/aula.mp4",
  ]);
  assert.strictEqual(find(tree, "Curso TP").type, "folder");
  assert.strictEqual(find(tree, "Aula TP avançado").type, "folder");
});

// 8. Curso modular (conteúdo só em módulos, SEM marcador) NÃO é tópico
test("curso modular sem marcador é folder (não tópico)", async () => {
  const { tree } = await scanFixture(["Curso X/Módulo 1/aula.mp4"]);
  assert.strictEqual(find(tree, "Curso X").type, "folder");
  assert.strictEqual(find(tree, "Curso X/Módulo 1").type, "folder");
});

// 9. Curso com vídeo direto NÃO é tópico
test("curso com vídeo direto é folder (não tópico)", async () => {
  const { tree } = await scanFixture(["Curso Y/Aula 01.mp4"]);
  assert.strictEqual(find(tree, "Curso Y").type, "folder");
});

// 10. Tópicos aninhados (profundidade arbitrária) — ambos tópicos
test("tópicos aninhados (marcadores em níveis diferentes)", async () => {
  const { tree } = await scanFixture([
    "TI/.topic",
    "TI/Python/.topic",
    "TI/Python/Curso Django/aula.mp4",
  ]);
  assert.strictEqual(find(tree, "TI").type, "topic");
  assert.strictEqual(find(tree, "TI/Python").type, "topic");
  // Curso dentro do tópico mais profundo continua um curso normal.
  assert.strictEqual(find(tree, "TI/Python/Curso Django").type, "folder");
});

// 11. Curso dentro de tópico (top-level raiz com vídeo direto não é tópico)
test("curso dentro de tópico", async () => {
  const { tree } = await scanFixture([
    "TI/.topic",
    "TI/Curso Linux/aula.mp4",
  ]);
  assert.strictEqual(find(tree, "TI").type, "topic");
  assert.strictEqual(find(tree, "TI/Curso Linux").type, "folder");
});

// 12. O arquivo ".topic" é invisível: não vira material, nem filho, nem entra
// em contagens — e vídeos/materiais reais continuam presentes.
test(".topic não aparece na árvore nem nas contagens", async () => {
  const { tree } = await scanFixture([
    "TI/.topic",
    "TI/Python/x.txt",
  ]);
  const ti = find(tree, "TI");
  assert.ok(ti, "TI presente");
  assert.strictEqual(ti.children.length, 1, "só o filho real aparece");
  assert.strictEqual(ti.children[0].name, "Python");
  assert.strictEqual(
    ti.children.some((c) => c.name === ".topic"),
    false,
    "nenhum filho chamado .topic",
  );
  // Vídeos/materiais reais continuam sendo achados normalmente.
  const { tree: t2 } = await scanFixture([
    "TI/.topic",
    "TI/Curso Z/aula.mp4",
  ]);
  const curso = find(t2, "TI/Curso Z");
  assert.strictEqual(curso.type, "folder");
  assert.ok(curso.children.some((c) => c.type === "video"));
});

// 13. Marcador explícito VENCE o conteúdo direto: pasta com ".topic" E vídeo
// é tópico (o vídeo continua existindo como filho).
test(".topic vence conteúdo direto", async () => {
  const { tree } = await scanFixture(["Híbrido/.topic", "Híbrido/aula.mp4"]);
  const node = find(tree, "Híbrido");
  assert.strictEqual(node.type, "topic");
  assert.ok(node.children.some((c) => c.type === "video"));
});

// 14. Unicodes nos nomes não quebram a regra
test("nomes com unicode", async () => {
  const { tree } = await scanFixture([
    "Áudio ão (TP)/Curso Áudio ão/Übung 01.mp4",
  ]);
  assert.strictEqual(find(tree, "Áudio ão (TP)").type, "topic");
  assert.strictEqual(find(tree, "Áudio ão (TP)/Curso Áudio ão").type, "folder");
});

// 15. normalizeDisplayTitle remove "(TP)" do título de exibição de pastas
// (não-vídeo) e a numeração inicial ("1. Language" -> "Language", primeira
// letra maiúscula); vídeos não são afetados; "(TP)" fora do final não é
// removido.
test("normalizeDisplayTitle remove sufixo (TP) e numeração inicial", () => {
  assert.strictEqual(
    normalizeDisplayTitle("1 Linguas (TP)", { keepNumber: false }),
    "Linguas",
  );
  assert.strictEqual(
    normalizeDisplayTitle("1. Language", { keepNumber: false }),
    "Language",
  );
  assert.strictEqual(
    normalizeDisplayTitle("TI (TP)", { keepNumber: false }),
    "TI",
  );
  // Vídeo com "(TP)" não é afetado (classificação é só de pastas).
  assert.ok(
    normalizeDisplayTitle("intro (TP).mp4", { isVideo: true }).includes("tp"),
  );
  // "(TP)" fora do final não é removido do título.
  assert.ok(
    normalizeDisplayTitle("x (TP) y", { keepNumber: true }).includes("tp"),
  );
});

// 16. Path traversal bloqueado por resolveSafeRelPath: nada resolve para fora
// de ROOT. `..`/absolutos são normalizados para dentro de ROOT (seguro — o
// leading slash é descartado); sequências que escapam são rejeitadas.
test("path traversal rejeitado", () => {
  assert.strictEqual(resolveSafeRelPath("../../etc/passwd"), null);
  assert.strictEqual(resolveSafeRelPath("Curso/../../etc/passwd"), null);
  assert.strictEqual(resolveSafeRelPath("a/b/../../../../etc/passwd"), null);
  if (process.platform === "win32") {
    assert.strictEqual(resolveSafeRelPath("..\\..\\etc\\passwd"), null);
  }
  // Absoluto e relativo simples ficam DENTRO de ROOT (nunca vazam).
  const inside = resolveSafeRelPath("/etc/passwd");
  assert.ok(inside);
  assert.ok(resolveSafeRelPath("Curso/Aula.mp4"));
});

// Bônus: normalizeDisplayTitle segue exportado e estável
test("normalizeDisplayTitle exportado", () => {
  assert.strictEqual(typeof normalizeDisplayTitle, "function");
});
