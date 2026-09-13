const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const { readJsonFile, writeFileAtomic, requestVolumeSync } = require("../core/fs-atomic");
const { getLibraries, getDefaultLibrary } = require("../libraries/registry");
const state = require("../state");
const {
  ROOT,
  DATA_DIR,
  PROGRESS_FILE,
  PROGRESS_BACKUP_FILE,
  PROGRESS_BACKUP2_FILE,
  DEFAULT_LIBRARY_ID,
} = state;

// Helpers de caminho de progresso dentro de cada biblioteca.
// O progresso é salvo em `<lib.path>/.courseplayer/progress.json` para que viaje
// com a própria biblioteca (HD/SSD/pendrive/backup), tornando os dados portáteis.
function libraryProgressDir(lib) {
  if (!lib || typeof lib.path !== "string" || !lib.path) return null;
  if (process.env.LP_DATA_DIR && (lib.isDefault || lib.path === ROOT)) {
    return DATA_DIR;
  }
  return path.join(lib.path, ".courseplayer");
}

function libraryProgressFile(lib) {
  if (!lib || typeof lib.path !== "string" || !lib.path) return null;
  if (process.env.LP_DATA_DIR && (lib.isDefault || lib.path === ROOT)) {
    return PROGRESS_FILE;
  }
  const dir = libraryProgressDir(lib);
  return dir ? path.join(dir, "progress.json") : null;
}

function libraryProgressBackupFile(lib) {
  if (!lib || typeof lib.path !== "string" || !lib.path) return null;
  if (process.env.LP_DATA_DIR && (lib.isDefault || lib.path === ROOT)) {
    return PROGRESS_BACKUP_FILE;
  }
  const dir = libraryProgressDir(lib);
  return dir ? path.join(dir, "progress.json.bak") : null;
}

function libraryProgressBackup2File(lib) {
  if (!lib || typeof lib.path !== "string" || !lib.path) return null;
  if (process.env.LP_DATA_DIR && (lib.isDefault || lib.path === ROOT)) {
    return PROGRESS_BACKUP2_FILE;
  }
  const dir = libraryProgressDir(lib);
  return dir ? path.join(dir, "progress.json.bak.1") : null;
}

// Lê o progresso específico de uma biblioteca (do arquivo na raiz da biblioteca).
async function readLibraryProgress(lib) {
  const file = libraryProgressFile(lib);
  if (!file) return {};
  const main = await readJsonFile(file);
  if (main.ok && main.parsed) return main.parsed;

  if (main.raw !== null) {
    console.error(
      `[PROGRESS] progress.json corrompido na biblioteca "${lib.name || lib.id}"; preservando e recuperando do backup…`,
    );
    await fs
      .rename(file, `${file}.corrupt-${Date.now()}`)
      .catch(() => {});
  }

  const bak1 = libraryProgressBackupFile(lib);
  const bak2 = libraryProgressBackup2File(lib);
  for (const backupFile of [bak1, bak2]) {
    if (!backupFile) continue;
    const backup = await readJsonFile(backupFile);
    if (backup.ok && backup.parsed) return backup.parsed;

    if (backup.raw !== null) {
      console.error(
        `[PROGRESS] ${path.basename(backupFile)} corrompido na biblioteca "${lib.name || lib.id}"; preservando…`,
      );
      await fs
        .rename(backupFile, `${backupFile}.corrupt-${Date.now()}`)
        .catch(() => {});
    }
  }
  return {};
}

