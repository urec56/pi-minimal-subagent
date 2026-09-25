import * as fs from "node:fs";
import { resolveConfiguredPath } from "./settings.ts";

/**
 * Context warning ("stop instruction") feature.
 *
 * An agent's frontmatter can configure `contextWarning` with a threshold
 * percentage and a `.md`/`.txt` file whose content is sent to the subagent as
 * a steer command (same mechanism as /subagent-msg) once its context usage
 * reaches the threshold — the same numbers pi's own `X%/Yk` indicator shows.
 * The idea: tell the subagent to wrap up while there is still context left.
 *
 * Validation happens at every subagent launch (index.ts). The message file
 * content is read once then and kept in memory for the run; nothing touches
 * disk after that. Invalid configuration never breaks the run — it only turns
 * the feature off for this launch, with an alert listing all found problems.
 */

export interface ContextWarning {
  /** Validated threshold percentage (0..100 inclusive). */
  percent: number;
  /** Resolved absolute path of the message file (.md/.txt). */
  messageFile: string;
  /** File content captured at validation time, sent as-is when triggered. */
  content: string;
}

export type ContextWarningValidation =
  | { ok: true; warning: ContextWarning }
  | { ok: false; errors: string[] };

function describeValue(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" && text.length <= 80 ? text : String(value);
  } catch {
    return String(value);
  }
}

/**
 * Validate a raw `contextWarning` frontmatter value for an agent launch.
 * Relative messageFile paths resolve against the session cwd (absolute and
 * `~/...` paths are used as-is, matching pi's own path resolution). All found
 * problems are collected into one list so a single alert can show them all.
 */
export function validateContextWarning(raw: unknown, cwd: string): ContextWarningValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: [`contextWarning must be an object (got ${describeValue(raw)})`] };
  }

  const value = raw as Record<string, unknown>;
  const errors: string[] = [];

  let percent: number | undefined;
  if (!Object.hasOwn(value, "percent")) {
    errors.push("contextWarning.percent is required");
  } else if (typeof value.percent !== "number" || !Number.isFinite(value.percent)) {
    errors.push(`contextWarning.percent must be a finite number between 0 and 100 (got ${describeValue(value.percent)})`);
  } else if (value.percent < 0) {
    errors.push(`contextWarning.percent must be >= 0 (got ${value.percent})`);
  } else if (value.percent > 100) {
    errors.push(`contextWarning.percent must be <= 100 (got ${value.percent})`);
  } else {
    percent = value.percent;
  }

  let messageFile: string | undefined;
  if (!Object.hasOwn(value, "messageFile")) {
    errors.push("contextWarning.messageFile is required");
  } else if (typeof value.messageFile !== "string" || !value.messageFile.trim()) {
    errors.push(`contextWarning.messageFile must be a non-empty string (got ${describeValue(value.messageFile)})`);
  } else {
    messageFile = value.messageFile;
  }

  let content: string | undefined;
  let resolvedPath: string | undefined;
  if (messageFile !== undefined) {
    const trimmedPath = messageFile.trim();
    const lower = trimmedPath.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".txt")) {
      errors.push(`contextWarning.messageFile must end in .md or .txt (got "${trimmedPath}")`);
    } else {
      const resolved = resolveConfiguredPath(trimmedPath, cwd);
      let stats: fs.Stats | null;
      try {
        stats = fs.statSync(resolved);
      } catch {
        errors.push(`contextWarning.messageFile does not exist: ${resolved}`);
        stats = null;
      }
      if (stats) {
        if (!stats.isFile()) {
          // statSync succeeded but the path is not a regular file (e.g. a directory).
          errors.push(`contextWarning.messageFile is not a regular file: ${resolved}`);
        } else {
          try {
            content = fs.readFileSync(resolved, "utf-8");
            resolvedPath = resolved;
          } catch (err) {
            errors.push(
              `contextWarning.messageFile could not be read: ${resolved} (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
      }
    }
  }

  if (errors.length > 0 || percent === undefined || content === undefined || resolvedPath === undefined) {
    return { ok: false, errors };
  }

  if (!content.trim()) {
    return { ok: false, errors: [`contextWarning.messageFile is empty: ${resolvedPath}`] };
  }

  return { ok: true, warning: { percent, messageFile: resolvedPath, content } };
}

/**
 * One-shot threshold evaluation. Fires when the run has real usage data and its
 * context fill (tokens over window — exactly what pi's `X%/Yk` indicator
 * shows) reaches the configured percentage. Called after every event that can
 * update usage; the caller guards one delivery per run.
 */
export function evaluateContextWarning(
  warning: Pick<ContextWarning, "percent">,
  contextWindow: number | undefined,
  contextTokens: number | undefined,
): { reached: true; percent: number } | { reached: false } {
  if (typeof contextWindow !== "number" || !(contextWindow > 0)) return { reached: false };
  if (typeof contextTokens !== "number" || !(contextTokens > 0)) return { reached: false };

  const percent = (contextTokens / contextWindow) * 100;
  if (percent < warning.percent) return { reached: false };
  return { reached: true, percent };
}
