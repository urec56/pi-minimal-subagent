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
    }
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

The extension does not block recursive usage. If a user loads this extension inside a subagent, nested subagent calls are allowed.

### Subagent environment markers

Every spawned child always receives `PI_IS_SUBAGENT=1`, and — when the parent session id is available — `PI_SUBAGENT_PARENT_SESSION=<parent session id>`. These follow the conventions expected by `@gotgenes/pi-permission-system` (and `pi-agent-router`): they let a child running without a UI detect that it is a subagent and forward `ask` permission prompts to the parent session's UI instead of auto-denying them. The variables are set after the configured `environment` merge, so they cannot be overridden or stripped by settings. Nested subagent calls re-derive the marker from their own session, so each level points at its direct parent.

## Development

From this directory:

```bash
npm run typecheck
pi -e .
```
