Default to using Bun instead of Node.js.

## Backstage dev workflow (self-hosting — read this first)

Backstage runs itself: the live server is `bun --hot` from this main checkout
(`/home/ubuntu/projects/tella-backstage`), so the fastest way to see a change is
to **edit the main checkout on `master` directly** — `bun --hot` reloads it live.
Because of that, backstage code sessions do **not** get their own worktree
(`sharedCheckout` in `src/server/worktree.ts`); they all work in this one shared
checkout on `master`. That's intentional wild-west iteration. The rules that keep
it from descending into chaos:

- **Only `add` → `commit` → `push`. Never `git reset --hard`, `git checkout .`,
  `git revert`, or `git checkout <other-branch>` in the shared checkout.** A reset
  or branch-switch yanks the working tree out from under the live server *and*
  every other session — that's the "sessions undoing each other's work" trap. If
  something looks wrong, inspect and fix forward; don't roll back the shared tree.
- **`git add <specific files>`, not `git add -A`** — multiple sessions may have
  uncommitted edits in this tree; only commit your own. High-traffic files
  (`global.css`, `backstage.ts`, `App.tsx`) are sweep magnets: even a specific
  `git add` on one of them can pick up another session's uncommitted hunks
  (it's happened three times: 2c89f14, 5a372890, and Kent's title commit). For
  those files use `git add -p` to stage only your hunks, and check
  `git diff --cached` before committing.
- **Commit + push frequently.** Un-pushed work is the only thing a sync can't
  protect (the deploy is now `merge --ff-only`, never `reset --hard`, so it aborts
  loudly instead of wiping — but push anyway).
- **Don't `systemctl restart` casually.** Most edits hot-reload. Only runner
  internals / agent-loop / scheduler changes need a real restart, and a restart
  drains every session — treat it as a deliberate, announced action. Frontend
  changes never need it (`kill -USR2 <pid>` or the watcher rebuilds the bundle).
- Want isolation for a risky/breaking change? Make a worktree by hand and run a
  second instance on another `PORT` — but note `BACKSTAGE_DEV=1` only swaps the
  frontend build; it does **not** yet disable the Slack/Linear/Stripe loops,
  webhook server, or schedulers, so a naive second instance double-sends. (A real
  isolated dev mode is a future task.)

## Frontend UI system (Base UI + Tailwind + Motion)

New UI goes through this stack; legacy `global.css` classes are migrated
opportunistically when touched (strangler pattern — never a big-bang rewrite):

- **Tokens**: `src/frontend/styles/tailwind.css` maps the existing `global.css`
  variables (`--bg`, `--text-dim`, …) into Tailwind's namespace via
  `@theme inline` — use `bg-panel text-dim border-line text-fg bg-surface` etc.,
  never raw hex or stock Tailwind grays. Dark/light theming comes for free
  because the vars re-resolve under `html[data-theme]`. The spacing/radius/text
  scales are px-anchored there (global.css sets `html { font-size: 14px }`,
  which would otherwise shrink every rem-based utility to 87.5%) — so `p-3` is
  a true 12px and `text-xs` a true 12px. Bare `rounded` bypasses the radius
  scale; use `rounded-sm/md/lg` (4/6/8px).
- **Compile**: Tailwind is compiled by an `@tailwindcss/cli` subprocess inside
  `buildFrontend()` (backstage.ts) and linked *after* `global.css`; utilities
  are imported unlayered so they win source-order ties against legacy rules.
  Preflight is intentionally NOT imported (global.css assumes browser
  defaults). Don't import tailwind.css from App.tsx — Bun can't compile it.
- **Primitives**: wrap Base UI (`@base-ui/react`) per component in
  `src/frontend/ui/` (see `ui/tooltip.tsx` for the pattern). Rules: always
  pass `className` through `cn()` (ui/cn.ts); keep Base UI's composable parts
  shape rather than mega prop APIs; style open/close state via Base UI data
  attributes; few variants (`variant`/`size`), no boolean prop explosions.
