# Self-hosting sandboxes

How to run Open Session sessions inside isolated sandboxes on your own
infrastructure. Companion to `deploy/sandbox/README.md` (the runner image +
provider internals). This page is the operator's view: what to install, the
provider guides, and the safety switches.

**Default = None.** Sessions run on the host unless a Ready workspace
connection is selected explicitly, personally, or as the workspace default.

## Setup

Workspace administrators configure providers in **Workspace → Sandboxes**.
Daytona, Box and Modal accept workspace-owned credentials there; credentials
are written once to the server-side workspace secret store and are never
returned to the browser or placed in a sandbox.

Local providers use one generated host command:

```sh
opensession sandbox enable docker
opensession sandbox enable microvm
```

The command checks the host, installs and verifies signed release artifacts,
installs the persistent metadata firewall, runs a disposable qualification,
and records Ready in the shared connection store. Re-running it is safe.
`opensession sandbox test <provider>` requalifies a connection;
`opensession sandbox disable <provider>` stops future use without deleting
live sandboxes.

Remote providers use the workspace's canonical Public ingress origin. Configure
it once under Settings → Public ingress with Tailscale Funnel, Cloudflare
Tunnel, or a Caddy-managed custom domain. The same fail-closed listener receives
signed integration webhooks, Sandbox callbacks, and workload identity; the
private app is never part of that public listener.

None remains a first-class personal and per-session choice. If a chosen
provider later becomes unavailable, creation or the next turn fails clearly;
Open Session never changes the execution boundary to the host or another
provider.

### Building the image

`deploy/sandbox/build.sh` builds `deploy/sandbox/Dockerfile` from the repo
root. Pins are `ARG`s — override with `--build-arg` per build:

| ARG | Default | Keep in lockstep with |
| --- | --- | --- |
| `BUN_VERSION` | 1.4.0 | host `bun --version` |
| `CLAUDE_VERSION` | 2.1.218 | host `claude --version` |
| `NODE_MAJOR` | 24 | host Node LTS |
| `PI_VERSION` | 1.18.18 | host pi |

Rebuild whenever: the host Claude CLI or bun is bumped, `bun.lock` changes
(any dep, incl. the Agent SDK / vendored codex binary), or **anything under
`packages/core/opensession-server/src/runner-host/` changes** — sandboxed runs execute the image's copy of
the runner, not your checkout.

### Path parity is load-bearing (do not "tidy" it)

The image reproduces **your host's** absolute paths exactly: the runner
bundle at your checkout path, the claude CLI at your host's CLI path, a
uid-1000 user matching the host user, and the session worktree bind-mounted
at its **identical host path**. That parity is what lets
diff/status/push/preview/@-mentions and Claude session resume work unchanged
(resume state is keyed by cwd). The concrete paths baked into the shipped
`deploy/sandbox/Dockerfile` (`/home/ubuntu/projects/opensession`,
`/home/ubuntu/.local/bin/claude`, user `ubuntu`) are a **rebuild-time input
that must match your host**, not a universal truth — if your host's `$HOME`,
username, or checkout path differs, edit those paths in the Dockerfile and
rebuild the image to match. This is the one place the home-directory coupling
is intrinsic rather than lazy: the parity is the mechanism, not a default
nobody got round to extracting.

## Images, warm pools and snapshots

Three separate mechanisms get confused with each other. They solve the same
problem — a cold sandbox is slow — at different layers.

### The runner image

The base image a sandbox starts from. `deploy/sandbox/build.sh` builds it and
tags `opensession-runner:latest` plus the git SHA (`IMAGE=` overrides the
name). It carries the toolchain a
session needs (bun, git, the engine) so no session pays to install them.

This is the piece you should rebuild deliberately: pinning
`"image": "opensession-runner:<sha>"` means a rebuild cannot change behaviour
underneath running sessions, and rolling back is retagging.

Path parity between the image and the host is load-bearing — see the section
above before "tidying" any of it.

### Warm pools (prewarm)

Remote providers can take minutes to prepare a large repository. The default
pool starts while you type and destroys an untouched sandbox after its TTL. For
a project that must open quickly, explicitly keep a sandbox prepared:

```json
"prewarm": {
  "enabled": true,
  "ttlMinutes": 10,
  "maxLive": 2,
  "keepReady": [
    { "provider": "box", "repoId": "tella-fusion" },
    { "provider": "daytona", "repoId": "tella-fusion" }
  ]
}
```

