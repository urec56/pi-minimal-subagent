import { discoverAgents } from "./agents.ts";
import { resolveSettings } from "./settings.ts";
import type { AgentConfig, Settings } from "./types.ts";

/**
 * Session-level selection made via the /agent command:
 * - `undefined` (default): fall back to settings `activeAgent`.
 * - a name: use that agent for this session.
 * - `"none"`: explicitly disabled, even if settings configure one.
 */
export type SessionOverride = string | "none" | undefined;

export interface EffectiveActiveAgent {
  /** The resolved agent for the main session, or null when none is active. */
  agent: AgentConfig | null;
  /** Name that was requested (via settings or /agent) but not found. */
  missing?: string;
}

/**
 * Pure resolution of which agent name should be active, without touching disk.
 * Priority: explicit "none" > session command override > settings `activeAgent`.
 */
export function requestedActiveAgentName(
  settings: Pick<Settings, "activeAgent">,
  sessionOverride: SessionOverride,
): string | null {
  if (sessionOverride === "none") return null;
  if (typeof sessionOverride === "string" && sessionOverride.trim()) return sessionOverride.trim();

  const fromSettings = settings.activeAgent?.trim();
  return fromSettings || null;
}

/**
 * Resolve which agent (if any) should act as the main-session persona.
 * Re-discovers agents and re-reads settings so file changes apply live.
 */
export function resolveEffectiveActiveAgent(
  cwd: string,
  sessionOverride: SessionOverride,
): EffectiveActiveAgent {
  const requested = requestedActiveAgentName(resolveSettings(cwd), sessionOverride);
  if (!requested) return { agent: null };

  const discovery = discoverAgents(cwd);
  const agent = discovery.agents.find((candidate) => candidate.name === requested);
  return agent ? { agent } : { agent: null, missing: requested };
}
