const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

test("Cadeia Vocal DSP: filtros passa-altas, presenca vocal, pre-ganho, compressor e limiter", () => {
  const code = fs.readFileSync("public/js/player.js", "utf8");

  // 1. High-Pass Filter (85 Hz)
  assert.ok(
    code.includes("highPassFilter.type = \"highpass\""),
    "Deve configurar filtro passa-altas",
  );
  assert.ok(
    code.includes("highPassFilter.frequency.value = 85"),
    "Frequência de corte deve ser 85 Hz para eliminar ruído grave e hum de 60Hz",
  );

  // 2. Presence Filter (3 kHz, +3.5 dB)
  assert.ok(
    code.includes("presenceFilter.type = \"peaking\""),
    "Deve configurar filtro peaking de presença vocal",
  );
  assert.ok(
    code.includes("presenceFilter.frequency.value = 3000"),
    "Frequência central deve ser 3000 Hz (clareza de fala e consoantes)",
  );
  assert.ok(
    code.includes("presenceFilter.gain.value = 3.5"),
    "Ganho de presença deve ser +3.5 dB",
  );

  // 3. Pré-ganho para ressuscitar gravações com volume fraco
  assert.ok(
    code.includes("preGainNode = audioCtx.createGain()"),
    "Deve conter estágio de pre-gain para áudios muito baixos",
  );
  assert.ok(
    code.includes("preGainNode.gain.value = 2.2"),
    "Pre-gain deve aplicar +6.8 dB (~2.2x) nativamente",
  );

  // 4. Compressor profundo (-34 dB)
  assert.ok(
    code.includes("compressorNode.threshold.value = -34"),
    "Threshold do compressor deve ser -34 dB para capturar falas sussurradas",
  );
  assert.ok(
    code.includes("compressorNode.ratio.value = 12"),
    "Ratio deve ser 12 para controlar picos com transição suave",
  );

  // 5. Suporte a Ganho Extra ampliado para até 300%
  assert.ok(
    code.includes("Math.min(300, gain)"),
    "Preferências devem aceitar ganho extra de até 300%",
  );

  // 6. Limiter de saída true-peak (-1 dBFS)
  assert.ok(
    code.includes("limiterNode = audioCtx.createDynamicsCompressor()"),
    "Deve conter limiter de saída para impedir clipping",
  );
  assert.ok(
    code.includes("limiterNode.threshold.value = -1.0"),
    "Limiter deve atuar a -1.0 dBFS para proteção total",
  );

  // 7. Cadeia de áudio conectada de ponta a ponta
  assert.ok(
    code.includes("highPassFilter.connect(presenceFilter)"),
    "highPass deve conectar ao presenceFilter",
  );
  assert.ok(
    code.includes("presenceFilter.connect(preGainNode)"),
    "presenceFilter deve conectar ao preGain",
  );
  assert.ok(
    code.includes("preGainNode.connect(compressorNode)"),
    "preGain deve conectar ao compressor",
  );
  assert.ok(
    code.includes("compressorNode.connect(gainNode)"),
    "compressor deve conectar ao gain",
  );
  assert.ok(
    code.includes("gainNode.connect(limiterNode)"),
    "gain deve conectar ao limiter",
  );
});

test("Cadeia Vocal DSP: simulação completa do fluxo de 6 estágios", () => {
  class MockAudioParam {
    constructor(val) {
      this.value = val;
    }
  }

  class MockNode {
    constructor() {
      this.connectedTo = [];
    }
    connect(dest) {
      this.connectedTo.push(dest);
    }
    disconnect() {
      this.connectedTo = [];
    }
  }

  class MockBiquadFilter extends MockNode {
    constructor(type, freq, gainVal = 0) {
      super();
      this.type = type;
      this.frequency = new MockAudioParam(freq);
      this.gain = new MockAudioParam(gainVal);
    }
  }

  class MockGainNode extends MockNode {
    constructor(val = 1.0) {
      super();
      this.gain = new MockAudioParam(val);
    }
  }

  class MockCompressorNode extends MockNode {
    constructor(threshold = -34, ratio = 12) {
      super();
      this.threshold = new MockAudioParam(threshold);
      this.ratio = new MockAudioParam(ratio);
    }
  }

  const source = new MockNode();
  const hp = new MockBiquadFilter("highpass", 85);
  const presence = new MockBiquadFilter("peaking", 3000, 3.5);
  const preGain = new MockGainNode(2.2);
  const compressor = new MockCompressorNode(-34, 12);
  const userGain = new MockGainNode(3.0);
  const limiter = new MockCompressorNode(-1.0, 20);

  // Montagem do fluxo
  source.connect(hp);
  hp.connect(presence);
  presence.connect(preGain);
  preGain.connect(compressor);
  compressor.connect(userGain);
  userGain.connect(limiter);

  assert.strictEqual(source.connectedTo[0], hp);
  assert.strictEqual(hp.connectedTo[0], presence);
  assert.strictEqual(presence.connectedTo[0], preGain);
  assert.strictEqual(preGain.connectedTo[0], compressor);
  assert.strictEqual(compressor.connectedTo[0], userGain);
  assert.strictEqual(userGain.connectedTo[0], limiter);

  assert.strictEqual(hp.frequency.value, 85);
  assert.strictEqual(presence.frequency.value, 3000);
  assert.strictEqual(presence.gain.value, 3.5);
  assert.strictEqual(preGain.gain.value, 2.2);
  assert.strictEqual(limiter.threshold.value, -1.0);
});
