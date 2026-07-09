# GitHub

The GitHub integration has three parts: a PAT the PR agent posts with, a
webhook intake on the [webhook server](install.md#webhook-server), and the
`gh` CLI for PR operations from sessions. The deploy pipeline (last section)
is Tella-specific and replaceable.

## GITHUB_API_TOKEN

Read in `src/agents/github/github-rest.ts` (write-capable REST/GraphQL client
for the PR agent) and `src/agents/slack/github-reviews.ts` (read-only PR
lookups for Slack). Always sent as `Authorization: Bearer <token>` against
`api.github.com` — the code never runs `gh auth` with it.

What the token actually does (so you can scope the PAT):

- read PR issue comments, review comments, and reviews
- **write**: post/edit issue comments, reply to inline review threads, submit
  formal reviews (event `COMMENT`), delete labels
- GraphQL: read review threads, mutate `resolveReviewThread`

So: a token with read+write on issues/PRs (classic `repo` scope, or
fine-grained "Pull requests: read+write" + "Issues: read+write") for the
target repo. The agent is loaded even without the token — it just warns and
can't post (`src/agents/github/index.ts` startup).

Related env vars (`src/agents/github/`):

| Var | Default | Meaning |
| --- | --- | --- |
| `GITHUB_BOT_LOGIN` | `tella-butler` | the GitHub account the token posts as; used to skip the bot's own comments/pushes (self-trigger guard) |
| `GITHUB_MENTION_HANDLES` | `michael,tella-butler` | comma-separated handles; a PR comment matching `@<handle>` triggers the mention flow |

## gh CLI auth is separate

`src/server/pr-info.ts` and session prompts shell out to `gh` (`gh pr view`,
`gh pr diff`, `gh pr comment`, `gh pr merge`, `gh api`) with **no token passed
in code** — they use the box's ambient `gh` authentication (`gh auth login`,
or `GH_TOKEN` in `~/.opensession.env`, which systemd loads as the service's
`EnvironmentFile`). That identity needs write (and merge, if you use PR-merge
flows) rights on your repos. Set both up: the PAT for the API client, `gh`
auth for the CLI.

## Webhook intake

The webhook server (`src/server/webhook-server.ts`) listens on
`127.0.0.1:${WEBHOOK_PORT}` (default 3848; also settable via
`server.webhookPort` in `~/.opensession/config.json`). You need a
TLS-terminating proxy in front of it for GitHub to reach it — Tella uses
Caddy on a public hostname.

- Route: `POST /github/webhook` (registered by the Slack agent,
  `src/agents/slack/index.ts`, which forwards PR events to the github agent).
- Verification: `GITHUB_WEBHOOK_SECRET`, HMAC-SHA256 over the raw body,
  header `x-hub-signature-256` (`sha256=<hex>`), timing-safe compare; invalid
  signature → 401. Deliveries are deduped by `x-github-delivery`.

Configure the GitHub webhook (repo → Settings → Webhooks) with that URL,
content type `application/json`, your secret, and these events — this is what
the code consumes (`src/agents/github/webhook.ts`):

| Event | What happens |
| --- | --- |
| `issue_comment`, `pull_request_review_comment` (action `created`) | if the body matches a `GITHUB_MENTION_HANDLES` handle: intent-classified → whole-PR action (review / autofix / simplify / adversarial) or a conversational reply run in a PR-branch worktree |
| `pull_request` action `labeled` | labels `michael-review` / `michael-auto-fix` / `michael-simplify` / `michael-adversarial` trigger the corresponding behavior (label names hardcoded in `src/agents/github/constants.ts`) |
| `pull_request` `opened`/`reopened`/`synchronize`/`ready_for_review` | auto-review, if the PR is non-draft and either carries `michael-review` or the review automation is enabled |
| `pull_request` action `closed` + merged | notifies linked sessions; fires the docs-sync automation on `github:pr_merged` |
| `pull_request_review` | handled by the Slack agent (review → Slack notification) |
| `workflow_run` | notifies sessions waiting on a merged PR's deploy |

Events for other repos are dropped: the agent guards on
`repository.full_name === defaultRepo().ghRepo` — i.e. the **default repo**
from `~/.opensession/config.json` (Tella: `tellahq/tella-fusion`). The PR agent
is effectively single-repo today.

## Behavior toggles

- Auto-review on every PR push is **off by default**: the github agent seeds
  a "review" automation disabled (label-only mode). Enable it in the
  Automations UI. Not an env var.
- The docs-sync automation is seeded **enabled** and fires on merge. Its
  Slack notification channel is hardcoded (`DOCS_SYNC_SLACK_CHANNEL =
  "C09BAFFK8F8"` in `src/agents/github/constants.ts`) — changing it requires
  a code edit today; see [portability-audit §1d](../portability-audit.md).
- Mention replies are always on while the agent is loaded.
- Disable the whole agent with `ENABLE_GITHUB_AGENT=false` (default is ON;
  only the literal string `false` disables — see
  [integrations-misc.md](integrations-misc.md#boot-guards)).

**Requires code edit today:** many agent prompts embed `gh … --repo
tellahq/tella-fusion` literally (`src/agents/github/prompts.ts`), and
`src/server/pr-info.ts` has a `tellahq/tella-fusion` default — pointing the
PR agent at your own repo means editing those until the prompt-templating
batch lands ([portability-audit §1c](../portability-audit.md)).

## Deploy pipeline (Tella-specific, replaceable)

How Tella ships this repo to its box — documented as a pattern, not a
requirement. `.github/workflows/deploy.yml` (currently `workflow_dispatch`
only) authenticates to AWS with OIDC and calls `ssm:SendCommand` to run
`deploy/deploy.sh` on the EC2 instance — no inbound SSH. The script:

1. `git fetch` + `merge --ff-only` (never `reset --hard` — the checkout is
   live and shared; divergence aborts loudly),
2. `bun install --frozen-lockfile` only when the lockfile changed,
3. syncs `opensession.service` to `/etc/systemd/system/` when it changed
   (the deployed unit is a copy, not a symlink),
4. waits up to `MAX_DRAIN_WAIT` (480s) for `activeRuns == 0` on
   `/opensession/api/health`, then `systemctl restart opensession` and a
   post-restart health gate.

The AWS account ID, region, and instance ID are hardcoded in the workflow
([portability-audit §1g](../portability-audit.md)). Self-hosters replace the
workflow with anything that runs `deploy/deploy.sh` (or its equivalent) on
the box; the drain-aware contract (ff-only pull → conditional install → idle
wait → graceful restart) is the part worth keeping.
