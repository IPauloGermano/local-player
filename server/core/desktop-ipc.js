// Suporte a diálogo nativo do sistema operacional (Desktop / Electron IPC)

const pendingDesktopIpc = new Map();
let desktopIpcSeq = 1;

if (typeof process.on === "function") {
  process.on("message", (msg) => {
    if (msg && msg.id && pendingDesktopIpc.has(msg.id)) {
      const { resolve } = pendingDesktopIpc.get(msg.id);
      pendingDesktopIpc.delete(msg.id);
      resolve(msg);
    }
  });
}

function requestDesktopIpc(type, payload = {}) {
  return new Promise((resolve) => {
    if (typeof process.send !== "function") {
      return resolve({ supported: false, error: "not_desktop" });
    }
    const id = desktopIpcSeq++;
    const timer = setTimeout(() => {
      pendingDesktopIpc.delete(id);
      resolve({ supported: true, error: "timeout" });
    }, 120000);
    pendingDesktopIpc.set(id, {
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
    });
    process.send({ id, type, ...payload });
  });
}

module.exports = {
  requestDesktopIpc,
};
