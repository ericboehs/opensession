# Security model

Open Session runs agents against untrusted input: customer tickets, channel
events, webhook payloads, and the open internet. The stance throughout is
**enforce at the tool/env/credential layer, never just in prompts** — a prompt
rule is guidance, a stripped tool or scoped token is a guarantee. This
document is the full reference behind the invariant summary in
[AGENTS.md](../AGENTS.md).

## Automation least-privilege

Automation runs (especially event-triggered ones like support-ticket triage)
process untrusted text — ticket content is data the agent reads, never
configuration for the run.

- Agent subprocesses get a minimal env (PATH, HOME, LANG, OPENSESSION_MODEL) —
  no tokens from `~/.opensession.env`. MCP servers receive their own
  credentials via mcp-config.json per-server `env` or load it themselves.
- Each automation has an optional `mcpServers` allowlist (per-automation
  field, settable via the API); runs only see those servers. Example: a
  support-triage automation might name only its support-inbox, identity,
  analytics, issue-tracker, error-tracker, and billing servers so it can look
  up the customer, related issues, and errors while investigating.
- Scheduled automation `inputs` are a separate read path from the primary
  run's MCP allowlist. Built-in input providers fetch a bounded time window,
  pass it through a tool-less one-shot reducer as explicitly untrusted data,
  and persist only a cursor after the primary run succeeds. Raw Slack text and
  reductions are not stored in the checkpoint. A Slack input never grants the
  primary model Slack tools; optional Slack output is likewise server-side,
  disabled independently, and derived from the final structured report.
- Automation runs hard-deny *customer-facing and identity-mutating* tools
  (enforced for direct runs and interactive resumes of automation sessions):
  Plain thread writes (reply_to_thread, mark_thread_done/todo, snooze_thread)
  and the WorkOS write/destructive subset (create/delete/update user+org,
  revoke, invitations, password/verification emails, impersonation URLs).
  Reads stay allowed; suggested customer replies go in an internal Plain note.
  Linear (incl. issue creation) and Sentry are internal, so their writes are
  allowed — that's the "spin off work" affordance.
- Automations run on Pi in detached run hosts. `runAutomation` maps every
  native or legacy Pi model id onto Pi at dispatch (`automationModel`;
  unset uses `DEFAULT_PI_AUTOMATION_MODEL` in automations.ts). Deny-sets are
  enforced before Pi registers MCP tools, and its guarded local tools keep
  filesystem and environment access contained. opensession-admin,
  opensession-sessions, and per-user (`allowedUsers`) servers stay out of
  automation runs. Both engine run gates are
  deny-by-default on journal kind: interactive kinds
  (prompt/goal/create/linear/slack), unattended kinds
  (automation/plain/action/security-scan/github-*), everything else refused.
- `mode` is per-automation: "ask" runs read-only on the main checkout (no
  worktree, no Write/Edit); "code" gets an isolated worktree with Write/Edit
  and can open PRs (never merge — PRs are the human gate). Code mode still
  carries every other scoping (MCP allowlist, denied customer/identity
  writes, IMDS blocked, minimal env) — only the worktree + write tools differ
  from ask.
- When adding an automation, scope it: pick ask mode unless it must write, and
  name only the MCP servers it uses.
