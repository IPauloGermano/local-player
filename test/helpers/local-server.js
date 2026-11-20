const { fork } = require("node:child_process");
const { once } = require("node:events");
const path = require("node:path");
const { requestGracefulShutdown } = require("../../server/core/platform");

async function startTestServer(dataDir, extraEnv = {}) {
  const proc = fork(path.resolve(__dirname, "../../server.js"), [], {
    env: {
      ...process.env, LP_DATA_DIR: dataDir, LP_ROOT_DIR: dataDir,
      HOST: "127.0.0.1", PORT: "0", ...extraEnv,
    },
    silent: true,
    execArgv: [],
  });
  let log = "";
  const closed = once(proc, "close");
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) requestGracefulShutdown(proc);
    await closed;
  };
  let timer;
  try {
    const base = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Timeout iniciando servidor: " + log)), 30000);
      closed.then(() => reject(new Error("Servidor encerrou durante o boot: " + log)), reject);
      proc.stderr.on("data", chunk => { log += chunk; });
      proc.stdout.on("data", chunk => {
        log += chunk;
        const match = log.match(/Local Player rodando em (http:\/\/127\.0\.0\.1:\d+)\r?\n/);
        if (match) resolve(match[1]);
      });
    });
    return { base, proc, stop, output: () => log };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { startTestServer };
