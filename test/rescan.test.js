"use strict";

// Rescan reativo: POST /api/rescan reflete adição/remoção no disco e as
// respostas da árvore nunca são cacheáveis (sem F5 na UI).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer(dataDir) {
  const port = 34000 + Math.floor(Math.random() * 5000);
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      LP_DATA_DIR: dataDir,
      PORT: String(port),
      HOST: "127.0.0.1",
      LP_NO_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 300 && !out.includes("rodando em"); i++) await sleep(50);
  if (!out.includes("rodando em")) {
    try { proc.kill("SIGKILL"); } catch {}
    throw new Error(`servidor não subiu: ${out.slice(-2000)}`);
  }
  return {
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (proc.exitCode !== null) return;
      proc.kill("SIGTERM");
      const t0 = Date.now();
      while (proc.exitCode === null && Date.now() - t0 < 5000) await sleep(50);
      if (proc.exitCode === null) {
        try { proc.kill("SIGKILL"); } catch {}
      }
    },
  };
}

async function json(url, opts) {
  const res = await fetch(url, opts);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

function treeText(tree) {
  return JSON.stringify(tree);
}

test("rescan reflete arquivo novo/removido e nunca é cacheável", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-rescan-"));
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-media-"));
  const courseDir = path.join(mediaDir, "Curso X");
  fs.mkdirSync(courseDir, { recursive: true });
  fs.writeFileSync(path.join(courseDir, "Aula 01 - Intro.mp4"), "");
  const srv = await startServer(dataDir);
  try {
    // Isola o mundo: desabilita a padrão e cria lib externa temporária.
    const dis = await json(`${srv.base}/api/libraries/default`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.strictEqual(dis.status, 200);
    const created = await json(`${srv.base}/api/libraries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: mediaDir, name: "TMP" }),
    });
    assert.strictEqual(created.status, 201);

    // Estado inicial: só a Aula 01.
    const before = await json(`${srv.base}/api/tree`);
    assert.strictEqual(before.status, 200);
    assert.match(before.headers.get("cache-control") || "", /no-store/);
    assert.ok(treeText(before.body).includes("Aula 01"), "árvore inicial tem Aula 01");
    assert.ok(!treeText(before.body).includes("Aula 02"), "árvore inicial não tem Aula 02");

    // Adiciona no disco → rescan reflete IMEDIATAMENTE (resposta + GET).
    fs.writeFileSync(path.join(courseDir, "Aula 02 - Nova.mp4"), "");
    const rescanned = await json(`${srv.base}/api/rescan`, { method: "POST" });
    assert.strictEqual(rescanned.status, 200);
    assert.match(rescanned.headers.get("cache-control") || "", /no-store/);
    assert.ok(
      treeText(rescanned.body).includes("Aula 02"),
      "resposta do rescan já traz a aula nova (sem F5)",
    );
    const after = await json(`${srv.base}/api/tree`);
    assert.ok(treeText(after.body).includes("Aula 02"), "GET pós-rescan traz a aula nova");

    // Remove no disco → rescan reflete a remoção.
    fs.rmSync(path.join(courseDir, "Aula 01 - Intro.mp4"));
    await json(`${srv.base}/api/rescan`, { method: "POST" });
    const afterRm = await json(`${srv.base}/api/tree`);
    assert.ok(!treeText(afterRm.body).includes("Aula 01"), "remoção refletida sem F5");
    assert.ok(treeText(afterRm.body).includes("Aula 02"), "aula restante preservada");
  } finally {
    await srv.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(mediaDir, { recursive: true, force: true });
  }
});
