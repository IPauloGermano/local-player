#!/usr/bin/env node
// tools/clean-audio.js
// Ferramenta CLI de limpeza de áudio com Rede Neural (RNNoise / arnndn) + Noise Gate acústico + Filtros de ressonância
// Remove eco de sala, reverberação e ruídos de microfone preservando 100% da qualidade de vídeo (-c:v copy).

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawn } = require("node:child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const MODELS_DIR = path.join(ROOT_DIR, "data", "models");
const DEFAULT_MODEL_PATH = path.join(MODELS_DIR, "speech-enhance.rnnn");
const MODEL_URL = "https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn";

// Garante o diretório de modelos
function ensureModelsDir() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }
}

// Faz o download do modelo compacto da rede neural (apenas ~290 KB) se necessário
async function ensureRnnModel(targetPath = DEFAULT_MODEL_PATH) {
  if (fs.existsSync(targetPath)) {
    return targetPath;
  }
  ensureModelsDir();
  console.log("[IA] Baixando modelo compacto de rede neural (291 KB)...");
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(targetPath);
    const get = (url) => {
      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(targetPath);
          reject(new Error(`Falha no download do modelo (HTTP ${res.statusCode})`));
          return;
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            console.log("[IA] Modelo configurado com sucesso em:", targetPath);
            resolve(targetPath);
          });
        });
      }).on("error", (err) => {
        try { fs.unlinkSync(targetPath); } catch {}
        reject(err);
      });
    };
    get(MODEL_URL);
  });
}

function buildFfmpegArgs({ inputPath, outputPath, modelPath, previewSeconds, replaceOriginal }) {
  // Cadeia de filtros:
  // 1. highpass=f=95: elimina vibrações graves e ruído de 60Hz sem cortar os graves da voz masculina
  // 2. equalizer=f=360:width_type=q:w=1.4:g=-6: atenua a ressonância de caixa/sala (boxiness)
  // 3. arnndn=m=<model>: rede neural recorrente que isola a voz humana e suprime reverberação e ruídos
  // 4. agate=...: gate acústico que zera as caudas de eco restantes durante pausas de fala
  const filters = [
    "highpass=f=95",
    "equalizer=f=360:width_type=q:w=1.4:g=-6",
  ];
  if (modelPath && fs.existsSync(modelPath)) {
    // Normaliza caminho para sintaxe de filtro do ffmpeg (escapando dois pontos no Windows)
    const escapedModel = modelPath.replace(/\\/g, "/").replace(/:/g, "\\:");
    filters.push(`arnndn=m='${escapedModel}'`);
  }
  filters.push("agate=threshold=-34dB:ratio=2.2:attack=10:release=120:range=-16dB");

  const args = ["-hide_banner", "-loglevel", "error", "-stats"];

  if (previewSeconds && previewSeconds > 0) {
    args.push("-t", String(previewSeconds));
  }

  args.push("-i", inputPath);
  args.push("-af", filters.join(","));
  args.push("-c:v", "copy"); // NUNCA reencoda vídeo (zero perda de qualidade, velocidade máxima)
  args.push("-c:a", "aac", "-b:a", "192k");
  args.push("-y", outputPath);

  return args;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
    const child = spawn(ffmpegBin, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg finalizou com código ${code}`));
    });
  });
}

async function cleanFile(filePath, opts = {}) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`[ERRO] Arquivo não encontrado: ${filePath}`);
    return false;
  }

  const ext = path.extname(absPath);
  const baseName = path.basename(absPath, ext);
  const dirName = path.dirname(absPath);
  
  let outputPath;
  if (opts.preview) {
    outputPath = path.join(dirName, `${baseName}.preview-clean${ext}`);
  } else if (opts.inplace) {
    outputPath = path.join(dirName, `${baseName}.tmp-clean${ext}`);
  } else {
    outputPath = path.join(dirName, `${baseName}_limpo${ext}`);
  }

  console.log(`\n--------------------------------------------------`);
  console.log(`[PROCESSANDO] ${path.basename(absPath)}`);
  if (opts.preview) console.log(`[MODO PREVIEW] Primeiros ${opts.preview} segundos`);

  const modelPath = await ensureRnnModel(opts.modelPath || DEFAULT_MODEL_PATH).catch((err) => {
    console.warn("[AVISO] Não foi possível carregar modelo de IA; usando filtros acústicos de fallback:", err.message);
    return null;
  });

  const args = buildFfmpegArgs({
    inputPath: absPath,
    outputPath,
    modelPath,
    previewSeconds: opts.preview,
  });

  const t0 = Date.now();
  try {
    await runFfmpeg(args);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    
    if (opts.inplace && !opts.preview) {
      const backupPath = path.join(dirName, `${baseName}.orig${ext}`);
      if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(absPath, backupPath);
        console.log(`[BACKUP] Cópia original salva em: ${path.basename(backupPath)}`);
      }
      fs.renameSync(outputPath, absPath);
      console.log(`[CONCLUÍDO] Vídeo atualizado com sucesso em ${elapsed}s!`);
    } else {
      console.log(`[CONCLUÍDO] Arquivo limpo gerado em ${elapsed}s:`);
      console.log(`-> ${outputPath}`);
    }
    return true;
  } catch (err) {
    console.error(`[FALHA] Erro ao processar áudio:`, err.message);
    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch {}
    }
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log(`
Uso: npm run clean-audio -- <arquivo-ou-pasta> [opções]
  ou: node tools/clean-audio.js <arquivo-ou-pasta> [opções]

Opções:
  --preview [segundos]  Gera apenas um clipe rápido de teste (padrão: 30s) para avaliar o som.
  --inplace             Substitui o arquivo original criando um backup seguro (.orig.mp4).
  --model <caminho>     Especifica um arquivo de modelo .rnnn customizado.
  -h, --help            Exibe esta ajuda.

Exemplos:
  npm run clean-audio -- "aulas/modulo-1/aula-01.mp4" --preview
  npm run clean-audio -- "aulas/modulo-1/aula-01.mp4"
  npm run clean-audio -- "aulas/modulo-1/aula-01.mp4" --inplace
`);
    process.exit(0);
  }

  let previewSeconds = null;
  let inplace = false;
  let customModel = null;
  const targets = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--preview") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && Number(next) > 0) {
        previewSeconds = Number(next);
        i++;
      } else {
        previewSeconds = 30;
      }
    } else if (arg === "--inplace") {
      inplace = true;
    } else if (arg === "--model" && argv[i + 1]) {
      customModel = argv[++i];
    } else if (!arg.startsWith("-")) {
      targets.push(arg);
    }
  }

  if (targets.length === 0) {
    console.error("Nenhum arquivo ou pasta especificado.");
    process.exit(1);
  }

  const mediaExts = new Set([".mp4", ".mkv", ".webm", ".avi", ".mov", ".m4v"]);

  for (const target of targets) {
    const abs = path.resolve(target);
    if (!fs.existsSync(abs)) {
      console.error(`Alvo inexistente: ${target}`);
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(abs);
      for (const entry of entries) {
        const full = path.join(abs, entry);
        if (fs.statSync(full).isFile() && mediaExts.has(path.extname(entry).toLowerCase())) {
          await cleanFile(full, { preview: previewSeconds, inplace, modelPath: customModel });
        }
      }
    } else if (stat.isFile()) {
      await cleanFile(abs, { preview: previewSeconds, inplace, modelPath: customModel });
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}

module.exports = {
  buildFfmpegArgs,
  cleanFile,
  ensureRnnModel,
};
