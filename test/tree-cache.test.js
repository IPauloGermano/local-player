// Testes da persistência de cache de árvore (tree-cache).
// node:test + node:assert (stdlib) — nenhuma dependência externa.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  scanLibrary,
  libraryTreeCacheFile,
  saveLibraryTreeCache,
  loadLibraryTreeCache,
} = require("../server.js");

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lp-treecache-"));
  for (const f of files) {
    const abs = path.join(root, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, path.basename(f).startsWith(".") ? "" : "x");
  }
  return root;
}

test("saveLibraryTreeCache e loadLibraryTreeCache: salva e recupera cache da árvore em disco", async () => {
  const root = makeFixture(["Curso A/Aula 01.mp4", "Curso B/Aula 02.mp4"]);
  const libId = "test-cache-" + Date.now();
  const lib = { id: libId, name: "Test Lib", path: root, enabled: true };
  const cacheFile = libraryTreeCacheFile(libId);

  try {
    const scanned = await scanLibrary(lib);
    assert.strictEqual(scanned.status, "ok");
    assert.ok(scanned.tree);

    await saveLibraryTreeCache(lib, scanned);
    assert.ok(fs.existsSync(cacheFile), "arquivo de cache deve existir em disco");

    const loaded = await loadLibraryTreeCache(lib);
    assert.ok(loaded, "cache carregado do disco deve ser válido");
    assert.strictEqual(loaded.status, "ok");
    assert.strictEqual(loaded.tree.videoCount, 2);
    assert.strictEqual(loaded.tree.children.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  }
});

test("loadLibraryTreeCache: marca status 'unavailable' se a pasta da biblioteca não existe", async () => {
  const root = makeFixture(["Curso A/Aula 01.mp4"]);
  const libId = "test-unavail-" + Date.now();
  const lib = { id: libId, name: "Unavail Lib", path: root, enabled: true };
  const cacheFile = libraryTreeCacheFile(libId);

  try {
    const scanned = await scanLibrary(lib);
    await saveLibraryTreeCache(lib, scanned);

    // Remove a pasta da biblioteca simulando remoção de pendrive
    fs.rmSync(root, { recursive: true, force: true });

    const loaded = await loadLibraryTreeCache(lib);
    assert.ok(loaded);
    assert.strictEqual(loaded.status, "unavailable");
    assert.strictEqual(loaded.tree, null);
  } finally {
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  }
});
