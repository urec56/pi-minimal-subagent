import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { buildActiveAgentBlock, discoverAgents } from "./agents.ts";
import {
  resolveEffectiveActiveAgent,
  type EffectiveActiveAgent,
  type SessionOverride,
} from "./active-agent.ts";
import { resolveAgentModelRef } from "./model-ref.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import { runSubagent } from "./runner.ts";
import { getResultSummaryText } from "./runner-events.js";
import { resolveSettings } from "./settings.ts";
import {
  type SubagentDetails,
  type SubagentResult,
  emptyUsage,
  isResultError,
} from "./types.ts";

/**
 * Best-effort read of the current (parent) session id.
 * Passed to the child as PI_SUBAGENT_PARENT_SESSION so extensions like
 * pi-permission-system can forward `ask` prompts to the parent UI.
 */
function getParentSessionId(ctx: ExtensionContext): string | null {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
  } catch {
    // sessionManager unavailable — forwarding degrades gracefully.
  }
  return null;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description: "Name of the configured agent to run. Agents are loaded from ~/.pi/agent/agents/*.md and project .pi/agents/*.md files.",
  }),
  task: Type.String({
    description: "The focused task for the subagent. Include the expected scope, decision boundary, and return shape.",
  }),
});

function makeDetails(results: SubagentResult[], extra?: Omit<SubagentDetails, "results">): SubagentDetails {
  return { results, ...extra };
}