- **Motion**: use `motion.*` directly with shared presets from `ui/motion.ts` —
  don't build wrapper components around Motion. Caveat for Base UI popups:
  `render={<motion.div/>}` drops Base UI's injected attributes (role, data-*),
  so it's only safe on non-focus popups like the tooltip (enter-only; restore
  `role` by hand — see ui/tooltip.tsx). Focus-managed popups (menus, dialogs)
  animate with CSS transitions on Base UI's `[data-starting-style]` /
  `[data-ending-style]` lifecycle attributes instead (see ui/menu.tsx) — that
  keeps keyboard nav + a11y intact and gets exit animations for free.
  AnimatePresence can't track exits through Base UI portals; don't use it there.

- Use `bun run backstage.ts` to start the server
- Server binds to Tailscale IP (100.65.135.7:3850) — not publicly accessible
- Access at `http://michael:3850/backstage/`
- Bun automatically loads .env, so don't use dotenv
- HTML imports for frontend bundling (no Vite)
- All session file access is read-only (never modify ~/.slack-sessions/ or ~/.linear-sessions/)
- Own session store at ~/.backstage-sessions/
- Audit log: every agent run emits structured JSON events (incident-agent style) to ~/.backstage-audit/audit-YYYY-MM-DD.jsonl via src/server/audit.ts — see deploy/README-audit.md for the event catalog and CloudWatch shipping
- Internal notes and draft replies (Plain, Linear) are always written in English, regardless of the customer's language — note the customer's language so the team can translate before sending. This applies to agent prompts here (src/agents/plain/prompts.ts) and to automation prompts stored in ~/.backstage-automations/.

## Hot reload & restarts

The systemd service runs `bun --hot run backstage.ts`: editing source hot-reloads in-process so WebSocket clients and in-flight runs survive (rather than restarting and dropping every session). One-time setup (agents, schedulers, timers, signal handlers) is guarded behind `globalThis.__backstageBooted`; live state (watchers, pendingAsks, promptQueues, loaded agents, runner active-run maps) is parked on `globalThis`; the `Bun.serve` server is reused, not rebound.

