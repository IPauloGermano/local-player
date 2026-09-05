// INVARIÂNCIA DE PROGRESSO vs RESCAN/RELOAD/RESTART.
// node:test + node:assert (stdlib) — nenhuma dependência nova.
//
// A REGRA é absoluta: RESCAN/RESET/RELOAD nunca apagam progresso. Só uma ação
// explicitamente destrutiva (clear de curso/global) remove dados do usuário.
//
// Cada teste sobe o servidor REAL (`server.js`) como processo filho com
// `LP_DATA_DIR` num diretório temporário (nunca toca o data/ real) e exercita
// as rotas via HTTP. Cobre os 10+ invariantes da seção 20 do relatório:
//   T1  rescan (POST e GET ?rescan=1) mantém progresso em várias aulas/cursos
//   T2  curso removido do disco mantém o histórico (progresso não é podado)
//   T3  curso recriado recupera o progresso antigo
//   T4  marcador `.topic` (adicionar/remover) não apaga progresso
//   T5  sufixo `(TP)` no nome (adicionar/remover) não apaga progresso do arquivo
//   T6  refresh/reload da UI (GET tree+progress repetidos) não apaga
//   T7  restart do servidor não apaga
//   T8  rescan repetido (x5) mantém estado idêntico — sem perda/degradeção
//   T9  clear explícito apaga (o único caminho destrutivo legítimo)
//   T10 clear de curso é delimitado (não apaga outros cursos)
//   T11 clear global apaga tudo
//   T12 rescan NÃO reescreve progress.json em disco (teste direto do arquivo)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.resolve(__dirname, "..", "server.js");
const K = (libId, rel) => libId + "\0" + rel;

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Sobe o servidor num diretório de dados temporário. `stop` derruba com
// SIGTERM (exercita o dreno da fila de progresso antes do exit).
async function startServer(dataDir, { port = null } = {}) {
  const basePort = port || 33000 + Math.floor(Math.random() * 20000);
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
      return { base: `http://127.0.0.1:${p}`, proc, dataDir, stop, output: () => out + errOut };
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

// Salva progresso de uma aula (posição/duration/completed) na biblioteca dada.
const saveProgress = (base, libId, rel, pos, dur = 600, completed = false) =>
  postJson(
    base,
    libId === "default" ? "/api/progress" : `/api/progress?libraryId=${libId}`,
    { path: rel, position: pos, duration: dur, completed },
  );

// Registra uma biblioteca externa temporária; cria a estrutura de pastas/aulas.
function buildCourseDir(libDir, rel, count) {
  for (let i = 1; i <= count; i++) {
    const relFile = `${rel}/Aula 0${i}.mp4`;
    fs.mkdirSync(path.join(libDir, path.dirname(relFile)), { recursive: true });
    fs.writeFileSync(path.join(libDir, relFile), "x");
  }
}

// T1 — rescan (POST e GET) mantém progresso em várias aulas/cursos, sem tocar
// em nenhuma chave. Cobre também a seção 8 do relatório (sandbox fundamental).
test("T1 rescan mantém progresso em várias aulas/cursos (POST /api/rescan e GET ?rescan=1)", async () => {
  const dataDir = tmpDir("lp-inv-t1-");
  const libDir = tmpDir("lp-inv-t1-lib-");
  let srv = null;
  try {
    srv = await startServer(dataDir);
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    assert.strictEqual(r.status, 201, "biblioteca externa criada");
    const libId = r.data.id;

    buildCourseDir(libDir, "Curso A", 2);
    buildCourseDir(libDir, "Curso B", 1);

    await saveProgress(srv.base, libId, "Curso A/Aula 01.mp4", 100);
    await saveProgress(srv.base, libId, "Curso A/Aula 02.mp4", 200);
    await saveProgress(srv.base, libId, "Curso B/Aula 01.mp4", 300);

    // Antes do rescan.
    let g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 100);

    // POST /api/rescan.
    const rs = await postJson(srv.base, "/api/rescan", {});
    assert.strictEqual(rs.status, 200);

    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 100, "Aula 01 preservada");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 02.mp4")].position, 200, "Aula 02 preservada");
    assert.strictEqual(g.data[K(libId, "Curso B/Aula 01.mp4")].position, 300, "Curso B preservado");

    // GET /api/tree?rescan=1 (a outra forma de atualizar a árvore).
    const tr = await getJson(srv.base, "/api/tree?rescan=1");
    assert.strictEqual(tr.status, 200);

    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 100, "pós GET rescan");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 02.mp4")].position, 200);
    assert.strictEqual(g.data[K(libId, "Curso B/Aula 01.mp4")].position, 300);
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// T2+T3 — curso removido do disco não apaga o histórico; curso recriado volta
// a aplicar o progresso antigo. Corresponde às seções 3 e 9 do relatório.
test("T2+T3 curso removido do disco mantém histórico; recriado recupera o progresso", async () => {
  const dataDir = tmpDir("lp-inv-t2-");
  const libDir = tmpDir("lp-inv-t2-lib-");
  let srv = null;
  try {
    srv = await startServer(dataDir);
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;

    buildCourseDir(libDir, "Curso A", 1);
    buildCourseDir(libDir, "Curso B", 1);
    await saveProgress(srv.base, libId, "Curso A/Aula 01.mp4", 120);
    await saveProgress(srv.base, libId, "Curso B/Aula 01.mp4", 60);

    // Remove fisicamente o Curso A e rescan.
    fs.rmSync(path.join(libDir, "Curso A"), { recursive: true, force: true });
    await postJson(srv.base, "/api/rescan", {});
    let g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 120, "histórico de curso ausente permanece");
    assert.strictEqual(g.data[K(libId, "Curso B/Aula 01.mp4")].position, 60, "curso presente intacto");

    // Recria o curso no MESMO caminho e rescan: progresso volta a ser aplicado.
    buildCourseDir(libDir, "Curso A", 1);
    await postJson(srv.base, "/api/rescan", {});
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 120, "progresso recuperado após retorno");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// T4 — marcador `.topic` (estrutural/visual) não apaga progresso.
test("T4 marcador .topic (adicionar/remover) não apaga progresso", async () => {
  const dataDir = tmpDir("lp-inv-t4-");
  const libDir = tmpDir("lp-inv-t4-lib-");
  let srv = null;
  try {
    srv = await startServer(dataDir);
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;

    buildCourseDir(libDir, "TI/Python/Curso X", 1);
    await saveProgress(srv.base, libId, "TI/Python/Curso X/Aula 01.mp4", 42);

    // Adiciona .topic em TI → rescan.
    fs.writeFileSync(path.join(libDir, "TI/.topic"), "");
    await postJson(srv.base, "/api/rescan", {});
    let g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "TI/Python/Curso X/Aula 01.mp4")].position, 42, "com .topic");

    // Remove .topic → rescan.
    fs.rmSync(path.join(libDir, "TI/.topic"));
    await postJson(srv.base, "/api/rescan", {});
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "TI/Python/Curso X/Aula 01.mp4")].position, 42, "sem .topic");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// T5 — sufixo `(TP)` no NOME da pasta é apenas estrutural. Adicionar/remover
// muda o caminho físico (a chave de progresso usa o rel path), mas o progresso
// NUNCA é podado do arquivo — permanece e volta a casar quando o nome retorna.
test("T5 sufixo (TP) não apaga progresso do arquivo; renomear de volta re-casa", async () => {
  const dataDir = tmpDir("lp-inv-t5-");
  const libDir = tmpDir("lp-inv-t5-lib-");
  let srv = null;
  try {
    srv = await startServer(dataDir);
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;

    buildCourseDir(libDir, "Curso A", 1);
    await saveProgress(srv.base, libId, "Curso A/Aula 01.mp4", 77);

    // Renomeia a pasta para "Curso A (TP)" → caminho muda, chave antiga fica.
    fs.renameSync(path.join(libDir, "Curso A"), path.join(libDir, "Curso A (TP)"));
    await postJson(srv.base, "/api/rescan", {});
    let g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 77, "entrada antiga preservada após (TP)");

    // Renomeia de volta → progresso volta a casar com a árvore.
    fs.renameSync(path.join(libDir, "Curso A (TP)"), path.join(libDir, "Curso A"));
    await postJson(srv.base, "/api/rescan", {});
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 77, "re-casa após voltar");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// T6 — refresh/reload da UI (a sequência exata que o loadAll() executa após o
// rescan: GET /api/tree + GET /api/progress) não apaga nada.
test("T6 refresh/reload da UI (GET tree+progress repetidos) não apaga progresso", async () => {
  const dataDir = tmpDir("lp-inv-t6-");
  const libDir = tmpDir("lp-inv-t6-lib-");
  let srv = null;
  try {
    srv = await startServer(dataDir);
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;

    buildCourseDir(libDir, "Curso A", 2);
    await saveProgress(srv.base, libId, "Curso A/Aula 01.mp4", 30);
    await saveProgress(srv.base, libId, "Curso A/Aula 02.mp4", 50);

    for (let i = 0; i < 5; i++) {
      await getJson(srv.base, "/api/tree");       // loadAll()
      const g = await getJson(srv.base, "/api/progress"); // loadAll()
      assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 30, `reload #${i + 1}`);
      assert.strictEqual(g.data[K(libId, "Curso A/Aula 02.mp4")].position, 50, `reload #${i + 1}`);
    }
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// T7 — restart do servidor (shutdown + boot no mesmo data dir) preserva o
// progresso em disco. Cobre a seção 13 do relatório.
test("T7 restart do servidor não apaga progresso", async () => {
  const dataDir = tmpDir("lp-inv-t7-");
  const libDir = tmpDir("lp-inv-t7-lib-");
  let srv = null;
  try {
    srv = await startServer(dataDir);
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;

    buildCourseDir(libDir, "Curso A", 1);
    await saveProgress(srv.base, libId, "Curso A/Aula 01.mp4", 321);
    await srv.stop();
    srv = null;

    srv = await startServer(dataDir); // reboot no MESMO data dir
    const g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso A/Aula 01.mp4")].position, 321, "após restart");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// T8 — rescan repetido não degrada: estado idêntico, sem chaves perdidas.
test("T8 rescan x5 mantém estado idêntico", async () => {
  const dataDir = tmpDir("lp-inv-t8-");
  const libDir = tmpDir("lp-inv-t8-lib-");
  let srv = null;
  try {
    srv = await startServer(dataDir);
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;

    buildCourseDir(libDir, "Curso A", 2);
    buildCourseDir(libDir, "Curso B", 1);
    await saveProgress(srv.base, libId, "Curso A/Aula 01.mp4", 100);
    await saveProgress(srv.base, libId, "Curso A/Aula 02.mp4", 200);
    await saveProgress(srv.base, libId, "Curso B/Aula 01.mp4", 300);

    const before = await getJson(srv.base, "/api/progress");
    for (let i = 0; i < 5; i++) await postJson(srv.base, "/api/rescan", {});
    const after = await getJson(srv.base, "/api/progress");

    assert.deepStrictEqual(after.data, before.data, "estado idêntico após 5 rescans");
    assert.strictEqual(Object.keys(after.data).length, 3, "sem chaves duplicadas/perdidas");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// T9+T10+T11 — clear: o ÚNICO caminho destrutivo. Clear de curso é delimitado;
// clear global apaga tudo; ambos devem continuar funcionando.
test("T9+T10+T11 clear explícito (curso delimitado / global) continua funcionando", async () => {
  const dataDir = tmpDir("lp-inv-t9-");
  const libDir = tmpDir("lp-inv-t9-lib-");
  let srv = null;
  try {
    srv = await startServer(dataDir);
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;

    buildCourseDir(libDir, "Curso A", 1);
    buildCourseDir(libDir, "Curso A2", 1);
    buildCourseDir(libDir, "Curso B", 1);
    await saveProgress(srv.base, libId, "Curso A/Aula 01.mp4", 100);
    await saveProgress(srv.base, libId, "Curso A2/Aula 01.mp4", 110);
    await saveProgress(srv.base, libId, "Curso B/Aula 01.mp4", 200);

    // Clear de curso: delimita em "Curso A" (não alcança "Curso A2").
    let c = await postJson(srv.base, `/api/progress/clear?libraryId=${libId}`, { coursePath: "Curso A" });
    assert.strictEqual(c.status, 200);
    let g = await getJson(srv.base, "/api/progress");
    assert.ok(!g.data[K(libId, "Curso A/Aula 01.mp4")], "Curso A limpo");
    assert.ok(g.data[K(libId, "Curso A2/Aula 01.mp4")], "Curso A2 preservado (delimitação)");
    assert.ok(g.data[K(libId, "Curso B/Aula 01.mp4")], "Curso B preservado");

    // Clear global: apaga tudo com all: true explícito.
    c = await postJson(srv.base, `/api/progress/clear?libraryId=${libId}`, { all: true });
    assert.strictEqual(c.status, 200);
    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(Object.keys(g.data).length, 0, "clear global esvazia");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// T12 — teste DIRETO do arquivo (seção 8 do relatório): semente progress.json
// em disco, sobe o servidor, faz rescan e verifica que o arquivo não foi
// reescrito/tocado (continua idêntico). Cobre também curso AUSENTE da árvore.
test("T12 rescan não reescreve progress.json em disco (arquivo preservado byte a byte)", async () => {
  const dataDir = tmpDir("lp-inv-t12-");
  fs.mkdirSync(path.join(dataDir, "subtitles"), { recursive: true });
  // Curso que NÃO existe na árvore da biblioteca padrão: o histórico deve
  // sobreviver ao rescan (seção 3 do relatório — curso removido da árvore).
  const seeded = {
    [K("default", "Curso Removido/Aula 01.mp4")]: {
      position: 120,
      duration: 600,
      completed: false,
      updatedAt: 123456,
    },
    [K("default", "Curso Presente/Aula 01.mp4")]: {
      position: 55,
      duration: 300,
      completed: true,
      updatedAt: 654321,
    },
  };
  const seededRaw = JSON.stringify(seeded, null, 2);
  fs.writeFileSync(path.join(dataDir, "progress.json"), seededRaw);

  let srv = null;
  try {
    srv = await startServer(dataDir);
    // Confirma que o servidor devolve o progresso semeado.
    let g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "Curso Removido/Aula 01.mp4")].position, 120);
    assert.strictEqual(g.data[K("default", "Curso Presente/Aula 01.mp4")].completed, true);

    await postJson(srv.base, "/api/rescan", {});
    await getJson(srv.base, "/api/tree?rescan=1");

    g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "Curso Removido/Aula 01.mp4")].position, 120, "histórico do curso ausente permanece");
    assert.strictEqual(g.data[K("default", "Curso Presente/Aula 01.mp4")].completed, true);

    // O arquivo em disco continua EXATAMENTE o mesmo (nenhum reescrever do
    // rescan; a migração de chaves não toca chaves já com "\0").
    const onDisk = fs.readFileSync(path.join(dataDir, "progress.json"), "utf8");
    assert.strictEqual(onDisk, seededRaw, "progress.json não foi reescrito pelo rescan");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
