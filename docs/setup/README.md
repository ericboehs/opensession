# OpenSession setup

Operator documentation for self-hosting OpenSession. Start at
[install.md](install.md); the other pages are per-integration and optional.

For a single-user, interactive-only installation on macOS, use the smaller
[local profile guide](../local-profile.md) instead.

## What it is

OpenSession is a self-hosted agent-infrastructure server. One Bun process serves:

- **A web UI** for creating and steering coding sessions (chats) that run
  against registered git repos, in isolated worktrees or Docker sandboxes.
- **Agents** that turn external events into sessions: Slack messages, Linear
  issues, Plain support tickets, GitHub PR review comments.
- **One engine** that actually runs the agent turns: OpenCode, with Claude
  subscription capacity via the bundled Meridian bridge and ChatGPT-OAuth
  OpenAI capacity ([engines.md](engines.md)).
- **Automations**: stored prompts triggered by events or cron, run with
  least-privilege tool scoping ([plain.md](plain.md) documents the flagship
  triage automation).

## Architecture sketch

```
                 ┌──────────────────────────────────────────────┐
 Slack ─────────►│                                              │
 Linear webhook ►│  opensession.ts (one Bun process)              │
 Plain webhook ─►│                                              │
 GitHub webhook ►│  web UI + WS ──► session store ~/.opensession-chats
                 │  agents (slack/linear/plain/github/stripe)   │
                 │  automations + schedulers                    │
                 │  runner layer ──► the engine:                │
                 │    opencode-runner (opencode serve)          │
                 │  each run: git worktree or Docker sandbox    │
                 └──────────────────────────────────────────────┘
   MCP servers (mcp-config.json) give runs their external tools
   (Linear, Plain, Stripe, WorkOS, Sentry, Tinybird, ...)
```

A second small HTTP server (the webhook server, default port 3848) receives
GitHub/Linear/Plain/Stripe webhooks; the main server (default 3850) serves the
UI and API at `/opensession/`.

## Minimum requirements

- A Linux box (Tella runs Ubuntu on EC2; nothing requires AWS — see
  [github.md](github.md) for the AWS-specific deploy pipeline, which is
  replaceable).
- [Bun](https://bun.sh) — runtime, package manager, and bundler. No Node/Vite.
  The installer brings its own; you only need it up front for a manual install.
- `git`, and the [`gh` CLI](https://cli.github.com) for PR operations.
- The `claude` CLI (Claude Code) — the Claude engine shells out to it
  (`OPENSESSION_CLAUDE_BIN`, default `/home/ubuntu/.local/bin/claude`).
- Optional: **Docker** (sandboxed sessions —
  [self-hosting-sandboxes](../self-hosting-sandboxes.md)), **Caddy** (TLS for
  live previews), **Tailscale** (the recommended way to expose the UI at all),
  `opencode` binary (OpenCode engine), `whisper.cpp`/Groq/OpenAI key (voice
  dictation).

## Trust model (read this)

OpenSession has **no built-in authentication**. It binds to `HOST` (default
`127.0.0.1`; Tella binds it to a Tailscale IP) and trusts everyone who can
reach that address — the UI "user" is a self-selected display name stored in
localStorage, used for attribution and per-user MCP gating, not for auth. Put
it behind Tailscale or an equivalent private network; never expose it
publicly. Inside that boundary, safety comes from least-privilege scoping of
what runs can do, enforced at the tool/env layer rather than in prompts:
automation runs (which process untrusted text like customer tickets) get a
minimal environment without your API tokens, a per-automation MCP-server
allowlist, hard-denied customer-facing/identity-mutating tools, and per-call
human confirmation for money-moving Stripe tools. The systemd unit and the
sandbox host setup both block the EC2 metadata endpoint so agent code can't
mint cloud credentials. See the "Automation least-privilege", "Per-user MCP
servers", and "Self-management tools" sections of [CLAUDE.md](../../CLAUDE.md)
for the full rules the code enforces.

## Pages

| Page | Covers |
| --- | --- |
| [install.md](install.md) | installer → onboarding → env vars → config.json → accounts → systemd → health |
| [networking.md](networking.md) | **keeping it private** — Tailscale, SSH tunnels, verifying exposure |
| [ec2.md](ec2.md) | provisioning a clean EC2 box, networking, SSH debugging |
| [../../recipes/README.md](../../recipes/README.md) | bundled automation recipes, and what belongs in the repo |
| [slack.md](slack.md) | Slack app, token, scopes, event intake, admin gating |
| [github.md](github.md) | GitHub token, webhook server, PR agent, deploy pipeline |
| [linear.md](linear.md) | Linear OAuth app, webhooks, the Linear agent |
| [plain.md](plain.md) | Plain support tickets, the triage automation |
| [integrations-misc.md](integrations-misc.md) | Stripe, WorkOS, Grafana/Sentry/Tinybird, web push, voice |
| [engines.md](engines.md) | the OpenCode engine, accounts, model routing |
| [../self-hosting-sandboxes.md](../self-hosting-sandboxes.md) | Docker/Daytona/E2B/Box/Modal/AWS Lambda MicroVM sandboxes |
| [../portability-audit.md](../portability-audit.md) | what's still hardcoded (Tella-specific) |