- The PR gate is only a gate if a human is asked. A code automation's
  `prReviewer` (a GitHub login, `org/team` slug, or list) is requested as
  reviewer on the PRs it opens; without one the PR reaches nobody's review
  queue and the human gate degrades into an unread backlog. Set it on every
  code automation — see
  [Getting automation PRs reviewed](setup/github.md#getting-automation-prs-reviewed).

## Stripe: a third enforcement tier

Stripe is money-moving, so it gets a tier beyond allow/deny: the tools in
`STRIPE_CONFIRM_TOOLS` (runner-shared.ts: create_refund,
cancel/update_subscription, and the raw-API mutators stripe_api_execute +
stripe_api_write since they can hit any permitted endpoint — keep this list in
sync with mcp.stripe.com's live catalog). Run the MCP on a restricted key
(write on Refunds + Subscriptions + Invoices only — invoice voiding included;
read on core billing resources, nothing else — Stripe enforces this ceiling
server-side). On the pi engine there is no per-call approval card, so
the confirm tools are STRIPPED from the model's tool list on every run — the
server stays mounted and Stripe reads keep working. Guidance differs by run
type: unattended runs get post-the-proposal-in-your-note wording, interactive
runs get ask-the-human-in-this-session wording. (Dropping the whole server
from interactive runs was tried and reverted: it blanked Stripe reads for no
security gain — the money-movers were never reachable either way, and the
restricted key's write ceiling is enforced by Stripe server-side.)

## Per-user MCP servers (`allowedUsers`)

An MCP server in `mcp-config.json` can carry an optional
`allowedUsers: string[]`. When set (non-empty), only runs whose **user**
resolves to one of those people get that server's tools; everyone else's
sessions never see it. Omitted/empty = available to everyone (the default).
Entries are matched by `userMatchesAny` (packages/core/opensession-server/src/server/shared/user-mappings.ts)
through the same identity table as commit attribution, so a teammate's name
matches a run user given as their short name, a nickname, their email, or
their Slack id. Example use: scope a finance/expenses MCP server to the one or
two people who should see it.

- Enforcement is at the runner layer, not the prompt:
  `filterMcpServers(allowlist, user)` (runner-shared.ts, consumed by
  the MCP bridge in pi-mcp-bridge.ts) drops a restricted server
  the run's user isn't cleared for, and strips the `allowedUsers` field before
  the config reaches the engine. Both the per-automation allowlist and the
  per-user gate apply.
- The `user` is threaded from the run paths (`runSessionPrompt`, both
  `create_session` paths, goal wakes, the Slack/Linear loops) through
  `runAgent` → `runPi`, and is journaled on the `ActiveRunRecord` so a
  resume after a restart keeps the same visibility. **Automation runs pass no
  user**, so an `allowedUsers`-restricted server is invisible to them —
  untrusted ticket text can never reach a restricted server, even if the
  automation's own `mcpServers` allowlist names it (fail-closed).
- Manage it from the Connections UI (the Add-MCP form has an "Allowed users"
  field; each server card has a Restrict/Edit-access button →
  `PUT /api/connections/mcp/:name` with `{allowedUsers}`), or via
  opensession-admin (`add_mcp_server`'s `allowedUsers`, and
  `set_mcp_allowed_users`). Backing helpers: `addMcpServer` /
  `setMcpAllowedUsers` in packages/core/opensession-server/src/server/connections.ts.
- A change to the runner-layer filtering needs a real `systemctl restart`.
  Adding/removing/re-scoping a server in `mcp-config.json` itself is read
  fresh per run, but until the process runs the new `filterMcpServers`,
  `allowedUsers` is neither enforced nor stripped — so restart after wiring a
  restricted server.

## Personal MCP OAuth grants

Browser-connected MCP grants are stored as authenticated AES-256-GCM
ciphertext. Open Session prefers an operator-supplied systemd credential for
the 32-byte key. A rootless simple-mode install instead mints a `0600` key next
to the store on first use, so the feature works without a root step. That
fallback protects a stray copy of the grant file. It does not protect a whole
state-directory backup, or defend against another process already running as
the same Unix user, because that process can read both files.

Remote HTTP MCP grants are mounted as coordinator-side in-process proxies. The
provider token is resolved immediately before the upstream connection and does
not enter engine config, process environment, command arguments, projected
sandbox files, or the run transcript. The grant is bound to the configured
upstream URL; repointing the same server name makes the connection fail closed
until it is reconnected.

Personal tokens are never injected into local stdio MCP processes. On a normal
rootless install those executables and their package entrypoints can be changed
by the same Unix identity as an agent run, so pinning a pathname would not make
the token handoff safe. A stdio MCP keeps its configured workspace credential.
Provider-specific personal grants such as Slack may still be used by
coordinator-owned UI actions that call the provider API directly.

On an operator install, per-user grants and `allowedUsers` visibility follow the
verified **prompter**, never the session creator. A teammate steering somebody
else's session therefore cannot spend or reveal the owner's personal grant. A
simple-mode install has no web identity gate and creates shared grants, which
matches its single-user trust model. The OAuth callback is tied to the same
verified account that started it whenever web sign-in is enabled.

Encryption at rest and coordinator proxying are useful reductions, not a
same-UID sandbox. Full isolation requires a small broker under a separate OS
identity that holds the key and issues narrow per-use capabilities.

## GitHub webhook actor trust (public repositories)

A valid webhook signature proves that GitHub sent an event. It does **not**
prove that the GitHub user who caused it is trusted. This distinction is
critical for public repositories, where anyone can open or update a PR, write a
PR comment, or submit a review.

The GitHub agent therefore treats `identity.team[].github` as its human trust
roster and `policy.githubBotLogins` as its machine trust roster. Actor-driven
entry points fail closed before starting an agent run or steering a session:

- PR and inline-review `@mention` commands require the comment author's exact
  GitHub login on the team roster. `author_association` is never accepted as a
  substitute.
- label-triggered review, auto-fix, simplify, and adversarial runs require the
  label actor on the roster.
- automatic review on open/reopen/push/ready events requires a rostered sender
  or configured bot. The reconcile sweep applies the same gate and will not
  infer trust merely from a label that lacks a persisted trusted requester.
- merge automations and deploy-workflow session notifications require a
  rostered actor or configured bot.
- startup recovery revalidates persisted requesters, so a previously accepted
  public event cannot bypass the boundary after a restart.

Keep every trusted GitHub login in the identity roster. An empty roster disables
human GitHub commands rather than making the integration public.

## GitHub credential scoping (out-of-org writes fail server-side)

The "repositories outside your org require confirmation" rule in AGENTS.md is
enforced with credential scope, not just prompts. The selected GitHub App
installation belongs to `integrations.github.installationOwner`; server reads
and writes use short-lived installation tokens, while trusted repository code
runs receive a token narrowed to the owner-verified `owner/repo`. Teammate
device-flow tokens are limited by both that App installation and the person's
own GitHub access. Out-of-installation writes therefore fail at GitHub's side.

The App is a fail-closed boundary: token-mint failure never consults ambient
`gh` hosts.yml accounts, SSH credentials, or a connected human. Process-local
Git config rewrites GitHub SSH remotes to HTTPS so the projected App or user
credential is the only authority a run can use.

## Per-user GitHub auth + web sign-in (opt-in, config `integrations.github`)

Off by default. Opting in uses the same App identity as bot traffic:
`integrations.github` carries `userPrAuth`, `oauthClientId`,
`oauthClientSecret`, `appSlug`, and `installationOwner`; the private key lives
at `~/.opensession/github-app.pem` (or the path in
`OPENSESSION_GITHUB_APP_KEY`). Environment App identity values win over config.
Enabling `userPrAuth` activates both halves below:

- **PRs as the session owner** (packages/core/opensession-server/src/server/github-auth.ts): teammates connect
  their GitHub account via the OAuth *device flow* (Connections UI card, or
  implicitly by signing in). Tokens live per-login in
  `~/.opensession/github-auth.json` (0600, never returned by any API). The
  runner injects them as GH_TOKEN/GITHUB_TOKEN into the engine-server env —
  interactive kinds only and never a least-privilege run
  (`policy.unattended`: automations and deniedTools carriers including the
  Slack/Linear loops stay credential-free; trusted GitHub code workflows alone
  receive a repository-scoped App token). The run user
  resolves to a login through the SAME identity table as commit attribution,
  so the mapping is config (identity.team[].github), not code. The
  PR-attribution instructions swap the `--assignee` bot wording for "authored
  by them" when the token rides. Injection lives in pi-runner.ts ⇒
  needs a real restart.
- **GitHub web sign-in** (packages/core/opensession-server/src/server/web-auth.ts + routes/auth.ts): when
  active, the UI's name picker is replaced by a real sign-in (UserGate →
  device flow → HttpOnly `opensession_auth` cookie; sessions in
  `~/.opensession-web-sessions.json`, sliding 90d). Every API request and the
  UI WebSocket 401 without it (gate in opensession.ts's fetch preamble;
  exempt: `/api/auth/*`, run-ws/rpc-ws dial-backs, page/asset loads). Only
  logins on identity.team may sign in. The verified identity OVERRIDES
  client-claimed `user` on every WS message and stamps `createdByLogin` on
  new sessions; a one-time boot migration backfills `createdByLogin` onto
  existing sessions from `createdBy` (marker:
  `~/.opensession-sessions/.github-user-migration.json`). Non-browser callers
  (curl/CDP recipes) authenticate with `Authorization: Bearer <token>` using a
  token from the web-sessions file.

One sign-in flow, for every client: the **device flow** (`POST
/api/auth/device` → the person enters the code on github.com →
`/api/auth/device/poll`, which the server also polls to completion itself so a
suspended phone doesn't lose the outcome). There is deliberately no
authorization-code redirect. A redirect has to return to the exact origin it
left, and on the iOS PWA it comes back in Safari rather than the installed
app; native apps can't take one at all. GitHub side: one
org-owned **GitHub App** with "Enable Device Flow" checked, installed only on
the repositories Open Session should reach. GitHub App user
tokens are what scopes teammates' tokens to your org (see the previous
section): they can't reach public/third-party repos, they expire ~8h, and
github-auth.ts refreshes them via a rotating refresh token (20-min ticker
parked on globalThis + refresh-on-boot; getters never hand out an expired
token: interactive runs receive no GitHub credential and web mutations return
403 to "connect your account"). A refresh rotates the token string, which changes the
shared-server config hash → drain-respawn at next run start, by design.
`oauthClientSecret` is what that refresh grant needs. Signing in never uses
it, so an instance without one signs people in and then drops them at the
first expiry.

"Enable Device Flow" is not optional on the GitHub side. It is the only
sign-in there is, so an app without it refuses every attempt with
`device_flow_disabled`, and nobody can get in. `startGithubDeviceFlow` maps
that one code to a sentence naming the switch, since it is the failure that
locks out a whole instance at once.

## Self-management tools (Slack + interactive Open Session sessions)

The `opensession-admin` in-process MCP server
(packages/core/opensession-server/src/agents/slack/admin-tools.ts) lets the agent manage its own setup from
Slack: channel memory (remember/list_memory/forget) and — gated to the trusted
user (`isAdmin` = no `ALLOWED_SLACK_USER_ID` set, or sender matches it) —
automations (list/create/update/delete/run) and MCP connections
(list/add/remove). It is wired ONLY into interactive Slack runs (handlers.ts
`processMessage`); automation runs never go through there, so they never
receive these tools. Do not add `opensession-admin` to automation/`runAgent`
paths — that would let untrusted ticket text reconfigure the agent. Channel
memory is scoped in packages/core/opensession-server/src/agents/slack/memory.ts (public channel → shared
`workspace` store; private channel/DM → isolated, with read-only workspace
view) and auto-injected into the system prompt each run.

Both `opensession-admin` and `opensession-sessions` are ALSO available inside
**interactive Open Session sessions** (web UI + loops), not just Slack:
`interactiveMcpServers(user, sessionId)` (packages/core/opensession-server/src/server/interactive-mcp.ts)
builds them and they are passed as `inProcessMcp` from the interactive run
paths (`runSessionPrompt`, both `create_session` paths). They're withheld from
automation runs **and** from interactive resumes of automation-owned sessions
(gated on `!isAutomationSession`, the same gate as `deniedTools`) — untrusted
ticket text must never reach these tools. Open Session is network- and
team-gated and already exposes all of this through its UI, so interactive
users are treated as `isAdmin: true` there. The in-process servers are built
with `packages/core/opensession-server/src/server/inprocess-mcp.ts` (a thin @modelcontextprotocol/sdk wrapper)
and reach pi runs as stdio MCP proxies that forward to the in-process
tools through the run-RPC socket; the Slack loop registers its own
slack-context server set per run via `registerSessionMcpServers` (run-rpc.ts)
so those proxies execute the right context. The runner adds a short "Managing
<persona.name>" context block when these tools are present so the session
knows they exist.

The `opensession-sessions` in-process MCP (packages/core/opensession-server/src/agents/slack/sessions-tools.ts)
is a sibling, wired the same way (interactive runs only — never automations).
It lets the agent see and steer every *other* Open Session session: read tools
`list_sessions` (with a `waiting` state filter and an exact `createdBy`
identity filter) and `get_session` (explicit creator/creation timestamp, state,
pending question, and transcript tail) are open to any whitelisted user; the control tools —
`answer_session_question`, `send_to_session`, `cancel_session`,
`create_session` — are gated to the trusted user via `isAdmin`. The tools
don't touch in-process state directly; they go through the `SessionControl`
registry (packages/core/opensession-server/src/server/session-control.ts) that
packages/core/opensession-server/src/server/session-control-wiring.ts populates at boot with the same helpers
the WebSocket handlers use — so steering from here behaves exactly like a
human in the web UI, and an autonomous monitor can call the same registry
directly without the MCP. Sessions whose runs aren't owned by this process
(CLI/tmux) are surfaced as `observe-only` and can't be steered/cancelled. Do
NOT wire `opensession-sessions` into automation/`runAgent` paths —
cross-session control from untrusted ticket text would be a
privilege-escalation path. (Sole carve-out: `automation.selfImprove` below,
which grants the spawn_task suite only — never answer/send/cancel/create.)

### Exception 1: papercuts

`opensession-papercuts` (packages/core/opensession-server/src/agents/slack/papercuts-tools.ts, store in
packages/core/opensession-server/src/server/papercuts.ts → ~/.opensession-papercuts) is the one deliberate
exception to "no in-process servers for automations": an append-only friction
log with no reads of anything sensitive and no control surface, so automation
runs DO carry it (automations.ts registers the instances per run). Two
invariants keep that safe: the run-rpc interactive builder
(interactive-mcp.ts) fails closed for automation-owned sessions — a
registered automation run token can never resolve the admin/sessions siblings
through the socket — and the "Managing <persona.name>" instructions block is
gated on `opensession-sessions` presence, not on any in-process server.
Per-repo toggle (default on) in Settings → Papercuts; entries mirror into the
audit log. Hold new additions to automation runs to the same bar: append-only,
nothing sensitive readable, no control surface — anything more stays
interactive-only.

### Exception 2: self-improving automations (`automation.selfImprove`)

The second exception is human-set per instance (e.g. a nightly reflection
automation over the agent's own telemetry). A flagged automation's runs — and
thread-reply resumes of its sessions (run-session.ts + the run-rpc fallback
builder both honor the flag) — additionally carry two scoped servers:
`opensession-sessions` in `automationSelf` shape (sessions-tools.ts — list/get
reads plus the `spawn_task`/`task_status`/`cancel_task` suite ONLY; the
answer/send/cancel/create controls on other sessions stay isAdmin-gated and
are never included) and `opensession-self`
(packages/core/opensession-server/src/agents/slack/self-improve-tools.ts — read own record +
`update_own_prompt`, own automation only, timestamped backup +
`automation_self_update` audit event, length floor against degenerate
rewrites; schedule/model/mode/repo stay human-only via
`updateAutomationPromptSelf` in automations.ts). Containment: spawned children
go through the same createSession path (PR-gated, spawn-depth ≤ 2), and the
flag is settable only by humans (API/UI) — never grant it to automations
triggered by untrusted event/ticket text (ticket triage, channel watches);
it's meant for introspective/scheduled ones whose input is your own telemetry.
