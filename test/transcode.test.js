const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SERVER = path.join(__dirname, "..", "server.js");
const {
  probeMedia,
  isBrowserCompatibleVideo,
  parseByteRange,
  mediaUrlFromRel,
  clearTranscodeCache,
  transcodeJobs,
  transcodeQueue,
  transcodeHasActiveJobs,
  discardQueuedTranscodeJobsForLibrary,
  TRANSCODED_NAME_RE,
} = require("../server.js");

function tmpDir(prefix) {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer(dataDir) {
  const p = 33000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      LP_DATA_DIR: dataDir,
      PORT: String(p),
      HOST: "127.0.0.1",
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
      if (proc.exitCode !== null) return resolve(false);
      if (out.includes("rodando em") || errOut.includes("rodando em")) return resolve(true);
      if (Date.now() - t0 > 15000) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  });
  if (!ready) throw new Error("Falha ao subir servidor de teste");
  const stop = async () => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await new Promise((resolve) => {
      const t0 = Date.now();
      const poll = () => {
        if (proc.exitCode !== null) return resolve();
        if (Date.now() - t0 > 5000) {
          proc.kill("SIGKILL");
          return resolve();
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  };
  return { base: `http://127.0.0.1:${p}`, proc, stop };
}

test("transcode: isBrowserCompatibleVideo valida contêineres e codecs suportados", () => {
  assert.strictEqual(
    isBrowserCompatibleVideo({
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      streams: [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    }),
    true,
  );

  assert.strictEqual(
    isBrowserCompatibleVideo({
      format_name: "webm",
      streams: [
        { codec_type: "video", codec_name: "vp9" },
        { codec_type: "audio", codec_name: "opus" },
      ],
    }),
    true,
  );

  // MKV não é compatível direto no navegador
  assert.strictEqual(
    isBrowserCompatibleVideo({
      format_name: "matroska,webm",
      streams: [
        { codec_type: "video", codec_name: "h264" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    }),
    false,
  );

  // Codec de vídeo exótico (ex: hevc/h265 ou mpeg2video)
  assert.strictEqual(
    isBrowserCompatibleVideo({
      format_name: "mp4",
      streams: [
        { codec_type: "video", codec_name: "hevc" },
        { codec_type: "audio", codec_name: "aac" },
      ],
    }),
    false,
  );

  // Sem stream de vídeo
  assert.strictEqual(
    isBrowserCompatibleVideo({
      format_name: "mp4",
      streams: [{ codec_type: "audio", codec_name: "aac" }],
    }),
    false,
  );
});

test("transcode: parseByteRange faz parsing correto de cabeçalhos HTTP Range", () => {
  assert.deepStrictEqual(parseByteRange("bytes=0-499"), { start: 0, end: 499 });
  assert.deepStrictEqual(parseByteRange("bytes=500-"), { start: 500, end: null });
  assert.deepStrictEqual(parseByteRange("bytes=-500"), { start: 0, end: 500 });
  assert.strictEqual(parseByteRange(""), null);
  assert.strictEqual(parseByteRange(null), null);
  assert.strictEqual(parseByteRange("invalido"), null);
});

test("transcode: TRANSCODED_NAME_RE valida formato de 24 hex", () => {
  assert.ok(TRANSCODED_NAME_RE.test("0123456789abcdef01234567.mp4"));
  assert.strictEqual(TRANSCODED_NAME_RE.test("short.mp4"), false);
  assert.strictEqual(TRANSCODED_NAME_RE.test("0123456789abcdef01234567.mp4.tmp"), false);
  assert.strictEqual(TRANSCODED_NAME_RE.test("../0123456789abcdef01234567.mp4"), false);
});

test("transcode: mediaUrlFromRel diferencia biblioteca padrão de bibliotecas externas", () => {
  const defaultLib = { id: "default", name: "Default" };
  const extLib = { id: "ext-123", name: "External" };
  assert.strictEqual(mediaUrlFromRel(defaultLib, "Curso 1/Aula 1.mp4"), "/media/Curso%201/Aula%201.mp4");
  assert.strictEqual(mediaUrlFromRel(extLib, "Curso 1/Aula 1.mp4"), "/media/ext-123/Curso%201/Aula%201.mp4");
});

test("transcode: endpoints /api/video/fallback, /transcoded e /api/transcode/clear", async () => {
  const dataDir = tmpDir("lp-transcode-test-");
  const srv = await startServer(dataDir);
  try {
    // 1. Fallback sem caminho ou com caminho inválido
    const res1 = await fetch(srv.base + "/api/video/fallback?path=");
    assert.strictEqual(res1.status, 400);

    // Traversal rejeitado
    const res2 = await fetch(srv.base + "/api/video/fallback?path=../../etc/passwd");
    assert.strictEqual(res2.status, 400);

    // Rota /transcoded/ com cache inexistente
    const res3 = await fetch(srv.base + "/transcoded/0123456789abcdef01234567.mp4");
    assert.strictEqual(res3.status, 404);

    // Rota /transcoded/ com nome inválido cai para próximo handler / 404
    const res4 = await fetch(srv.base + "/transcoded/invalid_name.mp4");
    assert.strictEqual(res4.status, 404);

    // Salva um progresso de teste para garantir que o clear de transcode NUNCA toca progress.json
    await fetch(srv.base + "/api/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "Curso/Aula 1.mp4", position: 120, duration: 300, completed: false }),
    });

    // Cria um arquivo dummy no diretório de transcode
    const transcodeDir = path.join(dataDir, "transcoded");
    await fs.mkdir(transcodeDir, { recursive: true });
    const dummyFile = path.join(transcodeDir, "dummy.mp4");
    await fs.writeFile(dummyFile, "dummy video data");

    // Limpa o cache de transcode
    const clearRes = await fetch(srv.base + "/api/transcode/clear", { method: "POST" });
    assert.strictEqual(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.strictEqual(clearData.ok, true);

    // O arquivo dummy foi removido
    const exists = fsSync.existsSync(dummyFile);
    assert.strictEqual(exists, false);

    // O progresso em progress.json foi PRESERVADO
    const progRes = await fetch(srv.base + "/api/progress");
    const progData = await progRes.json();
    assert.ok(progData["default\0Curso/Aula 1.mp4"], "progresso deve permanecer intacto após limpar transcode");
  } finally {
    await srv.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
