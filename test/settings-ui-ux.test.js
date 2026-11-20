const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");
const SETTINGS_JS = fs.readFileSync(path.join(ROOT, "public", "js", "settings.js"), "utf8");

test("Fatia 1: Preservação de todos os controles e IDs essenciais de configurações", () => {
  // Categoria Geral
  assert.match(SETTINGS_JS, /id="toggle-close-modules"/, "Deve manter interruptor #toggle-close-modules");
  assert.match(SETTINGS_JS, /id="btn-create-shortcut"/, "Deve manter botão #btn-create-shortcut");
  assert.match(SETTINGS_JS, /id="btn-remove-shortcut"/, "Deve manter botão #btn-remove-shortcut");
  assert.match(SETTINGS_JS, /id="select-idle-timeout"/, "Deve manter select #select-idle-timeout");

  // Categoria Reprodução
  assert.match(SETTINGS_JS, /id="default-speed"/, "Deve manter select #default-speed");
  assert.match(SETTINGS_JS, /id="toggle-dereverb"/, "Deve manter interruptor #toggle-dereverb");
  assert.match(SETTINGS_JS, /id="toggle-autoplay"/, "Deve manter interruptor #toggle-autoplay");

  // Categoria Atalhos
  assert.match(SETTINGS_JS, /class="shortcut-list"/, "Deve manter lista de atalhos .shortcut-list");
  assert.match(SETTINGS_JS, /id="reset-shortcuts"/, "Deve manter botão #reset-shortcuts");

  // Categoria Armazenamento e Dados
  assert.match(SETTINGS_JS, /id="storage-status"/, "Deve manter container #storage-status");
  assert.match(SETTINGS_JS, /id="cleanup-workspace"/, "Deve manter botão #cleanup-workspace");
  assert.match(SETTINGS_JS, /id="clear-transcode-cache"/, "Deve manter botão #clear-transcode-cache");
  assert.match(SETTINGS_JS, /id="clear-all-progress"/, "Deve manter botão de perigo #clear-all-progress");

  // Categoria Bibliotecas
  assert.match(SETTINGS_JS, /id="lib-list"/, "Deve manter lista de bibliotecas #lib-list");
  assert.match(SETTINGS_JS, /id="lib-add"/, "Deve manter botão de adicionar biblioteca #lib-add");

  // Central de IA
  assert.match(SETTINGS_JS, /class="ai-tabs"/, "Deve manter abas de IA .ai-tabs");
  assert.match(SETTINGS_JS, /id="ai-panel"/, "Deve manter painel de IA #ai-panel");
});

test("Fatia 2: Padronização de formulários e eliminação de classes/estilos impróprios", () => {
  // O select de inatividade não deve usar a classe de busca da topbar (topbar-search-input)
  assert.doesNotMatch(
    SETTINGS_JS,
    /id="select-idle-timeout"[^>]*class="[^"]*topbar-search-input/,
    "select-idle-timeout não deve usar a classe topbar-search-input"
  );

  // Deve usar a classe semântica settings-select
  assert.match(
    SETTINGS_JS,
    /id="select-idle-timeout"[^>]*class="[^"]*settings-select/,
    "select-idle-timeout deve usar a classe padrão settings-select"
  );

  // Cabeçalho deve conter ícone vetorial SVG em vez de emoji de engrenagem cru
  assert.doesNotMatch(
    SETTINGS_JS,
    /<span[^>]*>[ \t\r\n]*⚙[ \t\r\n]*<\/span>/,
    "Cabeçalho de configurações não deve usar emoji cru ⚙, deve usar SVG padronizado"
  );
});

test("Fatia 3: Modernização visual no styles.css com custom select, grid de atalhos e responsividade", () => {
  // .settings-select deve ter suporte a aparência limpa e seta customizada
  assert.match(
    STYLES_CSS,
    /\.settings-select\s*\{[^}]*appearance:\s*none/s,
    "settings-select deve resetar a aparência nativa (appearance: none) para seta customizada"
  );

  // .shortcut-list deve utilizar grid responsiva para aproveitar a largura no desktop
  assert.match(
    STYLES_CSS,
    /\.shortcut-list\s*\{[^}]*display:\s*grid/s,
    "shortcut-list deve usar CSS Grid para melhor distribuição espacial no desktop"
  );

  // .lib-row deve ter regras para evitar quebra desordenada de botões e overflow no mobile
  assert.match(
    STYLES_CSS,
    /\.lib-row-path\s*\{[^}]*word-break:\s*break-all/s,
    "lib-row-path deve usar word-break: break-all para não gerar overflow horizontal em telas pequenas"
  );
});

