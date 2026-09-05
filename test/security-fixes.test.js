"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fsSync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  isPrivateIp,
  validateSafeUrl,
  verifyCsrfAndSafeOrigin,
  isLocalRequest,
  sanitizeDisplayPath,
  refreshHeavyMax,
  heavySlots,
} = require("../server");

const SERVER = path.join(__dirname, "..", "server.js");

function tmpDir(prefix) {
  return fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startServer(dataDir) {
  const basePort = 35000 + Math.floor(Math.random() * 10000);
  for (let attempt = 0; attempt < 5; attempt++) {
    const p = basePort + attempt * 11;
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
        if (out.includes("Local Player rodando em")) return resolve(true);
        if (Date.now() - t0 > 4000) return resolve(false);
        setTimeout(poll, 40);
      };
      poll();
    });
    if (ready) {
      return {
        base: `http://127.0.0.1:${p}`,
        proc,
        dataDir,
        stop: async () => {
          proc.kill("SIGTERM");
          await new Promise((r) => proc.on("exit", r));
        },
      };
    }
    try { proc.kill("SIGKILL"); } catch {}
  }
  throw new Error("Falha ao subir servidor de teste para security-fixes");
}

// ---------------------------------------------------------------------------
// 1. SSRF & IP / URL Validation Tests
// ---------------------------------------------------------------------------
test("Segurança Anti-SSRF: detecção de IPv4 e IPv6 privados/especiais (isPrivateIp)", () => {
  // IPv4 Loopback & Special
  assert.strictEqual(isPrivateIp("127.0.0.1"), true);
  assert.strictEqual(isPrivateIp("127.255.255.255"), true);
  assert.strictEqual(isPrivateIp("0.0.0.0"), true);
  assert.strictEqual(isPrivateIp("255.255.255.255"), true);

  // RFC 1918 Private ranges
  assert.strictEqual(isPrivateIp("10.0.0.1"), true);
  assert.strictEqual(isPrivateIp("10.255.255.255"), true);
  assert.strictEqual(isPrivateIp("172.16.0.1"), true);
  assert.strictEqual(isPrivateIp("172.31.255.255"), true);
  assert.strictEqual(isPrivateIp("192.168.0.1"), true);
  assert.strictEqual(isPrivateIp("192.168.255.255"), true);

  // Cloud metadata / Link-local
  assert.strictEqual(isPrivateIp("169.254.169.254"), true);
  assert.strictEqual(isPrivateIp("169.254.1.1"), true);

  // CGNAT (100.64.0.0/10)
  assert.strictEqual(isPrivateIp("100.64.0.1"), true);
  assert.strictEqual(isPrivateIp("100.127.255.254"), true);
  assert.strictEqual(isPrivateIp("100.63.255.255"), false); // fora do range CGNAT
  assert.strictEqual(isPrivateIp("100.128.0.0"), false); // fora do range CGNAT

  // IPv6 Loopback & Unique Local & Link-local
  assert.strictEqual(isPrivateIp("::1"), true);
  assert.strictEqual(isPrivateIp("::"), true);
  assert.strictEqual(isPrivateIp("fc00::1"), true);
  assert.strictEqual(isPrivateIp("fd12:3456:789a::1"), true);
  assert.strictEqual(isPrivateIp("fe80::1"), true);

  // IPv4-mapped IPv6
  assert.strictEqual(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.strictEqual(isPrivateIp("::ffff:10.1.2.3"), true);
  assert.strictEqual(isPrivateIp("::ffff:192.168.1.1"), true);
  assert.strictEqual(isPrivateIp("::ffff:169.254.169.254"), true);
  assert.strictEqual(isPrivateIp("::ffff:100.64.0.1"), true);
  // IPv4-mapped IPv6 em notação hexadecimal (::ffff:7f00:1 = 127.0.0.1)
  assert.strictEqual(isPrivateIp("::ffff:7f00:1"), true);
  assert.strictEqual(isPrivateIp("::ffff:c0a8:1"), true); // 192.168.0.1

  // 6to4 tunneling (2002::/16) embedding private IPv4
  assert.strictEqual(isPrivateIp("2002:7f00:0001::"), true); // 127.0.0.1
  assert.strictEqual(isPrivateIp("2002:0a00:0001::"), true); // 10.0.0.1

  // Public IPs
  assert.strictEqual(isPrivateIp("8.8.8.8"), false);
  assert.strictEqual(isPrivateIp("1.1.1.1"), false);
  assert.strictEqual(isPrivateIp("2607:f8b0:4005:805::200e"), false);
});

test("Segurança Anti-SSRF: validação de esquemas e portas (validateSafeUrl)", async () => {
  // Protocolos perigosos
  let res = await validateSafeUrl("ftp://example.com");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /apenas http/i);

  res = await validateSafeUrl("file:///etc/passwd");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /apenas http/i);

  res = await validateSafeUrl("gopher://127.0.0.1");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /apenas http/i);

  // Portas não-web perigosas
  res = await validateSafeUrl("http://example.com:22");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /porta.*não permitida/i);

  res = await validateSafeUrl("http://example.com:25");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /porta.*não permitida/i);

  res = await validateSafeUrl("http://example.com:6379");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /porta.*não permitida/i);

  res = await validateSafeUrl("http://example.com:11211");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /porta.*não permitida/i);

  // Loopback / hosts internos
  res = await validateSafeUrl("http://localhost");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /SSRF/i);

  res = await validateSafeUrl("http://127.0.0.1");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /SSRF/i);

  res = await validateSafeUrl("http://[::1]");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /SSRF/i);

  res = await validateSafeUrl("http://app.internal");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /SSRF/i);

  res = await validateSafeUrl("http://router.local");
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /SSRF/i);
});

