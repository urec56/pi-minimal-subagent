/**
 * Registry of subagent runs currently in flight in this parent session.
 *
 * Runs are registered by runSubagent() right after the child process is
 * spawned and unregistered when the run finishes (or fails). The
 * /subagent-msg command resolves its target against this registry so a
 * message can be sent to a running subagent as a steer command on its stdin.
 */

export interface ActiveSubagentRun {
  /** Stable per-session id, shown in the UI as `#N` and used for addressing. */
  runId: number;
  agent: string;
  task: string;
  startedAt: number;
  /** Returns false when the child process is gone or its stdin is closed. */
  sendSteer: (message: string) => boolean;
}

const runs = new Map<number, ActiveSubagentRun>();
let nextRunId = 1;

export function registerActiveRun(
  agent: string,
  task: string,
  sendSteer: (message: string) => boolean,
): number {
  const runId = nextRunId++;
  runs.set(runId, { runId, agent, task, startedAt: Date.now(), sendSteer });
  return runId;
}

export function unregisterActiveRun(runId: number | undefined): void {
  if (runId !== undefined) runs.delete(runId);
}

export function getActiveRun(runId: number): ActiveSubagentRun | undefined {
  return runs.get(runId);
}

/** All currently active runs, in start order. */
export function listActiveRuns(): ActiveSubagentRun[] {
  return [...runs.values()].sort((a, b) => a.runId - b.runId);
}

export type SubagentMsgTarget =
  | { kind: "ok"; runs: ActiveSubagentRun[] }
  /** Nothing is running. */
  | { kind: "no-runs" }
  /** A target was given but no matching run exists; `available` for the hint. */
  | { kind: "unknown-target"; target: string; available: ActiveSubagentRun[] };

/**
 * Resolve a /subagent-msg target:
 * - "" (no target) → the single active run, or an error listing all runs;
 * - "#N" → exactly that run id;
 * - agent name → every active run of that name (broadcast).
 */
export function resolveSubagentMsgTarget(rawTarget: string): SubagentMsgTarget {
  const target = rawTarget.trim();
  const available = listActiveRuns();

  if (target === "") {
    if (available.length === 0) return { kind: "no-runs" };
    if (available.length > 1) {
      return { kind: "unknown-target", target, available };
    }
    return { kind: "ok", runs: [available[0]] };
  }

  const runIdMatch = /^#(\d+)$/.exec(target);
  if (runIdMatch) {
    const run = runs.get(Number(runIdMatch[1]));
    if (!run) return { kind: "unknown-target", target, available };
    return { kind: "ok", runs: [run] };
  }

  const byName = available.filter((run) => run.agent === target);
  if (byName.length === 0) return { kind: "unknown-target", target, available };
  return { kind: "ok", runs: byName };
}

/** One-line human description of a run for user-facing listings. */
export function describeRun(run: ActiveSubagentRun, maxTaskChars = 60): string {
  const task = run.task.replace(/\s+/g, " ").trim();
  if (!task) return `#${run.runId} ${run.agent}`;
  const preview = task.length > maxTaskChars ? `${task.slice(0, maxTaskChars - 1)}…` : task;
  return `#${run.runId} ${run.agent} — "${preview}"`;
}
