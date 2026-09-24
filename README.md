# Pi Minimal Subagents

Minimal named subagent tool for Pi.

## Installation

Install directly from GitHub with Pi:

```bash
pi install git:github.com/elpapi42/pi-minimal-subagent
```

Then restart Pi, or run `/reload` in an existing session if your Pi version supports extension reloads.

For local development from this checkout:

```bash
cd /home/whitman/minimal-subagent/pi-minimal-subagents
pi -e .
```

## Usage

It registers one tool:

```json
{ "agent": "scout", "task": "Inspect the auth flow and report risks." }
```

There are no built-in parallel, chain, pool, or orchestrator modes. If the parent agent wants parallel subagents, it should call `subagent` multiple times in the same turn and let Pi execute those tool calls concurrently.

## Sending messages to running subagents

Subagent runs operate in Pi's RPC mode under the hood, so you can send them additional messages while they work. Use `/subagent-msg`:

```
/subagent-msg also check edge cases      → the single active run
/subagent-msg #2 skip the legacy path    → a specific run by id
/subagent-msg reviewer be concise        → all active runs of that agent
```

A message is sent as a *steer* command: while the subagent is streaming it waits in its queue and is delivered right after the current turn finishes executing tool calls — the same semantics as typing into a busy Pi session. If nothing matches (or nothing is running), the reply lists the active runs.

A delivered message shows up in the subagent's activity list at its delivery point:

```
✓ thinking 39 chars
✓ read ~/projects/work/pf-saas_back/internal/web/handler/admin.go
✓ user Доделал уже?
✓ write /tmp/writer-test-routes.md
```

Every run gets an id (`#N`) shown next to its agent name in the progress and usage lines:

```
… running reviewer #2
#2 32 turns ↑105k ↓25k R2.5M 40.1%/262k litellm/qwen
```

`/subagent-msg` without a message shows what the target run(s) currently are; with no active runs it reports that.

## Agent files

Agents are Markdown files with YAML frontmatter:

```markdown
---
name: scout
description: Fast codebase reconnaissance
model: claude-haiku-4-5
extensions: npm:some-pi-extension
---
You are a fast codebase scout. Return dense findings for the parent agent.
```

Loaded from:

- Pi's global agent directory, usually `~/.pi/agent/agents/*.md` and honoring `PI_CODING_AGENT_DIR`
- `.pi/agents/*.md` in the current project or an ancestor directory

Project agents override user agents with the same name.

Supported optional frontmatter: `model`, `extensions`, `skills`, and `thinking`.

Subagents use Pi's default enabled tools. This extension does not read `tools` frontmatter and does not pass `--tools` to child Pi processes. Extra tools should come from configured extensions.

## Settings

Global settings live in Pi's agent settings file (usually `~/.pi/agent/settings.json`; honors `PI_CODING_AGENT_DIR`). Project settings live in `.pi/settings.json` and override global settings.

```jsonc
{
  "pi-minimal-subagent": {
    "model": null,
    "extensions": [
      "git:git@github.com:elpapi42/pi-codemapper.git",
      "npm:pi-rtk-optimizer"
    ],
    "environment": {
      "MY_EXTENSION_MODE": "subagent",
      "SERVICE_BASE_URL": "https://example.test"
    },
    "activeAgent": null
  }
}
```

`model` is the default model for spawned subagents. Agent frontmatter `model` overrides it.

`extensions` is tri-state, matching `pi-fork`:

- `null` or omitted: child subagents load normal Pi extensions from settings and auto-discovery.
- `[]`: child subagents run with `--no-extensions` and no default extra extensions.
- non-empty array: child subagents run with `--no-extensions`, then explicitly load those extensions.

Agent frontmatter `extensions` are always appended as explicit `--extension` entries. With `extensions: null`, they are added on top of normal Pi extension loading; with `[]` or a non-empty array, they are the only additions besides the configured list.

`environment` is an optional object of environment variables for spawned subagents. Each key is an environment variable name and each value should be a string. Non-string entries and invalid or empty variable names are ignored; empty string values are allowed when intentional.

Configured `environment` values apply to all subagent runs in the resolved global/project scope. Global and project `environment` objects merge by variable name, with project values overriding global values for the same name.

Subagents still inherit the parent Pi process environment. The configured `environment` values are merged on top of that inherited environment, so configured names add new variables or override inherited values, while omitted names continue to inherit normally. If `environment` is omitted, subagents keep today's inherited-environment behavior.

This is a minimal escape hatch for env-configured extensions. It is not per-agent configuration, not per-invocation configuration, not an isolated environment mode, and not a secret masking, auditing, or secrets-management system. Configured values affect spawned subagents only; they do not change the parent/main agent environment.

### Active agent (main session)

By default the main session runs with Pi's normal prompt and reaches configured agents through `subagent` calls. If you want the main session to answer directly as a specific agent (for example, talk to your searcher without an orchestrator hop), activate it:

```jsonc
{ "pi-minimal-subagent": { "activeAgent": "searcher" } }
```

`activeAgent` is tri-state like `model`: omitted inherits the global value, a string activates that agent, and explicit `null` disables an inherited value. The referenced agent must exist in `~/.pi/agent/agents/*.md` or `.pi/agents/*.md`; project agents override user agents with the same name.

When active on every run of the main session, the agent's system prompt is **appended** to Pi's assembled prompt — exactly like subagent runs receive it via `--append-system-prompt` (including the `<active_agent name="...">` marker). Nothing else changes: tools, model, and session behavior stay as configured.

The selection can also be made per session with the `/agent` command (argument autocomplete lists all discovered agents plus `none`):

- `/agent searcher` — this session answers as `searcher`, overriding settings for the current process/session;
- `/agent searcher --model` — additionally switches the session model to the agent's frontmatter `model:` (explicit request only; without `--model` the model is never touched). References are resolved like pi's `--model`: `provider/modelId`, a bare model id, or a unique partial match; an optional `:thinkingLevel` suffix is applied too;
- `/agent none` — disable for this session even if settings configure one;
- `/agent` (no argument) — show the currently effective agent and the list of available agents.

The active agent is shown in the status line as `active-agent: <name>`. Subagent child processes never receive a second injection (`PI_IS_SUBAGENT=1` disables it), so nested runs keep exactly one persona.

The extension does not block recursive usage. If a user loads this extension inside a subagent, nested subagent calls are allowed.

### Subagent environment markers

Every spawned child always receives `PI_IS_SUBAGENT=1`, and — when the parent session id is available — `PI_SUBAGENT_PARENT_SESSION=<parent session id>`. These follow the conventions expected by `@gotgenes/pi-permission-system` (and `pi-agent-router`): they let a child running without a UI detect that it is a subagent and forward `ask` permission prompts to the parent session's UI instead of auto-denying them. The variables are set after the configured `environment` merge, so they cannot be overridden or stripped by settings. Nested subagent calls re-derive the marker from their own session, so each level points at its direct parent.

## Development

From this directory:

```bash
npm run typecheck
pi -e .
```
