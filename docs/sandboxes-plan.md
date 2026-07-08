# Sandboxes: self-hostable isolated execution for Backstage sessions

**Status:** plan written 2026-07-08 (Michael with Michiel); **Phases 0–3,
Workstream E (engine), and Workstream S (snapshots) are DONE** as of
2026-07-08 — per-phase commit ranges are on each heading below, remaining
work is in §8 Backlog. Operator docs: `docs/self-hosting-sandboxes.md`.
**End goal served:** open-sourcing Backstage. Companies must be able to fully
self-host, so the *default* sandbox backend is plain Docker on the host —
no third-party compute. Daytona and E2B are optional adapters (both
self-hostable OSS); Modal is out (managed-only).

---

## 1. Goal and constraints

Today a session's workspace is a git worktree on this host and the agent
(Claude Code / Codex) runs as a host process with `cwd` pointed at it.
We want each session to optionally run inside an **isolated container**
("sandbox") instead: its own filesystem, env, network policy, resource
limits, and eventually its own live preview — Ramp-Inspect-style.

Hard constraints:

1. **Do not break daily use.** Backstage is self-hosting and worked on every
   day. Local worktrees stay the default; sandboxes are opt-in per
   session/automation until proven. Every phase ships independently and is
   revertible by a config flip.
2. **Self-host first.** The built-in provider is Docker (already on the VPS).
   Daytona (AGPL-3.0, Helm/K8s) and E2B (Apache-2.0 SDK, OSS Terraform/Nomad
   infra; GCP full, AWS beta) are *adapters* behind the same interface —
   nothing in core may depend on them. Talking to Daytona over its API keeps
   AGPL obligations on whoever operates Daytona, not on Backstage's codebase.
3. **Runner internals don't hot-reload.** Every phase that touches
   claude-runner / codex-runner / runner-host needs a deliberate, announced
   `systemctl restart`. Plan restarts per phase, not per commit.

Non-goals for now: multi-tenant hosting, code.storage integration (orthogonal
— sandboxes must work with plain git remotes; scoped-token clone URLs are a
pluggable hook we leave room for), Firecracker-grade isolation (that's what
the Daytona/E2B adapters are for when someone needs it).

---

## 2. What exists today (the seams)

Findings from a full code map (2026-07-08):

- **`cwd` is the single workspace primitive.** It's threaded through
  `RunAgentOpts.cwd`, `ActiveRunRecord.cwd` (run journal / resume), and
  `RunHostSpec.cwd`. Nothing else identifies "where the work happens".
- **The run-host layer is a working "run elsewhere" abstraction.**
  `src/runner-host/protocol.ts` defines a serializable run spec + NDJSON
  wire protocol (`HostToClientMsg`/`ClientToHostMsg`);
  `src/server/host-client.ts` (`runAgentHosted` → `spawnHostRun` →
  `launchHostUnit`) launches a run in a transient **systemd unit**
  (`systemd-run` with `EnvironmentFile`, `IPAddressDeny=169.254.169.254`)
  and streams `StreamEvent`s back; `src/server/host-registry.ts` has a
  provider-agnostic per-run control handle (`steer`/`cancel`/reattach).
  **A Docker provider swaps `launchHostUnit` for a container launcher and
  keeps everything else.**
- **In-process MCP already crosses process boundaries.** The michael-*
  servers (sessions/admin/repos/preview) are exposed to Codex — and to
  hosted runs — as stdio proxies (`src/runner-host/mcp-proxy.ts`) that
  forward over a unix RPC socket (`src/server/run-rpc.ts`,
  `~/.backstage-chats/backstage-rpc.sock`) with per-run tokens
  (`RunHostSpec.proxyMcpServers` + `rpcToken`).
- **Host-filesystem-coupled surfaces** that assume a local dir + local
  `git`: `file-index.ts` (@-mention search, `git ls-files`), `git-diff.ts`
  (session diff + discard), `git-status.ts` / `push.ts`, `preview.ts`
  (`.ports.conf`, ensure-up.sh, Caddy admin on :2019), and all of
  `worktree.ts` (`REPOS` registry, `createWorktree` & friends,
  `bun install` post-setup). **`pr-info.ts` is already remote** (gh CLI by
  branch + ghRepo) and needs no changes.
