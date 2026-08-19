Default to using Bun instead of Node.js.

Instance-private operator instructions (deployment hostnames, org access
grants, incident history) belong in an untracked `AGENTS.local.md` or
`CLAUDE.local.md` next to this file — the runner appends it to every engine
run (`readLocalInstructions` in packages/core/opensession-server/src/server/opencode-runner.ts), and Claude
Code auto-loads `CLAUDE.local.md`. Keep anything you wouldn't publish there,
never here.

## Public repositories require confirmation

NEVER publish changes to an open-source or public repository without explicit
user confirmation in the current conversation. A request to investigate,
implement, or prepare a change is not permission to publish it. This covers
every kind of write — issues and comments included, not just forks/branches/PRs.
Local edits and commits are allowed, but before writing anything to a
public/open-source repository, stop and ask the user. This rule overrides
bias-to-action and generic commit/push/PR defaults; automatic PR creation
applies only to your registered first-party repositories.

Enforce this with credential scope, not just prompts — see
docs/security-model.md for the token setup that makes any out-of-org GitHub
write fail server-side. The rule itself is injected into every engine run via
`buildRunInstructions` (run-instructions.ts).

## Data handling — never upload to public hosts

NEVER upload files or data to public file-sharing hosts or pastebins — no
exceptions, no matter how delivery of a file is failing. Anything uploaded
there is public and unrecoverable, and session files routinely contain
customer data. Deliver files only through channels you control: Slack file
upload, the session UI, email via your own tooling, or a commit/PR in a
private repo. If every controlled channel fails, stop and report the failure
instead of escalating to a third-party host. The same rule is injected into
every engine run via `buildRunInstructions` (run-instructions.ts).

## The five client apps — resolve which one BEFORE working

OS1 has five user-facing clients in this repo, and requests about "the app"
are ambiguous between them:

- **Web UI** — `packages/core/opensession-server/src/frontend/` (React, served by the Bun server; also what the
  iOS PWA and the Electron shell display).
- **Electron desktop shell** — `packages/clients/mac/` (bundle id `dev.tella.os1.shell`;
  wraps the web UI).
- **Native Swift app** — `packages/clients/ios/` (one SwiftUI codebase, iOS + macOS targets,
  bundle id `dev.tella.os1`). Read `packages/clients/ios/AGENTS.md` before touching it —
  build/verify workflow, release trigger, and performance invariants live there.
  Screenshots are one command: `bun scripts/capture-ios.ts <out.png>`.
- **Chrome extension** — `packages/clients/chrome/` (MV3 side panel; captures page context —
  screenshot, element pick with React fiber info — and starts sessions via the
  REST surface with Bearer auth; loaded unpacked, never the Web Store; see
  `packages/clients/chrome/README.md`).

Conversation scoping rule: once a conversation is about a specific app, every
following message is about THAT app unless the user says otherwise — don't
drift back to the web UI because it's the default surface (e.g. after an iOS
bug report, "also fix X" means fix X in the native app). If it's genuinely
unclear which app a request targets, ask first instead of guessing; a fix
landed in the wrong app wastes a round-trip and can mask the real bug.

Cross-client check — do this for every new feature or user-visible update, not
only when the request names a client. Before calling the work done, ask what
the change means for the **native app** (`packages/clients/ios/`) in particular: it is the
client most often left behind, because it re-implements what the web UI gets
for free (transcript rendering, attribution, presence, prefs, image URL
resolution) rather than sharing code. Concretely:

- A **server/protocol change** (new WS message or field, new REST route or
  query param, changed entry shape, a new notice kind) — the Swift `Codable`
  models and socket handling are a hand-written copy of the wire shapes, so
  they do not follow automatically. Same for `packages/clients/chrome/`.
- A **new per-user pref, setting, or account-level toggle** — decide whether
  the native app should read and write it too, or deliberately ignore it.
- A **transcript or session-viewer change** — the native app renders its own
  transcript; a web-only fix leaves iOS looking wrong.
- A **web-only design token or color change** — do not copy the hex across:
  the native canvas differs, so port the *step* against the iOS surface.

If the native app needs a matching change, either make it in the same session
or say explicitly, in your final report, what is still web-only and why. "The
web works" is not done for a feature that spans clients. Server work that no
client surfaces (internal refactors, automation plumbing) needs no such note.

