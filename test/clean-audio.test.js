const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { buildFfmpegArgs } = require("../tools/clean-audio");

test("Clean-Audio CLI: montagem de argumentos do FFmpeg e proteção contra re-encode de vídeo", () => {
  const dummyModel = "/tmp/fake-model.rnnn";
  const args = buildFfmpegArgs({
    inputPath: "/tmp/aula.mp4",
    outputPath: "/tmp/aula_limpo.mp4",
    modelPath: dummyModel,
    previewSeconds: 15,
  });

  // 1. Não deve reencodar o vídeo (-c:v copy)
  const cvIndex = args.indexOf("-c:v");
  assert.ok(cvIndex !== -1, "Deve especificar codec de vídeo");
  assert.strictEqual(args[cvIndex + 1], "copy", "Deve copiar a trilha de vídeo sem recompressão");

  // 2. Transmissão de preview (-t 15)
  const tIndex = args.indexOf("-t");
  assert.ok(tIndex !== -1, "Deve conter flag de preview -t");
  assert.strictEqual(args[tIndex + 1], "15", "Duração do preview deve ser 15 segundos");

  // 3. Filtros de áudio
  const afIndex = args.indexOf("-af");
  assert.ok(afIndex !== -1, "Deve conter flag -af");
  const filters = args[afIndex + 1];
  assert.ok(filters.includes("highpass=f=95"), "Deve conter filtro highpass");
  assert.ok(filters.includes("equalizer=f=360"), "Deve conter equalizador cirúrgico de ressonância");
  assert.ok(filters.includes("agate="), "Deve conter noise gate acústico para cauda de eco");

  // 4. Parâmetros de áudio
  const caIndex = args.indexOf("-c:a");
  assert.ok(caIndex !== -1, "Deve especificar codec de áudio");
  assert.strictEqual(args[caIndex + 1], "aac");
});

test("Clean-Audio CLI: modo sem preview processa arquivo completo", () => {
  const args = buildFfmpegArgs({
    inputPath: "/tmp/aula.mp4",
    outputPath: "/tmp/aula_limpo.mp4",
    previewSeconds: null,
  });

  assert.strictEqual(args.includes("-t"), false, "Não deve conter flag -t em render completo");
  const afIndex = args.indexOf("-af");
  assert.ok(args[afIndex + 1].includes("agate"), "Deve incluir gate acústico mesmo sem modelo de IA");
});
