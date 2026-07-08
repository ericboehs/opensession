# Backstage open-source hardcoding audit

**Status:** audit complete 2026-07-08 (read-only pass, Opus reviewer). This is the
spec for the portability/config-extraction workstream that precedes open-sourcing.
See docs/sandboxes-plan.md for the wider effort.

**Scope:** every Tella/host-specific literal in code (not runtime data under
`~/.backstage-*`). Findings tiered **MUST** (blocks another org entirely),
**SHOULD** (runs but wrong/leaky default), **FINE** (universal or cosmetic), plus
**DOCS** (load-bearing, no sane default → document, don't config).

**Already de-hardcoded (Phase 0, env-overridable with Tella defaults):**
`BACKSTAGE_TELLA_FUSION`, `BACKSTAGE_WORKTREES_DIR` (worktree.ts:11-13),
`BACKSTAGE_CLAUDE_BIN` (claude-runner.ts:254), `BACKSTAGE_MCP_CONFIG`
(connections.ts:14, docker.ts:428), `BACKSTAGE_SANDBOX_CONFIG` (sandbox/config.ts:25),
`MICHAEL_UI_BASE`, `MICHAEL_MODEL`, `HOST`/`PORT` (backstage.ts:332-333),
`WEBHOOK_PORT`, `ENABLE_*_AGENT`, `TELLA_LOCAL_ENSURE_UP` (preview.ts:52),
`PREVIEW_HOST` (preview.ts:145), `AGENT_AWS_REGION` (aws-creds.ts:21). The
sandbox/opencode work is genuinely config-first — see §6.

---

## TIER 1 — MUST be config (blocks another org)

### 1a. Repo registry & repo-target constants
| File:line | Literal | Note |
|---|---|---|
| src/server/worktree.ts:38-47 | `REPOS` — all 7 entries `tellahq/*`, paths `/home/ubuntu/projects/*` | The registry itself. Only `tella-fusion`/`WORKTREES_DIR` are env-backed; the other 6 (backstage, gitops, infra, shared-infra, gstreamer, gst-plugins-rs) are pure literals |
| src/server/worktree.ts:50, 58 | `REPOS["tella-fusion"]` fallback | default repo baked in |
| src/agents/slack/state.ts:50 | `DEFAULT_CWD = "/home/ubuntu/projects/tella-fusion"` | not env-backed |
| src/agents/slack/state.ts:53 | `GITHUB_REPO = "tellahq/tella-fusion"` | drives Slack PR flows |
| src/server/actions.ts:29,36 | `TELLA_FUSION`, `REPO_PATHS={"tella-fusion":…}` | |
| src/agents/github/autofix.ts:31, github-rest.ts:12 | `REPO/GITHUB_REPO = "tellahq/tella-fusion"` | PR agent target |
| src/agents/github/review.ts:26 | `TELLA_FUSION = ${HOME}/projects/tella-fusion` | |
| src/agents/loops/{sweep,seo,stale-prs,cron-jobs,pr-tinder}.ts | `REPO = "tellahq/tella-fusion"` (5 files) | loop targets |
| src/server/pr-tinder.ts:15 | `REPO = "tellahq/tella-fusion"` | |
| src/server/sessions.ts:387-388 | rollup repos `tella-fusion`/`backstage` w/ `tellahq/*` | |

### 1b. Hardcoded worktree/checkout paths (not env-backed)
| File:line | Literal |
|---|---|
| src/agents/slack/index.ts:697; handlers.ts:150,194; worktree-channels.ts:86 | `/home/ubuntu/worktrees/tella-fusion-${branch}` |
| src/agents/linear/session.ts:158; handlers.ts:670 | same |
| src/agents/plain/handlers.ts:21,182 | `TELLA_FUSION_DIR`, worktree path |
| src/server/generated-titles.ts:86 | `cwd: "/home/ubuntu/projects/tella-fusion"` |
| src/server/worktree.ts:263,307 | `tella-fusion-…` worktree paths in PR/followup creators |
| backstage.ts:2464,2500,3313 | `${HOME}/projects/tella-fusion` cwd fallbacks |
| src/server/wiki.ts:10 | `DOCS_ROOT = ${HOME}/projects/tella-fusion/docs` |

### 1c. Executable `gh` commands hardcoding the repo (in prompts run by agents)
| File:line | Literal |
|---|---|
| src/agents/github/prompts.ts:49,51,107,146,169,190,218,262,274,281 | `gh … --repo tellahq/tella-fusion` in review/autofix/docs-sync/followup prompts |
| src/agents/slack/index.ts:505,509 | `gh api repos/tellahq/tella-fusion/pulls/…` |
| src/server/automation-templates.ts:35,81,93,124 | seed prompts referencing `tellahq/tella-fusion` |

### 1d. Hardcoded Tella Slack channel / user IDs (no env override)
| File:line | Literal |
|---|---|
| src/agents/github/constants.ts:15 | `DOCS_SYNC_SLACK_CHANNEL = "C09BAFFK8F8"` |
| src/agents/plain/top-issues-automation.ts, top-issues.ts:17 | `CHAT = "C01ED50A2KG"` (#chat) |
| src/agents/loops/cron-jobs.ts:14-16 | `CHAT`, `DOCS_CHANNEL`, `JOHNNY="U0866D7PCCU"` |
| src/agents/loops/monitor.ts, stale-prs.ts | channel constants (same class) |

### 1e. Linear OAuth redirect (hardcoded host, no env override)
| File:line | Literal |
|---|---|
| src/agents/linear/oauth.ts:92,113 | `redirect_uri: "https://michael.tella.dev/oauth/callback"` — OAuth unusable on another host |

### 1f. Identity table (whole file is Tella's team)
| File:line | Literal |
|---|---|
| src/server/shared/user-mappings.ts:6-146 | `GITHUB_TO_SLACK`, `LINEAR_EMAIL_TO_GITHUB`, `SLACK_ID_TO_NAME`, `TEAM_GIT_IDENTITY` — 8 Tella people w/ Slack IDs, emails, GitHub logins. Drives commit attribution, per-user MCP gating, human-asks routing. Empty table = features become no-ops (acceptable), but it must not ship as Tella's roster |

### 1g. Deploy pipeline (AWS account/instance baked) — see also DOCS
| File:line | Literal |
|---|---|
| .github/workflows/deploy.yml:30 | `role-to-assume: arn:aws:iam::486029010931:role/backstage-deploy` |
| .github/workflows/deploy.yml:20-21 | `AWS_REGION: eu-west-2`, `INSTANCE_ID: i-0df0e3818988c04ab` |
| deploy/cloudwatch-agent-backstage.json:11-12 | log group `/tella/backstage/prod`, path `/home/ubuntu/.backstage-audit/…` |

---

## TIER 2 — SHOULD be config (works but wrong/leaky)

### 2a. Leaky Tella-host default (env-backed, but literal is Tella's tailnet)
| File:line | Literal | Env |
|---|---|---|
| src/server/human-asks.ts:38, claude-runner.ts:246, codex-runner.ts:51, opencode-runner.ts:88, linear/session.ts:313, github/run.ts:75, slack/handlers.ts:1349, grafana-poller/index.ts:48 | `"https://michael.taila5d766.ts.net/backstage"` (8+ sites) | `MICHAEL_UI_BASE` (already) — but consolidate to one publicBaseUrl config |
| src/agents/slack/handlers.ts:635 | same URL inline (no env) | — |
| src/server/preview.ts:155 | tailnet fallback `"michael.taila5d766.ts.net"` | `PREVIEW_HOST` |
| src/server/push.ts:49 | VAPID `mailto:michael@tella.dev` | — |

### 2b. Binary/path defaults (env-backed, `/home/ubuntu` literal)
| File:line | Literal | Env |
|---|---|---|
| src/server/claude-runner.ts:254 | `/home/ubuntu/.local/bin/claude` | `BACKSTAGE_CLAUDE_BIN` |
| src/server/worktree.ts:11-13 | `/home/ubuntu/projects/tella-fusion`, `/home/ubuntu/worktrees` | `BACKSTAGE_TELLA_FUSION`, `BACKSTAGE_WORKTREES_DIR` |
| src/server/run-rpc-protocol.ts | `${HOME}/.bun/bin/bun`, `${HOME}/projects/tella-backstage` | none — assumes checkout dir name |
| src/server/opencode-runner.ts:92 | last fallback `${HOME}/.nvm/.../bin/opencode` | `BACKSTAGE_OPENCODE_BIN` (good chain) |
| src/server/preview.ts:52 | tella-local `ensure-up.sh` path | `TELLA_LOCAL_ENSURE_UP` |
| src/server/preview.ts:137 | `CADDY_ADMIN="http://localhost:2019"` | **not overridable** |

### 2c. `/home/ubuntu/bin/wt` (external tella-fusion script; several unguarded spawns)
| File:line | Note |
|---|---|
| src/server/worktree.ts:141-142 | best guarded: `repo.id==="tella-fusion"` + file-exists, else plain `git worktree remove` |
| src/agents/slack/{worktree-channels.ts:297, handlers.ts:199}, plain/handlers.ts:186, linear/session.ts:162,275 | direct spawn, absolute path, no guard |

### 2d. Tella product/observability assumptions in loop code
| File:line | Literal |
|---|---|
| src/agents/grafana-poller/index.ts:67-68,76,87 | Loki `service_name="temporal-rust-worker"`, workflow types `export`/`process_streaming_upload`, labels `story_id`/`streaming_upload_id` |
| src/agents/grafana-poller/index.ts:78,89 | channel fallbacks `C093YC3TX8E`, `C0AKPJ65BQA` (env-backed) |
| src/agents/plain/api.ts:553 | Linear team fallback `teamId \|\| "TELLA"` |
| src/agents/loops/seo.ts:49,104 | `tella.com`, Ahrefs `project_id 1751241` |

### 2e. Assumed-on integration loops (default-ON, seed Tella config regardless of creds)
Gating pattern = opt-**out** `ENABLE_*_AGENT !== "false"`. Slack (index.ts:80 no token
guard), Linear (index.ts:58), Plain (index.ts:43 seeds triage+top-issues automations),
GitHub (index.ts:194-203 seeds docs-sync **enabled**) all start and degrade with
warnings but never refuse on missing token. **Should flip to fail-closed on missing
token** (like Stripe). Boot guards at backstage.ts:8810-8888.

### 2f. Company/persona copy in prompt-builder code (not `~/.backstage-automations`)
| File:line |
|---|
| src/server/draft-automation.ts:38 ("Tella, a screen-recording product") |
| src/server/automation-templates.ts:83 ("Tella users (screen-recording creators)") |
| src/agents/plain/ticket-router.ts:40, prompts.ts:6 ("Tella is a screen recording app") |
| src/agents/slack/mention-intent.ts:29,47 ("Michael, Tella's engineering assistant… tella-fusion repo") |
| src/agents/github/prompts.ts:29,81 (persona + "embed Tella videos") |
| shot.mjs, shot-pr.mjs (`localStorage backstage-user = "Michiel"`, `/usr/bin/google-chrome`, port 3850) |

---

## TIER 3 — FINE (universal or cosmetic; leave as default)

- **Model registry** (models.ts:22-73): universal SDK defaults.
- **Policy constants**: `STRIPE_CONFIRM_TOOLS` (claude-runner.ts:459-464),
  `AUTOMATION_DENIED_TOOLS` (automations.ts:459-484) — MCP tool names, correct for any
  org using those MCPs. Optional override only.
- **Persona name "Michael" / `michael-*` MCP server names** — cosmetic branding.
- **`~/.backstage-*` dir names, `bks-`/`prj-` prefixes, PR label names, `===MICHAEL-SUMMARY===`
  markers, `.ports.conf` parser, Dockerfile pins, loopback defaults, Tailwind path.**
- **UI `"tella-fusion"` defaults** (~30 frontend files) — resolve against whatever REPOS
  returns; fix once REPOS is config-driven (populate picker from `/api/repos`).

---

## §6 — New sandbox / opencode / adapters work (audited to same standard)

Genuinely config-first — the model to follow. `sandbox/config.ts` reads
`~/.backstage-sandbox.json` fresh per run, missing = `local` = today. `callbackBaseUrl`
derives from `HOST:PORT`; image name overridable. Only Tella-isms are **by-design
path-parity** (noted, not flagged):
- deploy/sandbox/Dockerfile:67-94 — bakes `/home/ubuntu/...` paths, uid-1000 `ubuntu`.
  Path parity with the host is load-bearing (the runner's absolute paths must resolve
  inside the container). **The one place `/home/ubuntu` coupling is intrinsic, not
  lazy** — document the rebuild-with-matched-`$HOME` requirement.
- sandbox/adapters/bootstrap.ts REMOTE_HOME/REMOTE_REPO — same parity reason.
- One real leak: setup-host.sh is EC2-IMDS-specific — see DOCS.

---

## Proposed config schema

Single `~/.backstage/config.json` (or `$BACKSTAGE_CONFIG`), read fresh with the
sandbox-config pattern: **missing/invalid → today's hardcoded defaults, so the live
server never notices.** Existing env vars stay as per-key overrides.
Precedence: env var → config.json → hardcoded Tella default.

```jsonc
{
  "server": {
    "host": "127.0.0.1", "port": 3850, "webhookPort": 3848,
    "publicBaseUrl": "https://michael.taila5d766.ts.net/backstage",
    "previewHost": "michael.taila5d766.ts.net",
    "caddyAdmin": "http://localhost:2019"
  },
  "persona": { "name": "Michael", "company": "Tella", "product": "a screen-recording product" },
  "paths": {
    "claudeBin": "/home/ubuntu/.local/bin/claude",
    "opencodeBin": null,
    "worktreesDir": "/home/ubuntu/worktrees",
    "wtScript": "/home/ubuntu/bin/wt",
    "mcpConfig": "/home/ubuntu/projects/tella-backstage/mcp-config.json"
  },
  "repos": {
    "tella-fusion": {
      "repo": "/home/ubuntu/projects/tella-fusion", "wtPrefix": "tella-fusion",
      "defaultBranch": "main", "ghRepo": "tellahq/tella-fusion", "default": true,
      "previewCommand": "/home/ubuntu/.claude/skills/tella-local/ensure-up.sh",
      "depsInstall": "cd packages/core/webapp && bun install"
    },
    "backstage": { "repo": "/home/ubuntu/projects/tella-backstage", "wtPrefix": "backstage",
      "defaultBranch": "master", "ghRepo": "tellahq/backstage", "sharedCheckout": true }
  },
  "identity": { "team": [ { "name": "…", "email": "…", "aliases": ["…"], "slackId": "…", "github": "…" } ] },
  "integrations": {
    "slack":   { "enabled": true, "docsChannel": "C09BAFFK8F8", "chatChannel": "C01ED50A2KG" },
    "linear":  { "enabled": true, "team": "TELLA", "oauthRedirect": "https://michael.tella.dev/oauth/callback" },
    "plain":   { "enabled": true, "seedAutomations": true },
    "github":  { "enabled": true, "docsSyncChannel": "C09BAFFK8F8" },
    "stripe":  { "enabled": true },
    "grafana": { "enabled": false, "lokiService": "temporal-rust-worker",
                 "failureChannels": { "export": "C093YC3TX8E", "upload": "C0AKPJ65BQA" } }
  },
  "policy": { "stripeConfirmTools": null, "automationDeniedTools": null }
}
```

Back-compat: every field optional; `getRepo()`/`REPOS` become a function reading
`config.repos` merged over the built-in map; empty `identity.team` = attribution/gating
no-ops; `integrations.*.enabled` replaces `ENABLE_*_AGENT` and additionally requires
the secret (fixes 2e).

## Sizing & order

**Must precede open-sourcing (≈1–1.5 wk):**
1. Config loader + repos registry + paths (1a/1b, 2b) — ~40 sites, ~2–3 days.
2. Identity table → config (1f) — ~0.5 day.
3. Channel IDs + OAuth redirect + publicBaseUrl consolidation (1d, 1e, 2a) — ~1 day.
4. Deploy: strip AWS account/instance/log-group (1g); generic deploy.sh — ~1 day.
5. Integration fail-closed gating (2e) — ~0.5 day.
6. gh-repo templating in prompts (1c) — ~1 day.

**Can trail (post-launch, ≈2–3 days):** persona/company config (2f), Caddy-admin
override, grafana product-model config (2d), UI repo-picker from `/api/repos`,
policy override hooks.

## DOCS, not config

- **Deploy = EC2 + SSM + OIDC**: document the contract (pull → ff-only → bun install →
  restart-with-drain); non-AWS self-hosters replace the pipeline.
- **AWS creds via IMDS** (aws-creds.ts): `aws:true` runs need an EC2 instance role.
- **IMDS network isolation** (backstage.service IPAddressDeny, setup-host.sh
  DOCKER-USER rule): cloud-metadata-theft mitigation; harmless off-cloud.
- **CloudWatch shipping**: optional add-on.
- **Dockerfile path-parity**: rebuild with matched `$HOME`/uid; intrinsic.
- **Caddy + Tailscale previews**: previews need a TLS-terminating reverse proxy;
  degrade cleanly without one.

**Count:** ~95 distinct code sites — ~45 MUST, ~30 SHOULD, ~20 FINE, 6 DOCS clusters.
The new sandbox/opencode layer is clean; the blocker mass is the pre-sandbox core.
