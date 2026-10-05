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
  assert.equal(processPiEvent(userMessageEvent("Do you complete already?"), result), true);

  const activities = result.activities;
  assert.equal(activities.length, 1);
  assert.equal(activities[0].type, "message");
  assert.equal(activities[0].status, "completed");
  assert.equal(activities[0].text, "Do you complete already?");
});

test("a steering delivery is ordered after the preceding turn's tool activity", () => {
  const result = baseResult();
  processPiEvent(userMessageEvent("do work"), result);
  assistantTurn(result);
  processPiEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, result);

  assert.equal(processPiEvent(userMessageEvent("Do one more thing"), result), true);

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

test("a steering delivery queued before the first response is still recorded", () => {
  const result = baseResult();
  processPiEvent(userMessageEvent("do work"), result); // initial task — skipped
  assert.equal(result.activities, undefined);

  // Queued while the child was starting up: pi injects it right after the
  // task, before any assistant activity.
  assert.equal(processPiEvent(userMessageEvent("Do one more thing"), result), true);

  const activities = result.activities;
  assert.deepEqual(activities.map((activity) => activity.type), ["message"]);
  assert.match(getForkProgressText(result), /✓ user Do one more thing/);
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
  assert.equal(processPiEvent(userMessageEvent("Do one more thing"), result), true);
  assert.match(getForkProgressText(result), /✓ user Do one more thing/);
});

test("a re-emitted context warning steer is recorded as an 'alert' activity", () => {
  const result = baseResult();
  processPiEvent(userMessageEvent("do work"), result); // task batch — skipped
  processPiEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, result);
  // Raw file content as read from disk (trailing newline, not trimmed).
  result.sentContextAlerts = ["STOP — context limit reached\n"];

  assert.equal(processPiEvent(userMessageEvent("STOP — context limit reached"), result), true);

  const activities = result.activities;
  assert.deepEqual(activities.map((activity) => activity.type), ["tool", "alert"]);
  assert.equal(activities[1].text, "STOP — context limit reached");
  assert.match(getForkProgressText(result), /⚠ alert STOP — context limit reached/);
});

test("any of several sent context warnings is recorded as an 'alert' activity", () => {
  const result = baseResult();
  processPiEvent(userMessageEvent("do work"), result); // task batch — skipped
  processPiEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, result);
  result.sentContextAlerts = ["Start wrapping up.", "STOP — context limit reached"];

  assert.equal(processPiEvent(userMessageEvent("Start wrapping up."), result), true);

  const activities = result.activities;
  assert.deepEqual(activities.map((activity) => activity.type), ["tool", "alert"]);
  assert.equal(activities[1].text, "Start wrapping up.");
});

test("a /subagent-msg stays a 'user' line even when context alerts were also sent", () => {
  const result = baseResult();
  processPiEvent(userMessageEvent("do work"), result); // task batch — skipped
  processPiEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" }, result);
  result.sentContextAlerts = ["Start wrapping up.", "STOP — context limit reached"];

  assert.equal(processPiEvent(userMessageEvent("Do one more thing"), result), true);

  const activities = result.activities;
  assert.deepEqual(activities.map((activity) => activity.type), ["tool", "message"]);
  assert.match(getForkProgressText(result), /✓ user Do one more thing/);
});

// --- agent_end history replay: dedup must survive content corruption -------
// The agent_end event re-sends the full session history. A copy whose text
// was corrupted in transit (e.g. U+FFFD from a UTF-8 character split across
// stdout chunks) has a different content signature, but the same responseId —
// it must still be recognized as a duplicate.

function assistantResponse(text, totalTokens, responseId) {
  return {
    role: "assistant",
    responseId,
    content: [{ type: "text", text }],
    usage: {
      input: 46,
      output: 8042,
      cacheRead: totalTokens - 8088,
      cacheWrite: 0,
      totalTokens,
    },
  };
}

test("a corrupted agent_end copy of a seen response is not re-added", () => {
  const result = baseResult();
  const live = assistantResponse("Now `tests/top_history_ch_test.go`:", 214718, "chatcmpl-abc");
  processPiEvent({ type: "message_end", message: live }, result);
  const newer = assistantResponse("Прогресс-комментарий оставлен", 241680, "chatcmpl-new");
  processPiEvent({ type: "message_end", message: newer }, result);
  assert.equal(result.messages.length, 2);
  assert.equal(result.usage.contextTokens, 241680);

  // agent_end replay: same responses, but a chunk-split UTF-8 character
  // turned "дневные" into "днев\uFFFD\uFFFDые" in the first copy.
  const corruptedCopy = {
    ...live,
    content: [{ type: "text", text: "Now `tests/top_history_ch_test.go`: днев\uFFFD\uFFFDые" }],
  };
  assert.equal(processPiEvent({ type: "agent_end", messages: [corruptedCopy, newer] }, result), false);

  assert.equal(result.messages.length, 2);
  assert.equal(result.usage.contextTokens, 241680);
  assert.equal(result.usage.turns, 2);
  assert.equal(result.messages[1].content[0].text, "Прогресс-комментарий оставлен");
});

test("a stale message re-added late cannot lower contextTokens", () => {
  const result = baseResult();
  processPiEvent({ type: "message_end", message: assistantResponse("old", 214718, "r1") }, result);
  processPiEvent({ type: "message_end", message: assistantResponse("new", 241680, "r2") }, result);
  assert.equal(result.usage.contextTokens, 241680);

  // A stale copy whose responseId was also corrupted (worst case: both dedup
  // layers miss) is added, but the indicator must stay monotonic.
  processPiEvent({
    type: "agent_end",
    messages: [assistantResponse("old \uFFFD", 214718, "r1-corrupted")],
  }, result);
  assert.equal(result.usage.contextTokens, 241680);
});
