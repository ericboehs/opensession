# Install: bare box to running service

Prerequisites: Linux, [Bun](https://bun.sh), `git`, `gh` (authenticated),
the `claude` CLI. See [README.md](README.md#minimum-requirements) for the
optional extras.

## 1. Clone and install

```sh
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/tellahq/backstage.git tella-backstage
cd tella-backstage
bun install
```

The checkout path matters more than usual: the default mcp-config path is
`~/projects/tella-backstage/mcp-config.json` (`src/server/config.ts`), and
the repo registers *itself* as the `backstage` repo at
`~/projects/tella-backstage`. Other paths work but need config overrides.

## 2. Secrets: `~/.opensession.env`

Bun auto-loads a `.env` in the working directory for manual runs; the
systemd unit (`opensession.service`) instead loads
`EnvironmentFile=/home/ubuntu/.opensession.env`. Use that as your single
secrets file.

Everything is optional in the sense that the server boots without it — but
integrations degrade (or must be disabled) without their vars. Inventory of
what the code actually reads, by feature:

**Core server**

| Var | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | bind address for the main server. Bind to a Tailscale IP to share it with your team — there is no auth layer (see the [trust model](README.md#trust-model-read-this)) |
| `PORT` | `3850` | main server (UI + API at `/opensession/`) |
| `WEBHOOK_PORT` | `3848` | second HTTP server for inbound webhooks |
| `OPENSESSION_UI_BASE` | Tella tailnet URL | public base URL used in links posted to Slack/Linear/notes |
| `OPENSESSION_CONFIG` | `~/.opensession/config.json` | config-file path override |
| `SHUTDOWN_DRAIN_MS` | `120000` | graceful-shutdown drain window for in-flight runs |
| `OPENSESSION_CHATS_DIR` | `~/.opensession-chats` | session store override (mostly a test seam) |
| `OPENSESSION_WORKTREES_DIR` | `/home/ubuntu/worktrees` | where session worktrees are created |
| `OPENSESSION_TELLA_FUSION` | `/home/ubuntu/projects/tella-fusion` | checkout path of the default repo |
| `OPENSESSION_DEV` | unset | `1` = dev frontend build only; does NOT disable agent loops (a second naive instance double-sends) |

**Engines and models** (details: [engines.md](engines.md))

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENSESSION_CLAUDE_BIN` | `/home/ubuntu/.local/bin/claude` | claude CLI the Agent SDK spawns |
| `OPENSESSION_CLAUDE_ACCOUNTS_PATH` | `~/.opensession-claude-accounts.json` | Claude account store override |
| `OPENSESSION_OPENCODE_BIN` / `OPENSESSION_OPENCODE_CONFIG` | see engines.md | OpenCode binary / config path |
| `OPENSESSION_MODEL` | `claude-fable-5` | default model (below the UI override file) |
| `OPENSESSION_FALLBACK_MODEL` | unset | global fallback model; `none` disables |
| `OPENSESSION_MCP_CONFIG` | `~/projects/tella-backstage/mcp-config.json` | MCP config path override |
| `SUGGEST_BRANCH_MODEL`, `NOTE_EDIT_MODEL`, `MONITOR_ANSWER_MODEL`, `DRAFT_AUTOMATION_MODEL` | `claude-haiku-4-5` | per-feature cheap-task models |

**Integrations** — each has its own page with the full list:

| Feature | Vars | Page |
| --- | --- | --- |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ALLOWED_SLACK_USER_ID`, `WORKTREE_HOOK_SECRET`, `SLACK_MENTION_INTENT_MODEL`, `SCHEDULE_WHEN_MODEL` | [slack.md](slack.md) |
| GitHub | `GITHUB_API_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_BOT_LOGIN`, `GITHUB_MENTION_HANDLES` | [github.md](github.md) |
| Linear | `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `LINEAR_API_KEY` | [linear.md](linear.md) |
| Plain | `PLAIN_API_KEY`, `PLAIN_WEBHOOK_SECRET`, `PLAIN_API_URL`, `PLAIN_*_MODEL` ×3 | [plain.md](plain.md) |
| Stripe | `STRIPE_WEBHOOK_SECRET` | [integrations-misc.md](integrations-misc.md#stripe) |
| Grafana | `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `LOKI_DATASOURCE_UID`, `SLACK_EXPORT_FAILURE_CHANNEL`, `SLACK_UPLOAD_FAILURE_CHANNEL` | [integrations-misc.md](integrations-misc.md#grafana-poller) |
| Voice | `OPENAI_API_KEY`, `GROQ_API_KEY`, `WHISPER_CLI`, `WHISPER_MODEL` | [integrations-misc.md](integrations-misc.md#voice--transcription) |
| Sandboxes | `E2B_API_KEY`, `DAYTONA_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `OPENSESSION_SANDBOX_CONFIG` | [self-hosting-sandboxes](../self-hosting-sandboxes.md) |
| AWS runs | `AGENT_AWS_REGION` | [integrations-misc.md](integrations-misc.md#aws-creds-for-runs-agent_aws_region) |
| Previews | `PREVIEW_HOST`, `TELLA_LOCAL_ENSURE_UP` | Caddy-fronted live previews (`src/server/preview.ts`) |

**Feature flags** — `ENABLE_SLACK_AGENT`, `ENABLE_LINEAR_AGENT`,
`ENABLE_PLAIN_AGENT`, `ENABLE_GITHUB_AGENT`, `ENABLE_STRIPE_AGENT`,
`ENABLE_GRAFANA_POLLER`. All **default ON**; only the literal string `false`
disables (not `0`). Set the ones you don't use to `false` — see
[integrations-misc.md](integrations-misc.md#boot-guards) for why relying on
a missing token isn't enough.

Not for operators: `BKS_RPC_*` / `BKS_RUN_WS_*` / `BKS_MCP_SERVER` (set by
OpenSession for its own runner-host/MCP-proxy subprocesses),
`OPENSESSION_FORCE_LIMIT` and `OPENSESSION_RUN_JOURNAL` (dev/test seams),
`OPENSESSION_BG_HOLD_MAX_MS` (tuning).

Note: agent subprocesses do **not** inherit this env file — runs get a
minimal env (PATH, HOME, LANG, OPENSESSION_MODEL) by design, and MCP servers
carry their own credentials (`src/server/runner-shared.ts`).

## 3. `~/.opensession/config.json`

Instance config for everything that isn't a secret: server ports/URLs,
binary paths, the **repo registry**, the **team identity table**, persona
and branding. Copy [`config.example.json`](../../config.example.json) to
`~/.opensession/config.json` and edit. Every field is optional; precedence per
key is env var → config.json → built-in default (`src/server/config.ts`).
The file is re-read on change — no restart for config edits.

The two sections a non-Tella install must set:

- `repos` — your git repos (checkout path, `defaultBranch`, `ghRepo`
  owner/name for the `gh` CLI, `default: true` on the main one, optional
  `depsInstall`/`previewCommand`). **Caveat:** the built-in defaults are
  Tella's seven repos, and with *no* config the instance assumes
  `tella-fusion` exists; a number of agent code paths still hardcode
  Tella repo paths/names beyond this registry — see
  [portability-audit §1a-1c](../portability-audit.md).
- `identity.team` — your people (name, email, aliases, `slackId`, `github`,
  `linearEmails`). Drives commit attribution, per-user MCP `allowedUsers`
  gating, and human-ask routing. Omitting `identity` entirely keeps Tella's
  built-in roster; an empty team makes those features no-op.

The `integrations` and `policy` sections are parsed but **not applied yet**
(upcoming portability batches — the example file says the same).
`persona.name` and `branding.productName`/`productMark` are applied.

## 4. Engine accounts

At minimum add one Claude account or the default engine has nothing to run
on:

```sh
claude setup-token   # on a Claude Max login; prints sk-ant-…
```

Add it via the Connections UI, or create `~/.opensession-claude-accounts.json`
by hand — file shapes, account picking, Codex accounts
(`~/.opensession-codex-accounts.json`), and OpenCode config are documented in
[engines.md](engines.md).

## 5. `mcp-config.json`

MCP servers give runs their external tools. Copy
[`mcp-config.example.json`](../../mcp-config.example.json) to
`mcp-config.json` in the repo root (or point `OPENSESSION_MCP_CONFIG`
elsewhere). Per server: `{ "type": "http", "url": … }` or
`{ "command": …, "args": [], "env": {} }` — credentials go in the server's
own `env` block or URL, never the process env. Two OpenSession-specific
fields:

- `allowedUsers: ["Grant", "michiel@tella.to"]` — optional per-user gate;
  only runs whose user matches (through the identity table) see the server.
  Automation runs have no user, so restricted servers are invisible to them
  (fail-closed). Stripped before the config reaches the SDK.
- The `linear` server gets the Linear agent's OAuth token overlaid at run
  time ([linear.md](linear.md)).

Manage servers later from the Connections UI. **Changing the runner-layer
filtering code requires a restart; editing mcp-config.json itself is read
fresh per run.**

## 6. First run

```sh
bun run opensession.ts
# UI at http://127.0.0.1:3850/opensession/
curl -s http://127.0.0.1:3850/opensession/api/health
```

Health returns `{ ok, bootId, frontendVersion, uptime, activeRuns, agents }`
— `agents` includes per-agent status and what's missing (e.g. "missing
GRAFANA credentials"). The drain-aware deploy polls `activeRuns` to restart
when idle.

## 7. systemd

```sh
sudo cp opensession.service /etc/systemd/system/opensession.service
sudo systemctl daemon-reload
sudo systemctl enable --now opensession
```

The deployed unit is a **copy, not a symlink** — after editing the repo's
`opensession.service`, re-`cp` and `daemon-reload` (deploy.sh does this
automatically). Unit choices worth knowing (comments in the file itself):

- `ExecStart=bun run opensession.ts` — stable production runtime, see below.
- `EnvironmentFile=/home/ubuntu/.opensession.env` — your secrets file.
- `TimeoutStopSec=140` — must stay above `SHUTDOWN_DRAIN_MS` (120s) plus
  buffer, or systemd SIGKILLs mid-drain.
- `KillMode=mixed` — SIGTERM hits only the bun parent so it can drain
  in-flight runs; the default control-group mode would kill the Claude
  children instantly and defeat the run journal.
- `IPAddressDeny=169.254.169.254/32` — blocks the EC2 metadata endpoint for
  the whole service cgroup (untrusted agent text must not mint cloud
  credentials). Harmless off-cloud.
- The unit's `User`, paths, and `PATH=` line assume user `ubuntu` with bun
  in `~/.bun/bin` — adjust for your box.

## 8. Frontend rebuilds vs restart

The production unit intentionally does not use `bun --hot`: failed backend
reloads on Bun 1.3.14 can permanently stop timer delivery while HTTP remains
healthy. The in-process frontend watcher still rebuilds frontend edits live.
All backend changes need `systemctl restart opensession` after commit and push.
Restarts are graceful: detached engine turns survive and the run journal
reattaches them on boot, but they still churn active sessions, so restart once
after the backend change rather than after every save.

## 9. Next

- Wire up integrations: [slack.md](slack.md), [github.md](github.md),
  [linear.md](linear.md), [plain.md](plain.md),
  [integrations-misc.md](integrations-misc.md). Inbound webhooks all land on
  the webhook server — see below.
- Sandboxed execution: [../self-hosting-sandboxes.md](../self-hosting-sandboxes.md).

## Webhook server

One detail every integration page references: `src/server/webhook-server.ts`
runs a second `Bun.serve` on `127.0.0.1:${WEBHOOK_PORT}` (default 3848).
Agents register their own routes on it (`/slack/events`, `/slack/actions`,
`/github/webhook`, `/webhook` (Linear), `/plain/webhook`, `/stripe/webhook`,
`/oauth/*`, `/worktree/*`). It's loopback-only: you need a TLS-terminating
reverse proxy with a public hostname in front (Tella uses Caddy on
`michael.tella.dev`) for Slack/GitHub/Linear/Plain/Stripe to reach it. All
signature checks are HMAC-SHA256 and fail-closed — a missing secret rejects
everything rather than letting it through.
