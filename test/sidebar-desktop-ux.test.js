const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("Sidebar Desktop UX: css rules and mobile isolation", () => {
  const cssPath = path.join(__dirname, "../public/styles.css");
  const css = fs.readFileSync(cssPath, "utf8");

  // 1. Desktop sidebar rules
  assert.match(
    css,
    /\.sidebar\s*\{[^}]*position:\s*sticky;[^}]*top:\s*16px;/s,
    "Sidebar base/desktop should have position: sticky; top: 16px;",
  );
  assert.match(
    css,
    /\.sidebar\s*\{[^}]*max-height:\s*calc\(100vh - 32px\);/s,
    "Sidebar desktop should have fluid max-height accounting for sticky top margin",
  );
  assert.match(
    css,
    /#tree-slot\s*\{[^}]*overscroll-behavior:\s*contain;/s,
    "#tree-slot should contain overscroll to prevent scroll chaining on desktop",
  );

  // 2. Active lesson styling and hover microinteractions
  assert.match(
    css,
    /\.tree-lesson\.active\s*\{[^}]*box-shadow:[^}]*inset 3px 0 0 var\(--accent\)/s,
    "Active lesson must have accent left border glow",
  );
  assert.match(
    css,
    /\.tree-lesson\.active \.lesson-title-inner\s*\{[^}]*color:\s*#fff;/s,
    "Active lesson title must have high contrast white text",
  );

  // 3. Mobile isolation: drawer rules inside @media (max-width: 900px) must exist and override
  assert.match(
    css,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.course-view[\s\S]*?\.sidebar\s*\{[^}]*position:\s*fixed;[^}]*transform:\s*translateX\(102%\);/s,
    "Mobile sidebar drawer must remain position: fixed and off-canvas within @media (max-width: 900px)",
  );
});

test("Sidebar Desktop UX: app.js active lesson auto-scroll", () => {
  const appJsPath = path.join(__dirname, "../public/app.js");
  const appJs = fs.readFileSync(appJsPath, "utf8");

  assert.match(
    appJs,
    /function renderTree\([^)]*\)\s*\{[\s\S]*?scrollIntoView\(\{\s*block:\s*"nearest",\s*behavior:\s*"smooth"\s*\}\)/s,
    "renderTree should trigger smooth nearest scrollIntoView for active lesson when resetExpanded is true",
  );
});