// Restaura o arquivo de progresso de uma biblioteca a partir do backup.
async function restoreLibraryProgressFromBackup(lib) {
  const file = libraryProgressFile(lib);
  if (!file || file === PROGRESS_FILE) return false;
  const main = await readJsonFile(file);
  if (main.ok) return false;

  if (main.raw !== null) {
    console.error(
      `[PROGRESS] progress.json corrompido na biblioteca "${lib.name || lib.id}"; preservando e restaurando do backup…`,
    );
    await fs
      .rename(file, `${file}.corrupt-${Date.now()}`)
      .catch(() => {});
  }

  const bak1 = libraryProgressBackupFile(lib);
  const bak2 = libraryProgressBackup2File(lib);
  for (const backupFile of [bak1, bak2]) {
    if (!backupFile) continue;
    const backup = await readJsonFile(backupFile);
    if (backup.ok && backup.raw) {
      console.log(
        `[PROGRESS] recovery: restaurando progresso de ${path.basename(backupFile)} na biblioteca "${lib.name || lib.id}"`,
      );
      await writeFileAtomic(file, backup.raw);
      return true;
    }
    if (backup.raw !== null) {
      console.error(
        `[PROGRESS] ${path.basename(backupFile)} corrompido na biblioteca "${lib.name || lib.id}"; preservando…`,
      );
      await fs
        .rename(backupFile, `${backupFile}.corrupt-${Date.now()}`)
        .catch(() => {});
    }
  }
  return false;
}

// Lê o progresso com recuperação automática e consolidação multi-biblioteca.
// O progresso gravado diretamente na raiz de cada biblioteca (.courseplayer/progress.json)
// é a fonte de verdade portátil, integrado e espelhado com o data/progress.json central.
async function readProgress() {
  const consolidated = {};

  // 1. Lê progresso central (data/progress.json) se existir
  const main = await readJsonFile(PROGRESS_FILE);
  if (main.ok && main.parsed) {
    Object.assign(consolidated, main.parsed);
  } else {
    if (main.raw !== null) {
      console.error(
        "progress.json corrompido; preservando o arquivo e recuperando do backup…",
      );
      await fs
        .rename(PROGRESS_FILE, `${PROGRESS_FILE}.corrupt-${Date.now()}`)
        .catch(() => {});
    }

    // Cadeia de backups central
    for (const backupFile of [PROGRESS_BACKUP_FILE, PROGRESS_BACKUP2_FILE]) {
      const backup = await readJsonFile(backupFile);
      if (backup.ok && backup.parsed) {
        Object.assign(consolidated, backup.parsed);
        break;
      }

      if (backup.raw !== null) {
        console.error(
          `${path.basename(backupFile)} corrompido; preservando e tentando o próximo…`,
        );
        await fs
          .rename(backupFile, `${backupFile}.corrupt-${Date.now()}`)
          .catch(() => {});
      }
    }
  }

  // 2. Lê e mescla o progresso de cada biblioteca registrada (<lib.path>/.courseplayer/progress.json)
  let libs = [];
  try {
    libs = getLibraries();
  } catch {}

  for (const lib of libs) {
    if (!lib || !lib.path) continue;
    const libFile = libraryProgressFile(lib);
    if (libFile === PROGRESS_FILE) continue;
    try {
      const libProg = await readLibraryProgress(lib);
      for (const [key, val] of Object.entries(libProg)) {
        if (!val || typeof val !== "object") continue;
        const cleanRel = key.includes("\0") ? key.slice(key.indexOf("\0") + 1) : key;
        const compositeKey = `${lib.id}\0${cleanRel}`;
        const existing = consolidated[compositeKey];
        if (!existing || (val.updatedAt && (!existing.updatedAt || val.updatedAt >= existing.updatedAt))) {
          consolidated[compositeKey] = val;
        }
      }
    } catch {}
  }

  return consolidated;
}

