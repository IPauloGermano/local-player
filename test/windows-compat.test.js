// Compatibilidade Windows: nomes de executáveis e encerramento gracioso do
// servidor filho. No win32, child.kill("SIGTERM") mata na hora (não há
// sinais POSIX) — o flush de progresso só acontece via IPC.
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { executableName, requestGracefulShutdown } = require("../server/core/platform");

test("executableName: acrescenta .exe só no win32", () => {
  assert.strictEqual(executableName("whisper-cli", "win32"), "whisper-cli.exe");
  assert.strictEqual(executableName("whisper-cli", "linux"), "whisper-cli");
  assert.strictEqual(executableName("whisper-cli", "darwin"), "whisper-cli");
  assert.strictEqual(executableName("ffmpeg.exe", "win32"), "ffmpeg.exe");
  assert.strictEqual(executableName("FFMPEG.EXE", "win32"), "FFMPEG.EXE");
});

function fakeChild({ connected = true } = {}) {
  const child = new EventEmitter();
  child.connected = connected;
  child.exitCode = null;
  child.sent = [];
  child.killed = [];
  child.send = (msg) => child.sent.push(msg);
  child.kill = (sig) => child.killed.push(sig || "SIGTERM");
  return child;
}

test("requestGracefulShutdown: com IPC envia {type:'shutdown'} e não mata de imediato", () => {
  const child = fakeChild();
  requestGracefulShutdown(child, { timeoutMs: 10_000 });
  assert.deepStrictEqual(child.sent, [{ type: "shutdown" }]);
  assert.deepStrictEqual(child.killed, []);
  child.exitCode = 0;
  child.emit("exit", 0);
});

test("requestGracefulShutdown: força kill se o filho não sair no prazo", async () => {
  const child = fakeChild();
  requestGracefulShutdown(child, { timeoutMs: 20 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(child.killed, ["SIGKILL"]);
});

test("requestGracefulShutdown: não força kill se o filho já saiu", async () => {
  const child = fakeChild();
  requestGracefulShutdown(child, { timeoutMs: 20 });
  child.exitCode = 0;
  child.emit("exit", 0);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepStrictEqual(child.killed, []);
});

test("requestGracefulShutdown: sem IPC cai para SIGTERM", () => {
  const child = fakeChild({ connected: false });
  requestGracefulShutdown(child, { timeoutMs: 10_000 });
  assert.deepStrictEqual(child.sent, []);
  assert.deepStrictEqual(child.killed, ["SIGTERM"]);
  child.exitCode = 0;
  child.emit("exit", 0);
});

test("requestGracefulShutdown: tolera child nulo ou já encerrado", () => {
  assert.doesNotThrow(() => requestGracefulShutdown(null));
  const done = fakeChild();
  done.exitCode = 0;
  requestGracefulShutdown(done, { timeoutMs: 10 });
  assert.deepStrictEqual(done.sent, []);
  assert.deepStrictEqual(done.killed, []);
});

test("server.js: encerra ao receber {type:'shutdown'} via IPC (fork)", async () => {
  const { fork } = require("node:child_process");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-ipc-shutdown-"));
  const port = 45000 + Math.floor(Math.random() * 5000);
  const child = fork(path.join(__dirname, "..", "server.js"), [], {
    env: { ...process.env, LP_DATA_DIR: dataDir, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  try {
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const t0 = Date.now();
    while (!out.includes("Local Player rodando em")) {
      if (child.exitCode !== null || Date.now() - t0 > 5000) throw new Error("servidor não subiu: " + out);
      await new Promise((r) => setTimeout(r, 40));
    }
    const exited = new Promise((r) => child.once("exit", (code) => r(code)));
    child.send({ type: "shutdown" });
    const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
    assert.strictEqual(code, 0, "servidor deve sair com código 0 após shutdown via IPC");
    assert.match(out, /\[SHUTDOWN\]/);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

const { resolveSafeRelPath, isAppDirRel } = require("../server/core/paths");
const { checkDesktopShortcuts, createDesktopShortcuts, removeDesktopShortcuts } = require("../server/system/shortcuts");

test("resolveSafeRelPath: normaliza base com barra no final", () => {
  const os = require("node:os");
  const baseWithSlash = os.tmpdir() + require("node:path").sep;
  const safe = resolveSafeRelPath("curso/aula.mp4", baseWithSlash);
  assert.ok(safe, "base com barra no final deve ser aceito");
  assert.strictEqual(safe.rel, "curso/aula.mp4");
});

test("isAppDirRel: case-insensitive no Windows (win32)", () => {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const { APP_DIR } = require("../server/state");
    const upperApp = APP_DIR.toUpperCase();
    const safe = { abs: require("node:path").join(upperApp, "data", "test.json") };
    assert.strictEqual(isAppDirRel(safe), true, "deve detectar app dir mesmo com casing diferente");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("checkDesktopShortcuts: responde ok:true com supported:false no win32", async () => {
  const originalPlatform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const res = await checkDesktopShortcuts();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.supported, false);
    assert.strictEqual(res.platform, "win32");

    const createRes = await createDesktopShortcuts();
    assert.strictEqual(createRes.ok, false);
    assert.match(createRes.error, /instalador/i);

    const removeRes = await removeDesktopShortcuts();
    assert.strictEqual(removeRes.ok, false);
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});
