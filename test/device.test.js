// Testes unitários para detecção e montagem automática de dispositivos removíveis
const test = require("node:test");
const assert = require("node:assert");

const {
  DEVICE_UNAVAILABLE_CODES,
  isDeviceUnavailableCode,
  ensureRemovableDrivesMounted,
} = require("../server/core/device");
const serverModules = require("../server/index");

test("device: isDeviceUnavailableCode identifica códigos reais de hardware/disco indisponível", () => {
  assert.strictEqual(isDeviceUnavailableCode("ENODEV"), true);
  assert.strictEqual(isDeviceUnavailableCode("EIO"), true);
  assert.strictEqual(isDeviceUnavailableCode("ESTALE"), true);
  assert.strictEqual(isDeviceUnavailableCode("ENXIO"), true);
  assert.strictEqual(isDeviceUnavailableCode("EBUSY"), true);
  assert.strictEqual(isDeviceUnavailableCode("ENOTCONN"), true);
  assert.strictEqual(isDeviceUnavailableCode("ENOENT"), true);

  assert.strictEqual(isDeviceUnavailableCode("EACCES"), false);
  assert.strictEqual(isDeviceUnavailableCode("EPERM"), false);
  assert.strictEqual(isDeviceUnavailableCode("EINVAL"), false);
  assert.strictEqual(isDeviceUnavailableCode(null), false);
  assert.strictEqual(isDeviceUnavailableCode(undefined), false);
  assert.strictEqual(isDeviceUnavailableCode(123), false);
});

test("device: server/index exporta funções de dispositivo", () => {
  assert.strictEqual(typeof serverModules.ensureRemovableDrivesMounted, "function");
  assert.strictEqual(typeof serverModules.isDeviceUnavailableCode, "function");
  assert.ok(serverModules.DEVICE_UNAVAILABLE_CODES instanceof Set);
});

test("device: ensureRemovableDrivesMounted executa sem erros e resolve para boolean", async () => {
  const res = await ensureRemovableDrivesMounted();
  assert.strictEqual(typeof res, "boolean");
});
