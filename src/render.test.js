import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { renderSubagentResult } from "./render.ts";
import { emptyUsage } from "./types.ts";

const renderSource = fs.readFileSync(new URL("./render.ts", import.meta.url), "utf-8");

// Plain-text theme: fg(color, text) returns the bare string so rendered
// output can be asserted with regexes.
const plainTheme = { fg: (_color, text) => String(text), bold: (text) => text };

function renderCollapsed(result) {
  return renderSubagentResult({ details: { results: [result] } }, { expanded: false }, plainTheme);
}

function baseRenderResult(activities) {
  return {
    agent: "writer",
    task: "write routes",
    exitCode: -1,
    messages: [],
    usage: emptyUsage(),
    activities,
  };
}

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

// Delivered steering messages (/subagent-msg) show up as `✓ user <text>`
// lines in the activity list at their delivery point.
test("delivered steering messages render as 'user' activity lines", () => {
  const result = baseRenderResult([
    { type: "thinking", status: "completed", chars: 39, activityOrder: 1 },
    { type: "tool", toolName: "read", displayText: "read /tmp/admin.go", status: "completed", activityOrder: 2 },
    { type: "message", status: "completed", text: "Do you complete already?", activityOrder: 3 },
  ]);

  const component = renderCollapsed(result);
  assert.match(component.text, /✓ user Do you complete already\?/);
});

test("long steering message previews are truncated on one line", () => {
  const longText = "x".repeat(400);
  const result = baseRenderResult([
    { type: "message", status: "completed", text: longText, activityOrder: 1 },
  ]);

  const component = renderCollapsed(result);
  assert.match(component.text, /user x{50,}…/);
  // The full untruncated text must not appear.
  assert.doesNotMatch(component.text, new RegExp(`x{${160}}`));
});
