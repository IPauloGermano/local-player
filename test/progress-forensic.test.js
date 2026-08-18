// INVESTIGAÇÃO FORENSE DE PROGRESSO.
// node:test + node:assert (stdlib) — sem dependências novas.
//
// Roda o servidor REAL com `LP_PROGRESS_FORENSIC=1` (log de toda escrita com
// hash/diff/stack + snapshot em disco) e com `LP_DATA_DIR` em dir temporário.
// Objetivo: provar a invariante principal
//     OLD_PROGRESS ⊆ NEW_PROGRESS   (nenhuma chave some em operação normal)
// e que NENHUMA escrita regressiva é rejeitada durante operações normais
// (o log do servidor não pode conter "[PROGRESS] rejected invalid state").
// Cenários:
//   F1  rescan em sequência (§6)     F2  tópicos / .topic / (TP) (§7)
//   F3  múltiplas bibliotecas (§8)   F4  crash/SIGKILL (§9)
//   F5  troca rápida de aula (§10)   F6  longa duração (centenas de ops, §13)
//   F7  clear separado — único caminho que remove chaves (§5)
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

// Sobe o servidor com forense ligada. `output()` devolve todo o log do
// servidor (para analisar [PROGRESS-WRITE] / rejections).
async function startServer(dataDir, { port = null } = {}) {
  const basePort = port || 37000 + Math.floor(Math.random() * 12000);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = basePort + attempt * 7;
    const proc = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        LP_DATA_DIR: dataDir,
        LP_PROGRESS_FORENSIC: "1",
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
        if ((out + errOut).includes("rodando em")) return resolve(true);
        if (Date.now() - t0 > 15000) { lastErr = new Error(`timeout: ${out}\n${errOut}`); return resolve(false); }
        setTimeout(poll, 100);
      };
      poll();
    });
    if (ready) {
      const stop = () => new Promise((resolve) => {
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
      const kill9 = () => new Promise((resolve) => {
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

// Verifica que o estado `after` contém todas as chaves de `before`
// (invariante OLD ⊆ NEW) e devolve o conjunto de chaves atual.
function assertSuperset(beforeKeys, afterKeys, ctx) {
  const missing = beforeKeys.filter((k) => !afterKeys.includes(k));
  assert.deepStrictEqual(missing, [], `${ctx}: chaves sumiram: ${JSON.stringify(missing)}`);
}

function keysOf(g) {
  return Object.keys(g.data).sort();
}

function buildCourseDir(libDir, rel, count) {
  for (let i = 1; i <= count; i++) {
    const relFile = `${rel}/Aula 0${i}.mp4`;
    fs.mkdirSync(path.join(libDir, path.dirname(relFile)), { recursive: true });
    fs.writeFileSync(path.join(libDir, relFile), "x");
  }
}

// F1 — rescan em sequência (§6): save → rescan → save outra → rescan → reload
// → restart → rescan; nenhuma chave existente pode sumir.
test("F1 sequência rescan nunca remove chaves (OLD ⊆ NEW)", async () => {
  const dataDir = tmpDir("lp-forensic-f1-");
  const libDir = tmpDir("lp-forensic-f1-lib-");
  let srv = await startServer(dataDir);
  try {
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;
    buildCourseDir(libDir, "Curso A", 3);
    buildCourseDir(libDir, "Curso B", 2);

    let keys = [];
    let g;
    const step = async (label) => {
      g = await getJson(srv.base, "/api/progress");
      assertSuperset(keys, keysOf(g), `${label} (antes de salvar nesta etapa)`);
      keys = keysOf(g);
    };

    await saveProgress(srv.base, libId, "Curso A/Aula 01.mp4", 100);
    await step("pós save A01");
    await postJson(srv.base, "/api/rescan", {});
    await step("pós rescan #1");
    await saveProgress(srv.base, libId, "Curso A/Aula 02.mp4", 200);
    await step("pós save A02");
    await postJson(srv.base, "/api/rescan", {});
    await getJson(srv.base, "/api/tree?rescan=1");
    await step("pós rescan #2 + tree");
    await saveProgress(srv.base, libId, "Curso B/Aula 01.mp4", 300);
    await step("pós save B01");

    // restart
    await srv.stop();
    srv = await startServer(dataDir);
    await step("pós restart");
    await postJson(srv.base, "/api/rescan", {});
    await step("pós rescan pós-restart");

    assert.ok(keys.includes(K(libId, "Curso A/Aula 01.mp4")), "A01 presente");
    assert.ok(keys.includes(K(libId, "Curso A/Aula 02.mp4")), "A02 presente");
    assert.ok(keys.includes(K(libId, "Curso B/Aula 01.mp4")), "B01 presente");

    // Nenhuma rejeição regressiva pode ter ocorrido em operação normal.
    assert.ok(!srv.output().includes("[PROGRESS] rejected invalid state"), "nenhuma escrita regressiva rejeitada");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// F2 — tópicos (§7): adicionar/remover .topic e (TP) não altera o progresso
// (hash do estado permanece o mesmo).
test("F2 .topic / (TP) não alteram o estado de progresso (hash igual)", async () => {
  const dataDir = tmpDir("lp-forensic-f2-");
  const libDir = tmpDir("lp-forensic-f2-lib-");
  const srv = await startServer(dataDir);
  try {
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;
    buildCourseDir(libDir, "TI/Python/Curso X", 1);
    await saveProgress(srv.base, libId, "TI/Python/Curso X/Aula 01.mp4", 42);

    const snap = () => getJson(srv.base, "/api/progress");
    const baseline = await snap();
    const json = JSON.stringify(baseline.data);

    fs.writeFileSync(path.join(libDir, "TI/.topic"), "");
    await postJson(srv.base, "/api/rescan", {});
    assert.strictEqual(JSON.stringify((await snap()).data), json, "add .topic não muda progresso");

    fs.rmSync(path.join(libDir, "TI/.topic"));
    await postJson(srv.base, "/api/rescan", {});
    assert.strictEqual(JSON.stringify((await snap()).data), json, "remove .topic não muda progresso");

    fs.renameSync(path.join(libDir, "TI"), path.join(libDir, "TI (TP)"));
    await postJson(srv.base, "/api/rescan", {});
    assert.strictEqual(JSON.stringify((await snap()).data), json, "add (TP) não muda progresso (caminho antigo preservado)");

    fs.renameSync(path.join(libDir, "TI (TP)"), path.join(libDir, "TI"));
    await postJson(srv.base, "/api/rescan", {});
    assert.strictEqual(JSON.stringify((await snap()).data), json, "remove (TP) não muda progresso");
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// F3 — múltiplas bibliotecas (§8): rescan/reload/restart não misturam chaves.
test("F3 bibliotecas A/B: rescan, reload e restart mantêm chaves intactas", async () => {
  const dataDir = tmpDir("lp-forensic-f3-");
  const libRoot = tmpDir("lp-forensic-f3-libs-");
  const libA = path.join(libRoot, "libA");
  const libB = path.join(libRoot, "libB");
  fs.mkdirSync(libA, { recursive: true });
  fs.mkdirSync(libB, { recursive: true });
  let srv = await startServer(dataDir);
  try {
    const a = await postJson(srv.base, "/api/libraries", { path: libA });
    const b = await postJson(srv.base, "/api/libraries", { path: libB });
    const idA = a.data.id;
    const idB = b.data.id;
    buildCourseDir(libA, "Curso X", 1);
    buildCourseDir(libB, "Curso X", 1);
    await saveProgress(srv.base, idA, "Curso X/Aula 01.mp4", 7);
    await saveProgress(srv.base, idB, "Curso X/Aula 01.mp4", 8);

    let keys = [];
    const step = async (label) => {
      const g = await getJson(srv.base, "/api/progress");
      assertSuperset(keys, keysOf(g), label);
      keys = keysOf(g);
    };
    await step("início");
    await postJson(srv.base, `/api/libraries/${encodeURIComponent(idA)}/rescan`, {});
    await postJson(srv.base, `/api/libraries/${encodeURIComponent(idB)}/rescan`, {});
    await step("pós rescan A+B");
    await getJson(srv.base, "/api/tree");
    await step("pós reload tree");
    await srv.stop();
    srv = await startServer(dataDir);
    await step("pós restart");

    const g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(idA, "Curso X/Aula 01.mp4")].position, 7, "A não misturou com B");
    assert.strictEqual(g.data[K(idB, "Curso X/Aula 01.mp4")].position, 8, "B não misturou com A");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libRoot, { recursive: true, force: true });
  }
});

// F4 — crash (§9): sequência intensa de saves + SIGKILL → restart preserva.
test("F4 crash (SIGKILL) após sequência intensa de saves preserva o estado", async () => {
  const dataDir = tmpDir("lp-forensic-f4-");
  let srv = await startServer(dataDir);
  try {
    const before = {};
    for (let i = 1; i <= 12; i++) {
      const rel = `Curso S/Aula ${String(i).padStart(2, "0")}.mp4`;
      const pos = i * 10;
      const r = await saveProgress(srv.base, "default", rel, pos);
      assert.strictEqual(r.status, 200);
      before[K("default", rel)] = pos;
    }
    const beforeKeys = Object.keys(before);
    // save in-flight e kill imediato (crash).
    const inflight = saveProgress(srv.base, "default", "Curso S/Aula 13.mp4", 130).catch(() => {});
    await srv.kill9();
    await inflight;
    srv = null;

    srv = await startServer(dataDir);
    const g = await getJson(srv.base, "/api/progress");
    for (const [k, pos] of Object.entries(before)) {
      assert.strictEqual(g.data[k] && g.data[k].position, pos, `preservada após crash: ${k}`);
    }
    assert.ok(beforeKeys.every((k) => k in g.data), "todas as chaves ack existem após crash");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// F5 — troca rápida de aula (§10): A→B→A→rescan não troca estados.
test("F5 troca rápida A→B→A→rescan não troca nem remove estados", async () => {
  const dataDir = tmpDir("lp-forensic-f5-");
  const libDir = tmpDir("lp-forensic-f5-lib-");
  const srv = await startServer(dataDir);
  try {
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;
    buildCourseDir(libDir, "Curso R", 2);
    await saveProgress(srv.base, libId, "Curso R/Aula 01.mp4", 100);
    await saveProgress(srv.base, libId, "Curso R/Aula 02.mp4", 200);
    await saveProgress(srv.base, libId, "Curso R/Aula 01.mp4", 110); // volta para A
    await postJson(srv.base, "/api/rescan", {});
    const g = await getJson(srv.base, "/api/progress");
    assert.strictEqual(g.data[K(libId, "Curso R/Aula 01.mp4")].position, 110, "A = 110");
    assert.strictEqual(g.data[K(libId, "Curso R/Aula 02.mp4")].position, 200, "B = 200");
    assert.strictEqual(Object.keys(g.data).length, 2, "só as 2 aulas");
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// F6 — longa duração (§13): centenas de operações; contagem nunca diminui.
test("F6 longa duração: centenas de ops mantêm monotonicidade das chaves", async () => {
  const dataDir = tmpDir("lp-forensic-f6-");
  const libDir = tmpDir("lp-forensic-f6-lib-");
  let srv = await startServer(dataDir);
  try {
    const r = await postJson(srv.base, "/api/libraries", { path: libDir });
    const libId = r.data.id;
    buildCourseDir(libDir, "Curso L", 3);

    let keys = [];
    let peak = 0;
    const assertNoShrink = async (label) => {
      const g = await getJson(srv.base, "/api/progress");
      const k = keysOf(g);
      assertSuperset(keys, k, label);
      keys = k;
      peak = Math.max(peak, k.length);
    };

    for (let round = 0; round < 40; round++) {
      // save/pausa/troca: grava as 3 aulas em posições variadas
      for (let i = 1; i <= 3; i++) {
        await saveProgress(srv.base, libId, `Curso L/Aula 0${i}.mp4`, round * 10 + i);
      }
      await assertNoShrink(`round ${round} (saves)`);
      if (round % 4 === 0) {
        await postJson(srv.base, "/api/rescan", {});
        await getJson(srv.base, "/api/tree?rescan=1");
        await assertNoShrink(`round ${round} (rescan)`);
      }
      if (round % 9 === 0) {
        fs.writeFileSync(path.join(libDir, "Curso L/.topic"), "");
        await postJson(srv.base, "/api/rescan", {});
        await assertNoShrink(`round ${round} (.topic add)`);
        fs.rmSync(path.join(libDir, "Curso L/.topic"));
        await postJson(srv.base, "/api/rescan", {});
        await assertNoShrink(`round ${round} (.topic remove)`);
      }
    }
    // restart no fim
    await srv.stop();
    srv = await startServer(dataDir);
    await assertNoShrink("pós restart");
    assert.strictEqual(peak, 3, "exatamente 3 chaves estáveis ao longo de tudo");
  } finally {
    if (srv) await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(libDir, { recursive: true, force: true });
  }
});

// F7 — clear separado (§5): é o ÚNICO caminho que remove chaves; tudo o mais
// preserva. Também valida o log [PROGRESS-CLEAR].
test("F7 clear explícito é o único que remove; save normal preserva", async () => {
  const dataDir = tmpDir("lp-forensic-f7-");
  const srv = await startServer(dataDir);
  try {
    await saveProgress(srv.base, "default", "Curso A/Aula 01.mp4", 1);
    await saveProgress(srv.base, "default", "Curso A/Aula 02.mp4", 2);
    await saveProgress(srv.base, "default", "Curso B/Aula 01.mp4", 3);

    let g = await getJson(srv.base, "/api/progress");
    const allKeys = keysOf(g);
    assert.strictEqual(allKeys.length, 3);

    // Saves normais não removem nada.
    await saveProgress(srv.base, "default", "Curso A/Aula 01.mp4", 5);
    g = await getJson(srv.base, "/api/progress");
    assertSuperset(allKeys, keysOf(g), "pós save normal");
    assert.strictEqual(Object.keys(g.data).length, 3);

    // Clear de curso: remove SÓ o curso pedido.
    await postJson(srv.base, "/api/progress/clear", { coursePath: "Curso A" });
    g = await getJson(srv.base, "/api/progress");
    assert.ok(!(K("default", "Curso A/Aula 01.mp4") in g.data), "A01 removida pelo clear");
    assert.ok(!(K("default", "Curso A/Aula 02.mp4") in g.data), "A02 removida pelo clear");
    assert.ok(K("default", "Curso B/Aula 01.mp4") in g.data, "Curso B preservado pelo clear de curso");

    assert.ok(srv.output().includes("[PROGRESS-CLEAR]"), "log [PROGRESS-CLEAR] registrado");
    assert.ok(!srv.output().includes("[PROGRESS] rejected invalid state"), "nenhuma rejeição indevida");
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