`maxLive` bounds both preparing and prepared sandboxes. It must be at least the
number of keep-ready targets. Open Session parks prepared capacity when the
provider retains its disk on stop, so Box and Daytona stop billing compute while
waiting. A claim resumes that disk, and its replacement prepares in the
background before parking again. Completed entries survive coordinator restarts.
Without `keepReady`, the pool remains demand-driven and TTL-bound.

The pool is inert until a supported provider is configured. Docker starts fast
enough locally that it does not need this.

### Snapshots

Snapshots capture a *running* sandbox — installed dependencies, warm caches,
container-layer state — so the next start restores rather than rebuilds. Docker
snapshots on idle-stop; the Firecracker MicroVM backend goes further and
restores from a memory snapshot, so a workspace resumes in about a second.

```json
"snapshots": { "enabled": true, "onIdle": true, "maxPerSession": 2 }
```

Master switch is off. Nothing is captured or restored unless you turn it on, and
`maxPerSession` bounds disk growth — snapshots are large, and without a cap they
are the thing that fills a disk quietly.

Daytona has its own notion: an **org snapshot** that sandboxes are created from.
Worth setting, because Daytona's default is 1 vCPU / 1 GB / 3 GiB, which is too
small for a real repository. Note that custom `resources` are rejected when
creating from a snapshot — sizing lives in the snapshot itself.

### Current limits

Honest status, because these are the newest parts:

- **Snapshot restore is best-effort.** A restored workspace can hold stale git
  refs; the `quickSyncOnRestore` setting (a non-destructive `git fetch` +
  `git status` after a volume restore, default on) exists for exactly that. If
  a session starts confused about what branch it is on, suspect this first.
- **Prewarm restart recovery** restores completed, signature-matching entries.
  Interrupted bootstraps are destroyed because their completion promise cannot
  be resumed safely.
- **The MicroVM backend is live-certified** for provisioning, engine launch,
  reconnect/replay, steering, cancellation, durable pause/wake, workspace
  survival and teardown. Each Firecracker process is unprivileged and jailed
  in a per-clone chroot with zero capabilities, NoNewPrivileges, seccomp and a
  closed device cgroup. It still shares the host kernel, so do not describe it
  as a separate hardware trust domain.
- **Docker, Daytona, Modal and MicroVM** have live certifications. E2B, Box and
  Lambda MicroVM are implemented but remain unproven on this host. They are not
  offered for new sessions: configuring one does not certify it, and create
  fails until its live matrix passes and the code certification registry is
  updated.
- Clearly transient provider/network failures during idempotent sandbox
  creation are retried once. Agent launch is never retried because that could
  duplicate a turn.
- A default-branch update invalidates the repository's reusable Daytona, Box,
  Modal and MicroVM templates. The next preparation rebuilds from current
  source rather than adopting a stale artifact.

If you are starting out: use Docker, leave prewarm and snapshots off, and come
back to them when cold starts actually bother you.

## Repo lifecycle hooks — `.agents/`

Sandboxes honor the repo-committed lifecycle contract
([docs/repo-lifecycle.md](repo-lifecycle.md)); a repo that commits these
files provisions and boots itself in any sandbox with zero instance config:

- `.agents/setup` — provision hook. Runs once per workspace materialization,
  before the post-setup snapshot, skipped on snapshot restore.
- `.agents/resume` — idempotent post-wake repair, run after an actual durable
  MicroVM wake. Failures surface in the sandbox panel with the retained log.
- `.agents/start.sh` — dev-server / preview entry, foreground, honoring
  `WEBAPP_PORT` / `PREVIEW_URL` / `OPENSESSION_BOOT_MODE`.

## Internal runtime config — `~/.opensession-sandbox.json`

Do not configure Docker, Daytona, Modal or Local MicroVM connections by editing
this file. Normalized connections and opaque credential references are
server-owned. Raw Daytona/Modal credentials and credential environment
variables are not supported. The schema below documents low-level runtime
controls and experimental conformance providers.

