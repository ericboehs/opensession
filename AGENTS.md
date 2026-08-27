Default to Bun instead of Node.js.

Keep instance-private operator instructions in an untracked `AGENTS.local.md` or
`CLAUDE.local.md`, never in this file.

## Publishing to repositories

Repositories owned by your own organization are fair game, including public
ones: commit, push, and open issues, comments, and pull requests there as part
of normal work.

For any repository outside your organization, public or third-party, never
publish without explicit user confirmation in the current conversation. Local
investigation and commits are allowed; issues, comments, branches, forks,
pushes, and pull requests are not.

## Choose the client first

Open Session has five clients:

- Web UI: `packages/core/opensession-server/src/frontend/`
- Phone web/PWA: the same web bundle at phone width
- Electron shell: `packages/clients/mac/`
- Native Swift app: `packages/clients/ios/`
- Chrome extension: `packages/clients/chrome/`

Once a conversation names a client, keep working on that client unless the user
changes scope. Ask when the target is unclear. For web changes, build desktop
and phone together. For protocol, preference, or transcript changes, check the
native app and Chrome extension for matching wire models or behavior. Read the
nearest nested `AGENTS.md` before editing a client.

## Shared checkout and deployment workflow

Sessions edit the shared `main` checkout, but the live services run from an
immutable release worktree selected by `~/.opensession/deploy/current`. Other
sessions may edit and stage files in the shared checkout at the same time.
Uncommitted checkout edits never become live, including frontend edits.

- Never reset, revert, switch branches, or discard unrelated work.
- Stage only your files. Use `git add -p` for shared high-traffic files.
- Inspect `git diff --cached --name-only` and `git diff --cached` before every
  commit. Commit with a pathspec when the index contains other work.
- Commit and push promptly. Never use `git add -A`.
- Do not use an ad-hoc `systemctl restart`. It only restarts the already pinned
  release and can violate the gateway/kernel rollout order.
- After an approved live rollout, commit and push first, then deploy that exact
  commit. Use the standard (light) `deploy_self` flow for ordinary frontend,
  backend, protocol, and dependency changes. Despite its name, it restarts and
  health-checks the executor, session kernel, and gateway; “light” means it
  reuses installed root-owned artifacts.
- Use the full root deploy, `sudo deploy/deploy.sh <sha>`, instead when a change
  affects live deployment machinery or an artifact that script installs:
  `deploy/{deploy,self-deploy,release-checkout}.sh`, the three
  `opensession*.service` templates, credential installers, the fixed run-host
  helper/installer, or root-deploy-managed systemd units and drop-ins. The full
  deploy refreshes those privileged artifacts before switching the same
  immutable release. Other operator-managed artifacts, such as watchdog units
  and sandbox images, follow their own documented rollout. When unsure, inspect
  `deploy/deploy.sh` rather than assuming a restart applies the change.
- A docs-only change needs no live deploy. A frontend-only change does: its
  source watcher watches the pinned release, not the shared WIP checkout.

For risky isolated work, use `OPENSESSION_DEV=1` with a dedicated
`OPENSESSION_STATE_DIR`. See `docs/self-development.md` for the deployment
sequence and rollback behavior.

## Server invariants

`packages/core/opensession-server/opensession.ts` is composition and boot code.
Put HTTP handlers in `src/server/routes/`, WebSocket handling in
`src/server/ws-handlers.ts`, and run orchestration in `src/server/run-session.ts`.

Server modules must not bind sockets, start timers, or spawn processes at import
time. Put live effects behind idempotent `start*` or `ensure*` functions called
from boot. Run `bun scripts/check-module-side-effects.ts` when changing server
initialization.

## Frontend

Follow `packages/core/opensession-server/src/frontend/AGENTS.md`.

Use Base UI primitives from `frontend/ui/`, Tailwind utilities, and existing
semantic color tokens. Keep `styles/legacy.css` empty. Do not introduce raw
colors or one-off primitives. Check desktop and phone at shipped pixel density.
Use Motion presets from `ui/motion.ts`, preserve reduced-motion behavior, and
publish visual proof for user-visible changes.

Keep UI copy short, direct, sentence case, and consistent with `CONCEPTS.md`.
Do not use em dashes.

## Security

Treat automation inputs as untrusted data. Preserve these boundaries:

- Automation subprocesses receive a minimal environment and an explicit MCP
  allowlist.
- Customer-facing, identity-mutating, and money-moving tools stay unavailable
  where runner policy strips them.
- `opensession-admin`, `opensession-sessions`, and `opensession-repos` remain
  interactive-only unless a narrowly scoped exception is documented and
  enforced server-side.
- Run kinds and user-gated MCP access fail closed.

See `docs/security-model.md` before changing runner policy, credentials,
automations, or interactive MCP wiring.

## Waiting on background work

Do not block the conversation with `sleep` loops while waiting for reviews,
CI, builds, or worker sessions. Check the status once; if it is still pending,
do other useful work or end your reply. Worker reports and completed tasks wake
the session on their own.

## Multi-repo sessions

Attached repositories use isolated worktrees. Never attach another repository's
shared main checkout. Preserve repo-qualified file mentions, per-repo diffs, and
per-repo PR targeting when changing session repository behavior.
