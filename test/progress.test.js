// Testes de INTEGRIDADE DO PROGRESSO (auditoria pós-tópicos/bibliotecas).
// node:test + node:assert (stdlib) — nenhuma dependência nova.
//
// Sobe o servidor REAL (`server.js`) como processo filho com `LP_DATA_DIR`
// apontando para um diretório temporário (nunca toca o data/ real) e exercita
// as rotas de progresso via HTTP. Cobre:
//   - chave de progresso `libId\0rel` (isolamento entre bibliotecas/cursos/
//     tópicos; duas aulas com o mesmo nome não colidem)
//   - persistência básica + reload
//   - conclusão (completed)
//   - clear de curso DELIMITADO por prefixo (`Curso X` não apaga `Curso X2`)
//   - clear escopado por biblioteca + clear global
//   - path traversal / biblioteca desconhecida → 400
//   - primeiro save semeia o backup
//   - migração de chaves legadas (sem `\0`) → `default\0`
//   - corrupção: main → recupera do bak; main+bak → recupera do bak.1;
//     arquivos corrompidos preservados como `.corrupt-*`
//   - shutdown drena a fila (save pendente chega ao disco)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");
// Chave de progresso: "<libraryId>\0<rel>" (mesmo contrato do server/app.js).
const K = (libId, rel) => libId + "\0" + rel;

function tmpDir(prefix) {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Sobe o servidor num diretório de dados temporário. Retorna {base, proc,
// dataDir, stop}. `stop` derruba com SIGTERM (que exercita o dreno da fila).
async function startServer(dataDir, { port = null } = {}) {
  const basePort = port || 30000 + Math.floor(Math.random() * 20000);
  let lastErr = null;
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
        if (proc.exitCode !== null) {
          // EADDRINUSE → exit(1) com mensagem clara; tenta outra porta.
          resolve(false);
          return;
        }
        if (out.includes("rodando em") || errOut.includes("rodando em")) {
          resolve(true);
          return;
        }
        if (Date.now() - t0 > 15000) {
          lastErr = new Error(`timeout subindo servidor: ${out}\n${errOut}`);
          resolve(false);
          return;
        }
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
      return {
        base: `http://127.0.0.1:${p}`,
        proc,
        dataDir,
        stop,
        output: () => out + errOut,
      };
    }
    try { proc.kill("SIGKILL"); } catch {}
  }
  throw lastErr || new Error("falha ao subir servidor");
}

const postJson = async (base, url, body) => {
  const res = await fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
};

const getJson = async (base, url) => {
  const res = await fetch(base + url);
  return { status: res.status, data: await res.json() };
};

