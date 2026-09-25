import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { buildActiveAgentBlock } from "./agents.ts";
import { evaluateContextWarning } from "./context-warning.ts";
import { registerActiveRun, unregisterActiveRun } from "./active-runs.ts";
import { getSubagentProgressText, processPiJsonLine } from "./runner-events.js";
import {
  type AgentConfig,
  type Settings,
  type SubagentDetails,
  type SubagentResult,
  emptyUsage,
  normalizeCompletedResult,
} from "./types.ts";

const isWindows = process.platform === "win32";
const SIGKILL_TIMEOUT_MS = 5000;
const AGENT_END_GRACE_MS = 250;
const STDOUT_TAIL_LINES = 40;
type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

export interface RunSubagentOptions {
  cwd: string;
  agent: AgentConfig;
  task: string;
  settings: Settings;
  /** Parent session id, used to advertise PI_SUBAGENT_PARENT_SESSION to the child. */
  parentSessionId?: string | null;
  /**
   * Resolves a model's context window from the parent session's registry
   * (built-in + custom models). Used for the "10.8%/262k"-style indicator.
   */
  resolveContextWindow?: (provider: string, modelId: string) => number | undefined;
  signal?: AbortSignal;
  onUpdate?: OnUpdateCallback;
  /** Called with the spawned child process right after spawn (test cleanup, monitoring). */
  onChildSpawned?: (proc: import("node:child_process").ChildProcess) => void;
  /** Called once the run has fully finished and the child is terminated. */
  onRunFinished?: (runId: number) => void;
  /**
   * Called for every `turn_start` event of the child, with a per-run turn
   * counter starting at 1. Turn #1 belongs to the task itself; every later
   * turn start means one queued steering message was consumed.
   */
  onTurnStart?: (runId: number, turnNumber: number) => void;
  /**
   * Context warning captured at launch (validated agent frontmatter config).
   * When the run's context fill reaches `percent`, `content` is sent once as
   * a steer command — same delivery path as /subagent-msg.
   */
  contextWarning?: { percent: number; content: string };
  /** Called once, after the stop instruction was actually sent (UI alert). */
  onContextWarning?: (runId: number, percent: number) => void;
  makeDetails: (results: SubagentResult[]) => SubagentDetails;
}

/**
 * True when the given file sits inside a package whose `name` identifies it as
 * the Pi coding agent (npm scope varies across releases: @mariozechner/…,
 * @earendil-works/pi-coding-agent, …). Walking up from the resolved entry file
 * finds the owning package.json. This is deliberately independent of env vars:
 * PI_* variables are inherited by arbitrary child processes and cannot tell a
 * real Pi session apart from a script that merely runs in their environment.
 */
function looksLikePiCliEntry(file: string): boolean {
  let dir: string;
  try {
    dir = path.dirname(fs.realpathSync(file));
  } catch {
    return false; // File does not exist — certainly not the Pi CLI entry.
  }

  for (let depth = 0; depth < 12 && dir.length > 1; depth++) {
    try {
      const raw = fs.readFileSync(path.join(dir, "package.json"), "utf-8");
      const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(raw);
      if (nameMatch) return nameMatch[1].endsWith("pi-coding-agent");
    } catch {
      // No package.json at this level — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** Finds an executable on PATH without shelling out. */
function findOnPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(isWindows ? ";" : ":")) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not here — keep looking.
    }
  }
  return undefined;
}

/**
 * Resolves how to spawn a child Pi process:
 * - when this node process IS the Pi CLI (argv[1] points inside the Pi
 *   package): reuse the current node + entry file so children run exactly the
 *   same Pi build;
 * - otherwise (tests, SDK embedding, scripts that merely inherit PI_* env):
 *   fall back to `pi` on PATH.
 *
 * Throws instead of guessing when neither is available — spawning an arbitrary
 * script as if it were the Pi CLI must not happen silently. Note: the PATH
 * fallback locates a bare `pi` executable; Windows wrappers (`pi.cmd`) need
 * shell invocation and are only covered by the in-package fast path.
 */