- **Hardcoded host paths** that block portability:
  `pathToClaudeCodeExecutable: "/home/ubuntu/.local/bin/claude"`
  (claude-runner.ts), `TELLA_FUSION`/`WORKTREES_DIR` (worktree.ts),
  mcp-config.json path (connections.ts), the vendored codex binary under
  `node_modules/@openai/codex-linux-x64/...`.
- **Config precedents:** `~/.backstage-codex-transport.json` (runtime
  provider toggle), `~/.backstage-chats/disable-run-hosts` (kill-switch
  file), per-repo settings on the `REPOS` registry.

---

## 3. Target architecture

Two new interfaces, deliberately small:

```ts
// src/server/sandbox/provider.ts
interface SandboxProvider {
  id: "local" | "docker" | "daytona" | "e2b";
  // Create-or-reuse the sandbox for a session. Idempotent.
  ensure(session: SandboxSessionSpec): Promise<Sandbox>;
  get(sandboxId: string): Promise<Sandbox | null>;   // reattach after restart
  destroy(sandboxId: string): Promise<void>;
}

interface Sandbox {
  id: string;                    // journaled on ActiveRunRecord + session file
  provider: string;
  cwd: string;                   // path *inside* the sandbox
  exec(cmd: string[], opts?): Promise<ExecResult>;   // one-shot commands (git, ls-files…)
  launchRun(spec: RunHostSpec): RunHandle;           // long-lived agent run, NDJSON stream
  ports(): Promise<PortMap>;     // preview: container port → host port
  status(): Promise<"running" | "stopped" | "gone">;
}
```

- **`local`** wraps today's behavior exactly: `ensure` = the existing
  worktree resolution, `exec` = Bun `$` on the host, `launchRun` = in-process
  `runAgent` (or the existing systemd host unit). Default provider. Zero
  behavior change.
- **`docker`** (Phase 1): one container **per session** (not per run), kept
  alive across turns so engine session state (`~/.claude`, codex rollouts)
  and dev servers survive. Prebaked image `backstage-runner` with bun, node,
  git, gh, ripgrep, the claude CLI, and the repo's node_modules (which
  includes the vendored codex binary). The session worktree is
  **bind-mounted at the identical path** inside the container — this is the
  key trick that makes Phase 1 small (see §5, Phase 1).
- **`daytona` / `e2b`** (Phase 3): same interface over their SDKs. Both are
  remote, so no bind mounts — they need the Phase 2 exec-based surfaces and
  a TCP/WS transport for the run stream + MCP RPC.

Sandbox selection: `~/.backstage-sandbox.json`
(`{"provider": "docker", "image": "backstage-runner:latest", ...}`) +
optional per-repo default on `REPOS` entries + per-session override (UI
toggle on session create; `sandbox` field on `BackstageSessionFile`).
Kill-switch file `~/.backstage-chats/disable-sandboxes` checked per run,
mirroring `disable-run-hosts`. Missing config = `local` = today.

---

## 4. What this means for the Claude Agent SDK and Codex

The core decision: **the whole agent stack moves into the sandbox together.**
We do *not* run the SDK on the host with tools RPC'd into the container —
that would re-implement both SDKs' tool layers. Instead the existing
runner-host entry (`src/runner-host/`, which already runs `runClaude`/
`runCodex` in a separate process and streams events back) runs *inside* the
container. Consequences per engine:

### Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)

- `query()` spawns the claude CLI as a child of whatever process calls it.
  Runner-host-in-container ⇒ SDK host process, CLI, and every tool (Bash,
  Edit, subagents) execute inside the sandbox. Nothing about how we call
  `query()` changes.
- `pathToClaudeCodeExecutable` (today hardcoded to a host path) and
  `executable: "bun"` must resolve inside the image → make both
  configurable; the image bakes pinned versions. Same for
  `settingSources: ["user","project"]`: "project" is the worktree's
  `.claude/` (mounted, works as-is); "user" is `~/.claude` *inside the
  container* → the image ships a minimal one, and the container's `$HOME`
  is a per-session volume so **claude session resume keeps working**
  (resume state is keyed by cwd + `~/.claude` history; identical mount path
  + persistent volume preserves both).
