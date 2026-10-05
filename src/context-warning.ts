import * as fs from "node:fs";
import { resolveConfiguredPath } from "./settings.ts";

/**
 * Context warning ("stop instruction") feature.
 *
 * An agent's frontmatter can configure `contextWarning` as a list of
 * `{ percent, messageFile }` entries. Each entry's `.md`/`.txt` file content is
 * sent to the subagent as a steer command (same mechanism as /subagent-msg)
 * once its context usage (the same numbers pi's own `X%/Yk` indicator shows)
 * reaches the entry's threshold — at most once per entry, in ascending
 * threshold order. The idea: tell the subagent to wrap up while there is still
 * context left.
 *
 * Validation happens at every subagent launch (index.ts). Message file content
 * is read once then and kept in memory for the run; nothing touches disk after
 * that. Invalid configuration never breaks the run — it only turns the feature
 * off for this launch, with an alert listing all found problems.
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
  | { ok: true; warnings: ContextWarning[] }
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
 * Validate one `contextWarning` list entry. All found problems are collected
 * into a list, prefixed with the entry index so one alert can show them all.
 */
function validateEntry(raw: unknown, index: number, cwd: string): { warning?: ContextWarning; errors: string[] } {
  const prefix = `contextWarning[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { errors: [`${prefix} must be an object (got ${describeValue(raw)})`] };
  }

  const value = raw as Record<string, unknown>;
  const errors: string[] = [];

  let percent: number | undefined;
  if (!Object.hasOwn(value, "percent")) {
    errors.push(`${prefix}.percent is required`);
  } else if (typeof value.percent !== "number" || !Number.isFinite(value.percent)) {
    errors.push(`${prefix}.percent must be a finite number between 0 and 100 (got ${describeValue(value.percent)})`);
  } else if (value.percent < 0) {
    errors.push(`${prefix}.percent must be >= 0 (got ${value.percent})`);
  } else if (value.percent > 100) {
    errors.push(`${prefix}.percent must be <= 100 (got ${value.percent})`);
  } else {
    percent = value.percent;
  }

  let messageFile: string | undefined;
  if (!Object.hasOwn(value, "messageFile")) {
    errors.push(`${prefix}.messageFile is required`);
  } else if (typeof value.messageFile !== "string" || !value.messageFile.trim()) {
    errors.push(`${prefix}.messageFile must be a non-empty string (got ${describeValue(value.messageFile)})`);
  } else {
    messageFile = value.messageFile;
  }

  let content: string | undefined;
  let resolvedPath: string | undefined;
  if (messageFile !== undefined) {
    const trimmedPath = messageFile.trim();
    const lower = trimmedPath.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".txt")) {
      errors.push(`${prefix}.messageFile must end in .md or .txt (got "${trimmedPath}")`);
    } else {
      const resolved = resolveConfiguredPath(trimmedPath, cwd);
      let stats: fs.Stats | null;
      try {
        stats = fs.statSync(resolved);
      } catch {
        errors.push(`${prefix}.messageFile does not exist: ${resolved}`);
        stats = null;
      }
      if (stats) {
        if (!stats.isFile()) {
          // statSync succeeded but the path is not a regular file (e.g. a directory).
          errors.push(`${prefix}.messageFile is not a regular file: ${resolved}`);
        } else {
          try {
            content = fs.readFileSync(resolved, "utf-8");
            resolvedPath = resolved;
          } catch (err) {
            errors.push(
              `${prefix}.messageFile could not be read: ${resolved} (${err instanceof Error ? err.message : String(err)})`,
            );
          }
        }
      }
    }
  }

  if (errors.length > 0 || percent === undefined || content === undefined || resolvedPath === undefined) {
    return { errors };
  }

  if (!content.trim()) {
    return { errors: [`${prefix}.messageFile is empty: ${resolvedPath}`] };
  }

  return { warning: { percent, messageFile: resolvedPath, content }, errors: [] };
}

/**
 * Validate a raw `contextWarning` frontmatter value for an agent launch.
 *
 * The value must be a list of `{ percent, messageFile }` entries; `undefined`,
 * `null` and an empty list all mean "not configured" (silently off). Relative
 * messageFile paths resolve against the session cwd (absolute and `~/...`
 * paths are used as-is, matching pi's own path resolution). All found problems
 * are collected into one list so a single alert can show them all.
 */
export function validateContextWarning(raw: unknown, cwd: string): ContextWarningValidation {
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
    return { ok: true, warnings: [] };
  }

  if (!Array.isArray(raw)) {
    return {
      ok: false,
      errors: [`contextWarning must be an array of { percent, messageFile } entries (got ${describeValue(raw)})`],
    };
  }

  const errors: string[] = [];
  const warnings: ContextWarning[] = [];
  raw.forEach((entry, index) => {
    const validated = validateEntry(entry, index, cwd);
    errors.push(...validated.errors);
    if (validated.warning) warnings.push(validated.warning);
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // A duplicate threshold is a configuration mistake: with "highest reached
  // only" delivery one of the entries would be silently dead.
  const indexesByPercent = new Map<number, number[]>();
  warnings.forEach((warning, index) => {
    const indexes = indexesByPercent.get(warning.percent) ?? [];
    indexes.push(index);
    indexesByPercent.set(warning.percent, indexes);
  });
  for (const [percent, indexes] of indexesByPercent) {
    if (indexes.length > 1) {
      errors.push(`contextWarning.percent ${percent} is specified more than once (entries ${indexes.join(", ")})`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  warnings.sort((a, b) => a.percent - b.percent);
  return { ok: true, warnings };
}

/**
 * Pick the warning to deliver on the next context update.
 *
 * Returns the highest not-yet-consumed entry whose threshold is reached by the
 * current context fill (tokens over window — exactly what pi's `X%/Yk`
 * indicator shows). `nextIndex` marks how many entries were already consumed
 * (delivered or skipped); a threshold jumped over in one update is skipped
 * silently and never delivered. Called after every event that can update
 * usage; the caller advances `nextIndex` past the returned index.
 */
export function selectContextWarning(
  warnings: readonly ContextWarning[],
  nextIndex: number,
  contextWindow: number | undefined,
  contextTokens: number | undefined,
): { index: number; percent: number } | undefined {
  if (typeof contextWindow !== "number" || !(contextWindow > 0)) return undefined;
  if (typeof contextTokens !== "number" || !(contextTokens > 0)) return undefined;

  const percent = (contextTokens / contextWindow) * 100;
  for (let index = warnings.length - 1; index >= nextIndex; index--) {
    if (warnings[index].percent <= percent) {
      return { index, percent };
    }
  }
  return undefined;
}