What hot-reloads vs. what needs a real `systemctl restart` — **important, this has bitten us:**
- **Hot-applies:** HTTP/route + WebSocket handlers, the `SessionControl` registry (re-registered on every reload, so session-control / MCP-injection logic updates), per-message config and prompts read fresh.
- **Needs a real restart:** long-lived **agent loop code** (Slack/Linear/Stripe event loops — guarded against double-start, so the old code keeps running), and **runner internals** (`claude-runner.ts` / `agent-runner.ts` / `runClaude`, e.g. how a run's MCP/tool list is built). `--hot` does NOT propagate a change in a deeply-imported module like runClaude into the running process even though health/PID look fine. Before declaring a runner-path change live, `systemctl restart` and verify with a real run.

Restarts are graceful: SIGTERM stops new intake, then drains in-flight runner runs (bounded by `SHUTDOWN_DRAIN_MS`, default 2 min/120s; unit `TimeoutStopSec=140`, which must stay above the drain) before exiting; anything still going is resumed from the run journal on next boot. The unit also sets `KillMode=mixed` so SIGTERM hits only the bun parent (not the whole cgroup) — otherwise systemd kills the Claude children directly and the drain/journal never get a chance. The deployed `/etc/systemd/system/backstage.service` is a **copy** of the repo `backstage.service`, not a symlink — sync with `sudo cp` + `systemctl daemon-reload`.

## Automation least-privilege

Automation runs (especially event-triggered ones like Plain ticket triage) process untrusted text — customer ticket content is data the agent reads, never configuration for the run. Constraints are enforced at the tool/env layer, not just in prompts:

- Agent subprocesses get a minimal env (PATH, HOME, LANG, MICHAEL_MODEL) — no tokens from ~/.backstage.env. MCP servers receive their own credentials via mcp-config.json per-server `env` or load it themselves (workos-mcp wrapper).
- Each automation has an optional `mcpServers` allowlist (per-automation field, settable via the API); runs only see those servers. Triage uses six (`plain`, `workos`, `tinybird`, `linear`, `sentry`, `stripe`) so it can look up the customer, analytics, billing, related issues and errors while investigating.
- Stripe is money-moving, so it gets a third enforcement tier beyond allow/deny: **per-call human confirmation**. The MCP uses a restricted key (write on Refunds + Subscriptions only, read on core billing resources, nothing else — Stripe enforces this ceiling server-side). The tools in `STRIPE_CONFIRM_TOOLS` (claude-runner.ts: create_refund, cancel/update_subscription, and stripe_api_execute since it can hit any permitted endpoint) pause interactive sessions on an approve/deny card showing the exact tool input; in unattended runs they're denied with instructions to post the proposed action (tool + full parameters) in the note for a human to approve by opening the session. Approvals/denials land in the audit log as `human_confirmation` / `confirm_unattended` decisions.
- Automation runs hard-deny *customer-facing and identity-mutating* tools in canUseTool (enforced for direct runs and interactive resumes of automation sessions): Plain thread writes (reply_to_thread, mark_thread_done/todo, snooze_thread) and the WorkOS write/destructive subset (create/delete/update user+org, revoke, invitations, password/verification emails, impersonation URLs). Reads stay allowed; suggested customer replies go in an internal Plain note. Linear (incl. issue creation) and Sentry are internal, so their writes are allowed — that's the "spin off work" affordance.
- `mode` is per-automation: "ask" runs read-only on the main checkout (no worktree, no Write/Edit); "code" gets an isolated worktree with Write/Edit and can open PRs (never merge — PRs are the human gate). Triage runs in code mode: it can implement a fix in its worktree and open a PR for review, or recommend the fix in the note. Code mode still carries every other scoping (MCP allowlist, denied customer/identity writes, IMDS blocked, minimal env) — only the worktree + write tools differ from ask.
- When adding an automation, scope it: pick ask mode unless it must write, and name only the MCP servers it uses.

## Per-user MCP servers (`allowedUsers`)

An MCP server in `mcp-config.json` can carry an optional `allowedUsers: string[]`. When set (non-empty), only runs whose **user** resolves to one of those people get that server's tools; everyone else's sessions never see it. Omitted/empty = available to everyone (the default, unchanged behavior). Entries are matched by `userMatchesAny` (src/server/shared/user-mappings.ts) through the same identity table as commit attribution, so `"Grant"` matches a run user of `grant` / `9ranty` / `grant@tella.com` / their Slack id. Example: `brex` is scoped to Michiel + Grant.

- Enforcement is at the runner layer, not the prompt: `filterMcpServers(allowlist, user)` (claude-runner.ts) and `buildCodexMcpConfig(allowlist, disabled, user)` (codex-runner.ts) drop a restricted server the run's user isn't cleared for, and strip the `allowedUsers` field before the config reaches the SDK. Both allowlist (per-automation least-privilege) and the per-user gate apply.
- The `user` is threaded from the interactive run paths (`runSessionPrompt`, both `create_session` paths, goal wakes) through `runAgent` → `runClaude`/`runCodex`, and is journaled on the `ActiveRunRecord` so a resume after a restart keeps the same visibility. **Automation runs pass no user**, so a `allowedUsers`-restricted server is invisible to them — untrusted ticket text can never reach `brex`, even if the automation's own `mcpServers` allowlist names it (fail-closed).
- Manage it from the Connections UI (the Add-MCP form has an "Allowed users" field; each server card has a Restrict/Edit-access button → `PUT /api/connections/mcp/:name` with `{allowedUsers}`), or via michael-admin (`add_mcp_server`'s `allowedUsers`, and `set_mcp_allowed_users` to change it on an existing server). Backing helpers: `addMcpServer` / `setMcpAllowedUsers` in src/server/connections.ts.
- **A change to the runner-layer filtering needs a real `systemctl restart`** (runner internals don't hot-reload — see "Hot reload & restarts"). Adding/removing/re-scoping a server in `mcp-config.json` itself is read fresh per run, but until the process runs the new `filterMcpServers`, `allowedUsers` is neither enforced nor stripped — so restart after wiring a restricted server.

## Self-management tools (Slack + interactive Backstage sessions)

The `michael-admin` in-process MCP server (src/agents/slack/admin-tools.ts) lets Michael manage his own setup from Slack: channel memory (remember/list_memory/forget) and — gated to the trusted user (`isAdmin` = no `ALLOWED_SLACK_USER_ID` set, or sender matches it) — automations (list/create/update/delete/run) and MCP connections (list/add/remove). It is wired ONLY into interactive Slack runs (handlers.ts `processMessage`); automation runs never go through there, so they never receive these tools. Do not add `michael-admin` to automation/`runAgent` paths — that would let untrusted ticket text reconfigure Michael. Channel memory is scoped in src/agents/slack/memory.ts (public channel → shared `workspace` store; private channel/DM → isolated, with read-only workspace view) and auto-injected into the system prompt each run.

Both `michael-admin` and `michael-sessions` are ALSO available inside **interactive Backstage sessions** (web UI + loops), not just Slack: backstage.ts's `interactiveMcpServers(user, sessionId)` builds them and passes them as `inProcessMcp` from the interactive run paths (`runSessionPrompt`, both `create_session` paths). They're withheld from automation runs **and** from interactive resumes of automation-owned sessions (gated on `!isAutomationSession`, the same gate as `deniedTools`) — untrusted ticket text must never reach these tools. Backstage is Tailscale- and team-gated and already exposes all of this through its UI, so interactive users are treated as `isAdmin: true` there. Claude receives these servers directly through the SDK; Codex receives stdio MCP proxy configs that forward to the same in-process tools through Backstage's run-RPC socket. Both runners add short "Managing Michael" context when these tools are present so the session knows they exist.

The `michael-sessions` in-process MCP (src/agents/slack/sessions-tools.ts) is a sibling, wired the same way (interactive runs only — Slack and Backstage sessions per above — never automations). It lets Michael see and steer every *other* Backstage session: read tools `list_sessions` (with a `waiting` filter for sessions blocked on an AskUserQuestion) and `get_session` (state + pending question + transcript tail) are open to any whitelisted user; the control tools — `answer_session_question` (resolves a paused question), `send_to_session` (steer/queue/start a turn), `cancel_session`, `create_session` — are gated to the trusted user via `isAdmin`. The tools don't touch in-process state directly; they go through the `SessionControl` registry (src/server/session-control.ts) that backstage.ts populates at startup with the same helpers (`runSessionPromptAndDrain`, `steerAgentRun`, `makeAskHandler`, the `pendingAsks`/`promptQueues` maps) the WebSocket handlers use — so steering from here behaves exactly like a human in the web UI, and a future autonomous monitor (src/agents/loops) can call the same registry directly without the MCP. Sessions whose runs aren't owned by this process (CLI/tmux) are surfaced as `observe-only` and can't be steered/cancelled. Do NOT wire `michael-sessions` into automation/`runAgent` paths — cross-session control from untrusted ticket text would be a privilege-escalation path.

## Model routing and delegation

Interactive Claude/Fable sessions should act as orchestrators, not as the only
worker. Use the Backstage `michael-sessions` MCP tools to spin up focused worker
sessions when that saves scarce premium-model tokens or reduces context noise.

Model defaults:
- `gpt-5.5` / `codex` (Codex backend): bulk and mechanical work. Use for
  clear-spec implementation, broad read-only codebase analysis, migrations,
  test-log analysis, data crunching, and computer-use-like chores. It is cheap
  enough in practice that cost should rarely block use.
- `claude-sonnet-5`: focused Claude worker for subsystem tracing or a second
  implementation pass when Codex output is not good enough.
- `claude-opus-4-8`: strong reviewer / design critic when taste or judgment
  matters and Fable capacity should be saved.
- `claude-fable-5`: orchestration, ambiguous planning, final judgment,
  high-taste review, UI/UX, copy, API design, and deciding what ships.

How to delegate from a Fable/Claude Backstage session:
- Use `michael-sessions.create_session` with `model: "gpt-5.5"` or
  `model: "codex"` for Codex workers.
- For workers that only need filesystem/code access, pass `mcpServers: []` so
  unrelated external MCP startup does not slow or block them.
- Set `repo` to the registered repo id the worker should inspect or edit, such
  as `backstage` or `tella-fusion`.
- Use `mode: "ask"` for read-only investigation on the main checkout.
- Use `mode: "code"` plus a branch name for implementation work that can edit
  files or open a PR.
- Give worker sessions self-contained prompts: scope, repo/worktree path,
  relevant files, constraints, acceptance criteria, and exactly what to report
  back. Ask for summarized findings and file references, not raw dumps.
- Keep the final call in the orchestrator session. Inspect the worker's
  summary, diff, tests, and assumptions; rerun, steer, or escalate to a smarter
  model if the result misses the bar.

Codex transport: codex runs go through the exec SDK by default, or the
`codex app-server` JSON-RPC transport (src/server/codex-appserver.ts) when
`~/.backstage-codex-transport.json` is `{"transport": "app-server"}` (or
MICHAEL_CODEX_TRANSPORT=app-server). Both transports share the same threads/
rollouts, so the toggle is safe mid-session. App-server adds mid-turn steering
(`turn/steer`) and Esc-interrupt (`turn/interrupt`) — with it, busy sends to
Codex sessions steer/interrupt like Claude ones instead of queueing. All codex
entry points (interactive, Slack, Linear) route through `runCodexAuto`.
Transport code is runner internals — changes need a real restart.

Priority rule for shipped work: intelligence > taste > cost. Cost is only a
tie-breaker. Do not ship mediocre output just because it was cheaper to produce.

## Multi-repo sessions

A session is no longer single-repo. Beyond its primary `project`/`worktreeDir`/`branch`, it can **attach** secondary repos (`attachedRepos: {project,branch,dir}[]` on the session file + `UnifiedSession`). The registered repos live in `PROJECTS` (`src/server/worktree.ts`): tella-fusion, backstage (sharedCheckout), gitops, infra, shared-infra, gstreamer, gst-plugins-rs — each with a `defaultBranch` and `ghRepo` (`owner/name` for the gh CLI). All but backstage use the normal worktree+PR flow.

- **Attaching** creates (or reuses) an *isolated* worktree via `prepareAttachedWorktree` (never another repo's shared main checkout — that's the "parked on a random branch / collisions" trap). Default branch = the session's primary branch, so cross-repo PRs line up. Two entry points, both hitting `POST /api/sessions/:id/attach-repo` → `attachRepo()` in backstage.ts: the `michael-repos` in-process MCP server (`attach_repo`/`list_repos`, src/agents/slack/repos-tools.ts — wired in `interactiveMcpServers` exactly like the other sibling servers, interactive runs only, never automations) and the `RepoBar` UI in the session viewer. Detach via `POST /api/sessions/:id/detach-repo` (POST, not DELETE — a DELETE on `/sessions/:id/...` is swallowed by the generic session-delete route).
- **Agent awareness**: `runSessionPrompt` passes `reposNote` (built by `buildReposNote`) through `runAgent`; Claude gets it in the appended system prompt, and Codex gets it via the `developer_instructions` config key (codex ≥0.139's system-prompt channel — see codex-runner.ts). It lists primary + attached repos with their worktree paths so the agent cd's into the right isolated checkout. Only present when the session has attached repos.
- **@-mentions** (`GET /api/files`) search the primary worktree + every attached repo; cross-repo hits insert as `@<project>:path` (primary stays a bare path) and carry a repo label.
- **Diff** (`GET /api/sessions/:id/diff`) returns `{ repos: [{project,dir,primary,diff}] }` — one `getSessionDiff(dir, project.defaultBranch)` per repo. `DiffPanel` shows a repo switcher when >1 repo changed.
- **PR** routes accept `?repo=<project>`; `resolvePrTarget` maps it to the right `ghRepo`+branch (primary branch, or an attached repo's branch). `pr-info.ts` functions take a `repo` arg (caches keyed by repo+branch). `PrPanel` shows a repo switcher when a session spans repos. The Reviews list table still only surfaces the *primary* repo's PR columns — attached-repo PRs live inside the session's PR tab.
