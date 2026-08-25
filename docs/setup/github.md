# GitHub

The GitHub integration has three parts: one GitHub App for bot and teammate
credentials, webhook intake on the [webhook server](install.md#webhook-server),
and the `gh` CLI used inside trusted runs. Installation and App user tokens are
the only GitHub credentials Open Session accepts.

## GitHub App

Create one organization-owned GitHub App. The same App provides:

- short-lived installation tokens for reviews, comments, merges, clones,
  pushes, previews, sandboxes, and trusted GitHub automations;
- device-flow user tokens so interactive sessions act as the signed-in person;
- the bot identity `<app-slug>[bot]` for self-trigger protection and attribution.

Configure it from Settings → Integrations, or under
`integrations.github` in `~/.opensession/config.json`:

```jsonc
{
  "integrations": {
    "github": {
      "enabled": true,
      "oauthClientId": "Iv…",
      "oauthClientSecret": "…",
      "appSlug": "open-session-example",
      "installationOwner": "your-org",
      "userPrAuth": true
    }
  }
}
```

The private key is not stored in JSON. Paste the PEM in Settings →
Integrations; Open Session writes it atomically with mode 0600 to `~/.opensession/github-app.pem`. Operators
may instead set `OPENSESSION_GITHUB_APP_KEY` to an externally managed PEM path.
The UI will not overwrite or delete an operator-managed key.

Environment overrides for the App identity are
`OPENSESSION_GITHUB_CLIENT_ID`, `OPENSESSION_GITHUB_CLIENT_SECRET`,
`OPENSESSION_GITHUB_APP_SLUG`, and `OPENSESSION_GITHUB_APP_KEY` (a path, not PEM
contents). Environment values win over config. `installationId` may pin a known
numeric installation; normally `installationOwner` selects it by organization.

### Required permissions

The create-App link in Settings → Integrations is generated from the same
canonical permission set used when tokens are minted:

| Scope | Access | Why |
| --- | --- | --- |
| Actions | Read | failing workflow logs for trusted fixes |
| Checks | Read | check runs |
| Commit statuses | Read | status rollups |
| Contents | Read and write | clone and push |
| Deployments | Read | preview deployment state |
| Issues | Read and write | issue and PR comments |
| Metadata | Read | GitHub baseline |
| Pull requests | Read and write | reviews, PRs, merges |
| Members (organization) | Read | roster and attribution |

Enable **Device Flow**, generate a client secret and private key, then install
the App only on the organization and repositories Open Session should reach.
When permissions change, approve the updated installation permissions too.

GitHub service authority is fail-closed. A missing key, wrong installation
owner, unapproved permission, or failed token mint never falls back to ambient
`gh`, a host SSH key, or a connected human. Installation tokens remain process-local and
short-lived; repository code runs receive a token scoped to that one verified
repository.

### Bot identity and mention handles

Set `appSlug` even though token minting itself only needs the client id and key.
App-authored activity appears as `<app-slug>[bot]`; Open Session adds that login
to its own-author set so comments and pushes cannot trigger loops. The App slug
itself is the preferred PR mention handle. Keep old names in
`integrations.github.mentionHandles` only as compatibility aliases.

`policy.githubBotLogins` may retain aliases for historical App names.
`GITHUB_MENTION_HANDLES` adds compatibility mention handles. Server-owned `gh`
calls receive a short-lived App token in their process environment. HTTPS Git
operations use a process-local credential helper, and SSH GitHub remotes are
rewritten to HTTPS for that process so host keys cannot bypass the App.

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

### Public-repository actor gate

The webhook secret authenticates GitHub, not the person who caused an event.
Before an event can command the agent, the actor's exact login must appear in
`identity.team[].github`; the configured `policy.githubBotLogins` are trusted
separately for machine-originated events. This gate covers PR comments and
inline comments, labels, automatic review events, merge automations, workflow
notifications, Slack review notifications, reconcile retries, and restart
recovery. Unknown actors are ignored. GitHub's `author_association` field is
not a trust source.

This means a public contributor can still open a PR and receive ordinary
credential-free GitHub Actions CI, but cannot wake the Open Session agent,
spend its model budget, push code, steer a session, or trigger a privileged PR
behavior. Keep the team GitHub roster current; an empty roster fails closed.

**Multi-repo**: events are accepted for **any repo in the config registry**
(`repos` in `~/.opensession/config.json`, matched by `ghRepo`) — a repo joins
the PR agent by existing in config and pointing its own GitHub webhook (same
URL + secret) at the intake. Events for unconfigured repos are dropped.
Per-PR state, locks, worktrees, and session ids are repo-qualified for
non-default repos (the default repo keeps its historical bare-number keys).
Merge side effects (docs-sync, SEO tracking, session deploy notifications)
run for the **default repo only**.

## Webhook reachability

PR comments, labels, and other event-driven behavior need GitHub to reach the
public webhook URL. Set `server.webhookBaseUrl` (or the webhook origin in
Settings), terminate TLS there, and configure the organization webhook above.
A private-only instance can still reconcile missed PR reviews by polling, but
it cannot discover conversational comments without webhook delivery.

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

1. Use the same organization-owned **GitHub App** configured above: tick
   **"Enable Device Flow"** and generate a client secret. If the organization
   restricts GitHub Apps, approve its installation and updated permissions.

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
       "oauthClientSecret": "<client secret>",
       "appSlug": "<app slug>",
       "installationOwner": "<organization>"
     }
   }
   ```

   The private key is stored separately as described above. Environment
   `OPENSESSION_GITHUB_*` values win over config. Signing in needs the client
   id; the secret renews user tokens; the key mints bot installation tokens.
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
- **PRs as the owner**: signing in also stores the person's GitHub App
  user-to-server token (`~/.opensession/github-auth.json`, 0600). The App's
  Members permission lets initial setup list organization members. The runner
  injects it as `GH_TOKEN`/`GITHUB_TOKEN` into interactive,
  non-least-privilege runs only — automations, unattended kinds, and any
  run carrying a deny-set stay credential-free. Trusted GitHub code workflows
  receive the repository-scoped App credential instead. Manage
  connections (per-teammate status, disconnect) in the Connections UI.
- `GET /api/health` stays un-gated (deploy polls / restart detection).

## Connecting GitHub in simple mode

A **simple-mode install** is one person on their own box: no operator config, no
separate bot account, no `gh auth login`, and no sign-in gate. Such a user still
needs their **private** repos available, to list them in the repo picker, clone
them, and open PRs as themselves. Simple mode connects with a **GitHub App you
create**, configured entirely in the UI: no file editing, no restart.

1. **Create the app.** Settings → Connections → **GitHub App** opens a wizard
   whose link lands on `github.com/settings/apps/new` pre-filled: a generated,
   likely-unique name, private, no webhook, **Device Flow enabled**, permissions
   the complete permission set in [Required permissions](#required-permissions).
   The Members permission lets org setup import private memberships into the
   sign-in roster. Pick the owner:
   your personal account, or an organization (a
   team's app should be org-owned so the org owns it and can reach org repos).
   On that page, **generate a client secret** and copy it, then create the app.
2. **Paste the details.** Back in the wizard, paste the **Client ID**, app
   **slug**, **client secret**, and generated **private key**. The secret refreshes
   ~8h user-to-server tokens; the 0600 private key mints installation tokens for
   bot work. Select the installation owner when more than one installation exists.
3. **Install on your repositories.** Follow the install link and pick the repos
   to expose. A user-to-server token only reaches repos the app is installed on.
4. **Connect.** Enter the one-time code at `github.com/login/device`. The token
   is stored under the login GitHub reports (`~/.opensession/github-auth.json`,
   0600, never shown again). Interactive HTTPS clones and pushes receive it
   through a process-local credential helper. No static GitHub token is involved.

The single connected account is *the* account for this install (there is no
roster in simple mode; the one connected account is the acting identity).
**Disconnect** removes it; **Remove app** clears the configured client id, slug,
secret, private key, and installation intent, then returns the section to
unconfigured. There is no personal-access-
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
