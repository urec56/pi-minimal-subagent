import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { discoverAgents } from "./agents.ts";
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
}
