import type { Model } from "@mariozechner/pi-ai";

/**
 * Structural view of the model registry surface we rely on. Using a minimal
 * interface (instead of importing pi internals) keeps this resilient to pi
 * version changes; ctx.modelRegistry satisfies it structurally.
 */
export interface ModelCatalogLike {
  find(provider: string, modelId: string): Model<any> | undefined;
  getAll(): Model<any>[];
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ResolvedThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface AgentModelResolution {
  model?: Model<any>;
  /** Thinking level from a "<model>:<level>" suffix, when present. */
  thinkingLevel?: ResolvedThinkingLevel;
  error?: string;
}

function splitThinkingLevel(reference: string): { pattern: string; level?: ResolvedThinkingLevel } {
  const idx = reference.lastIndexOf(":");
  if (idx > 0) {
    const suffix = reference.slice(idx + 1);
    if ((THINKING_LEVELS as readonly string[]).includes(suffix)) {
      return { pattern: reference.slice(0, idx), level: suffix as ResolvedThinkingLevel };
    }
  }
  // Unknown ":suffix" (e.g. OpenRouter-style ids) stays part of the pattern.
  return { pattern: reference };
}

/**
 * Resolve a model reference in the same formats pi accepts for --model:
 * - "provider/modelId" exact reference;
 * - bare model id (ambiguous ids across providers are rejected);
 * - case-insensitive partial match on id or name when it matches exactly one.
 * An optional ":thinkingLevel" suffix is supported, mirroring the CLI.
 */
export function resolveAgentModelRef(reference: string, catalog: ModelCatalogLike): AgentModelResolution {
  const trimmed = reference.trim();
  if (!trimmed) return { error: "Empty model reference." };

  const { pattern, level } = splitThinkingLevel(trimmed);
  if (!pattern) return { error: `Invalid model reference "${reference}".` };

  if (pattern.includes("/")) {
    const idx = pattern.indexOf("/");
    const provider = pattern.slice(0, idx).trim();
    const modelId = pattern.slice(idx + 1).trim();
    if (!provider || !modelId) return { error: `Invalid model reference "${reference}".` };

    const found = catalog.find(provider, modelId);
    return found
      ? { model: found, thinkingLevel: level }
      : { error: `Model ${provider}/${modelId} not found.` };
  }

  const allModels = catalog.getAll();
  const exact = allModels.filter((m) => m.id === pattern);
  if (exact.length === 1) return { model: exact[0], thinkingLevel: level };
  if (exact.length > 1) {
    const options = exact.map((m) => `${m.provider}/${m.id}`).join(", ");
    return { error: `Model id "${pattern}" is ambiguous (${options}). Use provider/model.` };
  }

  const query = pattern.toLowerCase();
  const partial = allModels.filter(
    (m) => m.id.toLowerCase().includes(query) || m.name.toLowerCase().includes(query),
  );
  if (partial.length === 1) return { model: partial[0], thinkingLevel: level };
  if (partial.length > 1) {
    const sample = partial.slice(0, 5).map((m) => `${m.provider}/${m.id}`).join(", ");
    return { error: `Model "${pattern}" is ambiguous (${sample}${partial.length > 5 ? ", …" : ""}). Use provider/model.` };
  }

  return { error: `Model "${reference}" not found. Try "provider/model".` };
}