// ---------------------------------------------------------------------------
// 2. CSRF & Safe Origin Tests
// ---------------------------------------------------------------------------
test("Segurança CSRF: isLocalRequest e verifyCsrfAndSafeOrigin", () => {
  // isLocalRequest
  assert.strictEqual(isLocalRequest({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.strictEqual(isLocalRequest({ socket: { remoteAddress: "::1" } }), true);
  assert.strictEqual(isLocalRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.strictEqual(isLocalRequest({ socket: { remoteAddress: "192.168.1.100" } }), false);
  assert.strictEqual(isLocalRequest({ socket: { remoteAddress: "10.0.0.2" } }), false);

  // verifyCsrfAndSafeOrigin
  // Cross-site via Sec-Fetch-Site deve falhar
  const crossSiteRes = verifyCsrfAndSafeOrigin({
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.strictEqual(crossSiteRes.ok, false);
  assert.strictEqual(crossSiteRes.status, 403);

  // Origin malicioso divergente do Host
  const evilOriginRes = verifyCsrfAndSafeOrigin({
    headers: {
      host: "localhost:4173",
      origin: "http://malicious-site.com",
    },
  });
  assert.strictEqual(evilOriginRes.ok, false);
  assert.strictEqual(evilOriginRes.status, 403);

  // Same-origin válido via Sec-Fetch-Site
  const sameOriginRes = verifyCsrfAndSafeOrigin({
    headers: {
      "sec-fetch-site": "same-origin",
    },
  });
  assert.strictEqual(sameOriginRes.ok, true);

  // Same-site válido
  const sameSiteRes = verifyCsrfAndSafeOrigin({
    headers: {
      "sec-fetch-site": "same-site",
    },
  });
  assert.strictEqual(sameSiteRes.ok, true);

  // Origin correspondente ao Host
  const validOriginRes = verifyCsrfAndSafeOrigin({
    headers: {
      host: "127.0.0.1:4173",
      origin: "http://127.0.0.1:4173",
    },
  });
  assert.strictEqual(validOriginRes.ok, true);
});

// ---------------------------------------------------------------------------
// 3. Path Sanitization & Display Tests
// ---------------------------------------------------------------------------
test("Segurança: sanitização de caminhos do sistema (sanitizeDisplayPath)", () => {
  const home = os.homedir();
  const samplePath = path.join(home, "Cursos", "NodeJS");
  const sanitized = sanitizeDisplayPath(samplePath);
  assert.ok(sanitized.startsWith("~"), "Deve substituir home por ~");
  assert.ok(!sanitized.includes(home), "Não deve expor o caminho absoluto completo da home");

  assert.strictEqual(sanitizeDisplayPath(null), "");
  assert.strictEqual(sanitizeDisplayPath(""), "");
});

// ---------------------------------------------------------------------------
// 4. Heavy Slot / Concurrency Drainage
// ---------------------------------------------------------------------------
test("Concorrência: refreshHeavyMax drena imediatamente garçons na fila", () => {
  const origUsed = heavySlots.used;
  const origWaiters = [...heavySlots.waiters];

  try {
    heavySlots.used = 1;
    heavySlots.waiters = [];

    let notified1 = false;
    let notified2 = false;

    heavySlots.waiters.push(() => { notified1 = true; });
    heavySlots.waiters.push(() => { notified2 = true; });

    // Libera um slot e chama refreshHeavyMax
    heavySlots.used = 0;
    refreshHeavyMax(1);

    assert.strictEqual(notified1, true, "Primeiro waiter deve ser acordado");
    assert.strictEqual(heavySlots.used, 1, "Slot deve ser ocupado pelo waiter acordado");
  } finally {
    heavySlots.used = origUsed;
    heavySlots.waiters = origWaiters;
  }
});

// ---------------------------------------------------------------------------
// 5. Integração HTTP: CSRF, Clear de Progresso, Transcode e Directory 404
// ---------------------------------------------------------------------------
test("Integração HTTP: proteção CSRF e validações em endpoints destrutivos", async () => {
  const srv = await startServer(tmpDir("lp-sec-http-"));
  try {
    // 1. POST /api/progress/clear com {} deve retornar 400 Bad Request
    const resEmpty = await fetch(`${srv.base}/api/progress/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.strictEqual(resEmpty.status, 400, "Corpo vazio deve retornar 400");
    const jsonEmpty = await resEmpty.json();
    assert.ok(jsonEmpty.error.includes("ambíguo") || jsonEmpty.error.includes("all: true"));

    // 2. POST /api/progress/clear com Sec-Fetch-Site: cross-site deve retornar 403 Forbidden
    const resCross = await fetch(`${srv.base}/api/progress/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ all: true }),
    });
    assert.strictEqual(resCross.status, 403, "Cross-site request deve retornar 403");

    // 3. POST /api/progress/clear com Origin malicioso deve retornar 403 Forbidden
    const resEvil = await fetch(`${srv.base}/api/progress/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "http://evil-attacker.com",
      },
      body: JSON.stringify({ all: true }),
    });
    assert.strictEqual(resEvil.status, 403, "Origin falso deve retornar 403");

    // 4. POST /api/progress/clear com { all: true } e same-origin deve retornar 200
    const resOk = await fetch(`${srv.base}/api/progress/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ all: true }),
    });
    assert.strictEqual(resOk.status, 200, "Same-origin com all: true deve retornar 200");

    // 5. POST /api/transcode/clear com cross-site deve retornar 403
    const resTranscodeCross = await fetch(`${srv.base}/api/transcode/clear`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ confirm: true }),
    });
    assert.strictEqual(resTranscodeCross.status, 403, "Transcode clear cross-site deve retornar 403");

    // 6. POST /api/ai/llm/test com loopback/ip privado deve retornar 400
    const resLlmTest = await fetch(`${srv.base}/api/ai/llm/test`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({
        provider: "custom",
        customEndpoint: "http://127.0.0.1:22",
      }),
    });
    assert.strictEqual(resLlmTest.status, 400, "Endpoint privado em test deve retornar 400");
    const jsonLlm = await resLlmTest.json();
    assert.ok(jsonLlm.error, "Deve conter mensagem de erro de SSRF / porta / validação");

    // 7. GET /media em pasta (diretório) deve responder 404 sem erro 500/EISDIR
    const resMediaDir = await fetch(`${srv.base}/media/`);
    assert.strictEqual(resMediaDir.status, 404, "Acesso a diretório em /media deve ser 404");

    // 8. GET /api/libraries não deve expor caminho absoluto da biblioteca padrão
    const resLibs = await fetch(`${srv.base}/api/libraries`);
    assert.strictEqual(resLibs.status, 200);
    const dataLibs = await resLibs.json();
    const defaultLib = dataLibs.libraries.find((l) => l.isDefault || l.id === "default");
    assert.ok(defaultLib, "Biblioteca padrão deve existir");
    assert.strictEqual(defaultLib.path, null, "Caminho da biblioteca padrão deve ser null");
  } finally {
    await srv.stop();
  }
});
