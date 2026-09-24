// Testes da Fatia 4: Polimento de Micro-interações & Navegação por Teclado.
//
// Valida:
// 1. Cobertura completa de :focus-visible em botões secundários (.btn-ghost, .secondary-btn, .btn-nav, .fav-btn).
// 2. Anel duplo perceptível com outline-offset: 2px (evita clipping em ícones e botões compactos).
// 3. Foco visível explícito no input de busca global da topbar.
//
// Rodar: node --test test/ui-focus-microinteractions.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const STYLES_CSS = fs.readFileSync(path.join(ROOT, "public", "styles.css"), "utf8");

test("Fatia 4: .btn-ghost possui regra de :focus-visible para teclado", () => {
  assert.match(
    STYLES_CSS,
    /\.btn-ghost:focus-visible\s*\{[^}]*outline:/,
    ".btn-ghost deve definir :focus-visible com outline"
  );
});

test("Fatia 4: .secondary-btn possui regra de :focus-visible com anel perceptível", () => {
  assert.match(
    STYLES_CSS,
    /\.secondary-btn:focus-visible\s*\{[^}]*outline:/,
    ".secondary-btn deve definir :focus-visible com outline"
  );
});

test("Fatia 4: botões de navegação de aula (.btn-nav) possuem :focus-visible", () => {
  assert.match(
    STYLES_CSS,
    /\.btn-nav:focus-visible\s*\{[^}]*outline:/,
    ".btn-nav deve definir :focus-visible com outline"
  );
});

test("Fatia 4: .fav-btn possui :focus-visible para acessibilidade de teclado", () => {
  assert.match(
    STYLES_CSS,
    /\.fav-btn:focus-visible\s*\{[^}]*outline:/,
    ".fav-btn deve definir :focus-visible com outline"
  );
});

test("Fatia 4: botões da topbar usam outline-offset positivo (halo externo sem clipping)", () => {
  assert.match(
    STYLES_CSS,
    /\.topbar-brand-minimal:focus-visible\s*\{[^}]*outline-offset:\s*2px;/,
    ".topbar-brand-minimal deve usar outline-offset: 2px"
  );
  assert.match(
    STYLES_CSS,
    /\.topbar-icon-btn:focus-visible\s*\{[^}]*outline-offset:\s*2px;/,
    ".topbar-icon-btn deve usar outline-offset: 2px"
  );
});

test("Fatia 4: .topbar-search input possui foco visível acessível", () => {
  assert.match(
    STYLES_CSS,
    /\.topbar-search input:focus-visible\s*\{[^}]*outline:/,
    ".topbar-search input deve ter :focus-visible com outline"
  );
});
