// Gerenciamento de dispositivos de armazenamento removíveis e detecção de status
const { execFile } = require("child_process");

const DEVICE_UNAVAILABLE_CODES = new Set([
  "ENODEV", "EIO", "ESTALE", "ENXIO", "EBUSY", "ENOTCONN", "ENOENT",
]);

function isDeviceUnavailableCode(code) {
  return typeof code === "string" && DEVICE_UNAVAILABLE_CODES.has(code);
}

let mountingPromise = null;

// No Linux, pendrives e discos removíveis conectados antes da inicialização
// da sessão gráfica (boot) não são montados automaticamente pelo udisks2/gvfs
// (que reage apenas a eventos udev de inserção física). Esta função detecta
// partições de blocos removíveis/USB com filesystem válido e sem mountpoint,
// montando-as através do udisksctl (ou gio) sem exigir privilégios de root.
async function ensureRemovableDrivesMounted() {
  if (process.platform !== "linux") return false;
  if (mountingPromise) return mountingPromise;

  mountingPromise = (async () => {
    try {
      const lsblkOut = await new Promise((resolve) => {
        execFile(
          "lsblk",
          ["-r", "-n", "-o", "NAME,TRAN,RM,TYPE,FSTYPE,MOUNTPOINT,LABEL,UUID"],
          { timeout: 3000 },
          (err, stdout) => {
            if (err || !stdout) resolve(null);
            else resolve(stdout);
          },
        );
      });

      if (!lsblkOut) return false;

      const lines = lsblkOut.trim().split("\n");
      const candidates = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const [name, tran, rm, type, fstype, mountpoint] = parts;
        // Identifica partições ou discos com sistema de arquivos sem mountpoint
        const isRemovable = rm === "1" || tran === "usb";
        const isBlockType = type === "part" || type === "disk";
        const hasFs = fstype && fstype !== "[SWAP]";
        const isUnmounted = !mountpoint || mountpoint === "";

        if (isRemovable && isBlockType && hasFs && isUnmounted) {
          candidates.push(name);
        }
      }

      if (candidates.length === 0) return false;

      let mountedCount = 0;
      await Promise.all(
        candidates.map(
          (devName) =>
            new Promise((resDev) => {
              execFile(
                "udisksctl",
                ["mount", "-b", `/dev/${devName}`, "--no-user-interaction"],
                { timeout: 4000 },
                (uErr) => {
                  if (!uErr) {
                    mountedCount++;
                    resDev(true);
                  } else {
                    // Fallback para gio mount se udisksctl falhar
                    execFile(
                      "gio",
                      ["mount", "-d", `/dev/${devName}`],
                      { timeout: 4000 },
                      (gErr) => {
                        if (!gErr) mountedCount++;
                        resDev(!gErr);
                      },
                    );
                  }
                },
              );
            }),
        ),
      );

      return mountedCount > 0;
    } catch {
      return false;
    } finally {
      mountingPromise = null;
    }
  })();

  return mountingPromise;
}

module.exports = {
  DEVICE_UNAVAILABLE_CODES,
  isDeviceUnavailableCode,
  ensureRemovableDrivesMounted,
};