## Server architecture map

`opensession.ts` is a thin entry (~900 lines): env, `hotServe` (reuse the live
server across hot reloads), the `Bun.serve` composition (SPA routes map + fetch
preamble → route dispatch → WS-upgrade/SPA-fallback/404 tail), `loadAgents`,
the `__opensessionBooted` boot block, and graceful shutdown. Everything else
lives in focused modules — work in the module that owns your feature, not the
entry file (that's what keeps parallel sessions from colliding):

- `packages/core/opensession-server/src/server/routes/` — every HTTP route, one file per domain (sessions, pr,
  plain, workspace, models, …). Handlers get a `RouteContext` and return a
  `Response` or `undefined` to fall through; `routes/index.ts` is the ordered
  chain. Order only matters *within* a path family — keep a family (e.g.
  `/todos/search` before `/todos/:id`) in one module. New endpoint → add it to
  the matching domain file (or a new file + one line in index.ts).
- `packages/core/opensession-server/src/server/ws-handlers.ts` — the UI WebSocket (watch/prompt/queue control/
  answers/terminals + create_session).
- `packages/core/opensession-server/src/server/run-session.ts` — driving a session turn: runSessionPrompt(Inner),
  queue delivery (enqueue/steer/interrupt/drain), sandbox launch, restart
  resume, /loop ticker. This is runner-adjacent: changes need a real restart.
- State modules (all park live state on `globalThis` under the same keys so
  hot reloads keep it): `ws-hub.ts` (clients/presence/broadcasts),
  `queue-state.ts` (prompt queues + steer receipts), `asks.ts` (pending
  AskUserQuestion + Slack escalation), `session-cache.ts` (2s session cache —
  call `invalidateSessionsCache()`, never poke the cache), `agents-registry.ts`.
- `session-repos.ts` (repo notes/attach/switch), `interactive-mcp.ts`
  (interactive opensession-* MCP builders; side-effect registers the run-rpc
  builder), `session-control-wiring.ts` (opensession-sessions MCP surface),
  `slash-commands.ts`, `goal-runner.ts` (goal wakes + ticker),
  `frontend-build.ts` (in-process SPA rebuild), `uploads.ts`,
  `session-sandbox.ts`.

**Nothing under `packages/core/opensession-server/src/server/` may bind a socket, arm a ticker or spawn a
process at module scope.** Importing a module must stay free of live effects,
because half the graph is reachable from any script, test or `bun -e`: when
interactive-mcp.ts bound the run-rpc socket at import, every such process
unlinked the live server's socket and killed in-flight runs' MCP calls until
the heal ticker noticed. Quieter versions of the same shape wrote the live
search index from `bun test`, docker-rm'd the warm preview pool, rotated live
GitHub grants from every run host, and hung scripts that only wanted to read a
function. Registering a builder or a listener in memory is fine and stays at
module scope; anything that acquires a resource goes behind an exported
`start*`/`ensure*` function that opensession.ts calls (the boot block for
tickers, the listener block near the top for binds), or is armed lazily on
first real use (`ensureOpencodeIdleSweep`). Make every one idempotent — a
`bun --hot` reload re-evaluates the entry. `bun scripts/check-module-side-effects.ts`
imports every server module in an instrumented child process and fails on any
resource created at import time; it runs as part of `bun test`.

## Open Session dev workflow (self-hosting — read this first)

Basics:

- `bun run packages/core/opensession-server/opensession.ts` starts the server; it binds 127.0.0.1:3850 (not
  publicly accessible — front it however you like: reverse proxy, VPN/tailnet,
  SSH tunnel).
- Bun automatically loads .env, so don't use dotenv.
- HTML imports for frontend bundling (no Vite).
- Naming: OPENSESSION_* env vars, `~/.opensession-*` state. URLs are
  prefix-less: the app serves at the bare domain root. The product model —
  Projects > Workspaces > Sessions — is in CONCEPTS.md; use those words.
- Own session store at ~/.opensession-sessions/. All other engines' session file
  access is read-only (never modify ~/.slack-sessions/ or ~/.linear-sessions/)
  — sole exception: `packages/core/opensession-server/src/server/agent-session-sync.ts` (see that module's doc
  before widening it).
- Audit log: every agent run emits structured JSON events to
  ~/.opensession-audit/audit-YYYY-MM-DD.jsonl via packages/core/opensession-server/src/server/audit.ts — see
  deploy/README-audit.md for the event catalog and CloudWatch shipping.
- Internal notes and draft customer replies (Plain, Linear agents) are always
  written in English regardless of the customer's language — note the
  customer's language so the team can translate before sending.

Open Session runs itself from its main checkout. Code sessions on this repo do
**not** get their own worktree (`sharedCheckout` in `packages/core/opensession-server/src/server/worktree.ts`);
they all work in this one shared checkout on the default branch. That's
intentional wild-west iteration. The rules that keep it from descending into
chaos:

- **Only `add` → `commit` → `push`. Never `git reset --hard`, `git checkout .`,
  `git revert`, or `git checkout <other-branch>` in the shared checkout.** A
  reset or branch-switch yanks the working tree out from under the live server
  *and* every other session. If something looks wrong, inspect and fix
  forward; don't roll back the shared tree.
- **`git add <specific files>`, not `git add -A`** — multiple sessions may
  have uncommitted edits in this tree; only commit your own. High-traffic
  files (`legacy.css`, `opensession.ts`, `App.tsx`) are sweep magnets: even a
  specific `git add` on one of them can pick up another session's uncommitted
  hunks. For those files use `git add -p` to stage only your hunks, and check
  `git diff --cached` before committing.
- **Scope the *commit*, not just the `add`.** The index is shared too: another
  session's `git add` may already be staged before you touch anything. Always
  check `git diff --cached --name-only` first — if it lists anything that
  isn't yours, commit with a pathspec (`git commit -- <your files>`). Never
  `git reset`/`git restore --staged` to "clean up" first — that silently
  unstages what another session staged deliberately. When a file has foreign
  staged entries *and* foreign edits inside your own files, build the commit
  through a private index: `GIT_INDEX_FILE=/tmp/my.index git read-tree HEAD` →
  `git apply --cached your.patch` → `git write-tree` → `git commit-tree` →
  `git update-ref refs/heads/main <new> <old>` (the three-argument form is a
  compare-and-swap that fails instead of clobbering).
- **After a private-index commit, resync the shared index to HEAD for the
  paths you committed.** `update-ref` moves the branch without touching the
  shared index, so every path you just committed is left staged at its
  *pre-commit* content. `git status` then shows dozens of files as modified
  when the worktree already matches HEAD, and the next plain `git commit` in
  this checkout silently REVERTS them. Walk your own paths only — never the
  whole index, which would unstage other sessions' deliberate work:

  ```sh
  for f in $(git diff --name-only HEAD~1 HEAD); do
    if git cat-file -e "HEAD:$f" 2>/dev/null; then
      git update-index --add --cacheinfo \
        "$(git ls-tree HEAD -- "$f" | awk '{print $1}'),$(git rev-parse "HEAD:$f"),$f"
    else
      git update-index --force-remove "$f"
    fi
  done
  ```

  Reading `git status` here: a path listed as modified whose
  `git diff HEAD -- <path>` is empty is a stale index entry, not open work —
  resync it. Real open work shows up in `git diff HEAD --name-only`.
- **Commit + push frequently.** Un-pushed work is the only thing a sync can't
  protect (the deploy is `merge --ff-only`, never `reset --hard`, so it aborts
  loudly instead of wiping — but push anyway).
- **Backend edits need a deliberate `systemctl restart opensession`.** Commit
  and push first, then restart and verify health. Restarts are graceful and
  detached engine turns reattach, but they still churn active sessions, so do
  this once after the backend change rather than after every save. Frontend
  changes never need it: the in-process watcher rebuilds the bundle live.
- Want isolation for a risky/breaking change? Boot a real dev instance:
  `OPENSESSION_DEV=1` gates the FULL dev mode — no agent loops, webhook
  server, schedulers, automation seeding, detached-server adoption, or prewarm
  — and it refuses to boot without `OPENSESSION_STATE_DIR` (or a chats-dir
  override), so it can never touch live state or steal the run-rpc socket. Add
  `OPENSESSION_DEMO=1` for synthetic demo data. The repo's
  `.agents/start.sh` wires all of this for the session Preview button;
  see docs/self-development.md.

## Frontend UI system (Base UI + Tailwind + Motion)

New UI goes through this stack. There are two hand-written stylesheets, and
only one of them has anything in it:

- `styles/base.css` — the foundation, and it stays. Tokens, the hand-rolled
  preflight (Tailwind's own is deliberately not imported), the scroll model
  and selection policy, Electron/WCO/PWA chrome, reduced-motion and `@supports`
  fallbacks, plus the keyframes and `@property` registrations that have no
  element to hang a utility on. "Move everything to Tailwind" never meant
  deleting these; Tailwind v4 keeps tokens and base rules in CSS.
- `styles/legacy.css` — **empty.** It held the app's component styling before
  the Tailwind system landed; the migration finished, and the file is kept at
  zero rules, still imported, so the contract has a home and `css-audit` has a
  target. Nothing goes back in. Component styling is utilities on the markup or
  a primitive in `ui/`; a genuinely global rule goes to base.css.

Two things the migration learned, which still decide where a rule can live:

- Utilities only win source-order *ties*. The compiled sheet is linked after
  both hand-written ones, so a single class in base.css loses to a utility on
  the same element — but a compound selector (`.sidebar-item.is-selected
  .count`) still outranks one. If you put a rule in base.css, expect any
  utility on that element to beat it, and check rather than assume.
- A class name on the markup is not evidence that its rule does anything, and
  a rule that matches nothing on the page you are looking at is not evidence
  that it is dead. Both directions have to be measured — see the tooling below.

Tooling: `bun scripts/css-audit.ts` is now a guard rather than a worklist — it
reports `classes defined: 0` against legacy.css, so treat a non-zero count as
someone having put component styling back in a stylesheet, not as a backlog.
`bun scripts/css-shots.ts <name>` captures the routes × viewport × theme
screenshot gate; `--diff` compares two runs. For a finished one-off visual,
use `bun scripts/capture-ui.ts /tmp/name.png --route /path`: desktop captures
keep a 1440x900 CSS viewport but rasterize at Retina DPR 2 and emulate the Mac
Electron material/titlebar; phone captures use DPR 3 without desktop chrome.
Do not hand-roll a DPR 1 CDP screenshot for visual review — it makes borders,
shadows, and type look harsher than the shipped app. The CSS measurement tools start
and clean up their own private, resource-bounded headful Chrome+Xvfb service;
never launch or share a raw Chrome CDP service for them. Set `CDP_PORT` only
when deliberately using an externally managed browser. For CDP work none of
those scripts covers, `bun scripts/cdp-browser.ts start` acquires the same
bounded browser: stop the systemd unit it returns in a `finally`/trap.

`bun scripts/css-rulekill.ts --targets <file> --route <path> --control
'<selector>'` answers the question the audit can't: not "is this class name
still written anywhere" but "does this rule still change anything". It deletes
the rules from the LIVE stylesheet, re-renders, diffs every element's computed
longhands, and puts them back at their original index. That is what finds the
"live name, dead body" case — a rule whose class survives only as a hook while
every declaration now loses to a utility on the same element. Deleting the
whole candidate set at once answers forty rules in one measurement; `--each`
bisects. Two of its guards are the point: `--control` must name a rule that IS
live and must report a difference, or the run aborts (a broken probe and a dead
rule both report "no change"); and it prints how many elements each target
MATCHES, because a rule measured on a page it never matches scores 0 for the
wrong reason — `--add` / `--click` / `--hover` / `--remove` put the page into
the state the rule is about.

`bun scripts/css-ab.ts <label> --root '<selector>'` is the measurement half of
that gate: it records every computed longhand (plus `::before`/`::after`, and
the `corner-*-shape` properties, which are not enumerable and are exactly where
a lost squircle hides) for a whole subtree across viewport × theme, and
`--diff` reports what moved. Capture the same label twice first — that noise
floor should be 0, and if it isn't you are measuring the app's live data rather
than your change. A screenshot says a surface still looks right; this says
nothing resolved differently, which is what a migration actually promises.

These local browser tools authenticate as the dedicated `Automation` machine
identity (`kind: "automation"` in the 0600 web-session store), never by taking
a teammate's session token. Hosted loopback traffic rejects human sessions at
the server boundary and never contributes presence.

- **Tokens**: `packages/core/opensession-server/src/frontend/styles/tailwind.css` maps the existing `base.css`
  variables (`--bg`, `--text-dim`, …) into Tailwind's namespace via
  `@theme inline` — use `bg-panel text-dim border-line text-fg bg-surface` etc.,
  never raw hex or stock Tailwind grays. Dark/light theming comes for free
  because the vars re-resolve under `html[data-theme]`. The spacing/radius/text
  scales are px-anchored there (base.css sets `html { font-size: 14px }`,
  which would otherwise shrink every rem-based utility to 87.5%) — so `p-3` is
  a true 12px and `text-xs` a true 12px. Bare `rounded` bypasses the radius
  scale; use `rounded-sm/md/lg` (4/6/8px).
- **Compile**: Tailwind is compiled by an `@tailwindcss/cli` subprocess inside
  `buildFrontend()` (packages/core/opensession-server/src/server/frontend-build.ts) and linked *after*
  base.css + legacy.css; utilities are imported unlayered so they win
  source-order ties against legacy rules. Preflight is intentionally NOT
  imported (base.css assumes browser defaults). Don't import tailwind.css from App.tsx — Bun
  can't compile it.
- **Primitives**: wrap Base UI (`@base-ui/react`) per component in
  `packages/core/opensession-server/src/frontend/ui/` (see `ui/tooltip.tsx` for the pattern). Rules: always
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

Design/motion skills can be installed instance-locally under `.agents/skills/`
(gitignored — see docs/extending.md for the skill format). If your instance
has them, read the smallest relevant set before frontend design or motion
work.

## Writing UI copy

Every string a user reads is UI copy: titles, descriptions, hints, buttons,
empty states, errors, tooltips. It is designed, not narrated, and the default
failure here is length. A paragraph that explains the feature correctly still
fails if nobody reads it.

Follow Apple's Human Interface Guidelines. The rules that decide most cases:

- **Say the one thing.** A description earns one sentence. If a second sentence
  is doing real work, keep it; if it is restating the first with more nuance,
  cut it. Prefer "Review open pull requests one at a time." to a sentence that
  also explains why lists are bad.
- **Lead with what it does for the reader**, not how it is built. "A shared
  task list agents can add to" beats "A per-user todo store with reminder
  scheduling, Slack delivery, and agent read/write through the
  opensession-todos tools." Implementation detail belongs in the module doc.
- **Buttons are verbs, one or two words.** Add, Use, Set up, Connect, Retry.
  Not "Start from this template".
- **Sentence case** for everything except product names. Not Title Case.
- **Write to the person**, as "you". Avoid "the user", and avoid the passive.
- **Do not sell.** No "powerful", "seamless", "simply", "just".
- **Explain a limit plainly, once.** If a switch does less than it looks like
  it does, say so in a clause a person can act on, and do not add a roadmap
  note about what will fix it later.
- **Never use an em dash.** Not in copy, not in docs, not in a commit message,
  not in a reply to the human. It is almost always hiding a second sentence, a
  colon, or a comma, and the rewrite is clearer every time. Use a period and a
  second sentence, a colon when a list or a definition follows, a comma for an
  aside, and the middle dot `·` for a label and its qualifier
  ("Ask · read-only on main"). For an empty value in a table use `–`.
  Existing em dashes in comments and module docs are being retired as their
  lines are touched, so do not add new ones there either.
- **Terminology comes from CONCEPTS.md.** Project, workspace, session, turn,
  worktree, automation, goal. Do not invent a synonym in one panel.

Read the rendered result at the real width before calling it done, not the
string in the file. Copy that wraps to four lines under a card is too long
whatever it says.

## Frontend rebuilds & restarts

The systemd service runs `bun run packages/core/opensession-server/opensession.ts`, intentionally without
`--hot`: a Bun backend hot reload can permanently kill all timers while HTTP
keeps serving, leaving sessions stuck until a restart. The in-process frontend
watcher still rebuilds and broadcasts frontend changes. Every backend change —
routes, WebSocket handlers, agent loops, runner internals — needs one
deliberate `systemctl restart opensession` after the change is committed and
pushed.

Restarts are graceful and do not kill in-flight engine turns: `opencode serve`
processes are detached into transient systemd user scopes outside the unit's
cgroup (`packages/core/opensession-server/src/server/opencode-detach.ts`), survive the restart, and are
re-adopted on boot with journaled runs reattached to their live turns
(`tryReattachOpencodeRun`; the continuation re-prompt is the fallback for dead
servers). Kill switch: `OPENSESSION_OC_DETACH=0`. Full mechanics live in the
module docs of opencode-detach.ts and opencode-runner.ts. Ops invariants: the
unit's `TimeoutStopSec` must stay above `SHUTDOWN_DRAIN_MS` (60s default),
`KillMode=mixed` is required, and the deployed
`/etc/systemd/system/opensession.service` is a **copy** of the repo
`opensession.service`, not a symlink — sync with `sudo cp` +
`systemctl daemon-reload`.

## Security model — invariants (full detail in docs/security-model.md)

Automation runs (Plain ticket triage, channel watches, scheduled jobs) process
untrusted text: event/ticket content is data the agent reads, never
configuration for the run. Constraints are enforced at the tool/env layer, not
just in prompts. Every change must preserve these invariants:

- Automation subprocesses get a minimal env — no tokens from the server's env
  file. MCP servers receive their own credentials via mcp-config.json.
- Each automation has an optional `mcpServers` allowlist; runs only see those
  servers. When adding an automation, scope it: ask mode unless it must write,
  and name only the MCP servers it uses.
- Customer-facing and identity-mutating tools are hard-denied for automation
  runs *and* interactive resumes of automation-owned sessions, by STRIPPING
  them from the model's tool list (`opencodeRunPolicy` in opencode-runner.ts).
  Money-moving tools (`STRIPE_CONFIRM_TOOLS` in runner-shared.ts) are stripped
  from every run; reads keep working on a server-side-restricted key.
- The run gate (`opencodeGateReason`) is deny-by-default on journal kind.
- `mode` is per-automation: "ask" runs read-only on the main checkout; "code"
  gets an isolated worktree with Write/Edit and can open PRs — never merge,
  PRs are the human gate. Code mode keeps every other scoping. Give every code
  automation a `prReviewer` (GitHub login, `org/team` slug, or list) — it is
  requested as reviewer on the PRs it opens, and without one the gate is an
  unread backlog (docs/setup/github.md#getting-automation-prs-reviewed).
- An MCP server can carry `allowedUsers`; enforcement is at the runner layer
  (`filterMcpServers` in runner-shared.ts), matched through the identity
  table. Automation runs pass no user, so restricted servers are invisible to
  them — fail-closed.
- Per-user GitHub tokens (opt-in `integrations.github`, see the doc) ride
  interactive runs only; unattended/least-privilege runs keep the bot
  credential — fail-closed. When web sign-in is active, the verified identity
  overrides client-claimed `user` on every WS message.
- The in-process self-management servers — `opensession-admin` (automations +
  MCP connections + channel memory), `opensession-sessions` (see/steer other
  sessions), `opensession-repos` — are wired into INTERACTIVE runs only
  (`interactiveMcpServers` in packages/core/opensession-server/src/server/interactive-mcp.ts), never
  automations, never interactive resumes of automation-owned sessions. Do NOT
  add them to automation/`runAgent` paths — that would let untrusted text
  reconfigure the agent or escalate across sessions. The two deliberate,
  tightly-scoped exceptions (append-only papercuts; human-set
  `automation.selfImprove`) are documented in docs/security-model.md — hold
  anything new to the same bar: append-only, nothing sensitive readable, no
  control surface.
- Changes to runner-layer enforcement need a real `systemctl restart`.

## Model routing and delegation

Interactive sessions should act as orchestrators, not as the only worker. Use
the `opensession-sessions` MCP tools to spin up focused worker sessions when
that reduces context noise or parallelizes work.

Pick the model that fits each task — intelligence and taste come first, cost
isn't a reason to downgrade. All models run on the opencode engine (ids are
`opencode/<provider>/<model>`; bare native ids map onto that form at dispatch).

How to delegate from an Open Session session:
- Use `opensession-sessions.create_session`, setting `model` to whatever fits
  the worker's task.
- For workers that only need filesystem/code access, pass `mcpServers: []` so
  unrelated external MCP startup does not slow or block them.
- Set `repo` to the registered repo id the worker should inspect or edit
  (see "Multi-repo sessions").
- Use `mode: "ask"` for read-only investigation on the main checkout;
  `mode: "code"` plus a branch name for implementation work that can edit
  files or open a PR.
- Give worker sessions self-contained prompts: scope, repo/worktree path,
  relevant files, constraints, acceptance criteria, and exactly what to report
  back. Ask for summarized findings and file references, not raw dumps.
- Keep the final call in the orchestrator session. Inspect the worker's
  summary, diff, tests, and assumptions; rerun, steer, or escalate to a
  smarter model if the result misses the bar.

Engine notes: Pi is the default engine and supports mid-turn steering through
detached run hosts. OpenCode remains available explicitly and as a fallback;
it queues a busy steer for the next turn. Anthropic models use the configured
Anthropic account pool, and OpenAI models use the ChatGPT-OAuth account pool.
One-shot utility calls (titles, branch names, intent classifiers) go through
the tool-less Pi-backed `oneShot` helper (`packages/core/opensession-server/src/server/one-shot.ts`). Runner code
is runner internals. Changes need a real restart.

Eligible OpenCode interactive runs multiplex onto one shared always-warm
`opencode serve` per (bridge account × user). Pi sessions and automations run
in detached hosts, with automation MCP access proxied from the fail-closed
server-side set. Full contracts live in pi-runner.ts, host-client.ts, and
opencode-runner.ts ("Server
lifecycle"); adding a new in-process opensession-* server requires adding it
to SHARED_INPROCESS_SERVERS or its sessions silently fall back to per-session
servers.

Priority rule for shipped work: intelligence > taste > cost. Cost is only a
tie-breaker. Do not ship mediocre output just because it was cheaper to
produce.

## Multi-repo sessions

A session is not single-repo. Beyond its primary `project`/`worktreeDir`/
`branch`, it can **attach** secondary repos (`attachedRepos:
{project,branch,dir}[]` on the session file + `UnifiedSession`). The
registered repos live in `REPOS` (`packages/core/opensession-server/src/server/worktree.ts`), each with a
`defaultBranch` and `ghRepo` (`owner/name` for the gh CLI). All but the
self-hosted Open Session repo (`sharedCheckout`) use the normal worktree+PR
flow.

- **Attaching** creates (or reuses) an *isolated* worktree via
  `prepareAttachedWorktree` (never another repo's shared main checkout —
  that's the "parked on a random branch / collisions" trap). Default branch =
  the session's primary branch, so cross-repo PRs line up. Two entry points,
  both hitting `POST /api/sessions/:id/attach-repo` → `attachRepo()` in
  packages/core/opensession-server/src/server/session-repos.ts: the `opensession-repos` in-process MCP server
  (`attach_repo`/`list_repos`, interactive runs only, never automations) and
  the `RepoBar` UI in the session viewer. Detach via
  `POST /api/sessions/:id/detach-repo` (POST, not DELETE — a DELETE on
  `/sessions/:id/...` is swallowed by the generic session-delete route).
- **Agent awareness**: `runSessionPrompt` passes `reposNote` through
  `runAgent`; the opencode runner injects it via the per-session instructions
  file. It lists primary + attached repos with their worktree paths so the
  agent cd's into the right isolated checkout. Only present when the session
  has attached repos.
- **@-mentions** (`GET /api/files`) search the primary worktree + every
  attached repo; cross-repo hits insert as `@<project>:path` (primary stays a
  bare path) and carry a repo label.
- **Diff** (`GET /api/sessions/:id/diff`) returns
  `{ repos: [{project,dir,primary,diff}] }` — one `getSessionDiff` per repo.
  `DiffPanel` shows a repo switcher when >1 repo changed.
- **PR** routes accept `?repo=<project>`; `resolvePrTarget` maps it to the
  right `ghRepo`+branch. `pr-info.ts` functions take a `repo` arg (caches
  keyed by repo+branch). `PrPanel` shows a repo switcher when a session spans
  repos. The Reviews list table still only surfaces the *primary* repo's PR
  columns — attached-repo PRs live inside the session's PR tab.
