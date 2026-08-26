# Self-development: working on Open Session with Open Session

Open Session can develop itself: open a session on the `opensession` repo, edit
the server, and press **Preview** to boot your edited code as an isolated dev
instance next to the one you are using. This doc explains the pieces and their
boundaries.

## The dev instance

A dev instance is `bun run packages/core/opensession-server/opensession.ts` with:

- `OPENSESSION_DEV=1` — historically this only swapped the frontend pipeline:
  serve the UI through Bun's HMR dev server instead of the prebuilt
  `.frontend-dist` bundle. It gated nothing on the backend. With the dev boot
  gate, `OPENSESSION_DEV=1` additionally skips every boot side effect that
  talks to the outside world or to shared state: integration agents
  (Slack/Linear/Plain/GitHub/Stripe/Grafana), public webhook intake, the cron
  automation scheduler and all background tickers/sweeps, the public-ingress
  listener, detached-engine-server adoption, run resume/redelivery, and the
  seed writes to automations. What remains is the web server, the
  session store, and the UI.
- `OPENSESSION_DEMO=1` — demo mode. On first boot it idempotently seeds
  generated sessions, transcripts, repository and PR state, automations, audit
  data, and a goal, then registers a demo ask card and starts the transcript
  replayer. It requires `OPENSESSION_STATE_DIR`.
- `OPENSESSION_STATE_DIR=<dir>` — root for all instance state. The session
  store, config, automations, sandbox config, run-rpc unix socket, and the other
  stores normally grouped under `~/.opensession/` resolve under this directory
  instead, so a dev instance never reads or writes the operator's live stores.

None of these flags change anything when unset: an unflagged boot is
byte-identical to today's behavior.

## Previewing your own change

The Preview button uses the repo's own lifecycle scripts, the same convention
every other repo uses ([repo-lifecycle.md](repo-lifecycle.md)):

- `.agents/setup` — one-shot per worktree: `bun install
  --frozen-lockfile`. Safe to re-run.
- `.agents/start.sh` — boots the dev instance in the foreground on
  `$WEBAPP_PORT`, loopback only, with the three flags above and
  `OPENSESSION_STATE_DIR=$PWD/.dev-state`.

For a host preview when no warm-pool claim is available, pressing Preview
allocates a port (3100–3999), runs the `setup` hook once, and launches
`start.sh` detached with cwd = the session's checkout. Caddy fronts the port at
`https://<host>:<port+6000>` (the `PREVIEW_URL` in the button). Stop kills the
script's process group, which kills the instance because `start.sh` `exec`s it.

A warm-pool preview may adopt an already-running container instead. A sandbox
preview launches `start.sh` inside the sandbox on a pre-published container
port and uses a separately allocated HTTPS route in 20000–27999, so the
3100–3999 and port+6000 rules are host-specific.

`start.sh` is deliberately paranoid: the environment it inherits is the
calling server's production env (ports, agent toggles, secrets), so it
overrides or unsets every operationally significant variable rather than
inheriting anything — the production port is explicitly refused. Read the
comment block in the script for the variable-by-variable rationale.

`.dev-state/` (plus the preview flow's `.ports.conf` / `.ports/`) appears in
the checkout the preview ran from; it is disposable and must stay gitignored.

## What a dev instance does NOT cover

Live integrations are out of scope by design. A dev instance has no Slack,
Linear, Plain, Stripe, Grafana, or GitHub agents, receives no webhooks, and runs
no cron automations. It does not adopt or resume detached run hosts left by an
earlier process. The current `.agents/start.sh` disables the executor but does
not set `OPENSESSION_PI_DETACH=0`, so Pi turns may still attempt a transient
detached run host and fall back in-process if launch is unavailable.

You cannot use a dev instance to test "did my change fix the Slack agent"
end-to-end. Verify that class of change with tests plus a real deploy. Engine
runs depend on engine credentials and are best treated as untested from a
preview.

## Deploying your change: `deploy_self` and the canary

The complement of previews is the `opensession-self-deploy` in-process MCP
server (interactive sessions only, never automations, never dev instances):
`deploy_self({ sha?, confirm: true })` launches `deploy/self-deploy.sh` as a
transient system unit so the sequence survives its own restart. The script
fetches and fast-forwards the checkout with `git merge --ff-only`. Divergence
or local changes that conflict with the fast-forward abort it, but unrelated
dirty changes do not always block it. It records the pre-deploy HEAD as a
last-known-good pin, restarts and readiness-checks the executor and
session-kernel services, then restarts `opensession.service`. The health gate
requires three consecutive responses with the same `bootId` from the
configured `OPENSESSION_HEALTH_URL`. The script defaults to
`http://127.0.0.1:3850/ready`; `opensession service install --system` configures
the helper with `OPENSESSION_HEALTH_URL`, or defaults it to
`http://127.0.0.1:3850/api/health`.

On failure the script attempts rollback. Moving the tree back requires both a
clean tree and `OPENSESSION_DEPLOY_ALLOW_RESET=1`; otherwise it records
`rollback-needed` and leaves the tree for a human. Rollback is also refused
when the pin is below the durable session-kernel schema floor.
`deploy_status({})` reads the pin, the last result, and the deploy-marker age.
The watchdog itself acts only during the first 15 minutes. The current
`deploy_status` `OPEN` label does not expire at that cutoff.

Prerequisites — **your own remote first**: self-sessions commit and push to
`origin`, and `deploy_self` fast-forwards from `origin/main`. If your checkout
was cloned straight from `tellahq/opensession`, every push is rejected (you
can't write to our upstream) and, after your first local commit, ff-only
deploys abort permanently because your history has diverged from ours. Clone
your **fork** (keep `tellahq/opensession` as an `upstream` remote to pull our
updates), and in worktree mode set the self repo's `ghRepo` in your config to
the fork so the PR flow targets it. On Linux/systemd, run
`opensession service install --system` once from the service user account and
allow its sudo prompts. The default command without `--system` installs a
rootless user service and does not install the fixed run-host helper or
self-deploy grants.

Staying current is one command: **`opensession update`**. It refuses a dirty
checkout, detects fork topology (origin = your fork + an upstream remote),
fetches upstream, and either fast-forwards or creates an honest merge commit.
It never rebases, and conflicts abort cleanly back to your tree. For a fork it
attempts to push the result to `origin`; a push failure is only a warning, so
the local update and dependency install continue.

For a source checkout, update uses the health-gated self-deploy script only
when a service is installed, the script exists, and `sudo -n true` succeeds.
In that path the pre-update commit is the rollback pin. Otherwise an installed
service receives a plain restart with no rollback pin or health gate.
`opensession update --check` previews what it would pull without applying it.

The optional watchdog,
`deploy/systemd/opensession-watchdog.{service,timer}`, probes health every 60s
but only acts inside a 15-minute window after a self-deploy restart, after 3
consecutive failures, and at most once per deploy. The checked-in units are
host-specific templates. Before copying them, replace `User=ubuntu`,
`OPENSESSION_DEPLOY_STATE`, `OPENSESSION_DEPLOY_CHECKOUT`, `PATH`, and
`ExecStart` with this installation's service user, state directory, checkout,
and Bun path.

Install the adjusted units with:

```bash
sudo cp deploy/systemd/opensession-watchdog.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now opensession-watchdog.timer
```
