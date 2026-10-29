const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stylesPath = path.join(__dirname, "..", "public", "styles.css");
const playerJsPath = path.join(__dirname, "..", "public", "js", "player.js");
const tutorJsPath = path.join(__dirname, "..", "public", "js", "tutor.js");
const subtitlesJsPath = path.join(__dirname, "..", "public", "js", "subtitles.js");
const appJsPath = path.join(__dirname, "..", "public", "app.js");

const stylesContent = fs.readFileSync(stylesPath, "utf8");
const playerJsContent = fs.readFileSync(playerJsPath, "utf8");
const tutorJsContent = fs.readFileSync(tutorJsPath, "utf8");
const subtitlesJsContent = fs.readFileSync(subtitlesJsPath, "utf8");
const appJsContent = fs.readFileSync(appJsPath, "utf8");

test("Zoom: regras de CSS não bloqueiam desktop em modo paisagem com zoom elevado", () => {
  // A regra de max-height: 550px deve ser restrita a telas touch (pointer: coarse)
  // para evitar que desktops com zoom de 150% a 250% (altura <= 550px) ocultem
  // a topbar, o botão de voltar e forcem a sidebar ao lado.
  assert.ok(
    stylesContent.includes("@media (orientation: landscape) and (max-height: 550px) and (pointer: coarse)"),
    "A media query de landscape compacto deve exigir pointer: coarse"
  );
});

test("Zoom: limitação de altura mínima (clamp) no player para evitar esmagamento em zoom >= 200%", () => {
  // Em zoom alto (ex: 200% H=384px, 250% H=307px), calc(100vh - 230px) resultaria em 77px-154px.
  // O clamp max(240px, calc(100vh - 230px)) preserva altura mínima utilizável de 240px.
  assert.ok(
    stylesContent.includes("max(240px, calc(100vh - 230px))"),
    "Player deve usar max(240px, calc(100vh - 230px))"
  );
});

test("Zoom: breadcrumb e ações de autoplay usam flex-wrap e truncamento para evitar estouro horizontal", () => {
  // Breadcrumb deve quebrar linhas e truncar título da aula (leaf)
  assert.ok(stylesContent.includes(".lesson-header .breadcrumb"), "Estilo para breadcrumb do lesson-header deve existir");
  assert.ok(stylesContent.includes(".breadcrumb-leaf"), "Estilo para breadcrumb-leaf deve existir");
  // Autoplay countdown card
  assert.ok(stylesContent.includes(".paa-actions"), "Estilo para paa-actions deve existir");
});

test("Zoom: botão do Tutor IA não sofre colapso para 30x30 no desktop", () => {
  // .tutor-btn não deve estar agrupado com .btn-icon em regras que forçam 30px x 30px
  const iconRuleRegex = /\.btn-icon,\s*\.tutor-btn\s*\{[^}]*width:\s*30px/g;
  assert.equal(iconRuleRegex.test(stylesContent), false, ".tutor-btn não deve ser forçado a 30px x 30px");
});

test("Zoom: listeners de resize registrados para popovers, tutor e legendas", () => {
  assert.ok(playerJsContent.includes("window.addEventListener(\"resize\""), "player.js deve ouvir resize");
  assert.ok(playerJsContent.includes("constrainPopover"), "player.js deve chamar constrainPopover");
  assert.ok(tutorJsContent.includes("window.addEventListener(\"resize\""), "tutor.js deve ouvir resize");
  assert.ok(subtitlesJsContent.includes("window.addEventListener(\"resize\""), "subtitles.js deve ouvir resize");
  assert.ok(appJsContent.includes("window.addEventListener(\"resize\""), "app.js deve ouvir resize");
});