// T1 — persistência básica, reload, aulas de mesmo nome e cursos em tópicos.
test("progresso: salva/recarega; aulas de mesmo nome e cursos em tópicos têm chaves distintas", async () => {
  const dataDir = tmpDir("lp-prog-t1-");
  const srv = await startServer(dataDir);
  try {
    // Básico + reload.
    let r = await postJson(srv.base, "/api/progress", {
      path: "Curso A/Aula 01.mp4",
      position: 120,
      duration: 600,
      completed: false,
    });
    assert.strictEqual(r.status, 200);
    let g = await getJson(srv.base, "/api/progress");
    const kA = K("default", "Curso A/Aula 01.mp4");
    assert.ok(g.data[kA], "chave com prefixo da biblioteca padrão");
    assert.strictEqual(g.data[kA].position, 120);

    // Reload: novo save sobrescreve a mesma chave, não cria outra.
    await postJson(srv.base, "/api/progress", {
      path: "Curso A/Aula 01.mp4",
      position: 200,
      duration: 600,
      completed: false,
    });
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[kA].position, 200, "reload preserva a MESMA chave");

    // Caso A: duas aulas com o mesmo nome em cursos diferentes.
    await postJson(srv.base, "/api/progress", {
      path: "Curso B/Aula 01.mp4",
      position: 50,
      duration: 600,
      completed: false,
    });
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "Curso B/Aula 01.mp4")].position, 50);
    assert.strictEqual(g.data[kA].position, 200, "aulas de mesmo nome não colidem");

    // Caso B: mesmo nome de curso em tópicos diferentes (paths distintos).
    await postJson(srv.base, "/api/progress", {
      path: "TI/Python/Curso X/Aula 01.mp4",
      position: 10,
      duration: 100,
      completed: false,
    });
    await postJson(srv.base, "/api/progress", {
      path: "TI/Java/Curso X/Aula 01.mp4",
      position: 20,
      duration: 100,
      completed: false,
    });
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "TI/Python/Curso X/Aula 01.mp4")].position, 10);
    assert.strictEqual(g.data[K("default", "TI/Java/Curso X/Aula 01.mp4")].position, 20);

    // Conclusão.
    await postJson(srv.base, "/api/progress", {
      path: "Curso B/Aula 01.mp4",
      position: 600,
      duration: 600,
      completed: true,
    });
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "Curso B/Aula 01.mp4")].completed, true);
  } finally {
    await srv.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// T2 — isolamento entre bibliotecas + validações de path/biblioteca.
test("progresso: mesmo rel em bibliotecas distintas não colide; 400 para path/biblioteca inválidos", async () => {
  const dataDir = tmpDir("lp-prog-t2-");
  const libRoot = tmpDir("lp-prog-libs-");
  const libA = path.join(libRoot, "libA");
  const libB = path.join(libRoot, "libB");
  fsSync.mkdirSync(libA, { recursive: true });
  fsSync.mkdirSync(libB, { recursive: true });
  const srv = await startServer(dataDir);
  try {
    // Cria duas bibliotecas externas com o MESMO rel path interno.
    const a = await postJson(srv.base, "/api/libraries", { path: libA });
    assert.strictEqual(a.status, 201);
    const b = await postJson(srv.base, "/api/libraries", { path: libB });
    assert.strictEqual(b.status, 201);
    const idA = a.data.id;
    const idB = b.data.id;
    assert.notStrictEqual(idA, idB);

    await postJson(
      srv.base,
      `/api/progress?libraryId=${encodeURIComponent(idA)}`,
      { path: "Curso X/Aula 01.mp4", position: 7, duration: 100, completed: false },
    );
    await postJson(
      srv.base,
      `/api/progress?libraryId=${encodeURIComponent(idB)}`,
      { path: "Curso X/Aula 01.mp4", position: 8, duration: 100, completed: false },
    );
    let g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(idA, "Curso X/Aula 01.mp4")].position, 7);
    assert.strictEqual(g.data[K(idB, "Curso X/Aula 01.mp4")].position, 8);
    assert.ok(
      !g.data[K("default", "Curso X/Aula 01.mp4")],
      "aula externa não vaza para a biblioteca padrão",
    );

    // Caso C: mesma aula na padrão E na externa — três chaves independentes.
    await postJson(srv.base, "/api/progress", {
      path: "Curso X/Aula 01.mp4",
      position: 9,
      duration: 100,
      completed: false,
    });
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "Curso X/Aula 01.mp4")].position, 9);
    assert.strictEqual(g.data[K(idA, "Curso X/Aula 01.mp4")].position, 7);
    assert.strictEqual(g.data[K(idB, "Curso X/Aula 01.mp4")].position, 8);

    // Biblioteca desconhecida → 400 (nunca degrada para a padrão).
    let r = await postJson(
      srv.base,
      "/api/progress?libraryId=nao-existe",
      { path: "a.mp4", position: 1, duration: 1, completed: false },
    );
    assert.strictEqual(r.status, 400);
    r = await postJson(
      srv.base,
      "/api/progress/clear?libraryId=nao-existe",
      { coursePath: "a" },
    );
    assert.strictEqual(r.status, 400);

    // Traversal → 400; absoluto é re-ancorado DENTRO da biblioteca.
    r = await postJson(srv.base, "/api/progress", {
      path: "../../etc/passwd",
      position: 1,
      duration: 1,
      completed: false,
    });
    assert.strictEqual(r.status, 400, "traversal rejeitado no save");
    r = await postJson(srv.base, "/api/progress", {
      path: "/absoluto/x.mp4",
      position: 3,
      duration: 30,
      completed: false,
    });
    assert.strictEqual(r.status, 200);
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "absoluto/x.mp4")].position, 3, "absoluto re-ancorado sem escapar");
  } finally {
    await srv.stop();
    await fs.rm(libRoot, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// T3 — clear de curso (delimitação), escopo por biblioteca e clear global.
test("progresso: clear de curso é delimitado e escopado; clear global limpa tudo", async () => {
  const dataDir = tmpDir("lp-prog-t3-");
  const libRoot = tmpDir("lp-prog-t3libs-");
  const libA = path.join(libRoot, "libA");
  fsSync.mkdirSync(libA, { recursive: true });
  const srv = await startServer(dataDir);
  try {
    const a = await postJson(srv.base, "/api/libraries", { path: libA });
    const idA = a.data.id;

    // Semeia progresso: Curso A, Curso A2, Curso B, e a externa com "Curso A".
    const seed = [
      ["Curso A/Aula 01.mp4", 1],
      ["Curso A2/Aula 01.mp4", 2],
      ["Curso B/Aula 01.mp4", 3],
    ];
    for (const [p, pos] of seed) {
      await postJson(srv.base, "/api/progress", { path: p, position: pos, duration: 100, completed: false });
    }
    await postJson(
      srv.base,
      `/api/progress?libraryId=${encodeURIComponent(idA)}`,
      { path: "Curso A/Aula 01.mp4", position: 4, duration: 100, completed: false },
    );

    // Clear de "Curso A": apaga Curso A (padrão), NÃO apaga Curso A2 nem a externa.
    let r = await postJson(srv.base, "/api/progress/clear", { coursePath: "Curso A" });
    assert.strictEqual(r.status, 200);
    let g = await getJson(srv.base, "/api/progress");
    assert.ok(!g.data[K("default", "Curso A/Aula 01.mp4")], "Curso A limpo");
    assert.ok(g.data[K("default", "Curso A2/Aula 01.mp4")], "Curso A2 preservado (delimitação)");
    assert.ok(g.data[K("default", "Curso B/Aula 01.mp4")], "Curso B preservado");
    assert.ok(g.data[K(idA, "Curso A/Aula 01.mp4")], "aula da biblioteca externa preservada");

    // Clear na externa: só a externa é limpa (mesmo rel na padrão permanece).
    r = await postJson(
      srv.base,
      `/api/progress/clear?libraryId=${encodeURIComponent(idA)}`,
      { coursePath: "Curso A" },
    );
    assert.strictEqual(r.status, 200);
    g = await getJson(srv.base, "/api/progress");
    assert.ok(!g.data[K(idA, "Curso A/Aula 01.mp4")], "externa limpa por biblioteca");
    assert.ok(g.data[K("default", "Curso A2/Aula 01.mp4")], "padrão intacta");

    // Payload vazio/ambíguo é rejeitado com 400 (VULN-01):
    const badReq = await postJson(srv.base, "/api/progress/clear", {});
    assert.strictEqual(badReq.status, 400);

    // Clear global explícito (all: true): tudo some, inclusive bibliotecas externas.
    r = await postJson(srv.base, "/api/progress/clear", { all: true });
    assert.strictEqual(r.status, 200);
    g = await getJson(srv.base, "/api/progress");
    assert.deepStrictEqual(g.data, {}, "clear global zera todas as bibliotecas");
  } finally {
    await srv.stop();
    await fs.rm(libRoot, { recursive: true, force: true });
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// T4 — primeiro save semeia o backup; migração de chaves legadas.
test("progresso: primeiro save semeia o backup; chaves legadas migram para default", async () => {
  const dataDir = tmpDir("lp-prog-t4-");
  // Simula progresso criado ANTES das bibliotecas: chaves cruas sem "\0".
  await fs.writeFile(
    path.join(dataDir, "progress.json"),
    JSON.stringify({
      "Curso X/Aula 01.mp4": { position: 42, duration: 100, completed: false },
      "Curso Y/Aula 02.mp4": { position: 7, duration: 200, completed: true },
    }),
  );
  const srv = await startServer(dataDir);
  try {
    // Boot migrou: chaves legadas viraram default\0<rel>, valores intactos.
    const g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "Curso X/Aula 01.mp4")].position, 42);
    assert.strictEqual(g.data[K("default", "Curso Y/Aula 02.mp4")].completed, true);
    assert.ok(!g.data["Curso X/Aula 01.mp4"], "chave crua não permanece");

    // Primeiro save de verdade (após a migração): main e backup existem.
    await postJson(srv.base, "/api/progress", {
      path: "Novo/Aula.mp4",
      position: 5,
      duration: 50,
      completed: false,
    });
    const main = JSON.parse(await fs.readFile(path.join(dataDir, "progress.json"), "utf8"));
    assert.ok(main[K("default", "Novo/Aula.mp4")], "save gravado no main");
    const bakRaw = await fs.readFile(path.join(dataDir, "progress.json.bak"), "utf8");
    const bak = JSON.parse(bakRaw);
    assert.ok(bak, "backup semeado no primeiro save");
  } finally {
    await srv.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// T5 — corrupção: main → bak; main+bak → bak.1; arquivos preservados.
test("progresso: corrupção do main recupera do bak; main+bak recupera do bak.1; .corrupt-* preservados", async () => {
  const dataDir = tmpDir("lp-prog-t5-");
  const srv = await startServer(dataDir);
  try {
    // Três gerações: S1 (bak.1), S2 (bak), S3 (main).
    const save = async (pos) => {
      const r = await postJson(srv.base, "/api/progress", {
        path: "Curso G/Aula.mp4",
        position: pos,
        duration: 100,
        completed: false,
      });
      assert.strictEqual(r.status, 200);
    };
    await save(1);
    await save(2);
    await save(3);
    await srv.stop();

    const progFile = path.join(dataDir, "progress.json");
    const bakFile = path.join(dataDir, "progress.json.bak");
    const bak1File = path.join(dataDir, "progress.json.bak.1");

    // Cena 1: main corrompido → recupera do bak (geração 2).
    await fs.writeFile(progFile, "### corrompido");
    const s2 = await startServer(dataDir);
    try {
      const g = await getJson(s2.base, "/api/progress");
      assert.strictEqual(g.data[K("default", "Curso G/Aula.mp4")].position, 2, "recupera do bak");
      const corrupts = (await fs.readdir(dataDir)).filter((f) => f.includes(".corrupt-"));
      assert.ok(corrupts.some((f) => f.startsWith("progress.json")), "main corrompido preservado");
    } finally {
      await s2.stop();
    }

    // Cena 2: main E bak corrompidos → recupera do bak.1 (geração 1).
    await fs.writeFile(progFile, "### corrompido de novo");
    await fs.writeFile(bakFile, "### corrompido tb");
    const s3 = await startServer(dataDir);
    try {
      const g = await getJson(s3.base, "/api/progress");
      assert.strictEqual(g.data[K("default", "Curso G/Aula.mp4")].position, 1, "recupera do bak.1");
      const corrupts = (await fs.readdir(dataDir)).filter((f) => f.includes(".corrupt-"));
      assert.ok(corrupts.some((f) => f.startsWith("progress.json")), "main preservado");
      assert.ok(corrupts.some((f) => f.startsWith("progress.json.bak")), "bak preservado");
    } finally {
      await s3.stop();
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

// T6 — shutdown drena a fila: o último save chega ao disco antes do exit.
test("progresso: SIGTERM drena a fila e o último save chega ao disco", async () => {
  const dataDir = tmpDir("lp-prog-t6-");
  const srv = await startServer(dataDir);
  try {
    await postJson(srv.base, "/api/progress", {
      path: "Curso Final/Aula.mp4",
      position: 321,
      duration: 500,
      completed: false,
    });
    // SIGTERM → shutdownNow → drena progressWriteQueue antes do exit.
    await srv.stop();
    const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, "progress.json"), "utf8"));
    assert.strictEqual(onDisk[K("default", "Curso Final/Aula.mp4")].position, 321);
    assert.strictEqual(srv.proc.exitCode, 0, "exit limpo após drenar a fila");
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
