const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");
const TUTOR_JS_PATH = path.join(__dirname, "..", "public", "js", "tutor.js");
const STUDY_JS_PATH = path.join(__dirname, "..", "public", "js", "study.js");

test("Tutor mobile UI: styles.css garante que .tutor-btn-label é oculto em mobile no header", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  const hasLabelHideRule =
    css.includes(".tutor-header-actions .tutor-btn-label") ||
    css.includes(".tutor-icon-btn .tutor-btn-label");
  assert.ok(
    hasLabelHideRule,
    "styles.css deve ter seletor para ocultar .tutor-btn-label em botões de ação do tutor",
  );
});

test("Tutor mobile UI: styles.css previne quebra de linha em .tutor-status-badge e elipsa rótulo", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  assert.match(
    css,
    /\.tutor-status-badge[\s\S]*?white-space:\s*nowrap/,
    ".tutor-status-badge deve conter white-space: nowrap para evitar que o texto de transcrição quebre em várias linhas",
  );
  assert.match(
    css,
    /\.tutor-context-label[\s\S]*?text-overflow:\s*ellipsis/,
    ".tutor-context-label deve elipsar o texto caso o espaço na tela seja reduzido",
  );
});

test("Tutor mobile UI: tutor.js atualiza title e aria-label acessíveis em switchTutorTab", () => {
  const code = fs.readFileSync(TUTOR_JS_PATH, "utf8");
  assert.match(
    code,
    /newChatBtn\.setAttribute\("title"/,
    "tutor.js deve atualizar title de #tutor-new-chat na troca de abas para manter clareza sem depender do label visual",
  );
  assert.match(
    code,
    /newChatBtn\.setAttribute\("aria-label"/,
    "tutor.js deve atualizar aria-label de #tutor-new-chat na troca de abas para acessibilidade",
  );
});

test("Tutor IA: clicar em timestamp busca o vídeo sem fechar o drawer", () => {
  const code = fs.readFileSync(TUTOR_JS_PATH, "utf8");
  const timestampHandler = code.match(/\/\/ Timestamp interativo([\s\S]*?)\/\/ Bot\u00e3o de buscar v\u00eddeo alternativo/);
  assert.ok(timestampHandler, "handler de timestamp deve existir");
  assert.doesNotMatch(timestampHandler[1], /closeTutorDrawer\(/, "o clique no timestamp deve manter o chat aberto");
});

test("Tutor IA Header e Ícones: header compacto sem título 'Tutor IA' nem ponto de transcrição e SVGs padronizados 24x24 nas abas e study.js", () => {
  const tutorSrc = fs.readFileSync(TUTOR_JS_PATH, "utf8");
  const studySrc = fs.readFileSync(STUDY_JS_PATH, "utf8");
  const header = tutorSrc.split('<div class="tutor-header">')[1].split('role="tablist"')[0];

  assert.match(header, /id="tutor-lesson-badge"/);
  assert.match(header, /id="tutor-context-label"/);
  assert.doesNotMatch(header, />Tutor IA<|tutor-sparkle-badge|tutor-context-dot/);

  const tabBar = tutorSrc.split('role="tablist"')[1].split("<!-- View: Chat -->")[0];
  assert.doesNotMatch(tabBar, /💬|📝|🗂️/, "barra de abas não deve conter emojis");
  const tabs = Array.from(tabBar.matchAll(/data-tab="(chat|quiz|flashcards)"[^>]*>([\s\S]*?)<\/button>/g));
  assert.equal(tabs.length, 3);
  for (const [, name, content] of tabs) {
    assert.match(content, /class="tutor-tab-icon"|tutorTabIconHtml|TUTOR_ICONS/, `aba ${name} deve renderizar ícone SVG próprio`);
    assert.match(content, new RegExp(">" + name + "<", "i"));
  }

  assert.match(tutorSrc, /TUTOR_ICONS\s*=/, "tutor.js deve centralizar os ícones SVG próprios em TUTOR_ICONS");
  for (const key of ["chat", "quiz", "flashcards"]) {
    assert.match(
      tutorSrc,
      new RegExp(`${key}:\\s*['"\`]<svg[^>]*viewBox="0 0 24 24"[^>]*aria-hidden="true"`),
      `ícone ${key} deve usar viewBox="0 0 24 24" e aria-hidden="true"`,
    );
  }

  assert.doesNotMatch(studySrc, /<span>📝<\/span>/, "study.js deve substituir emoji 📝 por ícone SVG");
  assert.doesNotMatch(studySrc, /<span>🗂️<\/span>/, "study.js deve substituir emoji 🗂️ por ícone SVG");
});

test("Tutor IA Expansão lateral: ocupa toda altura vertical no desktop e expande horizontalmente respeitando player e topbar", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");

  assert.doesNotMatch(
    css,
    /height:\s*min\(72dvh,\s*44rem\)/,
    "o painel do tutor no PC deve ocupar todo o espaço vertical sem encolher para 72dvh",
  );

  assert.match(
    css,
    /body\.tutor-open\.tutor-expanded\s+\.tutor-drawer\s*\{[^}]*width:\s*min\([^;]*calc\(100vw\s*-/s,
    "expansão lateral deve ter largura máxima e proteger o espaço do player via calc(100vw - ...)",
  );
  assert.match(
    css,
    /body\.tutor-open\.tutor-expanded\s+\.course-view\s*\{[^}]*padding-right:/s,
    "expansão lateral deve ajustar padding-right de .course-view em sincronia",
  );
  assert.match(
    css,
    /body\.tutor-open\s+\.topbar\s*\{[^}]*padding-right:/s,
    "topbar deve reservar espaço lateral quando o tutor está aberto em altura cheia no desktop",
  );
  assert.match(
    css,
    /body\.tutor-open\.tutor-expanded\s+\.topbar\s*\{[^}]*padding-right:/s,
    "topbar deve acompanhar a largura expandida do tutor no desktop",
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.tutor-expand-btn\s*\{[^}]*display:\s*none/s,
    "no mobile portrait (largura 100%) o botão de expansão lateral deve ficar oculto",
  );
});

test("Tutor IA Expansão lateral (comportamento): alterna estado expandido, sincroniza classes no body/drawer e limpa ao fechar", () => {
  const bodyClasses = new Set(["tutor-open"]);
  const drawerClasses = new Set();
  const makeClassList = (set) => ({
    add: (...cls) => cls.forEach((c) => set.add(c)),
    remove: (...cls) => cls.forEach((c) => set.delete(c)),
    toggle: (c, force) => {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
    contains: (c) => set.has(c),
  });

  const drawer = {
    dataset: {},
    hidden: false,
    classList: makeClassList(drawerClasses),
    setAttribute() {},
    removeAttribute() {},
  };
  const attrs = new Map([["aria-expanded", "false"]]);
  const expand = {
    title: "",
    getAttribute: (name) => attrs.get(name),
    setAttribute: (name, value) => attrs.set(name, String(value)),
    addEventListener: (type, cb) => { if (type === "click") expand.click = cb; },
  };
  const document = {
    body: { classList: makeClassList(bodyClasses) },
    getElementById: (id) => ({ "tutor-drawer": drawer, "tutor-expand": expand })[id] || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const sandbox = {
    document,
    window: {
      addEventListener() {},
      matchMedia: () => ({ matches: true }),
    },
  };
  vm.runInNewContext(fs.readFileSync(TUTOR_JS_PATH, "utf8"), sandbox);
  sandbox.tutorState.open = true;
  sandbox.wireTutorDrawerEvents(null);

  expand.click();
  assert.equal(sandbox.tutorState.expanded, true);
  assert.equal(attrs.get("aria-expanded"), "true");
  assert.match(attrs.get("aria-label"), /recolher/i);
  assert.equal(bodyClasses.has("tutor-expanded"), true);
  assert.equal(drawerClasses.has("is-expanded"), true);

  sandbox.switchTutorTab("quiz", null);
  assert.notEqual(expand.hidden, true);
  assert.equal(bodyClasses.has("tutor-expanded"), true);

  sandbox.closeTutorDrawer();
  assert.equal(bodyClasses.has("tutor-open"), false);
  assert.equal(bodyClasses.has("tutor-expanded"), false);

  sandbox.openTutorDrawer(null);
  assert.equal(bodyClasses.has("tutor-expanded"), true);
  expand.click();
  assert.equal(sandbox.tutorState.expanded, false);
  assert.equal(attrs.get("aria-expanded"), "false");
  assert.match(attrs.get("aria-label"), /expandir/i);
  assert.equal(bodyClasses.has("tutor-expanded"), false);
  assert.equal(drawerClasses.has("is-expanded"), false);
});

test("Tutor IA Campo de digitação: alinhamento centralizado, field-sizing, label acessível e Enter seguro para IME", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  const tutorSrc = fs.readFileSync(TUTOR_JS_PATH, "utf8");

  assert.match(tutorSrc, /<label[^>]*for="tutor-input"/, 'campo de digitação deve ter <label for="tutor-input">');
  assert.match(tutorSrc, /id="tutor-input"[^>]*aria-describedby="tutor-input-hint"/, "textarea deve referenciar #tutor-input-hint via aria-describedby");

  const taBlock = css.match(/\.tutor-textarea\s*\{([^}]*)\}/);
  assert.ok(taBlock, ".tutor-textarea deve existir em styles.css");
  assert.match(taBlock[1], /field-sizing:\s*content/, ".tutor-textarea deve usar field-sizing: content");
  assert.match(taBlock[1], /box-sizing:\s*border-box/, ".tutor-textarea deve definir box-sizing: border-box");
  assert.match(taBlock[1], /line-height:\s*22px/, ".tutor-textarea deve usar line-height inteiro (22px) para centralização exata");
  assert.match(taBlock[1], /padding:\s*7px\s+0/, ".tutor-textarea deve usar padding vertical simétrico (7px 0 -> 36px total = botão)");
  assert.match(taBlock[1], /min-height:\s*36px/, ".tutor-textarea deve igualar min-height à altura do botão de envio (36px)");

  const btnBlock = css.match(/\.tutor-send-btn\s*\{([^}]*)\}/);
  assert.ok(btnBlock, ".tutor-send-btn deve existir em styles.css");
  assert.match(btnBlock[1], /height:\s*36px/, ".tutor-send-btn no desktop deve ter height: 36px alinhado à 1ª linha do textarea");

  let sentCount = 0;
  let keydownHandler = null;
  const input = {
    value: "teste",
    style: {},
    addEventListener: (type, cb) => { if (type === "keydown") keydownHandler = cb; },
  };
  const drawer = { dataset: {}, classList: { toggle() {} } };
  const document = {
    body: { classList: { add() {}, remove() {}, toggle() {} } },
    getElementById: (id) => ({ "tutor-drawer": drawer, "tutor-input": input })[id] || null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const sandbox = {
    document,
    window: { addEventListener() {} },
  };
  vm.runInNewContext(tutorSrc, sandbox);
  sandbox.sendTutorMessage = () => { sentCount++; };
  sandbox.wireTutorDrawerEvents({ path: "aula.mp4" });
  assert.ok(keydownHandler, "keydown handler deve ser registrado no #tutor-input");

  let prevented = false;
  keydownHandler({ key: "Enter", shiftKey: false, isComposing: true, preventDefault: () => { prevented = true; } });
  assert.equal(sentCount, 0);
  assert.equal(prevented, false);

  keydownHandler({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 229, preventDefault: () => { prevented = true; } });
  assert.equal(sentCount, 0);

  keydownHandler({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(sentCount, 1);
});
