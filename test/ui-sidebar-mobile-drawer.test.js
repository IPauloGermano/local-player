const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const STYLES_PATH = path.join(__dirname, "..", "public", "styles.css");

test("Mobile Drawer: styles.css garante que a sidebar no mobile (@media max-width 900px) sobrepõe o colapso do modo teatro", () => {
  const css = fs.readFileSync(STYLES_PATH, "utf8");
  const mediaQueryMatch = css.match(/@media\s*\(\s*max-width:\s*900px\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(mediaQueryMatch, "Deve existir @media (max-width: 900px) em styles.css");
  
  const mediaBlock = mediaQueryMatch[1];
  assert.ok(
    mediaBlock.includes(".course-view.theater:not(.summary-open) .sidebar") ||
    mediaBlock.includes(".course-view.theater .sidebar") ||
    mediaBlock.includes(".course-view.drawer-host.theater"),
    "No mobile, @media max-width 900px deve neutralizar explicitamente regras de colapso de .theater",
  );
  assert.match(
    mediaBlock,
    /\.course-view.*?(?:drawer-host|\.theater).*?\.drawer-open\s+\.sidebar[\s\S]*?visibility:\s*visible/,
    "No mobile, .drawer-open com ou sem teatro deve ter visibility: visible",
  );
});