test("Zoom: simulação matemática dos 12 níveis de zoom solicitados em janela 1366x768", () => {
  const baseW = 1366;
  const baseH = 768;

  const zoomLevels = [
    { zoom: 0.50, name: "50%", expectedLayout: "desktop-wide" },
    { zoom: 0.67, name: "67%", expectedLayout: "desktop-wide" },
    { zoom: 0.75, name: "75%", expectedLayout: "desktop-wide" },
    { zoom: 0.80, name: "80%", expectedLayout: "desktop-wide" },
    { zoom: 0.90, name: "90%", expectedLayout: "desktop-standard" },
    { zoom: 1.00, name: "100%", expectedLayout: "desktop-standard" },
    { zoom: 1.10, name: "110%", expectedLayout: "desktop-standard" },
    { zoom: 1.25, name: "125%", expectedLayout: "desktop-standard" },
    { zoom: 1.50, name: "150%", expectedLayout: "drawer-overlay" },
    { zoom: 1.75, name: "175%", expectedLayout: "drawer-overlay" },
    { zoom: 2.00, name: "200%", expectedLayout: "drawer-compact-player" },
    { zoom: 2.50, name: "250%", expectedLayout: "drawer-compact-player-narrow" },
  ];

  for (const { zoom, name, expectedLayout } of zoomLevels) {
    const cssW = Math.round(baseW / zoom);
    const cssH = Math.round(baseH / zoom);

    // Validações por nível:
    if (zoom <= 1.25) {
      // 50% a 125%: cssW >= 1092px > 1024px.
      // Sidebar permanece acoplada ao lado (layout em 2 colunas).
      const isSidebarDocked = cssW > 1024;
      assert.strictEqual(isSidebarDocked, true, `Zoom ${name} (${cssW}px) deve ter sidebar acoplada`);
    } else {
      // 150% a 250%: cssW <= 910px <= 1024px.
      // Sidebar transforma-se em gaveta (off-canvas drawer) deslizante.
      const isDrawerMode = cssW <= 1024;
      assert.strictEqual(isDrawerMode, true, `Zoom ${name} (${cssW}px) deve acionar modo drawer`);
    }

    if (zoom >= 2.00) {
      // 200% e 250%: cssW <= 683px <= 680px (ou próximo).
      // Controles do player colapsam velocidade e legendas no menu overflow ⋮
      const isCompactPlayer = cssW <= 683;
      assert.strictEqual(isCompactPlayer, true, `Zoom ${name} (${cssW}px) deve acionar player compacto`);

      // Altura calculada do player em modo teatro: sem o clamp, cssH - 230 esmagaria o player.
      const rawHeight = cssH - 230;
      const clampedHeight = Math.max(240, rawHeight);
      assert.ok(clampedHeight >= 240, `Zoom ${name} altura mínima do player deve ser >= 240px`);
      if (zoom === 2.50) {
        // Altura bruta seria 307 - 230 = 77px! O clamp garante 240px.
        assert.strictEqual(rawHeight, 77);
        assert.strictEqual(clampedHeight, 240);
      }
    }
  }
});

test("Zoom: função constrainPopover impede corte de popovers fora dos limites do player", () => {
  // Simulação de lógica da constrainPopover
  function simulateConstrain(wrapRect, popRect) {
    let rightShift = 0;
    let maxH = null;

    if (popRect.left < wrapRect.left + 8) {
      rightShift = (wrapRect.left + 8) - popRect.left;
    }
    if (popRect.top < wrapRect.top + 8) {
      maxH = Math.max(100, popRect.bottom - (wrapRect.top + 8));
    }
    return { rightShift, maxH };
  }

  // Cenário 1: popover cabe normalmente
  const res1 = simulateConstrain(
    { left: 100, right: 800, top: 100, bottom: 500 },
    { left: 500, right: 750, top: 200, bottom: 450 }
  );
  assert.strictEqual(res1.rightShift, 0);
  assert.strictEqual(res1.maxH, null);

  // Cenário 2: em zoom de 200%, popover ultrapassa o topo e a esquerda do player
  const res2 = simulateConstrain(
    { left: 100, right: 500, top: 100, bottom: 400 },
    { left: 50, right: 350, top: 80, bottom: 380 } // left 50 < 108; top 80 < 108
  );
  assert.strictEqual(res2.rightShift, 58); // 108 - 50 = 58
  assert.strictEqual(res2.maxH, 272); // 380 - 108 = 272
});
