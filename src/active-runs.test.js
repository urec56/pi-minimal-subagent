import assert from "node:assert/strict";
import test from "node:test";
import {
  registerActiveRun,
  unregisterActiveRun,
  listActiveRuns,
  resolveSubagentMsgTarget,
  describeRun,
} from "./active-runs.ts";

function makeSteerTracker() {
  const sent = [];
  return {
    sent,
    send: (message) => {
      sent.push(message);
      return true;
    },
  };
}

test("run ids are sequential and stable within the session", () => {
  const a = registerActiveRun("reviewer", "task A", makeSteerTracker().send);
  const b = registerActiveRun("tester", "task B", makeSteerTracker().send);
  try {
    assert.equal(a, 1);
    assert.equal(b, 2);
    const list = listActiveRuns();
    assert.deepEqual(
      list.map((run) => run.runId),
      [a, b],
    );
  } finally {
    unregisterActiveRun(a);
    unregisterActiveRun(b);
  }
});

test("no target resolves to the single active run", () => {
  const a = registerActiveRun("reviewer", "task A", makeSteerTracker().send);
  try {
    const resolution = resolveSubagentMsgTarget("");
    assert.equal(resolution.kind, "ok");
    assert.deepEqual(resolution.runs.map((run) => run.runId), [a]);
  } finally {
    unregisterActiveRun(a);
  }
});

test("no target with several active runs asks for a specific one", () => {
  const a = registerActiveRun("reviewer", "task A", makeSteerTracker().send);
  const b = registerActiveRun("tester", "task B", makeSteerTracker().send);
  try {
    const resolution = resolveSubagentMsgTarget("");
    assert.equal(resolution.kind, "unknown-target");
    assert.deepEqual(
      resolution.available.map((run) => run.runId),
      [a, b],
    );
  } finally {
    unregisterActiveRun(a);
    unregisterActiveRun(b);
  }
});

test("run id target resolves exactly one run", () => {
  const a = registerActiveRun("reviewer", "task A", makeSteerTracker().send);
  const b = registerActiveRun("tester", "task B", makeSteerTracker().send);
  try {
    assert.equal(resolveSubagentMsgTarget(`#${a}`).kind, "ok");
    assert.equal(resolveSubagentMsgTarget("#999").kind, "unknown-target");
  } finally {
    unregisterActiveRun(a);
    unregisterActiveRun(b);
  }
});

test("name target broadcasts to all runs of that agent", () => {
  const a = registerActiveRun("reviewer", "task A", makeSteerTracker().send);
  const b = registerActiveRun("tester", "task B", makeSteerTracker().send);
  const c = registerActiveRun("reviewer", "task C", makeSteerTracker().send);
  try {
    const resolution = resolveSubagentMsgTarget("reviewer");
    assert.equal(resolution.kind, "ok");
    assert.deepEqual(
      resolution.runs.map((run) => run.runId).sort(),
      [a, c].sort(),
    );
    // Unknown name → unknown-target with the full available list.
    const missing = resolveSubagentMsgTarget("ghost");
    assert.equal(missing.kind, "unknown-target");
    assert.deepEqual(
      missing.available.map((run) => run.runId).sort(),
      [a, b, c].sort(),
    );
  } finally {
    unregisterActiveRun(a);
    unregisterActiveRun(b);
    unregisterActiveRun(c);
  }
});

test("no active runs resolves to no-runs", () => {
  assert.equal(resolveSubagentMsgTarget("").kind, "no-runs");
  assert.equal(resolveSubagentMsgTarget("#9999").kind, "unknown-target");
});

test("describeRun shows id, agent and a truncated task preview", () => {
  const runId = registerActiveRun("reviewer", "check the auth flow end to end", makeSteerTracker().send);
  try {
    const described = describeRun(listActiveRuns()[0]);
    assert.ok(described.startsWith(`#${runId} reviewer — "check the auth flow`));
    // Long tasks are truncated with an ellipsis.
    const longId = registerActiveRun("tester", "x".repeat(200), makeSteerTracker().send);
    try {
      const longRun = listActiveRuns().find((run) => run.runId === longId);
      // The preview is wrapped in quotes, so truncation ends with `…"`.
      assert.ok(describeRun(longRun).endsWith('…"'));
    } finally {
      unregisterActiveRun(longId);
    }
  } finally {
    unregisterActiveRun(runId);
  }
});

test("unregistering removes the run from resolution", () => {
  const a = registerActiveRun("reviewer", "task A", makeSteerTracker().send);
  assert.equal(resolveSubagentMsgTarget("").kind, "ok");
  unregisterActiveRun(a);
  assert.equal(resolveSubagentMsgTarget(`#${a}`).kind, "unknown-target");
});