Read fresh per run (no restart for value changes — but see "What needs a
restart" below). Missing file, invalid JSON, or unknown values all resolve
to `provider: "local"` (today's host behavior). Env override for the path:
`OPENSESSION_SANDBOX_CONFIG` (used by the verify/conformance suites).

```jsonc
{
  // Which SandboxProvider new opted-in sessions get.
  // "local" | "docker" | "daytona" | "e2b" | "box" | "modal" | "microvm" |
  // "lambda-microvm"
  "provider": "docker",

  // Shared Workspace default for NEW interactive sessions. "none" is the
  // shipped default. A person's Settings override and an explicit session
  // choice both take precedence.
  "sessionDefault": "none",

  // ── Docker provider ────────────────────────────────────────────────
  // Container image (default "opensession-runner:latest").
  "image": "opensession-runner:latest",
  // docker stop idle containers after N minutes (default 30); restarted
  // automatically on the session's next turn.
  "idleStopMinutes": 30,
  // Per-container resource limits (docker --cpus / --memory).
  // Defaults: 4 cpus, "8g".
  "cpus": 4,
  "memory": "8g",

  // Workspace mode for NEW docker sandboxes (existing sandboxes keep the
  // mode they were created with — it's sticky in their state file):
  //  "bind"   (default): the host worktree is bind-mounted at its identical
  //           path. Host-side diff/status/push/preview work unchanged.
  //  "volume": the repo is cloned INTO a per-session volume inside the
  //           container; no host worktree exists at all. destroy() (session
  //           delete / archive sweep) DELETES the volume — un-pushed work
  //           is gone. Push your work. Attached repos + sibling sessions are
  //           not supported in volume mode.
  "workspace": "bind",

  // Container ports published for previews (docker -p 127.0.0.1::<port> at
  // container create → random loopback host port; preview.ts routes the
  // same Caddy tailnet-HTTPS front at the published port).
  // Default [3300, 3301, 3302].
  "previewPorts": [3300],

  // Snapshot-based warm restores (docker only; see docker.ts "Snapshots").
  // On idle-stop the container is `docker commit`ed; a later ensure() for a
  // GONE container starts from that snapshot — preserving container-layer
  // state (apt/global caches), NOT workspace or engine state (those live on
  // volumes/bind mounts). Absent block = disabled.
  "snapshots": {
    "enabled": false,          // master switch (default false)
    "onIdle": true,            // snapshot right before the idle-stop
    "maxPerSession": 2,        // keep at most N snapshot images per session
    "quickSyncOnRestore": true // git fetch + status after a volume restore
  },

  // Per-repo overrides (keys = repo ids from the repos registry).
  "perRepo": {
    "my-app": { "provider": "docker", "image": "opensession-runner:latest" }
  },

  // ── Transport (how the in-sandbox run host talks to opensession) ─────
  //  "socket" (default): unix socket in a bind-mounted run dir. Docker only.
  //  "ws": the sandbox DIALS OUT to opensession's /run-ws +
  //        /rpc-ws routes (token-authed, seq/ack replay on
  //        reconnect). Required for remote providers (they force it
  //        regardless of this value); docker can dogfood it.
  "transport": "socket",
  // Base URL sandboxes dial back to for the ws transport. MUST be reachable
  // FROM the sandbox: your Tailscale ts.net URL or a tunnel for remote
  // providers; 127.0.0.1 never works. http(s):// is normalized to ws(s)://.
  // Default derives from the server's HOST:PORT bind.
  "callbackBaseUrl": "ws://<your-tailnet-ip>:3850",

  // ── Experimental conformance providers ─────────────────────────────
  "e2b": {
    "apiKey": "e2b_…",         // falls back to E2B_API_KEY
    "template": "base"         // sandbox template id (default "base")
  },
  "awsLambdaMicrovm": {
    "imageIdentifier": "arn:aws:lambda:us-east-1:123456789012:microvm-image:opensession",
    "imageVersion": "1",       // optional; latest active version by default
    "executionRoleArn": "arn:aws:iam::123456789012:role/OpenSessionMicrovm",
    "region": "us-east-1",    // falls back to AGENT_AWS_REGION/AWS_REGION
    "controlPort": 8080,       // must match the image daemon
    "maximumDurationSeconds": 28800, // AWS hard max: eight hours
    // Optional: endpoint-idle suspension. Omit for long-running agents: their
    // outbound WebSocket does not count as endpoint activity.
    "idleSuspendSeconds": 3600,
    "suspendedDurationSeconds": 3600, // only used with idleSuspendSeconds
    "logGroup": "/aws/lambda/microvms/opensession",
    "ingressConnectorArn": "…",       // optional VPC connectors
    "egressConnectorArn": "…"
  },
  // Local Firecracker. Build this credential-free golden separately from the
  // preview-pool golden; the latter contains an app and may contain app creds.
  "firecrackerMicrovm": {
    "enabled": false,
    "storeDir": "/opt/firecracker/sandbox-store",
    "indexStart": 64,          // 1..63 are reserved for preview-pool clones
    "indexEnd": 127
  },

  // Credential-minimal unattended runs. MicroVM is deliberately the only
  // admitted backend until another provider proves an equally enforceable
  // outbound policy. Baseline model/Git/callback hosts are added by the
  // launcher; entries here are extra HTTPS hosts, IPv4 addresses or CIDRs.
  "automation": {
    "provider": "microvm",
    "egressAllowlist": ["api.example.internal", "10.40.0.0/16"]
  },

  // How remote sandboxes authenticate `git clone` (they can't mount host
  // creds). "none" = public clone; "https-token" injects the token into the
  // https URL (GitHub App token / x-access-token).
  "cloneCredential": { "type": "https-token", "token": "ghp_…" },

  // Demand-driven by default. Add explicit keepReady targets when a project
  // must open in seconds. maxLive includes both preparing and ready entries.
  "prewarm": {
    "enabled": true,
    "ttlMinutes": 10,
    "maxLive": 2,
    "keepReady": [
      { "provider": "box", "repoId": "tella-fusion" },
      { "provider": "daytona", "repoId": "tella-fusion" }
    ]
  },

  // Remote runner bootstrap. Sandbox-engine models install the full runner +
  // model CLIs. Pi models (OpenAI, Claude and other providers) keep
  // their engine/auth on the host and install only Git/Bun/ripgrep/core
  // workspace tools:
  "runnerBundleUrl": null,     // tarball of the runner bundle (preferred)
  "runnerRepoUrl": null,       // git URL fallback (default: this checkout's origin)
  "runnerSha": null            // pinned ref (default: origin default branch)
}
```

### Local Firecracker MicroVM (brain and workspace inside)

The `microvm` provider runs the normal runner payload and selected engine
inside a per-session Firecracker guest. Pi, Pi and native Claude use the
same brain-inside run-ws/rpc-ws transport as remote providers; only native
Codex stays host-only because its writable rotating `CODEX_HOME` is not safe to
project across the boundary. Per-launch credentials are scoped and copied into
the guest; the golden and shared repo templates remain credential-free.

Build the dedicated control-only golden, then enable it:

```sh
sudo -n bash deploy/sandbox/microvm/refresh-sandbox-golden.sh \
  /opt/firecracker/sandbox-store
```

The refresh builds `deploy/sandbox/microvm/Dockerfile.runner`: a
credential-free golden with the pinned runner and engines. Golden publication
is locked against clone creation and atomically rolls back all artifacts on
failure, so a clone cannot observe a mixed disk/memory/vmstate generation.

MicroVMs participate in warm-on-typing when sandbox prewarming is enabled. The
first prompt input restores a clone, pre-clones the selected repo, runs the
executable `.agents/setup` hook, scrubs clone authority, publishes a reflinked
repo template, and parks the prepared VM with compute off. The template is
keyed by repo plus runner signature and expires after 24 hours. Subsequent
sessions clone this post-setup disk and cold-boot it, restore fresh clone
authority only on their private copy, move the warm workspace into place, and
skip setup through its stable repo stamp.

Do not point this provider at `/opt/firecracker/store`: that is the legacy
preview-pool store. Sandbox clones use COW ext4 disks and transient systemd
scopes, so active guests survive an Open Session restart. An idle guest pauses
after five minutes by default; prompts, workspace reads, shell attach and
Portal requests wake the preserved disk transparently and run `.agents/resume`.
The current cold wake is about five seconds. A host reboot stops compute but
the COW disk remains recoverable through the same resume path.

The Shell tab is a real PTY inside the guest (start/read/write/resize/close over
the private control lane). Portal ports are routed from the guest's private
veth through authenticated Caddy routes; private guest addresses are never
sent to browsers. The session header's sandbox panel shows live state, setup /
resume logs, pause, wake and destructive recreate controls.

### Sandbox automations

An automation can opt into the MicroVM profile from its Advanced form. This is
not the interactive credential-bearing profile with a different label. Save is
refused unless the automation has one hard-pinned provider account and an
explicit MCP selection (`[]` means none); model/account fallback and nested
Claude/Codex CLI credentials are disabled. Only selected MCP configurations and
dynamic credentials are projected into the guest, and the workspace exists
only on the guest volume.

Outbound TCP is rejected before allow rules are installed. The host resolves
the model, Git, callback, configured MCP and operator allowlist endpoints to
IPv4/CIDRs; DNS and established return traffic remain available. Guest-provided
hostnames never reach the privileged firewall script. This boundary currently
requires the local MicroVM provider, so an automation's `sandbox: true` fails
loudly when that provider/golden is unavailable.

### Real-work scorecard

`GET /api/sandbox/scorecard?days=30` reports turn/preview/wake/restart evidence
from the structured audit log. The automatic gate requires 20 turns per
environment, five distinct sandbox-use days, five preview starts per
environment, five wake samples, three perfect restart-survival samples, median
first-token time no slower than worktrees, and no turn-failure regression over
two percentage points. It never changes configuration: a human still approves
any future default flip.

## Public ingress (remote providers)

Remote sandboxes must dial back from the public internet. They use the same
canonical public origin as signed integration webhooks and workload identity.
`packages/core/opensession-server/src/server/public-ingress.ts` binds the one
fail-closed gateway on `127.0.0.1:3860`.

| Path | What |
| --- | --- |
| registered webhook/OAuth paths | signature-checked integration intake |
| `/run-ws/<hostId>` | authenticated run-host event stream |
| `/rpc-ws?host=…` | authenticated MCP proxy channel |
| `/sandbox-portal-ws` | authenticated remote Portal relay |
| `/ingress-health` | bare `200 ok` |
| `/workload-identity/*` | OIDC discovery, JWKS and token exchange |

Every other method/path is a bodyless 404. The listener never exposes app
routes, the general API, or the frontend. Sandbox upgrades use per-launch
tokens and internet-facing upgrade/token attempts are rate-limited per client
IP.

Settings → Public ingress offers three exposure methods:

1. **Tailscale Funnel** routes the machine's HTTPS `*.ts.net` hostname to
   `127.0.0.1:3860`. It needs no DNS records or inbound ports.
2. **Cloudflare Tunnel** stores a named tunnel's connector token write-only,
   runs `cloudflared`, and uses a CNAME to `<tunnel-id>.cfargotunnel.com`;
   its only service must be `http://127.0.0.1:3860`.
3. **Custom domain** points A/AAAA records at the host and lets Open Session
   manage a Caddy site that reverse-proxies the whole origin to 3860. The
   application, not Caddy, remains the exact route allowlist.

The workload-identity issuer is the canonical public origin plus
`/workload-identity`. An external relying party must be able to fetch discovery
and JWKS from that exact issuer. Changing the origin therefore also requires
updating external trust policies.

Hosted-Daytona reminder: the sandbox side needs Tier 3 / self-hosted egress;
lower tiers block outbound traffic, so no ingress URL is reachable from inside.

## Known gaps (remote providers)

- **Audit trail**: in-sandbox runs write their `claude_turn_event` audit
  lines to the sandbox's own `~/.opensession-audit` — docker bind-mounts that
  dir so they land in the host stream, but **daytona/e2b sandboxes keep them
  local and they're lost when the sandbox is destroyed**. Host-side you still
  get the launch/journal/run-ws lines; grep the sandbox itself (`exec`) while
  it lives if you need a remote run's turn-level audit. (The persisted
  pi transcript had the same gap and is now mirrored host-side from the
  dial-back stream — see the transcript forwarder in
  `packages/core/opensession-server/src/server/sandbox/adapters/bootstrap.ts`; audit mirroring is a possible
  follow-up on the same hook.)

## Kill switch

```sh
touch ~/.opensession-sessions/disable-sandboxes
```

Checked per run: while the file exists every NEW run goes local regardless
of config — no restart needed. Remove the file to re-enable. Sessions with
**volume** workspaces are the exception to "goes local": their workspace
only exists inside the sandbox, so their prompts are refused with an
explanatory message instead of silently running against a missing dir.

## What needs a restart

The config file's *values* are read fresh per run. Code changes to the sandbox
path are **runner internals** and need a service restart:

- First-time enablement, provider/transport code changes, anything under
  `packages/core/opensession-server/src/server/sandbox/`, `packages/core/opensession-server/src/runner-host/`, run-ws/rpc-ws → real
  `systemctl restart opensession`.
- The public ingress gateway starts once at boot on loopback port 3860.
  Changing code or its internal bind requires a restart; changing the canonical
  public URL applies to new remote launches immediately.
- Transport flips (`socket` ↔ `ws`) apply to NEW sandbox launches, but the
  transport code itself must already be live (restart once, then flip
  freely).
- Image changes → rebuild the image; running containers keep their old
  image until destroyed (session delete) or GONE + re-ensured.
- Config value tweaks (idleStopMinutes, previewPorts, cpus/memory…) → no
  restart, but mounts/ports/limits are container-create-time: an EXISTING
  sandbox keeps its old ones until it's recreated.

## Provider guides

### Docker (default, certified)

Covered above. Per-session container, engine state (`~/.claude`, `~/.codex`)
on named volumes so session resume survives stop/start/restart; runs are
`docker exec`s of the same runner-host entry the systemd path uses, so
steer/cancel/reattach-after-restart all work. Verify end-to-end with
`bun run deploy/sandbox/verify.ts` (safe next to a live server — everything
is `sbxtest-*` scratch), and keep the conformance matrix green:

```sh
bun run deploy/sandbox/conformance.ts docker-socket docker-ws
```

For the retired host-engine boundary's regression coverage, the legacy verifier
still exists:

```sh
bun run deploy/sandbox/verify-external-engine.ts --provider daytona --provider modal
bun run deploy/sandbox/verify-external-engine.ts --provider microvm --restart
```

This no longer certifies the shipped architecture: remote providers and
MicroVMs now run the engine inside the sandbox. Use the behavioral conformance
matrix above for current certification.

### Daytona (implemented, live-certified 2026-08-11)

Self-hostable sandbox platform (Helm/K8s) with a hosted cloud. The adapter
(`packages/core/opensession-server/src/server/sandbox/adapters/daytona.ts`) creates sandboxes over the
Daytona API/SDK: volume-style workspace cloned in-sandbox over https
(`cloneCredential`), ws transport always, runner bootstrapped on first
ensure. A prewarm clones the repo, runs `.agents/setup`, scrubs clone and
model authority, and publishes a Daytona snapshot. The image registry refreshes
source snapshots every 30 minutes without discarding the old mapping until the
replacement is ready. Later sessions restore that artifact, fetch only the
small source delta, and skip setup. Preparation inputs such as `bun.lock` and
`.agents/setup` invalidate the image separately. Idle-stop is
native (`autoStopInterval`).

- Connect in Workspace → Sandboxes with a Daytona API key and a reachable
  public callback origin. Settings owns region/resource/snapshot overrides;
  private-repo clone authority remains a separately scoped runtime concern.
- **Org-tier egress caveat (hosted Daytona):** Tier 1/2 orgs restrict
  sandbox egress, which blocks the WS dial-back entirely — `launchRun`
  needs a **Tier 3 org or self-hosted Daytona**. Workspace clone/exec work
  on lower tiers; runs don't.
- Certify against your own account/deployment:
  `bun run deploy/sandbox/conformance.ts daytona` (needs the API key; runs
  a source sandbox and a distinct restore sandbox, destroys both, then lists
  the org's sandboxes to prove nothing leaked). The full matrix — incl.
  the launchRun round-trip + steer/cancel + mid-run WS drop/redial — went
  41/41 green 2026-08-11 against hosted Daytona (Tier 3), including an exact
  sealed-filesystem restore into a second sandbox, setup non-reexecution,
  real agent execution, and WS reconnect/steer/cancel, dialing back over
  the public ingress (`SBX_CONF_LISTEN_PORT=3860
  SBX_CONF_PUBLIC_BASE=wss://your.domain`).

### E2B (implemented, NOT yet certified)

Firecracker microVM sandboxes; hosted cloud plus an OSS self-host stack
(Terraform/Nomad, GCP full / AWS beta — heavyweight; we document it, we
don't operate it). The adapter (`packages/core/opensession-server/src/server/sandbox/adapters/e2b.ts`) is
written to the same contract as Daytona (volume-style workspace, ws
transport, bootstrap on first ensure) but has **not been run against a live
E2B account** — treat it as untested until the conformance suite passes.

- Config: `provider: "e2b"` + the `e2b` block (or `E2B_API_KEY`).
- Lifetime model differs: an E2B sandbox lives on a countdown that activity
  extends — **expiry KILLS the sandbox and its workspace** (vs. Daytona's
  stop/start). Push early.
- To certify: `bun run deploy/sandbox/conformance.ts e2b` with credentials,
fix what fails, and record the certification in this doc + the plan.
Until then, the adapter is available only to the conformance harness; it is
hidden from the picker and rejected by session creation/prewarm.

### Box / ascii.dev (live-certified 2026-08-13)

Persistent Ubuntu VMs from box.ascii.dev, integrated through its public HTTP
API without an SDK dependency. Connect an API key in **Workspace →
Sandboxes**. It is stored as an opaque workspace secret; new Boxes use
`noEnv: true`, so account-level Box/Git/agent credentials are never inherited.

- Projects opt in independently. Preparation runs the repository setup inside
  a Box, scrubs launch credentials, and publishes a named snapshot. Subsequent
  prewarms and sessions restore that exact prepared filesystem and are sized
  with Box's fixed **Small** (2 vCPU / 4 GB / at least 40 GB), **Default** (4 /
  8 GB / at least 80 GB), or **Large** (8 / 16 GB / at least 100 GB) profile.
- Warm-on-typing creates a Box while the user composes and the new session
  adopts it. Cold creation falls back cleanly when a named snapshot has gone
  stale. The image registry replaces the named snapshot every 30 minutes. A
  session then fetches only its requested branch and resets the lazy checkout
  to that small delta, rather than fetching every ref and hydrating the 9.6 GB
  filesystem. Feature-branch sessions therefore never begin on snapshot main.
- The command API's synchronous limit is 600 seconds. Longer work and
  background commands use Box's native detached-process endpoint and poll its
  separate stdout/stderr and exit status.
- A TTL archives idle Boxes. Archive releases compute, resume preserves the
  workspace, and opening a Shell tab wakes the Box. The Shell uses Box's
  authenticated SSH-key endpoint and a dedicated host-only Open Session key.
- Private previews use `host <port> --private`. Their `_token` remains only in
  the provider URL stored server-side; Open Session's Caddy Portal authenticates
  the user and appends that token while proxying, so browsers receive only the
  normal session Portal URL.
- Box's current public API intentionally offers archive rather than hard
  deletion. Removing a session archives its Box and forgets the Open Session
  association; the no-compute archived entry remains visible in the user's Box
  account. Prepared named snapshots can be deleted and rebuilt normally.
- Workspace qualification checks credentials and quota, outbound dial-back,
  command semantics, `/home/ubuntu` file writes, private previews,
  archive/resume persistence, and a distinct named-snapshot restore. The full
  release gate is `bun run deploy/sandbox/conformance.ts box`. The live matrix
  passed on 2026-08-13, including a real agent run, reconnect, steer/cancel,
  archive/resume, and an independent named-snapshot restore. Box serializes
  concurrent command admission per VM, so a launch behind a long command is
  bounded at 45 seconds rather than the 10-second parallel-lane target used by
  Daytona and Modal.

### Modal (implemented, live-certified 2026-08-11)

Modal sandboxes are ephemeral containers created through the official
Apache-2.0 TypeScript SDK. The adapter (`packages/core/opensession-server/src/server/sandbox/adapters/modal.ts`)
uses the same volume-style workspace, remote bootstrap, and WebSocket dial-back
contract as the other remote providers.

- Connect in Workspace → Sandboxes with a Modal token ID and secret. The
  connection owns app/environment, registry image, region, cloud, CPU and
  memory settings; CPU and memory are hard limits as well as reservations.
- Modal encrypted tunnel URLs are public Internet endpoints. Preview tunnels
  stay disabled unless `modal.publicPreviews` is explicitly `true`; only use
  that option for dev servers that are safe to expose publicly.
- Modal caps a sandbox's lifetime at 24 hours and deletes a terminated
  container's filesystem. After each clean turn Open Session therefore writes
  one session-private filesystem Image. An idle or near-lifetime follow-up
  restores that exact workspace, including uncommitted work, before syncing
  credentials and starting the runner. Each successful checkpoint replaces the
  previous one; session deletion removes it.
- The prewarm adapter publishes credential-free Modal filesystem Images after `.agents/setup`
  and credential scrubbing. The image registry refreshes them every 30 minutes,
  while input signatures rebuild immediately when setup or lockfiles change.
  A restored prewarm preserves the exact seal and setup output, then is adopted
  by the session. Shell-tab remote PTY remains provider-dependent work.
- The 41/41 live conformance pass covered provisioning, bootstrap, git/exec,
  idempotent reuse, encrypted preview tunnels, a distinct filesystem-image
  restore, real agent execution, WS reconnect/steer/cancel, and cleanup.
  Modal's SDK file-upload helper uses
  `ReadableStream.from`, which Bun lacks; the adapter's streamed-stdin fallback
  was separately verified against a disposable live sandbox with read-back.
- Re-run with `bun run deploy/sandbox/conformance.ts modal`; remote dial-back
  requires a public ingress whose token registry belongs to that test process.

### AWS Lambda MicroVMs (experimental, NOT yet certified)

AWS Lambda MicroVMs are Firecracker VMs purpose-built for agent sandboxes. The
adapter (`packages/core/opensession-server/src/server/sandbox/adapters/lambda-microvm.ts`) uses the AWS SDK
control plane and authenticated HTTP requests to the structured command daemon
in `deploy/sandbox/lambda-microvm/`.

- Build the ARM64 image first using
  `deploy/sandbox/lambda-microvm/README.md`, then set
  `awsLambdaMicrovm.imageIdentifier`. Ambient AWS credentials must allow the
  MicroVM lifecycle/token APIs and `iam:PassRole` when an execution role is set.
- Runtime disk and background processes survive AWS suspend/resume, and the
  adapter wakes a suspended VM before command/restart recovery. Automatic idle
  suspension is disabled by default because an active run's outbound dial-back
  traffic does not count as endpoint activity to AWS; opt in with
  `idleSuspendSeconds` only when that tradeoff is acceptable.
- Every VM has a hard eight-hour lifetime including suspended time. The adapter
  rotates 30 minutes before expiry only after proving the repo is clean and has
  no commits ahead of upstream. Runtime disk and engine state are not durable
  across that rotation, so the next turn starts a fresh engine. EFS-backed
  rollover remains a follow-up for truly persistent sessions.
- The image runs on ARM64 and needs enough baseline memory/disk for the runner
  and target repo. The AWS image configuration, not this per-run adapter,
  controls those resources.
- `executionRoleArn` is optional. If used, it must be a dedicated least-
  privilege role: agent code has root-equivalent control inside the VM and can
  use every permission granted to that role.
- Preview ports intentionally return no URL yet. AWS requires expiring auth
  headers on every request, so browser previews need an Open Session reverse
  proxy rather than exposing the raw endpoint.
- No prewarm adapter or Shell-tab integration yet.
- To certify: `bun run deploy/sandbox/conformance.ts lambda-microvm` after the
  image and IAM resources exist.
Until then, the adapter is available only to the conformance harness; it is
hidden from the picker and rejected by session creation.

## Licensing notes

- **Daytona** is AGPL-3.0. Open Session consumes it **over its API** (via the
  Apache-2.0 `@daytonaio/sdk`) and vendors none of its code, so AGPL
  obligations sit with whoever *operates* the Daytona deployment, not with
  Open Session's codebase. Self-hosters running Daytona themselves take on
  AGPL's network-service obligations for their Daytona instance.
- **E2B**: the JS SDK is MIT; the self-host infra repo is Apache-2.0.
- **Modal**: the official `modal` TypeScript SDK is Apache-2.0.
- **AWS Lambda MicroVMs**: the AWS SDK client is Apache-2.0.
- **Docker provider**: plain `docker` CLI against your own daemon; nothing
  vendored.
- Core imports adapter SDKs only inside `packages/core/opensession-server/src/server/sandbox/adapters/` —
  a build without those files carries no third-party sandbox code.

## Security posture (what a sandbox does and doesn't isolate)

- Process/env/resource isolation per session; minimal env (no
  `~/.opensession.env` tokens); IMDS blocked (setup-host.sh / the systemd
  `IPAddressDeny` mirror).
- Docker interactive mounts carry **interactive-level ambient trust**: `~/.ssh`,
  `~/.gitconfig`, `~/.config/gh` are mounted read-only for push/PR parity.
  That's the same trust host runs have today. Automations never use this path;
  they require the credential-minimal MicroVM profile described above.
- Volume mode removes the host-worktree mount entirely (per-session disk,
  instant cleanup) at the cost of the destroy-deletes-work contract.

## MicroVM preview backend (Firecracker snapshots)

The preview pool's third backend (`backend: "microvm"`, the default since
2026-07-24) restores Firecracker clones from a golden **memory snapshot** —
claims serve in ~2-5s with zero warm RAM. Requires KVM (`/dev/kvm`): on AWS
that means a bare-metal instance or the 8i-generation nested-virt families
(C8i/M8i/R8i). Assets live in `deploy/sandbox/microvm/`:

- `refresh-golden.sh` — docker-golden → `docker export` → ext4 rootfs
  (`build-rootfs.sh` injects `bks-init` as PID 1 plus the control.py agents)
  → boot under Firecracker → warm routes → pause → Full snapshot → kill.
  The canonical store paths and the tap name/guest IP are **load-bearing**:
  the vmstate embeds them. The base disk is frozen at pause time — never
  boot it read-write again.
- `clone.sh create|destroy <idx>` — per-claim: reflink COW disk (the store
  MUST be XFS — `/opt/firecracker/store.img` loop-mounted via fstab), a
  private netns recreating exactly `bkstap0`/172.16.100.2, snapshot load
  (~18ms), guest clock resync via the root agent (SigV4 tolerates <5min
  skew). VMs run in transient scopes (`os-fc-clone<idx>`) so they survive
  opensession restarts.
- `bks-host-setup.service` — boot oneshot re-arming the docker/guest IMDS
  drop rules. Enable it; nothing else needs manual re-arming after reboot.

Host prereqs: `firecracker` + a CI `vmlinux` under /opt/firecracker, the
service user in the `kvm` group, the XFS store mounted. Firecracker runs
unprivileged in a per-clone chroot with the same capability/device/seccomp
hardening as session MicroVMs. Claims still need ~8GB free page cache for
comfort (the memory file is pre-faulted), and un-pushed branches ship to clones
via the agent `/files` channel (30MB bundle cap).