test("Fatia 4: Integridade da UI de bibliotecas (edição inteligente e proteção da padrão)", () => {
  // Botão de remover deve ser renderizado para biblioteca não padrão ou quando houver mais de uma biblioteca
  assert.match(
    SETTINGS_JS,
    /if\s*\(!isDefault\s*\|\|\s*libs\.length\s*>\s*1\)\s*\{\s*actions\.push\(.*data-action="remove"/s,
    "Botão de remover deve ser permitido se não for a padrão ou se houver outras bibliotecas cadastradas"
  );

  // Botão de desativar deve ser desabilitado quando é a única ativa
  assert.match(
    SETTINGS_JS,
    /disableToggle\s*\?.*Não é possível desativar a única biblioteca ativa/s,
    "Desativação deve ser bloqueada na UI quando é a única biblioteca ativa"
  );

  // Edição não deve reenviar path inalterado
  assert.match(
    SETTINGS_JS,
    /path\s*!==\s*originalPath/,
    "Edição só deve enviar body.path se o caminho tiver sido realmente modificado"
  );

  // Erros devem rolar para a visão do usuário
  assert.match(
    SETTINGS_JS,
    /scrollIntoView/,
    "Mensagem de erro deve rolar suavemente para o campo de visão"
  );
});

test("Fatia 5: Controles de Tool Calling universal e OCR de PDFs na aba Tutor IA", () => {
  // Modo de Tool Calling
  assert.match(SETTINGS_JS, /id="ai-tu-tool-mode"/, "Deve renderizar select #ai-tu-tool-mode");
  assert.match(SETTINGS_JS, /value="auto"[\s\S]*value="native"[\s\S]*value="prompt"[\s\S]*value="off"/, "Select toolMode deve conter opções auto/native/prompt/off");

  // Controles de OCR
  assert.match(SETTINGS_JS, /id="ai-ocr-status-summary"/, "Deve exibir resumo de status de OCR #ai-ocr-status-summary");
  assert.match(SETTINGS_JS, /tuSwitch\("ai-ocr-enabled"/, "Deve renderizar switch #ai-ocr-enabled");
  assert.match(SETTINGS_JS, /id="ai-ocr-engine"/, "Deve renderizar select #ai-ocr-engine");
  assert.match(SETTINGS_JS, /id="ai-ocr-lang"/, "Deve renderizar input #ai-ocr-lang");
  assert.match(SETTINGS_JS, /id="ai-ocr-vlm-fields"/, "Deve renderizar seção condicional #ai-ocr-vlm-fields");
  assert.match(SETTINGS_JS, /id="ai-ocr-vlm-provider"/, "Deve renderizar select #ai-ocr-vlm-provider");
  assert.match(SETTINGS_JS, /id="ai-ocr-vlm-model"/, "Deve renderizar input #ai-ocr-vlm-model");
  assert.match(SETTINGS_JS, /id="ai-ocr-docling-fields"/, "Deve renderizar seção condicional #ai-ocr-docling-fields");
  assert.match(SETTINGS_JS, /id="ai-ocr-docling-url"/, "Deve renderizar input #ai-ocr-docling-url");
  assert.match(SETTINGS_JS, /id="ai-ocr-docling-test"/, "Deve renderizar botão #ai-ocr-docling-test");
  assert.match(SETTINGS_JS, /\/api\/ai\/ocr\/test-docling/, "Deve integrar botão de teste com /api/ai/ocr/test-docling");
  assert.match(SETTINGS_JS, /\/api\/ai\/ocr\/download-lang/, "Deve integrar download sob demanda com /api/ai/ocr/download-lang");

  // Acessibilidade e persistência conjunta (tutor + ocr)
  assert.match(SETTINGS_JS, /aria-describedby="ai-tu-tool-mode-desc"/, "Select toolMode deve vincular descrição via aria-describedby");
  assert.match(SETTINGS_JS, /autocorrect="off"/, "Campos técnicos (idiomas/URL/modelo) devem desativar autocorreção");
  assert.match(SETTINGS_JS, /saveAiPatch\(\{\s*tutor:\s*tu,\s*ocr:\s*oc\s*\}\)/, "Salvar na aba Tutor IA deve persistir tutor e ocr");
});