// Restaura o arquivo PRINCIPAL de progresso a partir do melhor backup válido
// quando o principal está ausente/corrompido. Regra de negócio (caso B do
// recovery): "progress.json ausente + backup válido → restaurar backup". O
// arquivo corrompido é preservado como `.corrupt-<ts>` (evidência para
// diagnóstico — nunca apagado). Só é chamado no boot (initPersistence), antes
// de o servidor aceitar saves, então não há corrida com a fila de escrita.
// Retorna true quando restaurou. Nunca sobrescreve um principal VÁLIDO.
async function restoreProgressFromBackup() {
  const main = await readJsonFile(PROGRESS_FILE);
  if (main.ok) return false; // principal válido — nada a fazer

  if (main.raw !== null) {
    // Corrompido (existe mas não é JSON válido): preserva a evidência.
    console.error(
      "progress.json corrompido; preservando o arquivo e restaurando do backup…",
    );
    await fs
      .rename(PROGRESS_FILE, `${PROGRESS_FILE}.corrupt-${Date.now()}`)
      .catch(() => {});
  }

  for (const backupFile of [PROGRESS_BACKUP_FILE, PROGRESS_BACKUP2_FILE]) {
    const backup = await readJsonFile(backupFile);
    if (backup.ok) {
      console.log(
        `[PROGRESS] recovery: restaurando progresso de ${path.basename(backupFile)}`,
      );
      await writeFileAtomic(PROGRESS_FILE, backup.raw);
      return true;
    }
    // Backup corrompido: preserva a evidência (.corrupt-<ts>) e tenta o
    // próximo na cadeia — nunca apaga arquivo danificado (diagnóstico).
    if (backup.raw !== null) {
      console.error(
        `${path.basename(backupFile)} corrompido; preservando e tentando o próximo…`,
      );
      await fs
        .rename(backupFile, `${backupFile}.corrupt-${Date.now()}`)
        .catch(() => {});
    }
  }
  return false;
}

// sha256 curto do estado serializado — identifica exatamente quando o arquivo
// muda entre duas escritas (forense).
function progressHash(obj) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex")
    .slice(0, 16);
}

// Diferença entre dois estados de progresso (forense + guarda regressiva).
// Devolve os grupos de mudança; não imprime valores além das chaves.
function progressDiff(before, after) {
  const bKeys = new Set(Object.keys(before));
  const aKeys = new Set(Object.keys(after));
  const removed = [];
  const added = [];
  const changed = [];
  const completedRegressions = []; // completed true → não-true
  const durationLost = []; // duration válida (>0) → ausente/0
  const positionAbsent = []; // position válida → ausência
  for (const k of bKeys) {
    if (!aKeys.has(k)) { removed.push(k); continue; }
    const b = before[k];
    const a = after[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      changed.push(k);
      if (b && a && typeof b === "object" && typeof a === "object") {
        if (b.completed === true && a.completed !== true) completedRegressions.push(k);
        if (Number.isFinite(b.duration) && b.duration > 0 && !(Number.isFinite(a.duration) && a.duration > 0)) durationLost.push(k);
        if (Number.isFinite(b.position) && b.position >= 0 && (a.position === undefined || a.position === null || !Number.isFinite(a.position))) positionAbsent.push(k);
      }
    }
  }
  for (const k of aKeys) if (!bKeys.has(k)) added.push(k);
  return { removed, added, changed, completedRegressions, durationLost, positionAbsent };
}

// Modo forense (env LP_PROGRESS_FORENSIC=1): cada escrita registra hash/diff/
// stack e grava snapshot antes, para descobrir QUEM/QUANDO/POR QUE o estado
// muda. Nunca ativo em uso normal.
const progressForensic = process.env.LP_PROGRESS_FORENSIC === "1" || process.env.LP_PROGRESS_FORENSIC === "true";

