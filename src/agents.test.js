import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverAgents } from "./agents.ts";

/** Project agents dir in an isolated tmp cwd (no .pi above it), so discovery is hermetic. */
function makeProjectAgentDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ctxwarn-agents-"));
  const agentsDir = path.join(root, ".pi", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  return { root, agentsDir };
}

function writeAgent(dir, file, content) {
  const filePath = path.join(dir, file);
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

test("nested contextWarning frontmatter block is captured as raw value", () => {
  const { root, agentsDir } = makeProjectAgentDir();
  writeAgent(
    agentsDir,
    "scout.md",
    `---
name: scout-cw-test
description: Agent with a context warning
contextWarning:
  percent: 85.5
  messageFile: ~/ctx-stop.md
---
You are a test agent.
`,
  );

  const { agents } = discoverAgents(root);
  const agent = agents.find((candidate) => candidate.name === "scout-cw-test");
  assert.ok(agent, "agent with contextWarning frontmatter should be discovered");
  assert.deepEqual(agent.contextWarning, { percent: 85.5, messageFile: "~/ctx-stop.md" });
});

test("empty contextWarning key is captured as null (not configured)", () => {
  const { root, agentsDir } = makeProjectAgentDir();
  writeAgent(
    agentsDir,
    "blank.md",
    `---
name: blank-cw-test
description: Agent with an empty contextWarning key
contextWarning:
---
You are a test agent.
`,
  );

  const { agents } = discoverAgents(root);
  const agent = agents.find((candidate) => candidate.name === "blank-cw-test");
  assert.ok(agent, "agent should be discovered");
  assert.equal(Object.hasOwn(agent, "contextWarning"), true);
  assert.equal(agent.contextWarning, null);
});

test("agents without the key do not get a contextWarning property", () => {
  const { root, agentsDir } = makeProjectAgentDir();
  writeAgent(
    agentsDir,
    "plain.md",
    `---
name: plain-cw-test
description: Agent without contextWarning
---
You are a test agent.
`,
  );

  const { agents } = discoverAgents(root);
  const agent = agents.find((candidate) => candidate.name === "plain-cw-test");
  assert.ok(agent, "agent should be discovered");
  assert.equal(Object.hasOwn(agent, "contextWarning"), false);
});
