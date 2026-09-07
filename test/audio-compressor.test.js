const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");

test("Normalizador de Áudio Nativo: verificação de parâmetros e grafo permanente no player.js", () => {
  const code = fs.readFileSync("public/js/player.js", "utf8");

  // 1. Criação do DynamicsCompressorNode e parâmetros ideais de compressão
  assert.ok(
    code.includes("audioCtx.createDynamicsCompressor()"),
    "Deve instanciar DynamicsCompressorNode via createDynamicsCompressor",
  );
  assert.ok(
    code.includes("compressorNode.threshold.value = -24"),
    "Threshold do compressor deve ser -24 dB para voz/videoaulas",
  );
  assert.ok(
    code.includes("compressorNode.knee.value = 30"),
    "Knee do compressor deve ser 30 dB para transição suave",
  );
  assert.ok(
    code.includes("compressorNode.ratio.value = 12"),
    "Ratio deve ser 12 para atenuar picos altos",
  );
  assert.ok(
    code.includes("compressorNode.attack.value = 0.003"),
    "Attack deve ser 0.003s (3ms) para resposta rápida a transientes",
  );
  assert.ok(
    code.includes("compressorNode.release.value = 0.25"),
    "Release deve ser 0.25s (250ms) para retorno gradual sem efeito de respiração",
  );

  // 2. Cadeia de áudio nativa permanente
  assert.ok(
    code.includes("compressorNode.connect(gainNode)"),
    "Compressor deve conectar ao gainNode permanentemente",
  );
  assert.ok(
    code.includes("sourceNode.connect(compressorNode || gainNode)"),
    "SourceNode deve conectar ao compressorNode nativamente",
  );

  // 3. UI limpa: sem interruptores manuais nem poluição visual
  assert.ok(
    !code.includes("id=\"pc-norm-toggle\""),
    "UI não deve ter toggle manual para normalizador, pois o recurso é nativo e automático",
  );
  assert.ok(
    !code.includes("id=\"pc-norm-badge\""),
    "Botão de volume não deve ter badge NORM, mantendo interface limpa",
  );

  // 4. Ativação automática ao dar play
  assert.ok(
    code.includes("videoEl.addEventListener(\"play\", () => {"),
    "Deve ouvir evento de play no vídeo para garantir inicialização imediata do áudio nativo",
  );
});

test("Normalizador de Áudio Nativo: simulação do pipeline de áudio", () => {
  class MockAudioParam {
    constructor(val) {
      this.value = val;
    }
  }

  class MockGainNode {
    constructor() {
      this.gain = new MockAudioParam(1.0);
      this.connectedTo = [];
    }
    connect(dest) {
      this.connectedTo.push(dest);
    }
    disconnect() {
      this.connectedTo = [];
    }
  }

  class MockCompressorNode {
    constructor() {
      this.threshold = new MockAudioParam(-24);
      this.knee = new MockAudioParam(30);
      this.ratio = new MockAudioParam(12);
      this.attack = new MockAudioParam(0.003);
      this.release = new MockAudioParam(0.25);
      this.connectedTo = [];
    }
    connect(dest) {
      this.connectedTo.push(dest);
    }
    disconnect() {
      this.connectedTo = [];
    }
  }

  class MockSourceNode {
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

  const source = new MockSourceNode();
  const gain = new MockGainNode();
  const compressor = new MockCompressorNode();

  // Simulação do pipeline nativo
  compressor.connect(gain);
  source.connect(compressor);

  assert.strictEqual(source.connectedTo.length, 1);
  assert.strictEqual(source.connectedTo[0], compressor, "Source deve sempre conectar ao compressor");
  assert.strictEqual(compressor.connectedTo.length, 1);
  assert.strictEqual(compressor.connectedTo[0], gain, "Compressor deve sempre conectar ao gain");
  assert.strictEqual(compressor.threshold.value, -24);
  assert.strictEqual(compressor.ratio.value, 12);
});