function updateProgress(mutator, opts = {}) {
  // BUG-002: no shutdown, novos saves são rejeitados — a fila em andamento
  // é drenada com timeout pelo shutdownNow antes do exit.
  if (state.shuttingDown) {
    return Promise.reject(new Error("servidor em desligamento"));
  }
  const allowShrink = opts.allowShrink === true;
  const allowCompletedRegression = opts.allowCompletedRegression === true;
  const requestId = opts.requestId || crypto.randomUUID();
  const run = state.progressWriteQueue.then(async () => {
    const pState = await readProgress();
    // Snapshot do estado ANTES da mutação (para hash/diff/guarda).
    const beforeState = JSON.parse(JSON.stringify(pState));
    const beforeHash = progressHash(pState);
    await mutator(pState);
    const afterHash = progressHash(pState);
    const diff = progressDiff(beforeState, pState);
    const entryCountBefore = Object.keys(beforeState).length;
    const entryCountAfter = Object.keys(pState).length;

    // Guarda anti-perda POR CONTEÚDO: um save NORMAL nunca pode
    //   - remover chaves;
    //   - virar um estado vazio a partir de um não-vazio;
    //   - regredir completed de true para false (exceto toggle manual);
    //   - perder uma duration válida;
    //   - perder uma position válida (virar ausência).
    // A redução de POSIÇÃO é permitida (reassistir/voltar e pausar é regra
    // atual do player — a proteção de reassistir concluído vive no frontend).
    if (!allowShrink) {
      const regressionReasons = [];
      if (diff.removed.length) regressionReasons.push(`removedKeys=${JSON.stringify(diff.removed)}`);
      if (entryCountBefore > 0 && entryCountAfter === 0) regressionReasons.push("estado vazio a partir de não-vazio");
      if (!allowCompletedRegression && diff.completedRegressions.length) regressionReasons.push(`completedRegressions=${JSON.stringify(diff.completedRegressions)}`);
      if (diff.durationLost.length) regressionReasons.push(`durationLost=${JSON.stringify(diff.durationLost)}`);
      if (diff.positionAbsent.length) regressionReasons.push(`positionAbsent=${JSON.stringify(diff.positionAbsent)}`);
      if (regressionReasons.length) {
        console.error(
          `[PROGRESS] rejected invalid state (${entryCountBefore} → ${entryCountAfter} entradas, requestId=${requestId}): ${regressionReasons.join("; ")}; estado persistido preservado`,
        );
        throw new Error("refusing regressive progress write");
      }
    }

    // Forense: registra a tentativa de escrita (hash antes/depois, diff, stack)
    // e grava snapshot em disco — só com LP_PROGRESS_FORENSIC=1.
    if (progressForensic) {
      console.log(
        `[PROGRESS-WRITE] ${new Date().toISOString()} reason=save requestId=${requestId} isClear=${allowShrink} entryCountBefore=${entryCountBefore} entryCountAfter=${entryCountAfter} added=${diff.added.length} removed=${diff.removed.length} changed=${diff.changed.length} beforeHash=${beforeHash} afterHash=${afterHash}`,
      );
      if (diff.removed.length) console.log(`[PROGRESS-WRITE] removedKeys=${JSON.stringify(diff.removed)}`);
      if (diff.changed.length) console.log(`[PROGRESS-WRITE] changedKeys=${JSON.stringify(diff.changed)}`);
      if (diff.completedRegressions.length) console.log(`[PROGRESS-WRITE] completedRegressions=${JSON.stringify(diff.completedRegressions)}`);
      console.log(`[PROGRESS-WRITE] stack:\n${new Error().stack.split("\n").slice(0, 7).join("\n")}`);
      try {
        const snap = path.join(DATA_DIR, `progress.snapshot.${Date.now()}.${requestId}.json`);
        await fs.writeFile(
          snap,
          JSON.stringify({ ts: Date.now(), requestId, isClear: allowShrink, beforeHash, afterHash, before: beforeState, after: pState }, null, 2),
        );
      } catch {}
    }

    // 1. Persistência na pasta de cada biblioteca (<lib.path>/.courseplayer/progress.json)
    let defaultLib = null;
    let libs = [];
    try {
      defaultLib = getDefaultLibrary();
      libs = getLibraries();
    } catch {}

    const progressByLibId = new Map();
    for (const lib of libs) {
      progressByLibId.set(lib.id, {});
    }

    const defaultLibId = defaultLib ? defaultLib.id : DEFAULT_LIBRARY_ID;
    for (const [compositeKey, entry] of Object.entries(pState)) {
      let libId = defaultLibId;
      let rel = compositeKey;
      if (compositeKey.includes("\0")) {
        const idx = compositeKey.indexOf("\0");
        libId = compositeKey.slice(0, idx);
        rel = compositeKey.slice(idx + 1);
      }
      if (!progressByLibId.has(libId)) {
        progressByLibId.set(libId, {});
      }
      progressByLibId.get(libId)[rel] = entry;
    }

    for (const lib of libs) {
      const libData = progressByLibId.get(lib.id) || {};
      const libFile = libraryProgressFile(lib);
      if (!libFile || libFile === PROGRESS_FILE) continue;
      try {
        const libSerialized = JSON.stringify(libData, null, 2);
        const currentLib = await readJsonFile(libFile);
        if (currentLib.ok && currentLib.raw !== libSerialized) {
          const bak1 = libraryProgressBackupFile(lib);
          const bak2 = libraryProgressBackup2File(lib);
          if (bak1 && bak2) {
            await fs.copyFile(bak1, bak2).catch(() => {});
            await writeFileAtomic(bak1, currentLib.raw);
          }
        } else if (!currentLib.ok && currentLib.raw === null) {
          const bak1 = libraryProgressBackupFile(lib);
          if (bak1) {
            const backup = await readJsonFile(bak1);
            if (!backup.ok) {
              await writeFileAtomic(bak1, libSerialized);
            }
          }
        }
        await writeFileAtomic(libFile, libSerialized);
        requestVolumeSync(libFile);
      } catch (err) {
        console.warn(
          `[PROGRESS] Aviso: falha ao salvar progresso na biblioteca "${lib.name || lib.id}": ${err.message}`,
        );
      }
    }

    // 2. Persistência no espelho central data/progress.json
    const serialized = JSON.stringify(pState, null, 2);
    const current = await readJsonFile(PROGRESS_FILE);
    if (current.ok && current.raw !== serialized) {
      // Rotaciona: bak.1 recebe o bak atual antes de o bak ser sobrescrito —
      // segunda camada de recuperação, escrita em momento diferente do main.
      await fs
        .copyFile(PROGRESS_BACKUP_FILE, PROGRESS_BACKUP2_FILE)
        .catch(() => {});
      await writeFileAtomic(PROGRESS_BACKUP_FILE, current.raw);
    } else if (!current.ok && current.raw === null) {
      // BUG-003: primeiro save (main inexistente — instalação nova, ou main já
      // renomeado por corrupção). Não há estado anterior para rotacionar; semeia
      // o backup com o próprio estado para que uma corrupção futura do main
      // tenha ponto de recuperação coerente. Não sobrescreve um backup válido
      // que já exista (preserva a cadeia de recuperação mais antiga).
      const backup = await readJsonFile(PROGRESS_BACKUP_FILE);
      if (!backup.ok) {
        await writeFileAtomic(PROGRESS_BACKUP_FILE, serialized);
      }
    }
    await writeFileAtomic(PROGRESS_FILE, serialized);
    // Força o flush do volume (vfat) para a escrita sobreviver à remoção.
    requestVolumeSync(PROGRESS_FILE);
  });
  // Erro não para a fila; quem chama (a rota) trata e responde 500.
  state.progressWriteQueue = run.catch(() => {});
  return run;
}