export function resolvePiSpawn(): { command: string; prefixArgs: string[] } {
  const isNode = /[\\/]node(?:\.exe)?$/i.test(process.execPath);
  if (isNode && process.argv[1] && looksLikePiCliEntry(process.argv[1])) {
    return { command: process.execPath, prefixArgs: [process.argv[1]] };
  }

  const piBin = findOnPath("pi");
  if (!piBin) {
    throw new Error(
      "Unable to locate the Pi CLI: this node process is not a Pi session and no 'pi' executable was found on PATH.",
    );
  }
  return { command: piBin, prefixArgs: [] };
}

function writeSystemPromptToTempFile(agent: AgentConfig): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-subagent-"));
  const filePath = path.join(tmpDir, "system-prompt.md");
  // Advertise the active agent via the <active_agent> tag convention so
  // extensions (e.g. pi-permission-system) can resolve the agent name for
  // per-agent policy and attribute forwarded permission prompts.
  fs.writeFileSync(filePath, buildActiveAgentBlock(agent), { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string | null): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

function createArtifactFiles(): { dir: string; stdoutPath: string; stderrPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minimal-subagent-output-"));
  const stdoutPath = path.join(dir, "stdout.jsonl");
  const stderrPath = path.join(dir, "stderr.log");
  fs.writeFileSync(stdoutPath, "", { encoding: "utf-8", mode: 0o600 });
  fs.writeFileSync(stderrPath, "", { encoding: "utf-8", mode: 0o600 });
  return { dir, stdoutPath, stderrPath };
}

function appendArtifact(filePath: string | undefined, chunk: Buffer | string): void {
  if (!filePath) return;
  try {
    fs.appendFileSync(filePath, chunk);
  } catch {
    // Preserve subagent execution even when diagnostic artifact writing fails.
  }
}

function rememberStdoutLine(result: SubagentResult, line: string): void {
  if (!line.trim()) return;
  if (!Array.isArray(result.stdoutTail)) result.stdoutTail = [];
  result.stdoutTail.push(line);
  while (result.stdoutTail.length > STDOUT_TAIL_LINES) result.stdoutTail.shift();
}

function mergeExtensions(settings: Settings, agent: AgentConfig): string[] {
  return [...new Set([...(settings.extensions ?? []), ...(agent.extensions ?? [])])];
}

function buildChildEnv(settings: Settings, parentSessionId?: string | null): NodeJS.ProcessEnv {
  const inheritedEnv: NodeJS.ProcessEnv = { ...process.env };

  if (isWindows) {
    for (const [configuredKey, configuredValue] of Object.entries(settings.environment)) {
      const normalizedKey = configuredKey.toLowerCase();
      for (const key of Object.keys(inheritedEnv)) {
        if (key.toLowerCase() === normalizedKey) delete inheritedEnv[key];
      }
      inheritedEnv[configuredKey] = configuredValue;
    }
  } else {
    Object.assign(inheritedEnv, settings.environment);
  }

  // Subagent markers so extensions in the child (e.g. pi-permission-system)
  // can detect the subagent context and forward `ask` prompts to the parent UI.
  inheritedEnv.PI_IS_SUBAGENT = "1";
  const trimmedParentSessionId = parentSessionId?.trim();
  if (trimmedParentSessionId) {
    inheritedEnv.PI_SUBAGENT_PARENT_SESSION = trimmedParentSessionId;
  }

  return inheritedEnv;
}

/**
 * Builds the child CLI arguments. The child runs in RPC mode: the task is
 * sent as an initial `prompt` command on stdin (not a positional argument) and
 * stdin stays open so steering messages can be written while it runs.
 */
function buildPiArgs(opts: {
  systemPromptPath: string | null;
  settings: Settings;
  agent: AgentConfig;
}): string[] {
  const { systemPromptPath, settings, agent } = opts;
  const args = ["--mode", "rpc", "--no-session"];
  const extensions = mergeExtensions(settings, agent);

  if (settings.extensions !== null) {
    args.push("--no-extensions");
  }

  for (const extension of extensions) {
    args.push("--extension", extension);
  }

  const model = agent.model ?? settings.model;
  if (model) args.push("--model", model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  if (agent.skills?.length) {
    for (const skill of agent.skills) args.push("--skill", skill);
  }
  if (systemPromptPath) args.push("--append-system-prompt", systemPromptPath);

  return args;
}

export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
  const { cwd, agent, task, settings, signal, onUpdate, makeDetails } = opts;

  const result: SubagentResult = {
    agent: agent.name,
    agentSource: agent.source,
    agentFile: agent.filePath,
    task,
    exitCode: -1,
    messages: [],
    response: "",
    stderr: "",
    usage: emptyUsage(),
  };

  const emitUpdate = () => {
    onUpdate?.({
      content: [
        {
          type: "text",
          text: getSubagentProgressText(result),
        },
      ],
      details: makeDetails([result]),
    });
  };

  let activeRunId: number | undefined;
  let tmpDir: string | null = null;
  let systemPromptPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tmp = writeSystemPromptToTempFile(agent);
    tmpDir = tmp.dir;
    systemPromptPath = tmp.filePath;
  }

  try {
    let spawnInfo: { command: string; prefixArgs: string[] };
    try {
      spawnInfo = resolvePiSpawn();
    } catch (err) {
      // Report a clean tool error instead of crashing or spawning the wrong
      // process (the finally block still cleans up temp files).
      const message = err instanceof Error ? err.message : String(err);
      result.stderr = message;
      return normalizeCompletedResult({ ...result, exitCode: 127 }, false);
    }

    const piArgs = buildPiArgs({ systemPromptPath, settings, agent });
    const artifacts = createArtifactFiles();
    result.artifactDir = artifacts.dir;
    result.stdoutArtifact = artifacts.stdoutPath;
    result.stderrArtifact = artifacts.stderrPath;
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(spawnInfo.command, [...spawnInfo.prefixArgs, ...piArgs], {
        cwd,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildChildEnv(settings, opts.parentSessionId),
      });

      // Let callers (tests, monitoring) track the child for cleanup.
      try {
        opts.onChildSpawned?.(proc);
      } catch {
        // A faulty callback must not break the run.
      }

      proc.stdin.on("error", () => {
        // Ignore broken pipe on fast exits.
      });

      // RPC mode: send the task as a prompt command and keep stdin open so
      // /subagent-msg can steer this run while it is active. Registering the
      // run right after spawn makes it addressable before events start flowing.
      const writeRpcCommand = (command: object): boolean => {
        if (proc.stdin.destroyed || proc.killed) return false;
        try {
          proc.stdin.write(`${JSON.stringify(command)}\n`);
          return true;
        } catch {
          // Child died before reading — the error/close handlers report it.
          return false;
        }
      };

      activeRunId = registerActiveRun(agent.name, task, (message) =>
        writeRpcCommand({ type: "steer", message }),
      );
      result.runId = activeRunId;

      // A failed initial write just means the child is already gone; the
      // error/close handlers finish the run.
      writeRpcCommand({ type: "prompt", message: task });

      let buffer = "";
      let didClose = false;
      let settled = false;
      let turnsSeen = 0;
      let contextWarningFired = false;
      let abortHandler: (() => void) | undefined;
      let semanticCompletionTimer: NodeJS.Timeout | undefined;

      const clearSemanticCompletionTimer = () => {
        if (semanticCompletionTimer) {
          clearTimeout(semanticCompletionTimer);
          semanticCompletionTimer = undefined;
        }
      };

      const terminateChild = () => {
        if (isWindows) {
          if (proc.pid !== undefined) {
            const killer = spawn("taskkill", ["/T", "/F", "/PID", String(proc.pid)], {
              stdio: "ignore",
            });
            killer.unref();
          }
          return;
        }

        proc.kill("SIGTERM");
        const sigkillTimer = setTimeout(() => {
          if (!didClose) proc.kill("SIGKILL");
        }, SIGKILL_TIMEOUT_MS);
        sigkillTimer.unref();
      };

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearSemanticCompletionTimer();
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        resolve(code);
      };

      // Best-effort one-shot resolution of the model's context window once
      // provider/model are known from child events. Undefined means "not in
      // registry" and is cached as-is so we do not re-lookup on every line.
      const maybeResolveContextWindow = () => {
        if (!opts.resolveContextWindow || result.contextWindow !== undefined) return;
        if (!result.provider || !result.model) return;
        try {
          result.contextWindow = opts.resolveContextWindow(result.provider, result.model);
        } catch {
          // Keep it unresolved — the context indicator is best-effort.
        }
      };

      // One-shot context warning: fires on the first event where the run's
      // context fill reaches the configured threshold (same numbers as the
      // X%/Yk indicator). Content was captured at launch, so sending never
      // touches disk. A failed write just means the child is already gone.
      const checkContextWarning = () => {
        const warning = opts.contextWarning;
        if (!warning || contextWarningFired) return;
        const evaluation = evaluateContextWarning(warning, result.contextWindow, result.usage?.contextTokens);
        if (!evaluation.reached) return;
        if (writeRpcCommand({ type: "steer", message: warning.content })) {
          contextWarningFired = true;
          // Tag the re-emitted steering message as an alert activity in the
          // event stream so the UI can distinguish it from a human /subagent-msg.
          result.sentContextAlert = warning.content;
          if (activeRunId !== undefined) opts.onContextWarning?.(activeRunId, evaluation.percent);
        }
      };

      const flushLine = (line: string) => {
        rememberStdoutLine(result, line);
        if (processPiJsonLine(line, result)) {
          maybeResolveContextWindow();
          checkContextWarning();
          emitUpdate();
        }
        // A queued steering message is consumed at the next turn boundary:
        // turn #1 belongs to the task itself, so every later turn_start
        // corresponds to one delivered message.
        if (line.includes('"turn_start"')) {
          try {
            const event = JSON.parse(line);
            if (event?.type === "turn_start") {
              turnsSeen += 1;
              if (activeRunId !== undefined) opts.onTurnStart?.(activeRunId, turnsSeen);
            }
          } catch {
            // Incomplete line — the next flush will carry the full event.
          }
        }
        maybeFinishOnSemanticCompletion();
      };

      const flushBufferedLines = (text: string) => {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) flushLine(line);
        }
      };

      const maybeFinishOnSemanticCompletion = () => {
        // agent_settled (RPC mode: full quiescence, no queued continuations)
        // or a non-retrying agent_end as the fallback for older pi versions.
        if (!(result.sawAgentSettled || result.sawAgentEnd) || didClose || settled) return;
        clearSemanticCompletionTimer();
        semanticCompletionTimer = setTimeout(() => {
          if (didClose || settled || !(result.sawAgentSettled || result.sawAgentEnd)) return;
          if (buffer.trim()) {
            flushBufferedLines(buffer);
            buffer = "";
          }
          proc.stdout.removeListener("data", onStdoutData);
          proc.stderr.removeListener("data", onStderrData);
          finish(0);
          terminateChild();
        }, AGENT_END_GRACE_MS);
        semanticCompletionTimer.unref();
      };

      const onStdoutData = (chunk: Buffer) => {
        appendArtifact(result.stdoutArtifact, chunk);
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) flushLine(line);
      };

      const onStderrData = (chunk: Buffer) => {
        appendArtifact(result.stderrArtifact, chunk);
        result.stderr += chunk.toString();
      };

      proc.stdout.on("data", onStdoutData);
      proc.stderr.on("data", onStderrData);

      proc.on("close", (code) => {
        didClose = true;
        if (buffer.trim()) flushBufferedLines(buffer);
        finish(code ?? 0);
      });

      proc.on("error", (err) => {
        appendArtifact(result.stderrArtifact, `${err.message}\n`);
        if (!result.stderr.trim()) result.stderr = err.message;
        finish(1);
      });

      if (signal) {
        abortHandler = () => {
          if (didClose || settled) return;
          wasAborted = true;
          terminateChild();
        };
        if (signal.aborted) abortHandler();
        else signal.addEventListener("abort", abortHandler, { once: true });
      }
    });

    result.exitCode = exitCode;
    return normalizeCompletedResult(result, wasAborted);
  } finally {
    unregisterActiveRun(activeRunId);
    if (activeRunId !== undefined) {
      try {
        opts.onRunFinished?.(activeRunId);
      } catch {
        // UI bookkeeping must not break the result.
      }
    }
    cleanupTempDir(tmpDir);
  }
}
