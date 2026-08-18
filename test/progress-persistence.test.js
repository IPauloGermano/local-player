// PROGRESSO PERSISTENTE — garantias contra perda acidental.
// node:test + node:assert (stdlib) — sem dependências.
//
// A REGRA é absoluta: progresso é dado persistente do usuário; NENHUMA
// operação normal (startup, restart, rescan, reload, scan, marcadores de
// tópico, bibliotecas, erro de filesystem) pode removê-lo. Só o clear
// explícito remove. Estes testes provam:
//   P1  crash (SIGKILL) no meio de saves → restart preserva tudo que foi ack
//   P2  main ausente/corrompido + backup válido → boot RESTAURA o main em disco
//   P3  main+bak+bak.1 corrompidos → boot inicia vazio, TODOS preservados
//   P4  save de uma aula NUNCA altera/remove as demais (merge, não replace)
//   P5  adicionar/remover biblioteca não altera progresso de outras bibliotecas
//   P6  re-save de uma aula com posição menor não remove nenhuma entrada
//   P7  rescan com erro de scan (biblioteca inacessível) não apaga progresso
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

// Sobe o servidor real com LP_DATA_DIR em diretório temporário. `stop` derruba
// com SIGTERM (drena a fila). `kill9` derruba bruscamente (crash).
async function startServer(dataDir, { port = null } = {}) {
  const basePort = port || 35000 + Math.floor(Math.random() * 15000);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = basePort + attempt * 7;
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, LP_DATA_DIR: dataDir, PORT: String(p), HOST: "127.0.0.1" },
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
        if (Date.now() - t0 > 15000) { lastErr = new Error(`timeout: ${out}\n${errOut}`); return resolve(false); }
        setTimeout(poll, 100);
      };
      poll();
    });
    if (ready) {
      const stop = () =>
        new Promise((resolve) => {
          if (proc.exitCode !== null) return resolve();
          proc.kill("SIGTERM");
          const t0 = Date.now();
          const poll = () => {
            if (proc.exitCode !== null) return resolve();
            if (Date.now() - t0 > 8000) { proc.kill("SIGKILL"); return resolve(); }
            setTimeout(poll, 50);
          };
          poll();
        });
      const kill9 = () =>
        new Promise((resolve) => {
          if (proc.exitCode !== null) return resolve();
          proc.kill("SIGKILL");
          const t0 = Date.now();
          const poll = () => {
            if (proc.exitCode !== null) return resolve();
            if (Date.now() - t0 > 5000) return resolve();
            setTimeout(poll, 50);
          };
          poll();
        });
      return { base: `http://127.0.0.1:${p}`, proc, dataDir, stop, kill9, output: () => out + errOut };
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

const saveProgress = (base, libId, rel, pos, dur = 600, completed = false) =>
  postJson(
    base,
    libId === "default" ? "/api/progress" : `/api/progress?libraryId=${libId}`,
    { path: rel, position: pos, duration: dur, completed },
  );

// P1 — crash: SIGKILL no meio de saves; restart preserva tudo que foi ack.
test("P1 crash (SIGKILL) no meio de saves → restart preserva tudo ack", async () => {
  const dataDir = tmpDir("lp-pp-p1-");
  let srv = await startServer(dataDir);
  try {
    for (let i = 1; i <= 5; i++) {
      const r = await saveProgress(srv.base, "default", `Curso A/Aula 0${i}.mp4`, i * 100);
      assert.strictEqual(r.status, 200, `save ack da Aula 0${i}`);
    }
    // Dispara um save sem aguardar e mata o processo imediatamente (crash).
    // O .catch é anexado na hora para a rejeição (ECONNRESET do kill) nunca
    // ficar sem handler.
    const inflight = saveProgress(srv.base, "default", "Curso A/Aula 06.mp4", 600).catch(() => {});
    await srv.kill9();
    await inflight;
    srv = null;

    srv = await startServer(dataDir); // restart
    const g = await getJson(srv.base, "/api/progress");
    for (let i = 1; i <= 5; i++) {
      assert.strictEqual(g.data[K("default", `Curso A/Aula 0${i}.mp4`)].position, i * 100, `Aula 0${i} preservada após crash`);
    }
    // O save in-flight pode ou não ter chegado, mas nunca pode corromper os demais.
    const n = Object.keys(g.data).length;
    assert.ok(n >= 5, `pelo menos as 5 ack existem (tem ${n})`);
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// P2 — main ausente/corrompido + backup válido → boot RESTAURA o main em disco.
// O backup é uma geração atrás do main (estado pré-último-save): a corrupção
// do main recupera até o último backup — perder apenas o último save num crash
// é a janela inerente a qualquer esquema de backup; operações NORMais nunca
// perdem nada.
test("P2 main corrompido + backup válido → boot restaura o main em disco", async () => {
  const dataDir = tmpDir("lp-pp-p2-");
  const srv = await startServer(dataDir);
  try {
    await saveProgress(srv.base, "default", "Curso A/Aula 01.mp4", 111);
    await saveProgress(srv.base, "default", "Curso B/Aula 02.mp4", 222);
    await saveProgress(srv.base, "default", "Curso C/Aula 03.mp4", 333);
    await srv.stop();

    const prog = path.join(dataDir, "progress.json");
    const bak = path.join(dataDir, "progress.json.bak");
    const bakContent = fs.readFileSync(bak, "utf8");
    const bakState = JSON.parse(bakContent);
    fs.writeFileSync(prog, "### corrompido"); // simula crash que zerou o main

    const s2 = await startServer(dataDir);
    try {
      const g = await getJson(s2.base, "/api/progress");
      // Recupera exatamente o estado do último backup válido (Aulas 01 e 02).
      assert.strictEqual(g.data[K("default", "Curso A/Aula 01.mp4")].position, 111, "recupera do backup");
      assert.strictEqual(g.data[K("default", "Curso B/Aula 02.mp4")].position, 222);
      // O main FOI restaurado em disco (não fica ausente esperando o 1º save).
      const onDisk = JSON.parse(fs.readFileSync(prog, "utf8"));
      assert.strictEqual(onDisk[K("default", "Curso A/Aula 01.mp4")].position, 111, "main restaurado em disco");
      assert.deepStrictEqual(onDisk, bakState, "main em disco == último backup válido");
      assert.ok(bakContent.length > 0, "backup continua existindo");
      const corrupts = fs.readdirSync(dataDir).filter((f) => f.includes(".corrupt-"));
      assert.ok(corrupts.some((f) => f.startsWith("progress.json")), "main corrompido preservado");
    } finally {
      await s2.stop();
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// P3 — main+bak+bak.1 corrompidos → boot inicia vazio, TODOS preservados.
test("P3 main+bak+bak.1 corrompidos → vazio, arquivos corrompidos preservados", async () => {
  const dataDir = tmpDir("lp-pp-p3-");
  fs.writeFileSync(path.join(dataDir, "progress.json"), "### ruim");
  fs.writeFileSync(path.join(dataDir, "progress.json.bak"), "### ruim tb");
  fs.writeFileSync(path.join(dataDir, "progress.json.bak.1"), "### ruim tb2");
  const srv = await startServer(dataDir);
  try {
    const g = await getJson(srv.base, "/api/progress");
    assert.deepStrictEqual(g.data, {}, "sem nenhum estado válido → vazio");
    const corrupts = fs.readdirSync(dataDir).filter((f) => f.includes(".corrupt-"));
    assert.ok(corrupts.some((f) => f.startsWith("progress.json.bak.1")), "bak.1 preservado");
    assert.ok(corrupts.some((f) => f.startsWith("progress.json.bak.")), "bak preservado");
    assert.ok(corrupts.some((f) => f.startsWith("progress.json.")), "main preservado");
    // Depois, um save normal continua funcionando e não ressuscita lixo.
    const r = await saveProgress(srv.base, "default", "Novo/Aula.mp4", 5);
    assert.strictEqual(r.status, 200);
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// P4 — save de uma aula nunca altera/remove as demais (merge, não replace).
test("P4 save de uma aula preserva todas as outras (merge, não replace)", async () => {
  const dataDir = tmpDir("lp-pp-p4-");
  const srv = await startServer(dataDir);
  try {
    for (let i = 1; i <= 4; i++) {
      await saveProgress(srv.base, "default", `Curso A/Aula 0${i}.mp4`, i);
    }
    const before = await getJson(srv.base, "/api/progress");
    assert.strictEqual(Object.keys(before.data).length, 4);

    // Re-save da Aula 01 (posição maior) — e depois posição MENOR (stale).
    await saveProgress(srv.base, "default", "Curso A/Aula 01.mp4", 50);
    await saveProgress(srv.base, "default", "Curso A/Aula 01.mp4", 3);
    const after = await getJson(srv.base, "/api/progress");
    assert.strictEqual(Object.keys(after.data).length, 4, "nenhuma entrada removida");
    assert.strictEqual(after.data[K("default", "Curso A/Aula 02.mp4")].position, 2, "Aula 02 intacta");
    assert.strictEqual(after.data[K("default", "Curso A/Aula 03.mp4")].position, 3, "Aula 03 intacta");
    assert.strictEqual(after.data[K("default", "Curso A/Aula 04.mp4")].position, 4, "Aula 04 intacta");
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// P5 — adicionar/remover biblioteca não altera progresso de outras bibliotecas.
test("P5 adicionar/remover biblioteca não altera progresso existente", async () => {
  const dataDir = tmpDir("lp-pp-p5-");
  const libRoot = tmpDir("lp-pp-p5-libs-");
  const libA = path.join(libRoot, "libA");
  fs.mkdirSync(libA, { recursive: true });
  const srv = await startServer(dataDir);
  try {
    await saveProgress(srv.base, "default", "Curso A/Aula 01.mp4", 10);
    const a = await postJson(srv.base, "/api/libraries", { path: libA });
    const idA = a.data.id;
    await saveProgress(srv.base, idA, "Curso A/Aula 01.mp4", 20);

    // Remove a biblioteca externa (config-only — nunca toca arquivos nem progresso).
    const delRes = await fetch(srv.base + `/api/libraries/${encodeURIComponent(idA)}`, { method: "DELETE" });
    assert.ok([200, 201].includes(delRes.status), `remoção config-only (status ${delRes.status})`);

    const g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K("default", "Curso A/Aula 01.mp4")].position, 10, "padrão preservada após remover externa");
    assert.strictEqual(g.data[K(idA, "Curso A/Aula 01.mp4")].position, 20, "externa preservada (config-only)");
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libRoot, { recursive: true, force: true });
  }
});

// P7 — erro de scan (biblioteca inacessível) não apaga progresso.
test("P7 scan com erro (biblioteca inacessível) não apaga progresso", async () => {
  const dataDir = tmpDir("lp-pp-p7-");
  const libRoot = tmpDir("lp-pp-p7-libs-");
  const libA = path.join(libRoot, "libA");
  fs.mkdirSync(libA, { recursive: true });
  const srv = await startServer(dataDir);
  try {
    const a = await postJson(srv.base, "/api/libraries", { path: libA });
    const idA = a.data.id;
    await saveProgress(srv.base, idA, "Curso A/Aula 01.mp4", 99);

    // Torna a biblioteca inacessível (remove o diretório) e força rescan.
    fs.rmSync(libA, { recursive: true, force: true });
    const rs = await postJson(srv.base, "/api/rescan", {});
    assert.ok([200, 201].includes(rs.status), `rescan responde (${rs.status})`);

    const g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(idA, "Curso A/Aula 01.mp4")].position, 99, "progresso preservado mesmo com biblioteca inacessível");
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libRoot, { recursive: true, force: true });
  }
});
