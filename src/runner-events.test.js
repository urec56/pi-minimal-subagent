import assert from "node:assert/strict";
import test from "node:test";
import { getForkProgressText, processPiEvent } from "./runner-events.js";
import { emptyUsage } from "./types.ts";

function baseResult() {
  return {
    agent: "worker",
    task: "do work",
    exitCode: -1,
    messages: [],
    usage: emptyUsage(),
  };
}

function userMessageEvent(text) {
  return { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } };
}

/** One completed assistant response (marks assistant-side activity). */
function assistantTurn(result) {
  processPiEvent(
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "working" }] } },
    result,
  );
}

test("agent_end without willRetry marks semantic completion", () => {
  const result = baseResult();
  processPiEvent({ type: "agent_end", messages: [] }, result);
  assert.equal(result.sawAgentEnd, true);
});

test("agent_end with willRetry is not a completion candidate (automatic retry follows)", () => {
  const result = baseResult();
  processPiEvent({ type: "agent_end", messages: [], willRetry: true }, result);
  assert.equal(result.sawAgentEnd, undefined);
});

test("agent_settled marks full session quiescence", () => {
  const result = baseResult();
  processPiEvent({ type: "agent_settled" }, result);
  assert.equal(result.sawAgentSettled, true);
  // Settled alone does not claim agent_end (older pi versions may lack it).
  assert.equal(result.sawAgentEnd, undefined);
});

test("a rejected initial prompt fails the run instead of hanging", () => {
  const result = baseResult();
  processPiEvent(
    { type: "response", command: "prompt", success: false, error: "No model selected" },
    result,
  );
  assert.match(result.errorMessage, /Prompt rejected: No model selected/);
  assert.equal(result.stopReason, "error");
  // Completion is triggered so the child process gets terminated.
  assert.equal(result.sawAgentEnd, true);
});

test("successful responses are ignored", () => {
  const result = baseResult();
  assert.equal(
    processPiEvent({ type: "response", command: "prompt", success: true }, result),
    false,
  );
  assert.equal(result.sawAgentEnd, undefined);
  assert.equal(result.errorMessage, undefined);
});

test("steer responses never fail the run", () => {
  const result = baseResult();
  processPiEvent({ type: "response", command: "steer", success: true }, result);
  assert.equal(result.sawAgentEnd, undefined);
  assert.equal(result.stopReason, undefined);
});

// --- Steering message delivery (/subagent-msg) ------------------------------
// The child emits the initial task as user-role message(s) before any
// assistant activity; steering messages delivered mid-run arrive after. Only
// the latter are recorded as "message" activities.

test("the initial task user message is not recorded as a steering delivery", () => {
  const result = baseResult(); // task: "do work"
  assert.equal(processPiEvent(userMessageEvent("do work"), result), false);
  assert.equal(result.activities, undefined);
});

test("a user message delivered after assistant activity becomes a 'message' activity", () => {
  const result = baseResult();
  processPiEvent(userMessageEvent("do work"), result); // task batch — skipped
  assistantTurn(result);
  assert.equal(processPiEvent(userMessageEvent("Доделал уже?"), result), true);

  const activities = result.activities;
  assert.equal(activities.length, 1);
  assert.equal(activities[0].type, "message");
  assert.equal(activities[0].status, "completed");
  assert.equal(activities[0].text, "Доделал уже?");
});

test("a steering delivery is ordered after the preceding turn's tool activity", () => {
  const result = baseResult();
  processPiEvent(userMessageEvent("do work"), result);
  assistantTurn(result);
  processPiEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, result);

  assert.equal(processPiEvent(userMessageEvent("Сделай ещё"), result), true);

  const activities = result.activities;
  assert.deepEqual(activities.map((activity) => activity.type), ["tool", "message"]);
  assert.equal(activities[1].activityOrder, activities[0].activityOrder + 1);
});

test("an exact re-emission of the task text is not recorded as a steering delivery", () => {
  const result = baseResult();
  assistantTurn(result);
  assert.equal(processPiEvent(userMessageEvent("do work"), result), false);
  assert.equal(result.activities, undefined);
});

test("empty user messages are not recorded", () => {
  const result = baseResult();
  assistantTurn(result);
  assert.equal(processPiEvent(userMessageEvent("   "), result), false);
  assert.equal(result.activities, undefined);
});

test("progress text lists a delivered steering message as a 'user' line", () => {
  const result = baseResult();
  processPiEvent(userMessageEvent("do work"), result); // task batch — skipped
  processPiEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, result);
  assert.equal(processPiEvent(userMessageEvent("Сделай ещё"), result), true);
  assert.match(getForkProgressText(result), /✓ user Сделай ещё/);
});