// Migra chaves de progresso legadas (sem "\0") para o namespace da biblioteca
// padrão. Idempotente: chaves já com "\0" ficam intactas; nada é perdido. A
// escrita atômica + backup preservam o estado pré-migração (reversível).
async function migrateProgressKeys() {
  const read = await readJsonFile(PROGRESS_FILE);
  if (!read.ok || !read.parsed || typeof read.parsed !== "object") return;
  const prefix = `${DEFAULT_LIBRARY_ID}\0`;
  let changed = false;
  for (const key of Object.keys(read.parsed)) {
    if (key.includes("\0")) continue; // já migrado (ou de biblioteca explícita)
    const value = read.parsed[key];
    delete read.parsed[key];
    read.parsed[prefix + key] = value;
    changed = true;
  }
  if (!changed) return;
  console.log(
    `[PROGRESS] migrando chaves legadas para a biblioteca padrão (${DEFAULT_LIBRARY_ID})…`,
  );
  await writeFileAtomic(PROGRESS_FILE, JSON.stringify(read.parsed, null, 2));
  // O backup também precisa ser migrado? Não: o backup é o estado pré-mudança
  // (reversível); a recuperação automática já cobre chaves sem "\0".
}

module.exports = {
  libraryProgressDir,
  libraryProgressFile,
  libraryProgressBackupFile,
  libraryProgressBackup2File,
  readLibraryProgress,
  restoreLibraryProgressFromBackup,
  readProgress,
  restoreProgressFromBackup,
  progressHash,
  progressDiff,
  progressForensic,
  updateProgress,
  migrateProgressKeys,
  get progressWriteQueue() { return state.progressWriteQueue; },
  set progressWriteQueue(v) { state.progressWriteQueue = v; },
};
