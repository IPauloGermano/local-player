// Testes de persistência de progresso NO CAMINHO DA BIBLIOTECA (.courseplayer/progress.json).
// Valida:
//   1. libraryProgressFile aponta para <lib.path>/.courseplayer/progress.json
//   2. Salvar progresso de uma biblioteca grava diretamente em <lib.path>/.courseplayer/progress.json
//   3. Chaves dentro de <lib.path>/.courseplayer/progress.json são relativas (portabilidade total)
//   4. Leitura automática de bibliotecas que já contêm .courseplayer/progress.json prévio
//   5. Limpeza de progresso (/api/progress/clear) limpa no arquivo da biblioteca
//   6. Recuperação automática de backup (.bak / .bak.1) na biblioteca quando corrompido
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const {
  libraryProgressDir,
  libraryProgressFile,
  libraryProgressBackupFile,
  libraryProgressBackup2File,
  readLibraryProgress,
  restoreLibraryProgressFromBackup,
} = require("../server.js");

function tmpDir(prefix) {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer(dataDir, { port = null } = {}) {
  const basePort = port || 32000 + Math.floor(Math.random() * 20000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = basePort + attempt * 7;
    const proc = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        LP_DATA_DIR: dataDir,
        PORT: String(p),
        HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (errOut += d));
    const ready = await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        if (proc.exitCode !== null) return resolve(false);
        if (out.includes("rodando em") || errOut.includes("rodando em")) return resolve(true);
        if (Date.now() - t0 > 15000) return resolve(false);
        setTimeout(poll, 100);
      };
      poll();
    });
    if (ready) {
      const stop = async () => {
        if (proc.exitCode !== null) return;
        proc.kill("SIGTERM");
        await new Promise((resolve) => {
          const t0 = Date.now();
          const poll = () => {
            if (proc.exitCode !== null) return resolve();
            if (Date.now() - t0 > 8000) {
              proc.kill("SIGKILL");
              return resolve();
            }
            setTimeout(poll, 50);
          };
          poll();
        });
      };
      return { base: `http://127.0.0.1:${p}`, proc, dataDir, stop };
    }
  }
  throw new Error("não foi possível subir o servidor de teste");
}

