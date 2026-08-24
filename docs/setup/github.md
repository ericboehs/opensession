# GitHub

The GitHub integration has three parts: a PAT the PR agent posts with, a
webhook intake on the [webhook server](install.md#webhook-server), and the
`gh` CLI for PR operations from sessions. The deploy script (last section)
is optional and replaceable. (Repos don't have to live on GitHub — see
[codestorage.md](codestorage.md) for code.storage as an alternative host.)

## The bot account (machine user)

Create a **dedicated GitHub machine-user account** for your instance (Tella's
is `tella-butler`) — a normal GitHub account, invited to your org with write
access to the repos the agent works on. Everything bot-shaped hangs off it:

1. its PAT is `GITHUB_API_TOKEN` (scoping below),
2. the box's `gh` CLI is signed in as it (`gh auth login`),
3. its SSH key is what `git push` uses from session worktrees,
4. its login goes in `policy.githubBotLogins` in `~/.opensession/config.json`
   (the `GITHUB_BOT_LOGIN` env var is merged in too; the first configured
   login is the bot) — the self-trigger guard (skip our own comments/pushes/
   reviews) keys on this,
5. `integrations.github.mentionHandles` (or `GITHUB_MENTION_HANDLES` env) —
   which `@name`s in PR comments wake the mention flow (default: your
   `persona.name` plus the bot login).

Using one account for all four keeps attribution coherent: PRs, comments,
reviews, and pushes all read as the same bot. A GitHub App would avoid
burning a seat, but the current code assumes a plain account (gh CLI +
git-over-SSH don't speak App installation tokens) — machine user is the
supported path.

With [per-user GitHub auth](#per-user-github-auth-prs-as-the-session-owner)
enabled, the bot becomes the *fallback* author: interactive sessions whose
owner connected their own account open PRs as that person instead.

## GITHUB_API_TOKEN

Read in `packages/core/opensession-server/src/agents/github/github-rest.ts` (write-capable REST/GraphQL client
for the PR agent) and `packages/core/opensession-server/src/agents/slack/github-reviews.ts` (read-only PR
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
can't post (`packages/core/opensession-server/src/agents/github/index.ts` startup).

Related settings (`packages/core/opensession-server/src/agents/github/`, resolved in `packages/core/opensession-server/src/server/config.ts`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `policy.githubBotLogins` (config) / `GITHUB_BOT_LOGIN` (env, merged in) | none | the GitHub account the token posts as; used to skip the bot's own comments/pushes (self-trigger guard) |
| `integrations.github.mentionHandles` (config) / `GITHUB_MENTION_HANDLES` (env, wins) | `<persona.name>,<bot login>` | handles (comma-separated in the env var); a PR comment matching `@<handle>` triggers the mention flow |

## gh CLI auth is separate

`packages/core/opensession-server/src/server/pr-info.ts` and session prompts shell out to `gh` (`gh pr view`,
`gh pr diff`, `gh pr comment`, `gh pr merge`, `gh api`) with **no token passed
in code** — they use the box's ambient `gh` authentication (`gh auth login`,
or `GH_TOKEN` in `~/.opensession.env`, which systemd loads as the service's
`EnvironmentFile`). That identity needs write (and merge, if you use PR-merge
flows) rights on your repos. Set both up: the PAT for the API client, `gh`
auth for the CLI.

## Webhook intake

The webhook server (`packages/core/opensession-server/src/server/webhook-server.ts`) listens on
`127.0.0.1:${WEBHOOK_PORT}` (default 3848). You need a
TLS-terminating proxy in front of it for GitHub to reach it — Tella, for
example, uses Caddy on a public hostname.

- Route: `POST /github/webhook` (registered by the GitHub agent,
  `packages/core/opensession-server/src/agents/github/index.ts`). For an existing Slack-only deployment with
  GitHub disabled, Slack registers the same GitHub-owned handler as a
  compatibility fallback. When both are enabled, only GitHub registers it.
- Verification: `GITHUB_WEBHOOK_SECRET`, HMAC-SHA256 over the raw body,
  header `x-hub-signature-256` (`sha256=<hex>`), timing-safe compare; invalid
  signature → 401. Deliveries are deduped by `x-github-delivery`.

Configure the GitHub webhook (repo → Settings → Webhooks) with that URL,
content type `application/json`, your secret, and these events — this is what
the code consumes (`packages/core/opensession-server/src/agents/github/webhook.ts`):

| Event | What happens |
| --- | --- |
| `issue_comment`, `pull_request_review_comment` (action `created`) | if the body matches a configured mention handle: intent-classified → whole-PR action (review / autofix / simplify / adversarial) or a conversational reply run in a PR-branch worktree |
| `pull_request` action `labeled` | labels `os-review` / `os-auto-fix` / `os-simplify` / `os-adversarial` trigger the corresponding behavior; create the labels on your repo first. Auto-fix also merges the current base into conflicting PR branches and resolves the conflicts without force-pushing. |
| `pull_request` `opened`/`reopened`/`synchronize`/`ready_for_review` | auto-review, if the PR is non-draft and either carries `os-review` or the review automation is enabled |
| `pull_request` action `closed` + merged | notifies linked sessions; fires the docs-sync automation on `github:pr_merged` |
| `pull_request_review` | refreshes PR state; when the Slack agent is enabled, review → Slack notification |
| `workflow_run` | notifies sessions waiting on a merged PR's deploy |

**Multi-repo**: events are accepted for **any repo in the config registry**
(`repos` in `~/.opensession/config.json`, matched by `ghRepo`) — a repo joins
the PR agent by existing in config and pointing its own GitHub webhook (same
URL + secret) at the intake. Events for unconfigured repos are dropped.
Per-PR state, locks, worktrees, and session ids are repo-qualified for
non-default repos (the default repo keeps its historical bare-number keys).
Merge side effects (docs-sync, SEO tracking, session deploy notifications)
run for the **default repo only**.

## GitHub events without a public URL

A simple install has no public hostname and no TLS proxy, so GitHub cannot POST
to `/github/webhook`. The **outbound** analogue of Slack Socket Mode covers this
case: the `cli/gh-webhook` gh extension opens an outbound connection to GitHub
and forwards received deliveries to the loopback handler.

```
gh webhook forward --repo=<owner/name> \
  --events=pull_request,pull_request_review,pull_request_review_comment,issue_comment,workflow_run \
  --url=http://127.0.0.1:${WEBHOOK_PORT}/github/webhook \
  --secret=$GITHUB_WEBHOOK_SECRET
```

Delivery becomes GitHub to gh (outbound) to the same `/github/webhook` handler a
public webhook would hit, signed with the same `GITHUB_WEBHOOK_SECRET` so the
handler's HMAC check passes unchanged. No inbound port is opened.

The github agent arms this from its `startup()`
(`packages/core/opensession-server/src/agents/github/webhook-forward.ts`): it
spawns one forwarder per configured repo that has a `ghRepo`, restarts each on
exit with capped backoff, and kills them on shutdown. Set
`GITHUB_WEBHOOK_FORWARD_ORG` (or `integrations.github.webhookForwardOrg`) to
forward a whole org with a single `--org` process instead.

**Gating.** The forwarder runs when no public webhook URL is configured
(`server.publicBaseUrl` is loopback, the simple-mode default) and stays off when
a public URL is set, where the inbound HTTP webhook above stays authoritative.
`GITHUB_WEBHOOK_FORWARD=true` or `=false` overrides that auto-selection. Under
either transport the reconcile sweep
(`packages/core/opensession-server/src/agents/github/reconcile.ts`) remains the
fire-once backstop, so a dropped or missed delivery is still recovered.

**Prerequisites.** The forwarder needs `gh` authenticated (`gh auth login`) and
the `cli/gh-webhook` extension. On startup the agent checks for both; if `gh` is
present but the extension is missing it attempts a one-time
`gh extension install cli/gh-webhook`. If `gh` is absent or the install fails it
logs one line with the fix and falls back to the reconcile sweep rather than
crashing.

## Behavior toggles

- Auto-review on every PR push is **off by default**: the github agent seeds
  a "review" automation disabled (label-only mode). Enable it in the
  Automations UI. Not an env var.
- The docs-sync automation is seeded (enabled, fires on merge) **only when
  you set a prompt** in `integrations.github.docsSyncPrompt`. Set
  `integrations.github.docsSyncChannel` to have it announce its PRs in a Slack
  channel; leave the channel unset and it still runs, just silently.
- Set `integrations.github.shippedChangesChannel` to a Slack channel id to
  enable the merged walkthrough's **Share to Slack** action. A teammate clicks
  it deliberately after merge; the durable `after` screenshot is uploaded with
  the PR link and the walkthrough's first prose paragraph. Backend/refactor
  changes and walkthroughs without visual proof do not show the action.
- Mention replies are always on while the agent is loaded.
- The agent itself is off unless enabled: `integrations.github.enabled: true`
  in config, or the `ENABLE_GITHUB_AGENT` env flag (which wins when set — see
  [integrations-misc.md](integrations-misc.md#boot-guards)).

Prompts and `pr-info.ts` defaults are config-driven (they interpolate the
default repo's `ghRepo`, or the PR's own repo when threaded) — no code edits
needed to point the PR agent at your repos.

## Getting automation PRs reviewed

A `code` automation can open PRs but never merge them — PRs are the human
gate. That gate only closes if a human is actually asked, and nothing asks by
default: an automation PR opens with no reviewer, so it lands in the repo and
waits. Left alone this compounds quietly; the backlog is invisible precisely
because no one was requested on it.

Set `prReviewer` on every `code` automation (and `code` recipe). It takes a
GitHub login, an `org/team` slug, or a comma-separated list of either, and the
run is instructed to pass it to `gh pr create --reviewer`:

```jsonc
{ "name": "Production Error Sweep", "mode": "code",
  "prReviewer": "your-org/your-reviewers" }
```

How the request becomes a notification: `pr-review-notifications.ts` polls the
PR cache every 60s and pushes to anyone newly appearing in a PR's
`reviewRequested`. A team slug is expanded to its members
(`github-review-requests.ts`), each mapped through the identity table to a
person, so one team request notifies every member individually.

Three things to know before you pick a value:

- **A reviewer must be a collaborator on the repo.** For a team that means the
  team itself needs access — being an org member with access by some other
  route is not enough. GitHub rejects the rest with
  `422 Reviews may only be requested from collaborators`. Grant it under
  *Team → Repositories → Add repository*; the bot token can't (it has no
  Administration scope).
- **A team request fans out, it does not round-robin.** Every member gets their
  own notification for every PR. If you want a shared queue rather than a group
  ping, turn on the team's code review assignment in GitHub (round-robin or
  load-balance, count 1) so the team request resolves to one person.
- **The PR author is never requested**, so a reviewer who also authors PRs in
  the same repo gets nothing from those.

The notification is edge-triggered and sent once — there is no digest,
reminder, or re-notify. A recipient with no push subscription, or one who
misses the push, is left with only the review-queue row in the sidebar. Bear
that in mind when backfilling reviewers onto many existing PRs: doing it
against a running server fires one push per PR per reviewer, while doing it
with the server stopped lets the next boot adopt them as the baseline
silently.

## Per-user GitHub auth (PRs as the session owner)

Opt-in: interactive sessions open PRs as the actual human who owns the
session instead of the bot, and the web UI's name picker becomes a real
GitHub sign-in. Off by default — without it everything above is the whole
story.

1. Create one **OAuth App** in your org (Settings → Developer settings →
   OAuth Apps): tick **"Enable Device Flow"** and generate a client secret. If
   the org restricts third-party OAuth apps, approve it.

   Device Flow is not an option here. It is the only sign-in there is, so an
   app without it refuses every attempt (`device_flow_disabled`) and nobody
   can get in. The callback URL, by contrast, is unused, because sign-in never
   redirects; put your instance's URL in if GitHub insists on the field.
2. Configure `~/.opensession/config.json`:

   ```json
   "integrations": {
     "github": {
       "userPrAuth": true,
       "oauthClientId": "<client id>",
       "oauthClientSecret": "<client secret>"
     }
   }
   ```

   (env `OPENSESSION_GITHUB_CLIENT_ID` / `OPENSESSION_GITHUB_CLIENT_SECRET`
   win over config. Signing in needs only the client id; the secret is what
   renews a GitHub App's user tokens, and without it everyone is dropped at
   the first ~8h expiry.)
3. Restart the service to load the runner-internal token injection.

What turns on (`packages/core/opensession-server/src/server/github-auth.ts`, `web-auth.ts`, `routes/auth.ts`):

- **Sign-in required**: the UI shows "Continue with GitHub", which starts the
  device flow, the one sign-in every client uses; only logins on
  `identity.team[].github` may sign in. Every `/api/*` call and the UI WebSocket are 401-gated on the HttpOnly
  session cookie; non-browser callers use `Authorization: Bearer <token>`
  with a token from `~/.opensession-web-sessions.json`. The verified
  identity overrides client-claimed user names (WS and HTTP), stamps
  `createdByLogin` on new sessions, and a one-time boot migration backfills
  it onto existing ones.
- **Organization members imported**: after a repository identifies the GitHub
  organization, the People step adds every organization member to
  `identity.team`. Existing profile details are preserved, and the import is
  recorded so removing someone later is not undone on the next page load.
- **PRs as the owner**: signing in also stores the person's OAuth token
  (scopes `repo read:org`, `~/.opensession-github-auth.json`, 0600). The
  `read:org` scope lets initial setup list organization members. The runner
  injects it as `GH_TOKEN`/`GITHUB_TOKEN` into interactive,
  non-least-privilege runs only — automations, unattended kinds, and any
  run carrying a deny-set keep the bot credential, fail-closed. Manage
  connections (per-teammate status, disconnect) in the Connections UI.
- `GET /api/health` stays un-gated (deploy polls / restart detection).

## Connecting GitHub in simple mode

A **simple-mode install** is one person on their own box: no operator config, no
bot machine-user, no `gh auth login`, and no sign-in gate. Such a user still
needs their **private** repos available, to list them in the repo picker, clone
them, and open PRs as themselves. Simple mode connects with a **GitHub App you
create**, configured entirely in the UI: no file editing, no restart.

1. **Create the app.** Settings → Connections → **GitHub App** opens a wizard
   whose link lands on `github.com/settings/apps/new` pre-filled: a generated,
   likely-unique name, private, no webhook, **Device Flow enabled**, permissions
   **Contents: Read & write**, **Pull requests: Read & write**, and organization
   **Members: Read** (Metadata: Read is automatic). The Members permission lets
   org setup import private memberships into the sign-in roster. Pick the owner:
   your personal account, or an organization (a
   team's app should be org-owned so the org owns it and can reach org repos).
   On that page, **generate a client secret** and copy it, then create the app.
2. **Paste the details.** Back in the wizard, paste the **Client ID**, the app
   **slug** (from the app's URL), and the **client secret**. All three are
   required. The secret is stored 0600 so Open Session can refresh the ~8h
   user-to-server token; without it the connection would lapse.
3. **Install on your repositories.** Follow the install link and pick the repos
   to expose. A user-to-server token only reaches repos the app is installed on.
4. **Connect.** Enter the one-time code at `github.com/login/device`. The token
   is stored under the login GitHub reports (`~/.opensession-github-auth.json`,
   0600, never shown again). Private clones use it through a temporary
   `GIT_ASKPASS` (never written into the remote), and a per-checkout credential
   helper keeps later `fetch`/`push` authenticated. No `gh` CLI or
   `GITHUB_API_TOKEN` is involved.

The single connected account is *the* account for this install (there is no
roster in simple mode; the one connected account is the acting identity).
**Disconnect** removes it; **Remove app** clears the configured client id, slug,
and secret and returns the section to unconfigured. There is no personal-access-
token path: the App is the only simple-mode connect.

### Graduating to per-user sign-in

Connecting the app does **not** by itself turn on the sign-in gate (governed
solely by `integrations.github.userPrAuth`). Because the App's client id is the
*same* key sign-in reads, graduating a team to
[per-user GitHub auth](#per-user-github-auth-prs-as-the-session-owner) is a
one-flag change, or automatic for an org-owned app: `install.sh --org <name>`
(or choosing the Organization owner in the wizard) records the org, and at the
connect step rosters the connecting account as the first admin and enables
sign-in in one locked write. A personal app stays single-user with no gate.

## Deploy script

`deploy/deploy.sh` updates a running box in place. There is no deploy workflow
in this repo — run it however you like: over SSH, from a CI job, or by hand on
the box. Tella drives it with `ssm:SendCommand` so nothing needs inbound SSH,
which is a pattern worth copying but not a requirement.

The script:

1. `git fetch` + `merge --ff-only` (never `reset --hard` — the checkout is
   live and shared; divergence aborts loudly),
2. `bun install --frozen-lockfile` only when the lockfile changed,
3. syncs `opensession.service` to `/etc/systemd/system/` when it changed
   (the deployed unit is a copy, not a symlink),
4. when Caddy is installed, syncs the Tailscale boot-order/retry drop-in from
   `deploy/systemd/caddy.service.d/opensession.conf` and recovers Caddy if it
   was left failed by the tailnet-IP bind race,
5. installs the coordinator resource override and the `opensession.slice`
   aggregate budget for detached engine/preview scopes, preventing one session
   or an accumulation of scopes from exhausting the host,
6. waits up to `MAX_DRAIN_WAIT` (480s) for `activeRuns == 0` on
   `/api/health`, then `systemctl restart opensession` and a
   post-restart health gate.

The drain-aware contract — ff-only pull → conditional install → idle wait →
graceful restart — is the part worth keeping whatever invokes it. `ff-only`
matters most: the checkout on the box is live and shared, so a divergence
aborts loudly rather than discarding work.
