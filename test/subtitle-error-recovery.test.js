// Testes de recuperação de erro e reinício forçado (force: true) de legendas.
// node:test + node:assert (stdlib) — sem dependências externas.
const test = require("node:test");
const assert = require("node:assert");

const {
  subtitleCacheName,
  startSubtitleJob,
  cancelSubtitleJob,
  subtitleJobs,
} = require("../server.js");

test("startSubtitleJob: deduplica jobs ativos quando force não é fornecido", () => {
  const lib = { id: "test-lib", path: "/tmp/fake-lib" };
  const rel = "Modulo 1/Aula 01.mp4";
  const abs = "/tmp/fake-lib/Modulo 1/Aula 01.mp4";
  const hash = subtitleCacheName(lib.id, rel);

  // Limpa se houver job residual
  cancelSubtitleJob(hash);
  subtitleJobs.delete(hash);

  const res1 = startSubtitleJob(lib, rel, abs, { priority: 2 });
  assert.ok(res1.job);
  assert.strictEqual(res1.alreadyRunning, false);

  // Segunda chamada sem force: deve dedupar
  const res2 = startSubtitleJob(lib, rel, abs, { priority: 2 });
  assert.strictEqual(res2.alreadyRunning, true);
  assert.strictEqual(res2.job.hash, hash);

  // Limpa após o teste
  cancelSubtitleJob(hash);
  subtitleJobs.delete(hash);
});

test("startSubtitleJob: com force=true destrava job ativo cancelando o anterior e reiniciando", () => {
  const lib = { id: "test-lib", path: "/tmp/fake-lib" };
  const rel = "Modulo 1/Aula 02.mp4";
  const abs = "/tmp/fake-lib/Modulo 1/Aula 02.mp4";
  const hash = subtitleCacheName(lib.id, rel);

  // Limpa se houver job residual
  cancelSubtitleJob(hash);
  subtitleJobs.delete(hash);

  // Inicia um job que fica travado/ativo em 'extracting'
  const res1 = startSubtitleJob(lib, rel, abs, { priority: 2 });
  res1.job.status = "extracting";

  // Chamada com force=true: deve destravar e reiniciar em vez de devolver alreadyRunning: true
  const res2 = startSubtitleJob(lib, rel, abs, { priority: 0, force: true });
  assert.notStrictEqual(res2.alreadyRunning, true);
  assert.strictEqual(res2.job.hash, hash);
  assert.strictEqual(res2.job.priority, 0);

  // Limpa após o teste
  cancelSubtitleJob(hash);
  subtitleJobs.delete(hash);
});
