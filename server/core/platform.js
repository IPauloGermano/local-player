// Diferenças de plataforma (Linux/Windows) sem dependências — usado tanto pelo
// servidor quanto pelo electron-main.js (que não pode puxar state/express).

// No Windows executáveis têm extensão .exe; spawn/existsSync com o nome sem
// extensão não encontram o arquivo embutido.
function executableName(base, platform = process.platform) {
  if (platform !== "win32") return base;
  return /\.exe$/i.test(base) ? base : `${base}.exe`;
}

// Encerramento gracioso de um filho criado com fork(). No Windows não existem
// sinais POSIX: kill("SIGTERM") termina o processo na hora e o handler de
// SIGTERM do servidor (flush de progresso, parada de ffmpeg/whisper) nunca
// roda. Por isso pedimos o shutdown pelo canal IPC (multiplataforma) e só
// forçamos o kill se o filho não sair no prazo.
function requestGracefulShutdown(child, { timeoutMs = 4000 } = {}) {
  if (!child || child.exitCode !== null) return;
  if (child.connected && typeof child.send === "function") {
    try {
      child.send({ type: "shutdown" });
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }, timeoutMs);
  if (timer.unref) timer.unref();
  child.once("exit", () => clearTimeout(timer));
}

module.exports = {
  executableName,
  requestGracefulShutdown,
};
