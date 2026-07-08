# `backstage-runner` image

Prebaked container image for the **Docker sandbox provider** (see
`docs/sandboxes-plan.md` §3–§5, Phase 1). One container per session runs the
existing runner-host entry inside an isolated filesystem/env/network, with the
session's git worktree **bind-mounted at its identical host path**.

## What it contains

| Component | Purpose | Pin |
| --- | --- | --- |
| `bun` | runs the runner bundle + Bun `$` exec | `1.3.14` (host) |
| Node.js LTS | native-dep builds, tooling | `20.x` |
| `git`, `gh` | clone / status / diff / push / PR | apt latest |
| `ripgrep` | @-mention file search | apt |
| `python3`, `build-essential` | worktree `bun install` native deps | apt |
| Claude Code CLI | Claude Agent SDK spawns it as a child | `2.1.204` (host) |
| runner bundle | `/home/ubuntu/projects/tella-backstage` (`src/`, `backstage.ts`, `tsconfig.json`) + `node_modules` | from lockfile |
| vendored codex binary | `@openai/codex-linux-x64` (musl, ~223 MB) — Codex exec/app-server | via `bun.lock` |
| `@anthropic-ai/claude-agent-sdk` | Claude engine | via `bun.lock` |
| minimal `~/.claude/settings.json` | so `settingSources:["user"]` doesn't error | `{}` |

Runs as uid **1000** user `ubuntu` (matches the host uid) so bind-mounted
worktrees keep sane ownership. Default `CMD` is `sleep infinity` — the provider
starts the container long-lived and `docker exec`s runs into it; there's no
baked ENTRYPOINT.

## Why path parity matters

The runner config is hardcoded to host absolute paths:
`pathToClaudeCodeExecutable = /home/ubuntu/.local/bin/claude`, the runner bundle
at `/home/ubuntu/projects/tella-backstage`, and the session worktree
bind-mounted at its **same** host path. The image reproduces every one of those
absolute paths exactly. If any drifts, the in-container runner can't find the
CLI, the SDK, the codex binary, or the worktree. Do not "tidy" these paths.

## Build

```sh
deploy/sandbox/build.sh
```

Tags `backstage-runner:latest` and `backstage-runner:<git-sha>` from the repo
root context. Override the name with `IMAGE=... deploy/sandbox/build.sh`.

Version pins are `ARG`s in the Dockerfile (`BUN_VERSION`, `CLAUDE_VERSION`,
`NODE_MAJOR`) — override per build with `--build-arg` if needed.

## Runtime design (Phase 1 — DockerProvider)

`src/server/sandbox/docker.ts` runs one container per session
(`bks-sbx-<sessionId>`, labels `backstage.sandbox=1` +
`backstage.session=<id>`, `--init`, `--restart no`, `--cpus`/`--memory` from
`~/.backstage-sandbox.json`, defaults 4 / 8g). A run is the same runner-host
entry the systemd path uses (`src/runner-host/host.ts`), `docker exec -d`'d
into the container; its unix socket + spec/meta/journal/log live in a
bind-mounted per-session run dir (`~/.backstage-chats/sandbox-runs/<id>`), so
backstage drives it with the normal HostHandle machinery and can reattach
after a restart. Idle containers are `docker stop`ped after
`idleStopMinutes` (default 30) and restarted on the next turn.

Mounts (rationale in the docker.ts header):

| Mount | Mode | Why |
| --- | --- | --- |
| named vol → `~/.claude`, `~/.codex` | rw | engine session state survives; NEVER a volume at `/home/ubuntu` (would shadow the baked CLI + bundle) |
| session worktree at identical path | rw | diff/files/status/push/preview unchanged host-side |
| main checkout `.git` at identical path | rw | worktrees aren't self-contained (`rev-parse --git-common-dir`); accepted Phase 1 tradeoff |
| host `~/.claude/projects/<munged-cwd>` | rw | engine transcripts stay host-visible (viewer tail, resume continuity) |
| `~/.backstage-chats/backstage-rpc.sock` | rw | michael-* stdio proxies; goes stale across a backstage restart until the container restarts |
| `~/.ssh`, `~/.gitconfig`, `~/.config/gh` | ro | git push / PR parity — interactive-level ambient trust, same as host runs today; automations are refused in Phase 1 |
| `mcp-config.json`, `~/.backstage-claude-accounts.json` | ro | external MCP servers + in-container account-pool selection |
| `~/.backstage-audit` | rw | one audit jsonl stream for host + sandboxed runs |