- `canUseTool` / `confirmTools` (Stripe approval cards) / `AskUserQuestion`
  already work across a process boundary: they run in the runner-host
  process and proxy asks back over the NDJSON protocol. Carries over
  unchanged.
- In-process MCP (michael-sessions/admin/repos/preview) cannot be in-process
  across a container boundary — use the **existing stdio→RPC proxy path**
  (the one Codex and hosted runs already use). Requirement: the RPC unix
  socket must be reachable inside the container → bind-mount the socket
  (Docker) or upgrade run-rpc to a token-authed TCP/WS listener (needed for
  Phase 3 remote providers anyway).
- Minimal env discipline (`childEnv`: PATH/HOME/LANG + git identity +
  OAuth token + short-lived AWS creds) maps 1:1 onto `docker run -e` and
  actually gets *stronger*: the container has no host filesystem beyond its
  mounts, so a leaked env var can't be combined with `~/.backstage.env`.

### Codex (`@openai/codex-sdk` exec + app-server)

- The exec SDK spawns the **vendored codex binary** from node_modules; the
  app-server transport spawns the same binary with JSON-RPC over stdio.
  Both work inside the container as long as the image contains the repo's
  node_modules (it does — it's the same runner bundle). App-server's
  long-lived process actually *prefers* container-per-session: it stays up
  across turns, keeping steer/interrupt cheap.
- Today we run codex with `sandboxMode: "danger-full-access"` because its
  own bwrap sandbox can't initialize under the service env. Inside a
  container that stops being scary: **the container is the sandbox.** We
  can also finally give codex real per-mode network policy
  (`--network none` for ask-mode automations) instead of relying on
  `networkAccessEnabled` alone.
- `CODEX_HOME` (account homes) and rollout/thread state move to the same
  per-session `$HOME` volume, so `resumeThread` survives restarts.
- MCP: codex already consumes the michael-* servers as stdio proxy
  subprocesses with `BKS_RPC_SOCKET` — same socket-reachability requirement
  as Claude, same fix.

### Shared implications

- `ActiveRunRecord` gains `sandboxId` + `provider` so
  `resumeInterruptedRuns` can reattach to a still-running container after a
  backstage restart (containers outlive the backstage process — same
  property the systemd host units have today).
- IMDS blocking (`IPAddressDeny=169.254.169.254` in the systemd path) must
  be reproduced in the Docker path (iptables DOCKER-USER rule or network
  policy) — automation least-privilege depends on it.
- **Everything in this section is runner internals ⇒ real restart to take
  effect.** Each phase ends with one announced restart + a verification run.

---

## 5. Phases

### Phase 0 — Seams, zero behavior change  — **DONE** (5bec62af, 99de3dbb, 8f12737b, a10baa27)

1. Introduce `SandboxProvider`/`Sandbox` interfaces + `LocalProvider` that
   wraps existing behavior (worktree resolution from `prepareWorktree` in
   backstage.ts / `worktree.ts` creators; `exec` = host `$`; `launchRun` =
   current in-process path). Thread a `Sandbox` handle through
   `runSessionPromptInner` instead of a bare `cwd` string; `RunAgentOpts`
   keeps `cwd` (derived from the handle) so runners don't change yet.
2. Config plumbing: `~/.backstage-sandbox.json` reader, `sandbox` field on
   `BackstageSessionFile` + `ActiveRunRecord` (optional, unused), kill-switch
   file check. Session-create API accepts `sandbox: boolean` and ignores it
   unless a provider is configured.
3. De-hardcode paths the sandbox path will hit: claude executable path,
   worktrees dir, mcp-config path → env/config with current values as
   defaults. (This is also pure open-source-readiness work.)

**Acceptance:** no user-visible change; all existing flows (interactive,
automations, goals, Slack, resume-after-restart) behave identically with
the local provider. One restart at the end.

### Phase 1 — Docker provider, bind-mount mode  — **DONE** (8d60b13e, b2ba6e94, ffedd1f8, fd66c839, f8a16d08, f400fee3)

The trick that keeps this phase small: the container **bind-mounts the
existing host worktree at the identical path**. Execution is isolated
(processes, env, network, resources) but files stay visible to the host —
so @-mention search, session diff, git status/push, and previews keep
working with **zero changes** to those surfaces.

1. `backstage-runner` image: Dockerfile in `deploy/sandbox/` — bun, node,
   git, gh, ripgrep, claude CLI (pinned), backstage runner bundle +
   node_modules (vendored codex included), minimal `~/.claude`. Build
   script + version tag; document rebuild cadence.
2. `DockerProvider`: container-per-session, named
   `bks-sbx-<sessionId>`, mounts = worktree (rw, same path), RPC socket
   (ro), per-session `$HOME` volume; env from the same minimal-env builders;
   CPU/mem limits; DOCKER-USER iptables rule for IMDS; label
   `backstage.session=<id>` for sweeps. Lifecycle: create on first run,
   stop after idle TTL, `docker start` on next turn, destroy on session
   delete/archive (worktree survives — it's the host's).
3. `launchRun` = `docker exec` of the runner-host entry with the
   `RunHostSpec` (same NDJSON stream over exec's stdio); register in
   `host-registry` so steer/cancel/reattach work; journal
   `sandboxId`; extend `resumeInterruptedRuns` to reattach via
   `provider.get()`.
4. Opt-in surface: toggle on session create (UI + `create_session` MCP tool
   arg), per-automation `sandbox: true` field. **Default off.**
5. Verification suite (the "don't break backstage" gate): scripted run that
   exercises ask + code sessions, steer, cancel, restart-resume, Stripe
   confirm card, AskUserQuestion, @-mention search, diff, push, PR create —
   once with provider=local, once with provider=docker.

**Acceptance:** a code-mode tella-fusion session runs fully inside a
container with identical UX; killing backstage mid-run and restarting
reattaches; flipping the kill-switch instantly reverts new runs to local.
Restart required; announce it.

### Phase 2 — Exec-based workspace surfaces  — **DONE** (244741c4, fbaead99, abf58883, a45e76d8, f86412fe, 7f1ba764)

Prep for remote providers + full isolation. Replace direct host `$ git -C`
calls with `sandbox.exec()` in: `file-index.ts`, `git-diff.ts`,
`git-status.ts`, `push.ts`. Local provider keeps host exec (no perf
change); Docker provider can now optionally own the workspace **inside**
the container (clone into a volume, no host worktree) — enabling
per-session disk caps and instant cleanup. Preview: replace
`.ports.conf` + host ensure-up with container port mapping + Caddy route
per sandbox (`getPreviewStatus` reads `sandbox.ports()`).

**Acceptance:** diff/files/status/push/preview all work against a
volume-only Docker session; worktree-disk-cleanup problem disappears for
sandboxed sessions.

### Phase 3 — Remote adapters: Daytona, then E2B  — **DONE** (13745145, e06c7eae, fe843109, e650d370, fe33a6be, 7d1436af, 4a37cd31, 22f55b7d, 5206c669; Daytona live-certified via the conformance suite, E2B implemented but uncertified — see docs/self-hosting-sandboxes.md)

1. Transport upgrade: run stream + MCP RPC over token-authed WS to the
   backstage server (which already binds Tailscale) instead of unix
   sockets/stdio. Docker provider migrates to it too (dogfood).
2. `DaytonaProvider` first (Helm/K8s self-host, snappier startup story) via
   its SDK: create sandbox from our image/snapshot, `exec`, port preview.
   `E2BProvider` second (their self-host is a heavier Terraform/Nomad/GCP
   project — document it, don't operate it for them).
3. Provider conformance test: the Phase 1 verification suite parameterized
   over providers; adapters must pass it to be listed.

**Acceptance:** same session UX on a Daytona sandbox; provider chosen purely
by config. Core has zero imports from adapter SDKs except in
`src/server/sandbox/adapters/`.

### Workstream E — OpenCode engine  — engine **DONE** (7b3075d4, b7816045, 5e908d59; direction update a1cdb8b7 — staged migration itself is backlog)

DIRECTION UPDATE 2026-07-08 (late, Michiel): **OpenCode is the destination —
"fully move over to opencode only."** Staged migration: (1) opencode-first
(default engine for new interactive sessions; parity work: permission-asks →
ask/confirm cards restoring Stripe approvals, transcript tail, opencode in the
runner image, steer ergonomics); (2) automations once confirm-parity is proven;
(3) rip out claude-runner/codex-runner when parity holds and the metered Claude
billing is accepted. claude-fable-5 via the direct SDK stays in the picker
through stages 1–2 (subscription economics). opensession-the-product ships
opencode-native from day one. The section below built the engine and remains
accurate; its "third engine, not a replacement" framing is superseded as
end-state but its constraints (Jun-15 billing, confirm-tool gap) gate the stages.

Original decision 2026-07-08: OpenCode joins as a **third engine**, not a replacement.
Anthropic's April 2026 policy change blocks subscription OAuth tokens in
third-party harnesses, so Claude models via OpenCode are API-key-only —
the Claude Agent SDK path (subscription-priced, plus our canUseTool /
confirm-tools / skills stack) stays primary for Anthropic models. OpenCode
(MIT, 75+ providers, `opencode serve` headless HTTP+SSE server,
`@opencode-ai/sdk`) is the "bring any LLM" engine for open-source
self-hosters and model experiments.

1. `src/server/opencode-runner.ts`: spawn/manage `opencode serve` (per
   session), map its event stream to `StreamEvent`s, thread
   prompt/steer/interrupt/resume. Wire into `runOnModel`'s provider
   dispatch (the same seam Codex used); model ids like `opencode/<provider>/<model>`.
2. Permissions parity: map `deniedTools`/`confirmTools`/ask flows onto
   OpenCode's permission + plugin hooks; automation least-privilege must
   hold before any automation may select this engine.
3. Sandbox synergy: in Docker sandboxes, run the opencode server inside
   the container and talk HTTP — no stdio proxying. Add the binary to the
   `backstage-runner` image.
4. Max-subscription bridge — decided 2026-07-08, built in-repo
   (src/server/anthropic-bridge.ts: Anthropic-compatible HTTP endpoint
   backed by the official Claude Agent SDK + our accounts layer, audit +
   rate limits in 5e908d59). **Verified billing reality (live-tested
   2026-07-08, supersedes earlier readings):**
   - Our in-repo bridge hits the extra-usage 400 because it deliberately
     does **not** scrub opencode fingerprints (anti-evasion stance,
     unchanged).
   - The **literal opencode-with-claude plugin** (1.6.14, Meridian 1.45.0)
     was live-tested 2026-07-08 and DOES complete turns on flat Max quota
     (haiku verified, HTTP 200). Mechanism: its bundled scrub plugin strips
     opencode's duplicated env preamble + powered-by line; per the scrub
     author's bisection the billing gate is **opus-specific** (sonnet/haiku
     pass even unscrubbed).
   - **Adopted direction:** wrap the literal Meridian as the bridge process
     behind our accounts/audit/containment layer (the already-authorized
     fallback path) rather than porting scrub logic in-repo. Opus/Fable-tier
     via the plugin is being tested; enforcement is a moving target —
     designated accounts + audit remain mandatory. Extra-usage credits are
     explicitly NOT used (Michiel decision).
   - Containment unchanged: interactive sessions only (never automations),
     designated accounts only (not the pool), direct Agent SDK stays the
     default engine for Claude models; if enforcement tightens, the bridge
     is removed and nothing else depends on it. June-15 policy context:
     github.com/ianjwhite99/opencode-with-claude issue #154.
5. Still NOT in scope: OAuth spoofing / reverse-engineered auth of any
   kind (ToS-violating and server-side blocked).

### Workstream S — Snapshot warm restores  — **DONE** (a40c65cd)

Docker-provider snapshotting (background-agents pattern, adapted): on
idle-stop the container is `docker commit`ed to a per-session image, and a
later ensure() for a GONE container restores from it — preserving
container-layer state (installed deps, apt, global caches), not workspace
or engine state (those live on volumes/bind mounts). Off by default
(`snapshots.enabled` in `~/.backstage-sandbox.json`); warm-on-typing (start
restoring while the user is still writing the prompt) is backlog.

### Phase 4 — Product layer + open-source polish  (ongoing; UI + docs landed 01247795, a210fb08 + this doc)

- ~~Sandbox status in the UI~~ DONE: session-create "Run in sandbox" toggle
  (recorded via the Phase-0 `sandbox` create param), SessionViewer header +
  WorkspaceInfo badge (provider · bind/volume, rendered from session
  fields), engine-grouped model picker for opencode/<provider>/<model> ids.
  Still open: live container state / resources on the badge (needs a small
  status API), and a config-status read so the toggle only shows when a
  provider is configured (today it's always offered and inert without one).
- Warm pool / snapshotting for fast starts — base snapshots DONE
  (Workstream S); warm-on-typing + prebaked-deps images are backlog.
- ~~Self-hoster docs~~ DONE: `docs/self-hosting-sandboxes.md` (Docker
  default, full config schema, Daytona/E2B guides + certification via the
  conformance suite, licensing, path parity, kill switch, restart rules).
- Optional hook: pluggable clone-credential source per repo (where a
  code.storage-style scoped token would slot in later) — the global
  `cloneCredential` config exists; per-repo is backlog.

---

## 6. Rollout & safety rules (repeat per phase)

- Local provider is the default until we've dogfooded Docker for ≥2 weeks
  on our own sessions; automations move last (triage only after interactive
  is boring).
- Every phase: ship dark → opt-in on a few of our sessions → flip default
  for new sessions only. Existing sessions never migrate automatically.
- One announced `systemctl restart` per phase, immediately followed by the
  verification suite; kill-switch file reverts new runs without a restart.
- Journal fields are additive/optional so old `active-runs.json` records
  always resume.

## 7. Backlog (post Phases 0–3 + E + S, 2026-07-08)

Not scheduled; roughly ordered by how hard they block open-sourcing.

- **Secrets vault**: a real per-run secret store (scoped injection into
  sandboxes/runs, rotation, audit) instead of ro-mounted host files +
  minimal-env discipline.
- **OAuth / allowlist auth layer**: today Backstage is Tailscale- +
  team-gated at the network layer; open-sourcing needs a first-class login
  (OAuth/OIDC) with a user allowlist so `backstage-user` isn't just a
  localStorage string.
- **opensession TUI**: engine-agnostic session TUI (attach to any Backstage
  session from a terminal) + opencode attach for opencode-engine sessions.
- **Workstream E staged migration**: opencode-first defaults → automations
  → engine consolidation, gated on confirm-tool parity + the billing
  reality above (a1cdb8b7 has the stages).
- ~~ws-buffer-ack~~ **DONE** (e650d370): seq/ack replay on the WS run
  transport closed the frame-loss window flagged in 0ee1bbd1.
- **Snapshot warm-on-typing**: kick the sandbox restore while the prompt is
  still being typed (Workstream S left the hook).
- **Portability batches 2–4** (docs/portability-audit.md sizing): batch 1
  (config loader, repos registry, paths, identity table — b3fd72d7,
  ec36ba98, c04735d8, 56546e17, 6b3035f2) is done; still open: channel
  IDs / OAuth redirect / publicBaseUrl consolidation, deploy pipeline
  genericization, integration fail-closed gating, gh-repo templating in
  prompts, persona/company config.
- **Sandbox UI follow-ups**: config-status read to gate the create toggle;
  live container state/resources on the badge; per-repo clone-credential
  hook.

## 8. Open questions (decide during Phase 0/1)

1. Idle policy: stop containers after N minutes idle vs keep warm — cost of
   `docker start` (~1s) vs RAM of dozens of live sandboxes on the VPS.
2. Does the backstage repo itself (shared checkout, self-hosting) ever get
   sandboxed? Proposal: no — it stays local forever; sandboxes are for
   worktree-flow repos.
3. Image contents for tella-fusion dev (Postgres/Redis for full local runs
   à la Ramp) — start with toolchain-only, add services when preview-in-
   sandbox lands (Phase 2).
4. WS transport auth model for Phase 3 (reuse run-rpc tokens vs mint
   per-sandbox certs).
