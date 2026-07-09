# Self-hosting sandboxes

How to run Backstage sessions inside isolated sandboxes on your own
infrastructure. Companion to `docs/sandboxes-plan.md` (the architecture and
phase plan) and `deploy/sandbox/README.md` (the runner image + provider
internals). This page is the operator's view: what to install, the full
config schema, the provider guides, and the safety switches.

**Default = no sandboxes.** With no config file, every session runs on the
host exactly as before. Sandboxes are opt-in per session (the "Run in
sandbox" toggle on session create, the `sandbox: true` arg on
`create_session`, or a per-automation `sandbox: true` field) and only take
effect once a provider is configured.

## TL;DR (Docker, the self-host default)

```sh
# 1. One-time host setup: block containers from the cloud metadata service
deploy/sandbox/setup-host.sh

# 2. Build the runner image (tags backstage-runner:latest + :<git-sha>)
deploy/sandbox/build.sh

# 3. Configure the provider
cat > ~/.backstage-sandbox.json <<'EOF'
{ "provider": "docker", "image": "backstage-runner:latest" }
EOF

# 4. Restart backstage (runner internals don't hot-reload)
sudo systemctl restart backstage

# 5. Verify
bun run deploy/sandbox/verify.ts
```

Then create a session with the sandbox toggle on. The session gets a
container named `bks-sbx-<sessionId>` that survives across turns; the badge
in the session header shows `docker · bind` (provider · workspace mode).

### What setup-host.sh does

Installs an idempotent `DOCKER-USER` iptables rule dropping container
traffic to `169.254.169.254` (EC2 IMDS) — the container mirror of the
`IPAddressDeny` the systemd units enforce, so sandboxed agent code can never
mint instance-role credentials. Off-cloud it's harmless. **Not persisted
across host reboots** — re-run it after one (or wire a `@reboot` cron /
systemd oneshot).

### Building the image

`deploy/sandbox/build.sh` builds `deploy/sandbox/Dockerfile` from the repo
root. Pins are `ARG`s — override with `--build-arg` per build:

| ARG | Default | Keep in lockstep with |
| --- | --- | --- |
| `BUN_VERSION` | 1.3.14 | host `bun --version` |
| `CLAUDE_VERSION` | 2.1.204 | host `claude --version` |
| `NODE_MAJOR` | 20 | host Node LTS |
| `OPENCODE_VERSION` | 1.17.15 | host opencode |

Rebuild whenever: the host Claude CLI or bun is bumped, `bun.lock` changes
(any dep, incl. the Agent SDK / vendored codex binary), or **anything under
`src/runner-host/` changes** — sandboxed runs execute the image's copy of
the runner, not your checkout.

### Path parity is load-bearing (do not "tidy" it)

The image reproduces the host's absolute paths exactly: the runner bundle at
`/home/ubuntu/projects/tella-backstage`, the claude CLI at
`/home/ubuntu/.local/bin/claude`, uid-1000 user `ubuntu`, and the session
worktree bind-mounted at its **identical host path**. That parity is what
lets diff/status/push/preview/@-mentions and Claude session resume work
unchanged (resume state is keyed by cwd). If your host's `$HOME` or checkout
path differs, **rebuild the image with matching paths** — see the audit note
in `docs/portability-audit.md` §6: this is the one place `/home/ubuntu`
coupling is intrinsic, not lazy.

## Config schema — `~/.backstage-sandbox.json`