Known Phase 1 caveats: external MCP servers now spawn inside the container
(host-only deps won't start); codex account homes aren't mounted (Claude
first); `aws: true` can't mint creds inside (IMDS blocked).

## Phase 2 — exec-routed surfaces, volume workspaces, preview ports

- **workspace-exec choke point** (`src/server/sandbox/workspace-exec.ts`):
  @-mention file search, the Changes diff/discard, and git status/pull/push
  take an optional exec from `workspaceExecFor(session, dir)` — host Bun `$`
  unless the session's sandbox is ACTIVE (materialized + config docker +
  kill-switch absent + container **running**; a stopped container is never
  started for a read). With bind mounts this is redundant by design — it's
  the seam volume workspaces and Phase 3 remote providers run through.
- **Volume workspaces** (`~/.backstage-sandbox.json` → `"workspace":
  "volume"`, default `"bind"`): new sandboxes whose canonical worktree path
  has no host dir get a per-session `<name>-ws` volume mounted at that path
  and cloned **inside** the container from the repo's origin (ro-mounted
  creds do the auth; a local-path origin is mounted ro — that's the verify
  suite's scratch case). No host worktree is created at all; the mode is
  sticky per sandbox (state file), and the session records
  `sandbox.workspace: "volume"`. **Contract: `destroy()` (session delete,
  archive sweep) deletes the workspace volume — un-pushed work is gone.
  Push your work.** While the container is idle-stopped, the read surfaces
  go quiet (empty diff/status) rather than waking it. Attached repos and
  sibling chats are rejected for volume-mode sessions.
- **Attached repos (bind mode)**: `attachedRepos[].dir` + each repo's common
  `.git` are now bind-mounted rw at identical paths; changing the attach set
  recreates the container on the next ensure (mounts are create-time).
- **Preview ports** (`"previewPorts": [3300, …]`): each listed container
  port is published to a random **loopback** host port at container create;
  `sandbox.ports()` reads the live map and preview.ts routes the same Caddy
  tailnet-HTTPS front at the published port. In-container dev-server start
  is gated behind `"devServerInSandbox": true` (default off — the image
  doesn't carry the tella-fusion dev toolchain yet); without it, preview
  start is a no-op and only status/ports/Caddy routing are active.
  **Latent collision:** sandbox and host previews both key the Caddy https
  port as webapp port + 6000, and the host port allocator (ss-based) can't
  see in-container listeners — the sandbox https-port range must be
  namespaced before enabling `devServerInSandbox` broadly.

## Host setup + verification

- `deploy/sandbox/setup-host.sh` — idempotently installs the DOCKER-USER
  iptables rule dropping container traffic to 169.254.169.254 (IMDS), the
  container mirror of the systemd `IPAddressDeny`. Not persisted across host
  reboots — re-run it after one.
- `deploy/sandbox/verify.ts` — manual end-to-end suite
  (`bun run deploy/sandbox/verify.ts`): ensure/reuse, in-container git
  commit through the mounts, claude CLI, RPC socket, IMDS block, a minimal
  real agent run via launchRun, stop/start/get/destroy. Uses only
  `sbxtest-*` scratch resources and a redirected run journal; safe next to
  the live server.

## When to rebuild

- **Claude CLI bump** on the host (`claude --version` changes) → bump
  `CLAUDE_VERSION`. The in-container CLI must match host session-resume behavior.
- **Codex SDK bump** (`@openai/codex-sdk` in `package.json`, which pulls a new
  vendored codex binary) → rebuild so the new binary is baked.
- **Lockfile change** (`bun.lock`) — any dependency add/upgrade, incl. the Claude
  Agent SDK → rebuild (the deps layer re-installs).
- **Bun bump** on the host → bump `BUN_VERSION` to keep parity.
- Source changes to `src/` / `backstage.ts` that the runner-host path uses →
  rebuild (fast: only the final COPY layers change). In particular ANY change
  under `src/runner-host/` (protocol/entry) must be rebuilt before the next
  sandboxed run — the container executes the image's copy, not the checkout.

Keep the image's pins in lockstep with the host; parity is the whole point.
