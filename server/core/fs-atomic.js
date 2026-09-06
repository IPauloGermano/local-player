// Escrita atômica e leitura resiliente de arquivos no disco
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { spawn } = require("child_process");

// Lê um arquivo JSON e valida a forma esperada (objeto não-vazio). `raw` é
// preservado para distinguir "arquivo inexistente" de "arquivo corrompido".
async function readJsonFile(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { ok: false, raw: null, parsed: null };
  }
  try {
    const parsed = JSON.parse(raw);
    const ok = parsed && typeof parsed === "object" && !Array.isArray(parsed);
    return { ok, raw, parsed: ok ? parsed : null };
  } catch {
    // JSON inválido: o arquivo existe mas está corrompido.
    return { ok: false, raw, parsed: null };
  }
}

// Escrita atômica e durável: o conteúdo vai para um arquivo temporário
// exclusivo, é sincronizado no disco (fsync) e só então renomeado sobre o
// destino. O fsync antes do rename garante que os dados sobrevivam a um
// desligamento brusco (restart do sistema, queda de energia, desmontagem do
// pendrive) — sem ele, o kernel pode descartar o buffer não sincronizado e
// o arquivo final fica truncado/corrompido.
async function writeFileAtomic(file, content) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fh = await fs.open(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmp, file);
  try {
    const dirFh = await fs.open(dir, "r");
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close();
    }
  } catch {
    // fsync de diretório não é suportado em todos os sistemas/filesystems;
    // sem ele a escrita atômica continua funcionando.
  }
}

// Versão SÍNCRONA da escrita atômica, usada apenas no shutdown (o processo
// está sendo encerrado e não pode esperar I/O async). Mesmo contrato:
// temporário exclusivo → fsync → rename sobre o destino. Se a energia cair no
// meio, o jobs.json original permanece íntegro (nunca fica truncado).
function writeFileAtomicSync(file, content) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fsSync.openSync(tmp, "w", 0o644);
    fsSync.writeSync(fd, content, null, "utf8");
    fsSync.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { fsSync.closeSync(fd); } catch {}
    }
  }
  fsSync.renameSync(tmp, file);
}

// Durabilidade no vfat: fsync+rename da writeFileAtomic não garantem que a
// tabela FAT/entrada de diretório chegou ao dispositivo físico — numa remoção
// brusca o progress.json e o backup podem ser zerados juntos. `sync -f`
// (syncfs do Linux, coreutils) força o flush de TODA a filesystem que contém
// o arquivo, fechando essa janela. Fire-and-forget coalescido (um sync por
// vez).
let volumeSyncRunning = false;
function requestVolumeSync(file) {
  if (process.platform !== "linux" || volumeSyncRunning) return;
  volumeSyncRunning = true;
  try {
    const child = spawn("sync", ["-f", file], { stdio: "ignore" });
    const done = () => {
      volumeSyncRunning = false;
    };
    child.on("exit", done);
    child.on("error", done);
  } catch {
    volumeSyncRunning = false;
  }
}

module.exports = {
  readJsonFile,
  writeFileAtomic,
  writeFileAtomicSync,
  requestVolumeSync,
};