Read fresh per run (no restart for value changes — but see "What needs a
restart" below). Missing file, invalid JSON, or unknown values all resolve
to `provider: "local"` (today's host behavior). Env override for the path:
`BACKSTAGE_SANDBOX_CONFIG` (used by the verify/conformance suites).

```jsonc
{
  // Which SandboxProvider new opted-in sessions get.
  // "local" (default) | "docker" | "daytona" | "e2b"
  "provider": "docker",

  // ── Docker provider ────────────────────────────────────────────────
  // Container image (default "backstage-runner:latest").
  "image": "backstage-runner:latest",
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
  //           is gone. Push your work. Attached repos + sibling chats are
  //           not supported in volume mode.
  "workspace": "bind",

  // Container ports published for previews (docker -p 127.0.0.1::<port> at
  // container create → random loopback host port; preview.ts routes the
  // same Caddy tailnet-HTTPS front at the published port). Default none.
  "previewPorts": [3300],
  // Allow startPreview to launch the dev-server bring-up INSIDE the
  // sandbox. Default false: only port-mapping + Caddy routing are active
  // (the stock image doesn't carry your app's dev toolchain).
  "devServerInSandbox": false,

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
    "tella-fusion": { "provider": "docker", "image": "backstage-runner:latest" }
  },

  // ── Transport (how the in-sandbox run host talks to backstage) ─────
  //  "socket" (default): unix socket in a bind-mounted run dir. Docker only.
  //  "ws": the sandbox DIALS OUT to backstage's /backstage/run-ws +
  //        /backstage/rpc-ws routes (token-authed, seq/ack replay on
  //        reconnect). Required for remote providers (daytona/e2b force it
  //        regardless of this value); docker can dogfood it.
  "transport": "socket",
  // Base URL sandboxes dial back to for the ws transport. MUST be reachable
  // FROM the sandbox: your Tailscale ts.net URL or a tunnel for remote
  // providers; 127.0.0.1 never works. http(s):// is normalized to ws(s)://.
  // Default derives from the server's HOST:PORT bind.
  "callbackBaseUrl": "ws://100.65.135.7:3850",

  // Isolated PUBLIC dial-back listener for remote providers — see the
  // "Public dial-back ingress" section below. When enabled with a
  // publicBaseUrl, remote (daytona/e2b) launches dial IT back instead of
  // callbackBaseUrl; docker always stays on callbackBaseUrl.
  "publicIngress": {
    "enabled": false,          // start the listener at boot (needs restart)
    "port": 3860,              // listen port (default 3860)
    "host": "127.0.0.1",       // bind (default loopback — front with Caddy/tunnel)
    "publicBaseUrl": "wss://your.domain"  // what sandboxes dial
  },

  // ── Remote providers ────────────────────────────────────────────────
  "daytona": {
    "apiKey": "dtn_…",         // falls back to DAYTONA_API_KEY
    "apiUrl": "…",             // optional (self-hosted Daytona)
    "target": "…"              // optional region/target
  },
  "e2b": {
    "apiKey": "e2b_…",         // falls back to E2B_API_KEY
    "template": "base"         // sandbox template id (default "base")
  },

  // How remote sandboxes authenticate `git clone` (they can't mount host
  // creds). "none" = public clone; "https-token" injects the token into the
  // https URL (GitHub PAT / x-access-token).
  "cloneCredential": { "type": "https-token", "token": "ghp_…" },

  // Remote runner bootstrap (first ensure() installs bun + the backstage
  // runner + claude CLI inside the sandbox — minutes cold):
  "runnerBundleUrl": null,     // tarball of the runner bundle (preferred)
  "runnerRepoUrl": null,       // git URL fallback (default: this checkout's origin)
  "runnerSha": null            // pinned ref (default: origin default branch)
}
```

## Public dial-back ingress (remote providers)

Remote sandboxes (Daytona/E2B) run on third-party compute and must dial back
to backstage's `/backstage/run-ws/<hostId>` and `/backstage/rpc-ws`
WebSocket routes from the **public internet**. The main server binds the
tailnet and carries the whole app — never expose it. Instead,
`src/server/public-ingress.ts` runs a **second, isolated Bun.serve** when
`publicIngress.enabled` is set:

**What it serves — and everything it will ever serve:**

| Path | What |
| --- | --- |
| `/backstage/run-ws/<hostId>` | WS upgrade — the run host's event stream |
| `/backstage/rpc-ws?host=…` | WS upgrade — the michael-* MCP proxy channel |
| `/ingress-health` | bare `200 ok` (monitors/probes) |

Every other path is a **bodyless 404** — no app routes, no API, no frontend,
no route disclosure. Auth is run-ws.ts's own (shared functions, not copies):
per-launch `wsToken`s keyed by hostId, registered only by ws-transport
launches, constant-time compared **before** the upgrade. With no sandboxed
runs in flight the token registry is empty and every upgrade is a 403.
Being internet-facing it additionally rate-limits upgrade attempts
**per client IP: 30/min → 429** (X-Forwarded-For-aware behind a local
reverse proxy; health is exempt). The main :3850 server keeps serving the
same routes for the tailnet path (docker-ws) — the ingress is additive.

The listener binds `127.0.0.1:3860` by default: something must terminate
TLS in front of it and forward ONLY those paths. Two permanent options:

1. **Public IP + DNS + Caddy path routes** (what michael.tella.dev does —
   needs :443 open in the security group and an A record):

   ```caddyfile
   your.domain {
       handle /backstage/run-ws/* {
           reverse_proxy localhost:3860
       }
       handle /backstage/rpc-ws {
           reverse_proxy localhost:3860
       }
       handle /ingress-health {
           reverse_proxy localhost:3860
       }
       # …whatever else the domain serves stays in its own handle blocks;
       # the ingress paths never reach it.
   }
   ```

   Caddy fetches/renews the certificate itself; set
   `"publicBaseUrl": "wss://your.domain"`.

2. **Named Cloudflare tunnel** (no inbound ports at all): a `cloudflared`
   service with an `ingress` rule mapping a hostname to
   `http://127.0.0.1:3860`, `publicBaseUrl` = that hostname. Survives
   restarts, no security-group changes; adds Cloudflare as a dependency in
   the dial-back path. (For one-off testing, a QUICK tunnel —
   `cloudflared tunnel --url http://127.0.0.1:3860`, ephemeral URL, no
   account — also works: pass it as `SBX_CONF_PUBLIC_BASE` to the
   conformance suite.)

Enabling/disabling the listener or changing its port/host is a **restart**
(it starts once at boot); `publicBaseUrl` is read per launch like the rest
of the config. Hosted-Daytona reminder: the sandbox side of this dial-back
needs **Tier 3 / self-hosted** egress — lower tiers block outbound traffic
so no ingress URL is reachable from inside.

## Kill switch

```sh
touch ~/.backstage-chats/disable-sandboxes
```

Checked per run: while the file exists every NEW run goes local regardless
of config — no restart needed. Remove the file to re-enable. Sessions with
**volume** workspaces are the exception to "goes local": their workspace
only exists inside the sandbox, so their prompts are refused with an
explanatory message instead of silently running against a missing dir.

## What needs a restart

The config file's *values* are read fresh per run. But everything the
sandbox path executes is **runner internals**, which `bun --hot` does NOT
propagate (see CLAUDE.md "Hot reload & restarts"):

- First-time enablement, provider/transport code changes, anything under
  `src/server/sandbox/`, `src/runner-host/`, run-ws/rpc-ws → real
  `systemctl restart backstage`.
- The publicIngress listener starts once at boot: enabling/disabling it or
  changing `port`/`host` → restart (`publicBaseUrl` value tweaks apply to
  the next launch without one).
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

### Daytona (implemented, live-certified — full launchRun matrix green 2026-07-09)

Self-hostable sandbox platform (Helm/K8s) with a hosted cloud. The adapter
(`src/server/sandbox/adapters/daytona.ts`) creates sandboxes over the
Daytona API/SDK: volume-style workspace cloned in-sandbox over https
(`cloneCredential`), ws transport always, runner bootstrapped on first
ensure (minutes cold — provider snapshots as a prebaked fast path are a
backlog item). Idle-stop is native (`autoStopInterval`).

- Config: `provider: "daytona"` + the `daytona` block (or `DAYTONA_API_KEY`)
  + a reachable dial-back URL (the `publicIngress` section above — hosted
  Daytona sandboxes are on the public internet, not your tailnet) +
  `cloneCredential` for private repos.
- **Org-tier egress caveat (hosted Daytona):** Tier 1/2 orgs restrict
  sandbox egress, which blocks the WS dial-back entirely — `launchRun`
  needs a **Tier 3 org or self-hosted Daytona**. Workspace clone/exec work
  on lower tiers; runs don't.
- Certify against your own account/deployment:
  `bun run deploy/sandbox/conformance.ts daytona` (needs the API key; runs
  one smallest-size, sbxtest-labeled sandbox and destroys it, then lists
  the org's sandboxes to prove nothing leaked). The full matrix — incl.
  the launchRun round-trip + steer/cancel + mid-run WS drop/redial — went
  27/27 green 2026-07-09 against hosted Daytona (Tier 3) dialing back over
  the public ingress (`SBX_CONF_LISTEN_PORT=3860
  SBX_CONF_PUBLIC_BASE=wss://michael.tella.dev`).

### E2B (implemented, NOT yet certified)

Firecracker microVM sandboxes; hosted cloud plus an OSS self-host stack
(Terraform/Nomad, GCP full / AWS beta — heavyweight; we document it, we
don't operate it). The adapter (`src/server/sandbox/adapters/e2b.ts`) is
written to the same contract as Daytona (volume-style workspace, ws
transport, bootstrap on first ensure) but has **not been run against a live
E2B account** — treat it as untested until the conformance suite passes.

- Config: `provider: "e2b"` + the `e2b` block (or `E2B_API_KEY`).
- Lifetime model differs: an E2B sandbox lives on a countdown that activity
  extends — **expiry KILLS the sandbox and its workspace** (vs. Daytona's
  stop/start). Push early.
- To certify: `bun run deploy/sandbox/conformance.ts e2b` with credentials,
  fix what fails, and record the certification in this doc + the plan.

## Licensing notes

- **Daytona** is AGPL-3.0. Backstage consumes it **over its API** (via the
  Apache-2.0 `@daytonaio/sdk`) and vendors none of its code, so AGPL
  obligations sit with whoever *operates* the Daytona deployment, not with
  Backstage's codebase. Self-hosters running Daytona themselves take on
  AGPL's network-service obligations for their Daytona instance.
- **E2B**: the JS SDK is MIT; the self-host infra repo is Apache-2.0.
- **Docker provider**: plain `docker` CLI against your own daemon; nothing
  vendored.
- Core imports adapter SDKs only inside `src/server/sandbox/adapters/` —
  a build without those files carries no third-party sandbox code.

## Security posture (what a sandbox does and doesn't isolate)

- Process/env/resource isolation per session; minimal env (no
  `~/.backstage.env` tokens); IMDS blocked (setup-host.sh / the systemd
  `IPAddressDeny` mirror).
- Phase 1 docker mounts carry **interactive-level ambient trust**: `~/.ssh`,
  `~/.gitconfig`, `~/.config/gh` are mounted read-only for push/PR parity.
  That's the same trust host runs have today — but it's why **automation
  sessions are refused** by the docker launcher in this phase; untrusted
  ticket text never runs with those mounts.
- Volume mode removes the host-worktree mount entirely (per-session disk,
  instant cleanup) at the cost of the destroy-deletes-work contract.
