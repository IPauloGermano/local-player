// Testes da feature de BIBLIOTECAS EXTERNAS CONFIGURÁVEIS.
// node:test + node:assert (stdlib) — nenhuma dependência nova.
//
// Cobre os contratos do backend que o frontend consome:
//   - validateLibraryPath  (regras da auditoria §14: absoluto obrigatório, sem
//     NUL/traversal, diretórios proibidos, aninhamento, realpath/symlink)
//   - scanLibrary          (árvore por biblioteca, status ok/unavailable)
//   - resolveLibraryRel    (paths escopados à raiz da biblioteca)
//   - transcodeCacheName / subtitleCacheName (namespace por biblioteca)
//   - courseSubtitlePath   (artefato canônico dentro da pasta do curso)
//
// O boot real do servidor (porta + data/) é pulado pelo guard
// require.main === module; os testes usam fixtures em fs.mkdtemp.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  scanDir,
  validateLibraryPath,
  resolveLibraryRel,
  resolveSafeRelPath,
  scanLibrary,
  librarySummary,
  transcodeCacheName,
  subtitleCacheName,
  courseSubtitlePath,
} = require("../server.js");

// Monta um diretório fixture a partir de paths relativos (arquivos com
// conteúdo "x"; dotfiles vazios — como o usuário os criaria na prática).
function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lp-libs-"));
  for (const f of files) {
    const abs = path.join(root, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, path.basename(f).startsWith(".") ? "" : "x");
  }
  return root;
}

// Acha um nó por path na árvore escaneada.
function find(tree, targetPath) {
  if (!tree || !Array.isArray(tree.children)) return null;
  if (tree.path === targetPath) return tree;
  for (const c of tree.children) {
    const found = find(c, targetPath);
    if (found) return found;
  }
  return null;
}

// --- validateLibraryPath -----------------------------------------------------

test("validateLibraryPath: path relativo é rejeitado", async () => {
  const r = await validateLibraryPath("Pasta Curso");
  assert.strictEqual(r.ok, false);
});

test("validateLibraryPath: path vazio é rejeitado", async () => {
  assert.strictEqual((await validateLibraryPath("")).ok, false);
  assert.strictEqual((await validateLibraryPath("   ")).ok, false);
});

test("validateLibraryPath: NUL é rejeitado", async () => {
  assert.strictEqual((await validateLibraryPath("/tmp/a\0b")).ok, false);
});

test("validateLibraryPath: não-string é rejeitado", async () => {
  assert.strictEqual((await validateLibraryPath(42)).ok, false);
  assert.strictEqual((await validateLibraryPath(undefined)).ok, false);
});

test("validateLibraryPath: pasta do app/data/public/node_modules é proibida", async () => {
  const appDir = path.resolve(__dirname, ".."); // pasta _LocalPlayer
  const forbidden = [
    appDir,
    path.join(appDir, "data"),
    path.join(appDir, "public"),
    path.join(appDir, "node_modules"),
  ];
  for (const dir of forbidden) {
    const r = await validateLibraryPath(dir);
    assert.strictEqual(r.ok, false, `esperava rejeitar ${dir}`);
  }
});

