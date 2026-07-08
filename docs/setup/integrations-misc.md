# Misc integrations: Stripe, WorkOS, observability, push, voice

## Boot guards

All agent loops are gated in `loadAgents()` (backstage.ts, ~line 8810). The
pattern is opt-**out**: `if (process.env.ENABLE_X_AGENT !== "false")`. That
means:

- Every agent is **ON by default**. Only the literal string `false` disables
  it — `ENABLE_SLACK_AGENT=0` does *not* turn Slack off.
- Flags: `ENABLE_SLACK_AGENT`, `ENABLE_LINEAR_AGENT`, `ENABLE_PLAIN_AGENT`,
  `ENABLE_GITHUB_AGENT`, `ENABLE_GRAFANA_POLLER`, `ENABLE_STRIPE_AGENT`.
- Only Stripe is additionally credential-gated: it loads only when
  `STRIPE_WEBHOOK_SECRET` is also set. The others load without their tokens
  and degrade with warnings (Slack calls fail, webhook verification rejects
  everything, the Grafana poller no-ops) — and some **seed Tella-specific
  automations on startup regardless** (Plain triage/top-issues, GitHub
  docs-sync). If you don't use an integration, set its flag to `false`
  explicitly rather than relying on a missing token. This default-ON gating
  is flagged for a fail-closed rework in
  [portability-audit §2e](../portability-audit.md).

What "off but loaded" costs you in practice: log noise, health warnings, and
seeded automations you didn't ask for — not crashes. Missing webhook secrets
are fail-closed (401), so nothing untrusted gets in.

## Stripe

Two separate pieces:

1. **Dispute webhook agent** (`src/agents/stripe/`): route `POST
   /stripe/webhook` on the [webhook server](install.md#webhook-server),
   verified with `STRIPE_WEBHOOK_SECRET`. It only acts on
   `charge.dispute.created`, firing the `stripe:charge.dispute.created`
   automation event with a minimal payload (the automation re-fetches details
   via MCP). Everything else is acked and ignored.
2. **Stripe MCP server** (`mcp-config.json`): an HTTP server pointing at
   `https://mcp.stripe.com` with a **restricted key** (`rk_live_…`) in the
   config file, not env. Use a restricted key with write on Refunds +
   Subscriptions only and read on core billing resources — Stripe enforces
   that ceiling server-side no matter what the agent asks for.

On top of the key ceiling, money-moving tools require **per-call human
confirmation** (`STRIPE_CONFIRM_TOOLS`, `src/server/claude-runner.ts`):
`mcp__stripe__create_refund`, `mcp__stripe__cancel_subscription`,
`mcp__stripe__update_subscription`, and `mcp__stripe__stripe_api_execute`
(it can hit any endpoint the key permits). Interactive sessions pause on an
Approve/Deny card showing the exact tool input; unattended runs get an
auto-deny telling the agent to post the proposed action in its note for a
human to approve by opening the session. Both outcomes land in the audit log
(`human_confirmation` / `confirm_unattended`).

## WorkOS

No server code — it's a stdio MCP server in `mcp-config.json` (Tella runs a
wrapper at `/home/ubuntu/bin/workos-mcp` that loads its own credentials; the
repo doesn't contain it, so bring your own WorkOS MCP). Automation runs
hard-deny its entire write/impersonation surface
(`AUTOMATION_DENIED_TOOLS` in `src/server/automations.ts` — see
[plain.md](plain.md#the-triage-automation-least-privilege-model) for the
exact list); reads (`get_*`, `list_*`) stay allowed.

## Grafana poller

`src/agents/grafana-poller/` polls Loki for failure signatures and spins up
investigation automations with a Slack control card per fresh failure.

| Var | Default | Notes |
| --- | --- | --- |
| `GRAFANA_URL` | — | required; without it (or the token) startup logs "poller disabled" and the agent is a complete no-op |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | — | bearer token for the datasource proxy |
| `LOKI_DATASOURCE_UID` | `loki` | queried via `/api/datasources/proxy/uid/<uid>/loki/api/v1/query` |
| `SLACK_EXPORT_FAILURE_CHANNEL` | `C093YC3TX8E` | Slack channel for export-failure cards (Tella default) |
| `SLACK_UPLOAD_FAILURE_CHANNEL` | `C0AKPJ65BQA` | same, upload failures (Tella default) |

Dedup state lives in `~/.backstage-grafana-poll/<automationId>/` (default
window 7 days). **Tella-specific:** the two seeded investigators query
Tella's Loki labels (`service_name="temporal-rust-worker"`, `story_id`,
`streaming_upload_id`) — pointing the poller at your own failure signatures
means editing `src/agents/grafana-poller/index.ts` today
([portability-audit §2d](../portability-audit.md)).

## Sentry and Tinybird

MCP-only — no server code, no env vars. Configure them as HTTP MCP servers
in `mcp-config.json` (`https://mcp.sentry.dev/mcp`;
`https://mcp.tinybird.co?token=<token>` with the token in the URL). Omit
them and nothing breaks; runs just don't get those tools.

## Web push

`src/server/push.ts`. Zero configuration: VAPID keys are generated on first
use and stored in `~/.backstage-push/vapid.json`; per-user subscriptions in
`~/.backstage-push/subscriptions.json` (dead ones pruned on send). One
Tella-ism: the VAPID contact is hardcoded `mailto:michael@tella.dev`
([portability-audit §2a](../portability-audit.md)). Push requires the UI to
be served over HTTPS (e.g. Tailscale `ts.net` certs); on iOS it needs the
PWA installed.

## Voice / transcription

`src/server/transcribe.ts` tries providers in order, falling through on
failure:

1. OpenAI (`OPENAI_API_KEY`; `gpt-4o-mini-transcribe`)
2. Groq (`GROQ_API_KEY`; `whisper-large-v3-turbo`)
3. Local whisper.cpp — `WHISPER_CLI` (default
   `~/tools/whisper.cpp/build/bin/whisper-cli`) + `WHISPER_MODEL` (default
   `~/tools/whisper.cpp/models/ggml-small-q5_1.bin`), with `ffmpeg` for
   audio conversion. Build whisper.cpp yourself; it's outside the repo.

All optional — with no provider configured, dictation throws and the rest of
the app is unaffected.

## AWS creds for runs (`AGENT_AWS_REGION`)

`src/server/aws-creds.ts` mints short-lived instance-role credentials for
agent runs that opt into AWS (`aws: true`), injecting `AWS_REGION` /
`AWS_DEFAULT_REGION` (from `AGENT_AWS_REGION`, default `us-east-2`) plus
temporary keys into the child env. It exists because the service cgroup
blocks the EC2 metadata endpoint (`IPAddressDeny=169.254.169.254/32` in
`backstage.service`) so untrusted agent code can't mint the role itself; the
main process escapes via a transient systemd unit (`sudo -n systemd-run`) to
fetch read-only creds. EC2-specific; off AWS, mint failure returns `{}` and
runs proceed without AWS.
