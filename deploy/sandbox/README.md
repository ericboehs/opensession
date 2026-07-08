# `backstage-runner` image

Prebaked container image for the **Docker sandbox provider** (see
`docs/sandboxes-plan.md` §3–§5, Phase 1). One container per session runs the
existing runner-host entry inside an isolated filesystem/env/network, with the
session's git worktree **bind-mounted at its identical host path**.

## What it contains

| Component | Purpose | Pin |
| --- | --- | --- |
| `bun` | runs the runner bundle + Bun `$` exec | `1.3.14` (host) |
| Node.js LTS | native-dep builds, tooling | `20.x` |
| `git`, `gh` | clone / status / diff / push / PR | apt latest |
| `ripgrep` | @-mention file search | apt |
| `python3`, `build-essential` | worktree `bun install` native deps | apt |
| Claude Code CLI | Claude Agent SDK spawns it as a child | `2.1.204` (host) |
| runner bundle | `/home/ubuntu/projects/tella-backstage` (`src/`, `backstage.ts`, `tsconfig.json`) + `node_modules` | from lockfile |
| vendored codex binary | `@openai/codex-linux-x64` (musl, ~223 MB) — Codex exec/app-server | via `bun.lock` |
| `@anthropic-ai/claude-agent-sdk` | Claude engine | via `bun.lock` |
| minimal `~/.claude/settings.json` | so `settingSources:["user"]` doesn't error | `{}` |

Runs as uid **1000** user `ubuntu` (matches the host uid) so bind-mounted
worktrees keep sane ownership. Default `CMD` is `sleep infinity` — the provider
starts the container long-lived and `docker exec`s runs into it; there's no
baked ENTRYPOINT.

## Why path parity matters

The runner config is hardcoded to host absolute paths:
`pathToClaudeCodeExecutable = /home/ubuntu/.local/bin/claude`, the runner bundle
at `/home/ubuntu/projects/tella-backstage`, and the session worktree
bind-mounted at its **same** host path. The image reproduces every one of those
absolute paths exactly. If any drifts, the in-container runner can't find the
CLI, the SDK, the codex binary, or the worktree. Do not "tidy" these paths.

## Build

```sh
deploy/sandbox/build.sh
```

Tags `backstage-runner:latest` and `backstage-runner:<git-sha>` from the repo
root context. Override the name with `IMAGE=... deploy/sandbox/build.sh`.

Version pins are `ARG`s in the Dockerfile (`BUN_VERSION`, `CLAUDE_VERSION`,
`NODE_MAJOR`) — override per build with `--build-arg` if needed.

## When to rebuild

- **Claude CLI bump** on the host (`claude --version` changes) → bump
  `CLAUDE_VERSION`. The in-container CLI must match host session-resume behavior.
- **Codex SDK bump** (`@openai/codex-sdk` in `package.json`, which pulls a new
  vendored codex binary) → rebuild so the new binary is baked.
- **Lockfile change** (`bun.lock`) — any dependency add/upgrade, incl. the Claude
  Agent SDK → rebuild (the deps layer re-installs).
- **Bun bump** on the host → bump `BUN_VERSION` to keep parity.
- Source changes to `src/` / `backstage.ts` that the runner-host path uses →
  rebuild (fast: only the final COPY layers change).

Keep the image's pins in lockstep with the host; parity is the whole point.