function failedResult(agent: string, task: string, message: string): SubagentResult {
  return {
    agent,
    agentSource: "unknown",
    task,
    exitCode: 1,
    messages: [],
    response: "",
    stderr: message,
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: message,
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run one named subagent on one focused task in an isolated Pi subprocess. The tool accepts only an agent name and a task. For parallel work, call this tool multiple times in the same turn.",
    parameters: SubagentParams,
    renderCall: renderSubagentCall,
    renderResult: renderSubagentResult,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const discovery = discoverAgents(ctx.cwd);
      const agent = discovery.agents.find((candidate) => candidate.name === params.agent);

      if (!agent) {
        const availableAgents = discovery.agents.map((candidate) => candidate.name);
        const message = availableAgents.length > 0
          ? `Unknown subagent "${params.agent}". Available agents: ${availableAgents.join(", ")}.`
          : "No subagents found. Add agent markdown files to ~/.pi/agent/agents or .pi/agents.";
        const result = failedResult(params.agent, params.task, message);
        return {
          content: [{ type: "text" as const, text: message }],
          details: makeDetails([result], {
            availableAgents,
            projectAgentsDir: discovery.projectAgentsDir,
          }),
          isError: true,
        };
      }

      const settings = resolveSettings(ctx.cwd);
      const parentSessionId = getParentSessionId(ctx);
      const result = await runSubagent({
        cwd: ctx.cwd,
        agent,
        task: params.task,
        settings,
        parentSessionId,
        signal,
        onUpdate,
        makeDetails: (results) => makeDetails(results, {
          projectAgentsDir: discovery.projectAgentsDir,
        }),
      });

      if (isResultError(result)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Subagent ${result.stopReason || "failed"}: ${getResultSummaryText(result)}`,
            },
          ],
          details: makeDetails([result], {
            projectAgentsDir: discovery.projectAgentsDir,
          }),
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: getResultSummaryText(result) }],
        details: makeDetails([result], {
          projectAgentsDir: discovery.projectAgentsDir,
        }),
      };
    },
  });

  // --- Active agent for the main session ----------------------------------
  // Lets the main session answer directly as a configured agent (e.g. a
  // searcher) instead of orchestrating subagent calls. The agent's system
  // prompt is appended to the main session prompt on every run, exactly like
  // subagent runs get it via --append-system-prompt.
  const isSubagentChild = Boolean(process.env.PI_IS_SUBAGENT);
  // undefined → follow settings `activeAgent`; "none" → explicitly disabled.
  let sessionOverride: SessionOverride = undefined;
  let knownAgentNames: string[] = [];
  const warnedMissingAgents = new Set<string>();

  const refreshKnownAgents = (cwd?: string): void => {
    try {
      knownAgentNames = discoverAgents(cwd ?? process.cwd()).agents.map((agent) => agent.name);
    } catch {
      // Discovery failed — keep the previous list for completions.
    }
  };

  const effectiveState = (ctx: ExtensionContext): EffectiveActiveAgent =>
    resolveEffectiveActiveAgent(ctx.cwd, sessionOverride);

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    try {
      const state = effectiveState(ctx);
      ctx.ui.setStatus("pi-minimal-subagent", state.agent ? `active-agent: ${state.agent.name}` : undefined);
    } catch {
      // Status display is best-effort.
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (isSubagentChild) return; // subagent children keep their own persona
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Never double-inject inside subagent child processes: they already get
    // their agent prompt via --append-system-prompt.
    if (isSubagentChild) return;

    const state = effectiveState(ctx);
    if (!state.agent || !state.agent.systemPrompt.trim()) {
      if (state.missing && warnedMissingAgents.add(state.missing)) {
        try {
          ctx.ui.notify(`Active agent "${state.missing}" was not found; no agent prompt is applied.`, "warning");
        } catch {
          // Notifications are best-effort.
        }
      }
      return;
    }

    const block = buildActiveAgentBlock(state.agent);
    if (event.systemPrompt.includes(block)) return; // defensive: already appended this turn
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.registerCommand("agent", {
    description:
      "Select which agent answers in the main session. /agent <name> [--model], or 'none' to disable.",
    getArgumentCompletions: (prefix): AutocompleteItem[] => {
      const items = [...knownAgentNames, "none"];
      return items.filter((name) => name.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      if (isSubagentChild) {
        ctx.ui.notify("/agent only applies to the main session; this process is a subagent run.", "warning");
        return;
      }

      refreshKnownAgents(ctx.cwd);
      const discovery = discoverAgents(ctx.cwd);
      const availableNames = discovery.agents.map((agent) => agent.name);

      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const wantModel = tokens.includes("--model");
      const names = tokens.filter((token) => token !== "--model");

      if (names.length > 1) {
        ctx.ui.notify("Usage: /agent <name> [--model] | none", "error");
        return;
      }

      // No argument: show the current effective agent and what is available.
      if (names.length === 0) {
        const state = effectiveState(ctx);
        const settingsName = resolveSettings(ctx.cwd).activeAgent ?? null;
        let headline: string;
        if (!state.agent) {
          headline = sessionOverride === "none" ? "none (disabled via /agent none)" : "none";
        } else if (typeof sessionOverride === "string" && state.agent.name === sessionOverride) {
          headline = `${state.agent.name} (set via /agent)`;
        } else if (settingsName !== null && state.agent.name === settingsName) {
          headline = `${state.agent.name} (from settings activeAgent)`;
        } else {
          headline = state.agent.name;
        }

        ctx.ui.notify(
          `Active agent for this session: ${headline}\nAvailable agents: ${availableNames.join(", ") || "(none found)"}`,
          "info",
        );
        return;
      }

      const requested = names[0];

      if (requested === "none") {
        sessionOverride = "none";
        updateStatus(ctx);
        ctx.ui.notify("Active agent disabled for this session.", "info");
        return;
      }

      const agent = discovery.agents.find((candidate) => candidate.name === requested);
      if (!agent) {
        ctx.ui.notify(
          `Unknown agent "${requested}". Available agents: ${availableNames.join(", ") || "(none found)"}`,
          "error",
        );
        return;
      }

      sessionOverride = agent.name;
      updateStatus(ctx);
      const baseMessage = `Active agent for this session: ${agent.name}`;

      // Model switching is opt-in via --model (explicit request only).
      if (!wantModel) {
        ctx.ui.notify(baseMessage, "info");
        return;
      }

      if (!agent.model) {
        ctx.ui.notify(`${baseMessage}. Agent "${agent.name}" does not define a model in its frontmatter.`, "warning");
        return;
      }

      const resolved = resolveAgentModelRef(agent.model, ctx.modelRegistry);
      if (resolved.error || !resolved.model) {
        ctx.ui.notify(`${baseMessage}. Model switch failed: ${resolved.error ?? "unknown error"}`, "error");
        return;
      }

      const applied = await pi.setModel(resolved.model);
      if (!applied) {
        ctx.ui.notify(
          `${baseMessage}. No API key available for ${resolved.model.provider}/${resolved.model.id}.`,
          "warning",
        );
        return;
      }

      if (resolved.thinkingLevel) {
        try {
          pi.setThinkingLevel(resolved.thinkingLevel as Parameters<typeof pi.setThinkingLevel>[0]);
        } catch {
          // Thinking level unknown to this pi version — the model switch still applied.
        }
      }

      const modelLabel = `${resolved.model.provider}/${resolved.model.id}${
        resolved.thinkingLevel ? ` (${resolved.thinkingLevel})` : ""
      }`;
      ctx.ui.notify(`${baseMessage}. Model: ${modelLabel}`, "info");
    },
  });

  refreshKnownAgents(); // best-effort initial completion list (process.cwd() == session cwd)
}
