"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");

function tmpDir(prefix) {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer(dataDir, envOverrides = {}, { port = null } = {}) {
  const basePort = port || 33000 + Math.floor(Math.random() * 10000);
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = basePort + attempt * 7;
    const proc = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        LP_DATA_DIR: dataDir,
        PORT: String(p),
        HOST: "127.0.0.1",
        LP_NO_BROWSER: "1",
        ...envOverrides,
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
        setTimeout(poll, 50);
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
            if (Date.now() - t0 > 5000) {
              try { proc.kill("SIGKILL"); } catch {}
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Desligamento automático: processo encerra sozinho quando inativo (sem abas abertas)", async () => {
  const dir = tmpDir("lp-idle-test-1-");
  const srv = await startServer(dir, {
    LP_IDLE_TIMEOUT_MS: "1200",
    LP_IDLE_CHECK_INTERVAL_MS: "150",
  });

  try {
    const status = await getJson(srv.base, "/api/system/idle");
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.data.ok, true);
    assert.strictEqual(status.data.enabled, true);

    // Não envia nenhuma requisição / heartbeat e aguarda o encerramento automático
    const exitCode = await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        if (srv.proc.exitCode !== null) return resolve(srv.proc.exitCode);
        if (Date.now() - t0 > 8000) return resolve("timeout");
        setTimeout(poll, 100);
      };
      poll();
    });

    assert.strictEqual(exitCode, 0, "O servidor deve ter encerrado automaticamente com exitCode 0");
    const log = srv.output();
    assert.ok(log.includes("[IDLE] Inatividade detectada"), "Log deve acusar inatividade detectada");
    assert.ok(log.includes("[IDLE] Encerrando o servidor"), "Log deve acusar encerramento para economia de bateria");
    assert.ok(log.includes("[SHUTDOWN] encerrando processos"), "Log deve confirmar execução do shutdown ordeiro");
  } finally {
    await srv.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Heartbeat de abas ativas: impede o desligamento e desliga apenas após fechar as abas", async () => {
  const dir = tmpDir("lp-idle-test-2-");
  // Timeout de 1.2 segundos; enviaremos heartbeats por 2.5 segundos a cada 350ms
  const srv = await startServer(dir, {
    LP_IDLE_TIMEOUT_MS: "1200",
    LP_IDLE_CHECK_INTERVAL_MS: "150",
  });

  try {
    const t0 = Date.now();
    for (let i = 0; i < 7; i++) {
      const hb = await postJson(srv.base, "/api/system/heartbeat", {});
      assert.strictEqual(hb.status, 200);
      assert.strictEqual(hb.data.ok, true);
      await sleep(350);
    }
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 2000, `Passou tempo suficiente (${elapsed}ms > 1200ms timeout)`);
    assert.strictEqual(srv.proc.exitCode, null, "Servidor permaneceu vivo enquanto os heartbeats foram enviados");

    // Agora simula o fechamento das abas (cessa o heartbeat). O servidor deve desligar em ~1.2s.
    const exitCode = await new Promise((resolve) => {
      const waitStart = Date.now();
      const poll = () => {
        if (srv.proc.exitCode !== null) return resolve(srv.proc.exitCode);
        if (Date.now() - waitStart > 8000) return resolve("timeout");
        setTimeout(poll, 100);
      };
      poll();
    });

    assert.strictEqual(exitCode, 0, "Servidor encerrou com exitCode 0 após as abas fecharem");
    assert.ok(srv.output().includes("[IDLE] Inatividade detectada"), "Detectou inatividade após cessar heartbeats");
  } finally {
    await srv.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Timeout desativado (timeout = 0): servidor nunca desliga sozinho", async () => {
  const dir = tmpDir("lp-idle-test-3-");
  const srv = await startServer(dir, {
    LP_IDLE_TIMEOUT_MINUTES: "0",
    LP_IDLE_CHECK_INTERVAL_MS: "150",
  });

  try {
    const status = await getJson(srv.base, "/api/system/idle");
    assert.strictEqual(status.status, 200);
    assert.strictEqual(status.data.enabled, false);

    // Aguarda 1.5s com zero atividade
    await sleep(1500);
    assert.strictEqual(srv.proc.exitCode, null, "Servidor deve continuar ativo quando idleTimeoutMinutes = 0");
  } finally {
    await srv.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Configuração dinâmica via API: POST e GET /api/system/idle", async () => {
  const dir = tmpDir("lp-idle-test-4-");
  const srv = await startServer(dir, {
    LP_IDLE_TIMEOUT_MINUTES: "30",
  });

  try {
    // 1. Altera para 45 minutos
    const resSet = await postJson(srv.base, "/api/system/idle", { minutes: 45 });
    assert.strictEqual(resSet.status, 200);
    assert.strictEqual(resSet.data.ok, true);
    assert.strictEqual(resSet.data.idleTimeoutMinutes, 45);
    assert.strictEqual(resSet.data.enabled, true);

    // 2. Consulta GET
    const resGet = await getJson(srv.base, "/api/system/idle");
    assert.strictEqual(resGet.status, 200);
    assert.strictEqual(resGet.data.idleTimeoutMinutes, 45);
    assert.strictEqual(resGet.data.enabled, true);

    // 3. Desativa via minutes: 0
    const resOff = await postJson(srv.base, "/api/system/idle", { minutes: 0 });
    assert.strictEqual(resOff.status, 200);
    assert.strictEqual(resOff.data.enabled, false);

    // 4. Rejeição de valores inválidos (negativos ou não-numéricos)
    const resNeg = await postJson(srv.base, "/api/system/idle", { minutes: -10 });
    assert.strictEqual(resNeg.status, 400);
    assert.strictEqual(resNeg.data.ok, false);

    const resNan = await postJson(srv.base, "/api/system/idle", { minutes: "abc" });
    assert.strictEqual(resNan.status, 400);
  } finally {
    await srv.stop();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
