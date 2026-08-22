Default to Bun instead of Node.js.

Keep instance-private operator instructions in an untracked `AGENTS.local.md` or
`CLAUDE.local.md`, never in this file.

## Public repositories

Never publish to a public or third-party repository without explicit user
confirmation in the current conversation. Local investigation and commits are
allowed; issues, comments, branches, forks, pushes, and pull requests are not.

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

## Shared checkout workflow

This repository runs its live server from the shared `main` checkout. Other
sessions may edit and stage files at the same time.

- Never reset, revert, switch branches, or discard unrelated work.
- Stage only your files. Use `git add -p` for shared high-traffic files.
- Inspect `git diff --cached --name-only` and `git diff --cached` before every
  commit. Commit with a pathspec when the index contains other work.
- Commit and push promptly. Never use `git add -A`.
- Backend changes require a deliberate `systemctl restart opensession` after
  commit and push. Frontend changes rebuild without a restart.

For risky isolated work, use `OPENSESSION_DEV=1` with a dedicated
`OPENSESSION_STATE_DIR`. See `docs/self-development.md`.

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

## Multi-repo sessions

Attached repositories use isolated worktrees. Never attach another repository's
shared main checkout. Preserve repo-qualified file mentions, per-repo diffs, and
per-repo PR targeting when changing session repository behavior.
