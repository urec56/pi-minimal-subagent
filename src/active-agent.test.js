import assert from "node:assert/strict";
import test from "node:test";
import { buildActiveAgentBlock } from "./agents.ts";
import { requestedActiveAgentName } from "./active-agent.ts";
import { resolveAgentModelRef } from "./model-ref.ts";

function makeAgent(overrides = {}) {
  return {
    name: "searcher",
    description: "Fast codebase search",
    systemPrompt: "You are a fast codebase searcher.",
    source: "user",
    filePath: "/tmp/searcher.md",
    ...overrides,
  };
}

test("builds the shared <active_agent> block with name and body", () => {
  assert.equal(
    buildActiveAgentBlock(makeAgent()),
    `<active_agent name="searcher">\n\nYou are a fast codebase searcher.`,
  );
});

test("escapes quotes in agent names for the tag attribute", () => {
  const block = buildActiveAgentBlock(makeAgent({ name: 'we"ird' }));
  assert.match(block, /^<active_agent name="we'ird">/);
});

test("session override wins over settings; none disables everything", () => {
  const settings = { activeAgent: "scout" };
  assert.equal(requestedActiveAgentName(settings, undefined), "scout");
  assert.equal(requestedActiveAgentName(settings, "searcher"), "searcher");
  assert.equal(requestedActiveAgentName(settings, "none"), null);
});

test("settings value is used only when there is no session override", () => {
  assert.equal(requestedActiveAgentName({ activeAgent: null }, undefined), null);
  assert.equal(requestedActiveAgentName({}, undefined), null);
  assert.equal(requestedActiveAgentName({ activeAgent: "  scout  " }, undefined), "scout");
});

const catalog = {
  models: [
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
  ],
  find(provider, modelId) {
    return this.models.find((m) => m.provider === provider && m.id === modelId);
  },
  getAll() {
    return this.models;
  },
};

test("resolves exact provider/model references", () => {
  const resolved = resolveAgentModelRef("anthropic/claude-sonnet-4-5", catalog);
  assert.equal(resolved.model.id, "claude-sonnet-4-5");
  assert.equal(resolved.error, undefined);
});

test("rejects unknown provider/model references with a clear error", () => {
  const resolved = resolveAgentModelRef("anthropic/does-not-exist", catalog);
  assert.match(resolved.error ?? "", /not found/);
});

test("resolves bare ids and rejects ambiguous ones", () => {
  const resolved = resolveAgentModelRef("gpt-5", catalog);
  assert.equal(resolved.model.provider, "openai");

  const ambiguousCatalog = {
    ...catalog,
    models: [
      { id: "shared-id", name: "A Shared", provider: "alpha" },
      { id: "shared-id", name: "B Shared", provider: "beta" },
    ],
  };
  const ambiguous = resolveAgentModelRef("shared-id", ambiguousCatalog);
  assert.match(ambiguous.error ?? "", /ambiguous/);
});

test("falls back to unique partial matches on id or name", () => {
  assert.equal(resolveAgentModelRef("sonnet", catalog).model.id, "claude-sonnet-4-5");
  assert.equal(resolveAgentModelRef("GEMINI", catalog).model.id, "gemini-2.5-pro");

  const noMatch = resolveAgentModelRef("totally-unknown-model", catalog);
  assert.match(noMatch.error ?? "", /not found/);
});

test("parses an optional :thinkingLevel suffix without breaking unknown colons", () => {
  const withLevel = resolveAgentModelRef("anthropic/claude-sonnet-4-5:xhigh", catalog);
  assert.equal(withLevel.model.id, "claude-sonnet-4-5");
  assert.equal(withLevel.thinkingLevel, "xhigh");

  // Colon suffix that is not a known level stays part of the pattern.
  const colonId = resolveAgentModelRef("openrouter/model:exacto", catalog);
  assert.match(colonId.error ?? "", /not found/);
});