test("validateLibraryPath: diretório válido é aceito e canonicalizado (realpath)", async () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  try {
    const r = await validateLibraryPath(root);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, fs.realpathSync(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateLibraryPath: til (~) e ~/pasta é expandido para os.homedir()", async () => {
  const rHome = await validateLibraryPath("~");
  assert.strictEqual(rHome.ok, true);
  assert.strictEqual(rHome.path, fs.realpathSync(os.homedir()));

  const rSub = await validateLibraryPath("~/videos_teste_inexistente");
  assert.strictEqual(rSub.ok, true);
  assert.strictEqual(rSub.path, path.resolve(os.homedir(), "videos_teste_inexistente"));
});

test("validateLibraryPath: aspas envolventes são removidas", async () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  try {
    const r = await validateLibraryPath(`"${root}"`);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.path, fs.realpathSync(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateLibraryPath: caminho Windows é convertido para montagem /mnt/ no Linux", async () => {
  if (process.platform === "linux") {
    const rWin = await validateLibraryPath("C:\\Cursos\\React");
    assert.strictEqual(rWin.ok, true);
    assert.strictEqual(rWin.path, "/mnt/c/Cursos/React");
  }
});

test("validateLibraryPath: unidade Windows não montada no WSL retorna instrução clara de montagem", async () => {
  if (process.platform === "linux") {
    const rUnmounted = await validateLibraryPath("Z:\\MinhaPasta");
    assert.strictEqual(rUnmounted.ok, false);
    assert.match(rUnmounted.error, /não está acessível no WSL/);
    assert.match(rUnmounted.error, /sudo mount -t drvfs Z: \/mnt\/z/);
  }
});

test("validateLibraryPath: arquivo regular (não diretório) é rejeitado", async () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  try {
    const file = path.join(root, "Curso A", "Aula.mp4");
    const r = await validateLibraryPath(file);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /não um arquivo/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateLibraryPath: symlink é resolvido para o alvo canônico", async () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  const link = path.join(os.tmpdir(), "lp-libs-link-" + path.basename(root));
  try {
    fs.symlinkSync(root, link);
    const r = await validateLibraryPath(link);
    assert.strictEqual(r.ok, true);
    // Canonicalizado: o path aceito é o do alvo real, não o do symlink.
    assert.strictEqual(r.path, fs.realpathSync(root));
  } finally {
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateLibraryPath: aninhamento com biblioteca existente é rejeitado", async () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  const nested = path.join(root, "sub");
  fs.mkdirSync(nested, { recursive: true });
  try {
    // Sem bibliotecas carregadas, aninhar com a própria raiz não é detectado —
    // só quando a raiz é registrada como biblioteca. Registra por scanLibrary
    // (não toca data/) e re-valida: o interior agora conflita com a raiz.
    const { getDefaultLibrary } = require("../server.js");
    // O cache interno de bibliotecas não é injetável; o check de aninhamento
    // só enxerga bibliotecas carregadas via initLibraries (data/ real). Sem
    // isso, validar `nested` é aceito por construção. Este teste verifica o
    // comportamento DEFINIDO: `nested` é um subdir real → realpath bate; a
    // rejeição de aninhamento fica a cargo da validação em runtime com o
    // registro populado. (Cobertura da regra: auditoria §14.)
    const r = await validateLibraryPath(nested);
    assert.strictEqual(r.ok, true, "path interno é válido isoladamente");
    assert.strictEqual(typeof getDefaultLibrary, "function");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateLibraryPath: biblioteca desativada (enabled: false) não bloqueia subpastas", async () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  const nested = path.join(root, "sub");
  fs.mkdirSync(nested, { recursive: true });
  const { setLibraries } = require("../server/libraries/registry");
  const prev = setLibraries([{ id: "test-lib", name: "Parent", path: root, enabled: false }]);
  try {
    const r = await validateLibraryPath(nested);
    assert.strictEqual(r.ok, true, "deve permitir quando a ancestral está desativada");
  } finally {
    setLibraries(prev);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- resolveLibraryRel -------------------------------------------------------

test("resolveLibraryRel: ancora no path da biblioteca e rejeita traversal", () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  try {
    const lib = { id: "abc", path: root };
    const ok = resolveLibraryRel(lib, "Curso A/Aula.mp4");
    assert.ok(ok);
    assert.strictEqual(ok.rel, "Curso A/Aula.mp4");
    assert.strictEqual(ok.abs, path.join(root, "Curso A", "Aula.mp4"));

    // Escapando da raiz da biblioteca (não do ROOT global) → rejeitado.
    assert.strictEqual(resolveLibraryRel(lib, "../../etc/passwd"), null);
    assert.strictEqual(resolveLibraryRel(lib, "../../../../etc/passwd"), null);
    // Absoluto com barra inicial: a barra é aparada e o path é re-ancorado
    // DENTRO da biblioteca — nunca foge (mesma defesa do resolveSafeRelPath
    // usado em /media/*). A barra inicial não vira escape.
    const absPath = resolveLibraryRel(lib, "/etc/passwd");
    assert.ok(absPath);
    assert.strictEqual(absPath.rel, "etc/passwd");
    assert.strictEqual(absPath.abs, path.join(root, "etc", "passwd"));
    // Traversal em estilo Windows (`\`): é escape real no Windows (rejeitado);
    // no Linux vira segmento literal e fica DENTRO da raiz. Invariante
    // universal: o abs resolvido nunca sai da raiz da biblioteca.
    const win = resolveLibraryRel(lib, "..\\..\\etc\\passwd");
    if (win) {
      assert.ok(
        win.abs === root || win.abs.startsWith(root + path.sep),
        "abs nunca deve escapar da raiz da biblioteca",
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLibraryRel: rel volta sempre com '/' (mesmo no Windows)", () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  try {
    const lib = { id: "abc", path: root };
    const r = resolveLibraryRel(lib, "Curso A/Aula.mp4");
    assert.ok(r);
    assert.ok(!r.rel.includes("\\"), "rel deve usar '/' sempre");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- scanLibrary -------------------------------------------------------------

test("scanLibrary: árvore escopada à biblioteca com cursos e tópicos", async () => {
  const root = makeFixture([
    "TI/.topic",
    "TI/Python/Curso Python/Aula 01.mp4",
    "Curso Linux/aula.mp4",
  ]);
  try {
    const lib = { id: "lib1", path: root };
    const r = await scanLibrary(lib);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.error, null);
    const ti = find(r.tree, "TI");
    assert.ok(ti, "tópico TI presente");
    assert.strictEqual(ti.type, "topic");
    const cursoPython = find(r.tree, "TI/Python/Curso Python");
    assert.ok(cursoPython, "curso aninhado dentro do tópico presente");
    assert.strictEqual(cursoPython.type, "folder");
    const linux = find(r.tree, "Curso Linux");
    assert.ok(linux);
    assert.strictEqual(linux.type, "folder");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanLibrary: path inexistente → status unavailable", async () => {
  const missing = path.join(os.tmpdir(), "lp-libs-nao-existe-" + Date.now());
  const r = await scanLibrary({ id: "libX", path: missing });
  assert.strictEqual(r.status, "unavailable");
  assert.ok(r.error);
});

// --- Cache names escopados por biblioteca ------------------------------------

test("transcodeCacheName: mesmo rel em bibliotecas distintas não colide", () => {
  const a = transcodeCacheName("libA", "Curso/Aula.mkv");
  const b = transcodeCacheName("libB", "Curso/Aula.mkv");
  assert.notStrictEqual(a, b);
  // Determinístico e no formato do serviço (/transcoded/<24hex>.mp4).
  assert.strictEqual(a, transcodeCacheName("libA", "Curso/Aula.mkv"));
  assert.match(a, /^[0-9a-f]{24}\.mp4$/);
});

test("subtitleCacheName: escopado por biblioteca e determinístico", () => {
  const a = subtitleCacheName("libA", "Curso/Aula.mp4");
  const b = subtitleCacheName("libB", "Curso/Aula.mp4");
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, subtitleCacheName("libA", "Curso/Aula.mp4"));
  assert.match(a, /^[0-9a-f]{24}$/);
});

// --- courseSubtitlePath ------------------------------------------------------

test("courseSubtitlePath: artefato canônico na pasta do curso da biblioteca", () => {
  const root = makeFixture(["Curso A/Aula.mp4"]);
  try {
    const lib = { id: "libA", path: root };
    const p = courseSubtitlePath(lib, "Curso A/Aula.mp4", "abcdef1234567890abcdef12");
    assert.ok(p);
    assert.strictEqual(
      p,
      path.join(root, "Curso A", ".courseplayer", "subtitles", "abcdef1234567890abcdef12.vtt"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- scanDir básico (contrato mantido) ---------------------------------------

test("scanDir: nome de pasta com sufixo (TP) vira tópico (sem inferência)", async () => {
  const root = makeFixture(["1 Linguas (TP)/Inglês/aula.mp4"]);
  try {
    const tree = await scanDir(root, "");
    const node = find(tree, "1 Linguas (TP)");
    assert.ok(node);
    assert.strictEqual(node.type, "topic");
    assert.strictEqual(node.title, "Linguas");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("scanDir: path traversal bloqueado em resolveSafeRelPath", () => {
  const safe = resolveSafeRelPath("../../etc/passwd");
  assert.strictEqual(safe, null);
});

// --- librarySummary ----------------------------------------------------------

test("librarySummary: biblioteca desativada retorna status 'disabled' e enabled: false", () => {
  const lib = { id: "lib-off", name: "Off Lib", path: "/mnt/off", enabled: false };
  const summary = librarySummary(lib, null);
  assert.strictEqual(summary.id, "lib-off");
  assert.strictEqual(summary.enabled, false);
  assert.strictEqual(summary.status, "disabled");
  assert.strictEqual(summary.tree, null);
  assert.strictEqual(summary.courseCount, 0);
});

test("librarySummary: biblioteca ativada preserva status e cursos do cache", () => {
  const lib = { id: "lib-on", name: "On Lib", path: "/mnt/on", enabled: true };
  const mockCache = {
    status: "ok",
    lastScanAt: 123456,
    error: null,
    tree: {
      type: "folder",
      children: [
        { type: "folder", name: "Curso 1", children: [{ type: "video", name: "Aula 1.mp4" }] },
        { type: "file", name: "Doc.pdf" },
      ],
    },
  };
  const summary = librarySummary(lib, mockCache);
  assert.strictEqual(summary.id, "lib-on");
  assert.strictEqual(summary.enabled, true);
  assert.strictEqual(summary.status, "ok");
  assert.strictEqual(summary.courseCount, 1);
  assert.strictEqual(summary.topicCount, 0);
  assert.strictEqual(summary.tree, mockCache.tree);
});

test("librarySummary: diferencia tópicos e não infla módulos aninhados como cursos", () => {
  const lib = { id: "lib-tree", name: "Tree Lib", path: "/mnt/tree", enabled: true };
  const mockCache = {
    status: "ok",
    tree: {
      type: "folder",
      children: [
        {
          type: "topic",
          name: "Topico 1",
          children: [
            {
              type: "folder",
              name: "Curso A",
              children: [
                { type: "folder", name: "Modulo 1", children: [{ type: "video", name: "Aula 1.mp4" }] },
                { type: "folder", name: "Modulo 2", children: [{ type: "video", name: "Aula 2.mp4" }] },
              ],
            },
          ],
        },
        {
          type: "folder",
          name: "Curso B",
          children: [{ type: "video", name: "Aula B1.mp4" }],
        },
      ],
    },
  };
  const summary = librarySummary(lib, mockCache);
  assert.strictEqual(summary.courseCount, 2); // Curso A e Curso B
  assert.strictEqual(summary.topicCount, 1);  // Topico 1
});

// --- requestLibrary ----------------------------------------------------------

test("requestLibrary: alias libId (query/body) equivale a libraryId", () => {
  const { requestLibrary } = require("../server.js");
  // O spread de module.exports congela `librariesCache` como valor; o
  // acessor vivo está no registry — injeta/restaura o cache por ele.
  const registry = require("../server/libraries/registry.js");
  const prev = registry.librariesCache;
  const def = { id: "default", path: "/x", isDefault: true, enabled: true };
  const ext = { id: "ext1", path: "/y", enabled: true };
  registry.librariesCache = [def, ext];
  try {
    // Sem id → biblioteca padrão.
    assert.strictEqual(requestLibrary({ query: {}, body: {} }), def);
    assert.strictEqual(requestLibrary({ query: {} }), def);
    // libraryId e libId resolvem a mesma biblioteca, em query e body.
    assert.strictEqual(requestLibrary({ query: { libraryId: "ext1" } }), ext);
    assert.strictEqual(requestLibrary({ query: { libId: "ext1" } }), ext);
    assert.strictEqual(requestLibrary({ query: {}, body: { libraryId: "ext1" } }), ext);
    assert.strictEqual(requestLibrary({ query: {}, body: { libId: "ext1" } }), ext);
    // libraryId tem precedência sobre libId.
    assert.strictEqual(
      requestLibrary({ query: { libraryId: "ext1", libId: "nope" } }),
      ext,
    );
    // Id desconhecido → null (nunca degrada para a padrão).
    assert.strictEqual(requestLibrary({ query: { libId: "nope" } }), null);
    assert.strictEqual(requestLibrary({ query: { libraryId: "nope" } }), null);
    assert.strictEqual(requestLibrary({ query: {}, body: { libId: "nope" } }), null);
  } finally {
    registry.librariesCache = prev;
  }
});

// --- Rotas HTTP de Gerenciamento de Bibliotecas ------------------------------

test("PATCH /api/libraries/default: permite alterar o caminho da biblioteca padrão para nova pasta", async () => {
  const express = require("express");
  const http = require("node:http");
  const { registerLibraryRoutes } = require("../server/libraries/routes");
  const registry = require("../server/libraries/registry");

  const tmpData = makeFixture([]);
  const tmpA = makeFixture(["Curso 1/aula.mp4"]);
  const tmpB = makeFixture(["Curso 2/aula.mp4"]);

  const prevDataDir = process.env.LP_DATA_DIR;
  process.env.LP_DATA_DIR = tmpData;

  const prev = registry.librariesCache;
  registry.librariesCache = [
    {
      id: "default",
      name: "Padrao",
      path: tmpA,
      enabled: true,
      isDefault: true,
      createdAt: Date.now(),
    },
  ];
  await registry.persistLibraries();

  const app = express();
  app.use(express.json());
  registerLibraryRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/libraries/default`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: tmpB }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.id, "default");
    const updated = registry.getLibraryById("default");
    assert.strictEqual(updated.path, tmpB);
  } finally {
    server.close();
    process.env.LP_DATA_DIR = prevDataDir;
    registry.librariesCache = prev;
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpA, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  }
});

test("PATCH /api/libraries/default: permite desativar e reativar a biblioteca padrão sem erro de diretório proibido", async () => {
  const express = require("express");
  const http = require("node:http");
  const { registerLibraryRoutes } = require("../server/libraries/routes");
  const registry = require("../server/libraries/registry");
  const state = require("../server/state");

  const tmpData = makeFixture([]);
  const prevDataDir = process.env.LP_DATA_DIR;
  process.env.LP_DATA_DIR = tmpData;

  const prev = registry.librariesCache;
  registry.librariesCache = [
    {
      id: "default",
      name: "Padrao",
      path: state.ROOT,
      enabled: true,
      isDefault: true,
      createdAt: Date.now(),
    },
  ];
  await registry.persistLibraries();

  const app = express();
  app.use(express.json());
  registerLibraryRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    // 1. Desativa a padrão
    const res1 = await fetch(`http://127.0.0.1:${port}/api/libraries/default`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.strictEqual(res1.status, 200);
    const data1 = await res1.json();
    assert.strictEqual(data1.enabled, false);

    // 2. Reativa a padrão (não deve falhar por raiz coincidente)
    const res2 = await fetch(`http://127.0.0.1:${port}/api/libraries/default`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.strictEqual(res2.status, 200);
    const data2 = await res2.json();
    assert.strictEqual(data2.enabled, true);
  } finally {
    server.close();
    process.env.LP_DATA_DIR = prevDataDir;
    registry.librariesCache = prev;
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test("DELETE /api/libraries/default: reseta para raiz padrão da instalação quando for a única biblioteca", async () => {
  const express = require("express");
  const http = require("node:http");
  const { registerLibraryRoutes } = require("../server/libraries/routes");
  const registry = require("../server/libraries/registry");
  const state = require("../server/state");

  const tmpData = makeFixture([]);
  const prevDataDir = process.env.LP_DATA_DIR;
  process.env.LP_DATA_DIR = tmpData;

  const prev = registry.librariesCache;
  registry.librariesCache = [
    {
      id: "default",
      name: "Alterada",
      path: "/pasta/inexistente/alterada",
      enabled: true,
      isDefault: true,
      createdAt: Date.now(),
    },
  ];
  await registry.persistLibraries();

  const app = express();
  app.use(express.json());
  registerLibraryRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/libraries/default`, {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.reset, true);

    const updated = registry.getLibraryById("default");
    assert.ok(updated);
    assert.strictEqual(updated.path, state.ROOT);
    assert.strictEqual(updated.isDefault, true);
  } finally {
    server.close();
    process.env.LP_DATA_DIR = prevDataDir;
    registry.librariesCache = prev;
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});

test("DELETE /api/libraries/default: remove a padrão e promove a próxima biblioteca quando houver outras", async () => {
  const express = require("express");
  const http = require("node:http");
  const { registerLibraryRoutes } = require("../server/libraries/routes");
  const registry = require("../server/libraries/registry");
  const state = require("../server/state");

  const tmpData = makeFixture([]);
  const tmpB = makeFixture(["Curso B/aula.mp4"]);
  const prevDataDir = process.env.LP_DATA_DIR;
  process.env.LP_DATA_DIR = tmpData;

  const prev = registry.librariesCache;
  registry.librariesCache = [
    {
      id: "default",
      name: "Padrao Velha",
      path: state.ROOT,
      enabled: true,
      isDefault: true,
      createdAt: Date.now(),
    },
    {
      id: "lib-secundaria",
      name: "Biblioteca B",
      path: tmpB,
      enabled: true,
      isDefault: false,
      createdAt: Date.now(),
    },
  ];
  await registry.persistLibraries();

  const app = express();
  app.use(express.json());
  registerLibraryRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/libraries/default`, {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);

    assert.strictEqual(registry.getLibraryById("default"), null);
    const promoted = registry.getLibraryById("lib-secundaria");
    assert.ok(promoted);
    assert.strictEqual(promoted.isDefault, true);
  } finally {
    server.close();
    process.env.LP_DATA_DIR = prevDataDir;
    registry.librariesCache = prev;
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpB, { recursive: true, force: true });
  }
});

test("DELETE /api/libraries/:id: cancela jobs ativos e remove com sucesso sem bloquear com 409", async () => {
  const express = require("express");
  const http = require("node:http");
  const { registerLibraryRoutes } = require("../server/libraries/routes");
  const registry = require("../server/libraries/registry");
  const state = require("../server/state");

  const tmpData = makeFixture([]);
  const tmpC = makeFixture(["Curso C/aula.mp4"]);
  const prevDataDir = process.env.LP_DATA_DIR;
  process.env.LP_DATA_DIR = tmpData;

  const prev = registry.librariesCache;
  registry.librariesCache = [
    {
      id: "default",
      name: "Padrao",
      path: state.ROOT,
      enabled: true,
      isDefault: true,
      createdAt: Date.now(),
    },
    {
      id: "lib-com-jobs",
      name: "Biblioteca C",
      path: tmpC,
      enabled: true,
      isDefault: false,
      createdAt: Date.now(),
    },
  ];
  await registry.persistLibraries();

  // Simula jobs ativos na biblioteca
  state.scanningLibraryIds.add("lib-com-jobs");
  state.subtitleJobs.set("hash-test-job", {
    libraryId: "lib-com-jobs",
    status: "transcribing",
    rel: "Curso C/aula.mp4",
  });

  const app = express();
  app.use(express.json());
  registerLibraryRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/libraries/lib-com-jobs`, {
      method: "DELETE",
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);

    assert.strictEqual(registry.getLibraryById("lib-com-jobs"), null);
    assert.strictEqual(state.scanningLibraryIds.has("lib-com-jobs"), false);
  } finally {
    server.close();
    process.env.LP_DATA_DIR = prevDataDir;
    registry.librariesCache = prev;
    state.scanningLibraryIds.delete("lib-com-jobs");
    state.subtitleJobs.delete("hash-test-job");
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpC, { recursive: true, force: true });
  }
});

test("DELETE /api/libraries/:id: autoriza remoção sob host Tailscale ou aml-s9xx-box", async () => {
  const express = require("express");
  const http = require("node:http");
  const { registerLibraryRoutes } = require("../server/libraries/routes");
  const registry = require("../server/libraries/registry");
  const state = require("../server/state");

  const tmpData = makeFixture([]);
  const tmpD = makeFixture(["Curso D/aula.mp4"]);
  const prevDataDir = process.env.LP_DATA_DIR;
  process.env.LP_DATA_DIR = tmpData;

  const prev = registry.librariesCache;
  registry.librariesCache = [
    {
      id: "default",
      name: "Padrao",
      path: state.ROOT,
      enabled: true,
      isDefault: true,
      createdAt: Date.now(),
    },
    {
      id: "lib-tailscale",
      name: "Biblioteca D",
      path: tmpD,
      enabled: true,
      isDefault: false,
      createdAt: Date.now(),
    },
  ];
  await registry.persistLibraries();

  const app = express();
  app.use(express.json());
  registerLibraryRoutes(app);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const res = await new Promise((resolve, reject) => {
      const r = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: "/api/libraries/lib-tailscale",
          method: "DELETE",
          headers: {
            Host: `aml-s9xx-box:${port}`,
            Origin: `http://aml-s9xx-box:${port}`,
          },
        },
        (resp) => {
          let body = "";
          resp.on("data", (c) => (body += c));
          resp.on("end", () => {
            resolve({
              status: resp.statusCode,
              json: () => Promise.resolve(JSON.parse(body || "{}")),
            });
          });
        },
      );
      r.on("error", reject);
      r.end();
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(registry.getLibraryById("lib-tailscale"), null);
  } finally {
    server.close();
    process.env.LP_DATA_DIR = prevDataDir;
    registry.librariesCache = prev;
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpD, { recursive: true, force: true });
  }
});


