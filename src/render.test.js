import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const renderSource = fs.readFileSync(new URL("./render.ts", import.meta.url), "utf-8");

test("collapsed subagent result uses the configured expand keybinding hint", () => {
  assert.match(
    renderSource,
    /keyHint\(\s*["']app\.tools\.expand["']\s*,\s*["']to expand["']\s*\)/,
  );
  assert.doesNotMatch(renderSource, /Ctrl\+x to expand/);
});

// Context fill indicator (like pi's footer "10.8%/262k"):
// percent over the model context window, warning >70%, error >90%.
test("subagent usage line shows context fill with pi-style thresholds", () => {
  assert.match(renderSource, /function fmtContextFill/);
  assert.match(renderSource, /\(tokens \/ window\) \* 100/);
  // Renders as "<percent>%/<window>", e.g. `10.8%/262k`.
  assert.match(renderSource, /percent\.toFixed\(1\)\}%\/\$\{fmtCount\(window\)\}/);
  // pi footer thresholds: error above 90%, warning above 70%.
  assert.match(renderSource, /percent > 90[\s\S]*?fg\("error", display\)/);
  assert.match(renderSource, /percent > 70[\s\S]*?fg\("warning", display\)/);
  // Unknown token count (no LLM response yet) renders as "?/<window>".
  assert.match(renderSource, /`\?\/\$\{fmtCount\(window\)\}`/);
});