async function postJson(base, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

async function getJson(base, urlPath) {
  const res = await fetch(base + urlPath);
  return { status: res.status, data: await res.json().catch(() => null) };
}

test("libraryProgress helpers: caminhos canônicos dentro da biblioteca", () => {
  const fakeLib = { id: "ext-1", path: "/mnt/pendrive/Cursos" };
  assert.strictEqual(libraryProgressDir(fakeLib), path.join("/mnt/pendrive/Cursos", ".courseplayer"));
  assert.strictEqual(libraryProgressFile(fakeLib), path.join("/mnt/pendrive/Cursos", ".courseplayer", "progress.json"));
  assert.strictEqual(libraryProgressBackupFile(fakeLib), path.join("/mnt/pendrive/Cursos", ".courseplayer", "progress.json.bak"));
  assert.strictEqual(libraryProgressBackup2File(fakeLib), path.join("/mnt/pendrive/Cursos", ".courseplayer", "progress.json.bak.1"));
});

test("progresso na biblioteca: salvar aula via API grava em <lib.path>/.courseplayer/progress.json de forma portável", async () => {
  const dataDir = tmpDir("lp-libprog-data-");
  const libDir = tmpDir("lp-libprog-lib-");
  
  // Cria estrutura de curso e vídeo na biblioteca externa
  const courseDir = path.join(libDir, "Curso React");
  await fs.mkdir(courseDir, { recursive: true });
  await fs.writeFile(path.join(courseDir, "Aula 01.mp4"), "dummy video content");

  const srv = await startServer(dataDir);
  try {
    // 1. Cadastra a biblioteca externa
    const regRes = await postJson(srv.base, "/api/libraries", {
      name: "Meus Cursos",
      path: libDir,
    });
    assert.strictEqual(regRes.status, 201);
    const libId = regRes.data.id;

    // 2. Salva o progresso da aula na biblioteca externa
    const saveRes = await postJson(srv.base, "/api/progress", {
      path: "Curso React/Aula 01.mp4",
      position: 145,
      duration: 600,
      completed: true,
      libraryId: libId,
    });
    assert.strictEqual(saveRes.status, 200);

    // 3. Verifica se o arquivo foi criado dentro da pasta da biblioteca
    const targetFile = path.join(libDir, ".courseplayer", "progress.json");
    const exists = await fs.access(targetFile).then(() => true).catch(() => false);
    assert.ok(exists, "arquivo .courseplayer/progress.json deve existir na raiz da biblioteca");

    // 4. Verifica o conteúdo: as chaves devem ser relativas (sem o ID da biblioteca hardcoded)
    const content = JSON.parse(await fs.readFile(targetFile, "utf8"));
    assert.ok(content["Curso React/Aula 01.mp4"], "deve conter a chave relativa da aula");
    assert.strictEqual(content["Curso React/Aula 01.mp4"].position, 145);
    assert.strictEqual(content["Curso React/Aula 01.mp4"].completed, true);

    // 5. Verifica se GET /api/progress expõe a chave com namespace libId\0rel
    const getRes = await getJson(srv.base, "/api/progress");
    assert.strictEqual(getRes.status, 200);
    const compositeKey = `${libId}\0Curso React/Aula 01.mp4`;
    assert.ok(getRes.data[compositeKey], "API deve retornar chave composta");
    assert.strictEqual(getRes.data[compositeKey].position, 145);
  } finally {
    await srv.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(libDir, { recursive: true, force: true });
  }
});

test("progresso na biblioteca: biblioteca externa com .courseplayer/progress.json pré-existente carrega automaticamente", async () => {
  const dataDir = tmpDir("lp-libprog-pre-data-");
  const libDir = tmpDir("lp-libprog-pre-lib-");

  // Cria estrutura e pré-semeia .courseplayer/progress.json como se viesse de outro computador
  const courseDir = path.join(libDir, "Curso Python");
  await fs.mkdir(courseDir, { recursive: true });
  await fs.writeFile(path.join(courseDir, "Aula 01.mp4"), "dummy video");

  const courseplayerDir = path.join(libDir, ".courseplayer");
  await fs.mkdir(courseplayerDir, { recursive: true });
  await fs.writeFile(
    path.join(courseplayerDir, "progress.json"),
    JSON.stringify({
      "Curso Python/Aula 01.mp4": {
        position: 350,
        duration: 700,
        completed: false,
        updatedAt: Date.now() - 1000,
      },
    }),
  );

  const srv = await startServer(dataDir);
  try {
    // Cadastra a biblioteca no servidor
    const regRes = await postJson(srv.base, "/api/libraries", {
      name: "Python Lib",
      path: libDir,
    });
    assert.strictEqual(regRes.status, 201);
    const libId = regRes.data.id;

    // Consulta o progresso do servidor
    const getRes = await getJson(srv.base, "/api/progress");
    const compositeKey = `${libId}\0Curso Python/Aula 01.mp4`;
    assert.ok(getRes.data[compositeKey], "deve carregar o progresso pré-existente da biblioteca");
    assert.strictEqual(getRes.data[compositeKey].position, 350);
  } finally {
    await srv.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(libDir, { recursive: true, force: true });
  }
});

test("progresso na biblioteca: clear de curso atualiza <lib.path>/.courseplayer/progress.json", async () => {
  const dataDir = tmpDir("lp-libprog-clear-data-");
  const libDir = tmpDir("lp-libprog-clear-lib-");

  const courseDir = path.join(libDir, "Curso Node");
  await fs.mkdir(courseDir, { recursive: true });
  await fs.writeFile(path.join(courseDir, "Aula 01.mp4"), "dummy video");

  const srv = await startServer(dataDir);
  try {
    const regRes = await postJson(srv.base, "/api/libraries", {
      name: "Node Lib",
      path: libDir,
    });
    const libId = regRes.data.id;

    // Salva aula 1
    await postJson(srv.base, "/api/progress", {
      path: "Curso Node/Aula 01.mp4",
      position: 100,
      duration: 200,
      completed: true,
      libraryId: libId,
    });

    const targetFile = path.join(libDir, ".courseplayer", "progress.json");
    let content = JSON.parse(await fs.readFile(targetFile, "utf8"));
    assert.ok(content["Curso Node/Aula 01.mp4"], "deve ter aula salva");

    // Limpa o progresso do curso
    const clearRes = await postJson(srv.base, "/api/progress/clear", {
      coursePath: "Curso Node",
      libraryId: libId,
    });
    assert.strictEqual(clearRes.status, 200);

    // Verifica no arquivo da biblioteca
    content = JSON.parse(await fs.readFile(targetFile, "utf8"));
    assert.strictEqual(content["Curso Node/Aula 01.mp4"], undefined, "aula deve ter sido removida do .courseplayer/progress.json");
  } finally {
    await srv.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(libDir, { recursive: true, force: true });
  }
});

test("progresso na biblioteca: recuperação automática de .bak na biblioteca", async () => {
  const libDir = tmpDir("lp-libprog-rec-");
  const courseplayerDir = path.join(libDir, ".courseplayer");
  await fs.mkdir(courseplayerDir, { recursive: true });

  const progFile = path.join(courseplayerDir, "progress.json");
  const bakFile = path.join(courseplayerDir, "progress.json.bak");

  // Simula progress.json corrompido e backup íntegro
  await fs.writeFile(progFile, "{ json inválido corrompido");
  await fs.writeFile(
    bakFile,
    JSON.stringify({
      "Curso A/Aula.mp4": { position: 50, duration: 100, completed: true, updatedAt: 123 },
    }),
  );

  const fakeLib = { id: "ext-rec", name: "Rec Lib", path: libDir };
  const restored = await restoreLibraryProgressFromBackup(fakeLib);
  assert.strictEqual(restored, true, "deve ter restaurado do backup");

  const afterContent = JSON.parse(await fs.readFile(progFile, "utf8"));
  assert.strictEqual(afterContent["Curso A/Aula.mp4"].position, 50);

  // Verifica se o arquivo corrompido foi preservado com sufixo .corrupt-*
  const files = await fs.readdir(courseplayerDir);
  assert.ok(files.some((f) => f.includes(".corrupt-")), "deve preservar arquivo corrompido como .corrupt-<ts>");

  await fs.rm(libDir, { recursive: true, force: true });
});
