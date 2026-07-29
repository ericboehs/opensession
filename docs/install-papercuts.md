# Install papercuts

A running log of everything that made installing OpenSession harder than it
needed to be, and what was done about it. Kept while reworking the install
experience ahead of open-sourcing (July 2026).

The bar being measured against is [opencode](https://opencode.ai) and
[openclaw](https://openclaw.ai): one curl command, a binary on `PATH`, and
named subcommands for onboarding and updates.

Most of these were found by **running the installer on a bare Ubuntu EC2 box**,
not by reading the code. That distinction matters — the first four were
invisible from the repository.

---

## Fixed

### 1. Bun's installer needs `unzip`, which minimal cloud images lack

**Symptom:** the very first install on a fresh Ubuntu 24.04 EC2 box died at
`installing Bun ...` with no useful output.

**Cause:** `bun.sh/install` shells out to `unzip`. The Ubuntu cloud AMI does not
ship it.

**Fix:** missing prerequisites (`curl`, `git`, `unzip`) are installed via
apt/dnf/apk when passwordless sudo is available. When it is not, Bun is
downloaded and extracted with `python3 -m zipfile` instead, which works on
essentially every Linux image. A box with neither `unzip` nor sudo now
installs — that covers containers and locked-down hosts, not just this one.

### 2. The installer leaked a credential into the terminal

**Symptom:** installing from the private repo printed

```
source      https://x-access-token:github_pat_11BS...@github.com/tellahq/opensession.git
```

**Cause:** the plan banner echoed `$OPENSESSION_REPO` verbatim.

**Fix:** URLs pass through a `redact()` helper before printing, including in
git's own failure output (git echoes the remote URL when a clone fails). Shows
as `https://***@github.com/...`.

This one is worth remembering when the repo goes public and tokenised URLs stop
being the common case: the leak was silent, and it would have been in every CI
log.

### 3. Failure output was sent to `/dev/null`

**Symptom:** `error   Bun install failed` and nothing else. Undiagnosable.

**Cause:** `curl ... | bash >/dev/null 2>&1` in the installer.

**Fix:** installer sub-steps capture their output to a temp file and print the
tail on failure. Papercut #1 took one extra round-trip to diagnose purely
because of this.

### 4. No engine was installed

**Symptom:** the server starts, the UI loads, every session fails.

**Cause:** nothing installed OpenCode. `opencode-with-claude` is a dependency
but does not put an `opencode` binary on `PATH`.

**Fix:** the installer installs OpenCode by default (`--no-engine` opts out).

### 5. The shim ran with a `PATH` too thin to find the engine

**Symptom:** `doctor` reported `Bun missing` while running under Bun.

**Cause:** the generated shim exec'd bun by absolute path without exporting its
directory. A shim invoked from a non-login shell (ssh, cron, systemd) therefore
ran with a `PATH` containing neither bun nor opencode — and the server resolves
its engine through `Bun.which("opencode")`, so it would have silently found no
engine at runtime.

**Fix:** the shim exports `bun`/`~/.opencode/bin`/`~/.local/bin` onto `PATH`
before handing off. `doctor` additionally trusts `process.execPath` over a
`PATH` lookup for Bun specifically.

### 6. `opensession.service` could not be installed anywhere but Tella's box

**Cause:** the checked-in unit hardcodes `User=ubuntu`,
`WorkingDirectory=/home/ubuntu/projects/tella-backstage` and
`/home/ubuntu/.bun/bin/bun`.

**Fix:** `scripts/lib/service.ts` renders it per box, rewriting those five
directives and preserving every tuning comment (`KillMode=mixed`, the drain
window, the IMDS block) — those encode real incidents and a fresh install wants
them too.

### 7. Integrations defaulted to on

**Cause:** `ENABLE_*` flags default ON in code, and only the literal string
`"false"` disables them. A fresh install with no credentials started every agent
loop against nothing.

**Fix:** onboarding writes an explicit value for every integration. The
asymmetry itself is preserved (it is long-standing behaviour) but is now pinned
by a test so it cannot drift silently.

### 8. There was no way to *run* anything

**Cause:** the install path ended at `bun run opensession.ts`. `bun run setup`
is not something you can reasonably tell a self-hoster to run.

**Fix:** an `opensession` command with `onboard`, `start`, `stop`, `restart`,
`status`, `logs`, `doctor`, `update`, `integrations` and `version` — matching
the surface `openclaw` exposes.

### 9. Integrations existed only as control flow

**Cause:** each of plain/tella/linear/slack/stripe/grafana/github was a
hand-written `if` block in `loadAgents()`, and its environment variables were
documented only in prose.

**Fix:** `src/server/integrations/registry.ts`. Each integration declares its
config key, env flag, credentials and constructor in one place; `loadAgents()`
is a loop. This is what makes onboarding able to enumerate integrations and
`doctor` able to report a specific missing credential.

---

## Fixed — documentation

### 10. The documented clone URL was stale

`docs/setup/install.md` cloned `tellahq/backstage.git`. The repository is now
`tellahq/opensession`. It worked via GitHub's redirect, so it failed *quietly*
rather than loudly.

### 11. README and install.md disagreed on the directory name

README said clone into `opensession`, `install.md` said `tella-backstage`, and
the default `mcp-config` path is derived from the directory. Following the
README produced a wrong default. Both now describe the same layout, which the
installer creates for you.

---

## Fixed — provisioning

### 12. The recommended EC2 command broke `sudo` on the instance

**Symptom:** `sudo: a password is required` for the `ubuntu` user on a stock
Ubuntu AMI. `/etc/sudoers.d/` contained only `README`, and `id` showed
`groups=1000(ubuntu)` — no `sudo`, no `adm`, no `docker`.

**Cause:** passing user-data of the form

```yaml
#cloud-config
users:
  - name: ubuntu
    ssh_authorized_keys: ["ssh-ed25519 ..."]
```

*replaces* cloud-init's default user definition. The default carries
`sudo: ALL=(ALL) NOPASSWD:ALL` and the standard group memberships; redefining
`ubuntu` drops both.

**Fix:** add keys with the top-level `ssh_authorized_keys` module instead, which
appends to the default user without redefining it. See
[docs/setup/ec2.md](setup/ec2.md).

This is a good example of why the EC2 doc is worth having: the failure appears
long after provisioning, as an unrelated-looking permissions error.

---

## Fixed — macOS

### 16. The installer and CLI were Linux-only

Three separate assumptions:

- **Package installs assumed sudo + apt.** Homebrew installs as the invoking
  user, and asking for sudo on macOS is actively wrong. `install_package` now
  branches on `uname -s`.
- **The Bun fallback downloaded Linux binaries.** The arch case mapped
  `arm64 -> bun-linux-aarch64`, which on Apple Silicon would have fetched a
  Linux build. Platform is now part of the target name, and the
  baseline-binary retry is skipped on arm (only x64 has a baseline variant).
- **Service management was systemd-only.** macOS now gets a per-user
  **LaunchAgent**, which needs no root at all — a nicer story than the Linux
  path, where installing the unit needs sudo.

The launchd translation has one wrinkle worth recording: launchd has no
equivalent of systemd's `EnvironmentFile`, so the agent execs through
`/bin/bash -c 'set -a; . ~/.opensession.env; exec bun run opensession.ts'`.
Without that, none of the integration flags or secrets would reach the server
and it would boot looking healthy but inert.

`supervisor()` returns `systemd | launchd | none`, and `start/stop/restart/
status/logs/install` all branch on it. `logs` tails the plist's
`StandardOutPath` on macOS, since there is no journal.

Verified as far as is possible without a Mac: the generated plist parses with
Python's `plistlib` and carries the right label, `RunAtLoad`, `KeepAlive`,
exec line and `PATH`. **End-to-end macOS install is still untested.**

### 13. `OPENCODE_BIN` fell back to a hardcoded Tella path

`src/server/opencode-runner.ts` resolved the engine as `env ->
Bun.which("opencode") -> nvm scan -> ${HOME}/.nvm/versions/node/v20.20.0/bin/opencode`.

That last fallback is a specific nvm version path from Tella's box. It is only
reached when everything else fails, so it never broke anything here — but on
someone else's machine the resulting error names a directory they have never
heard of. It now falls back to `~/.opencode/bin/opencode`, which is where
opencode.ai's own installer puts it.

### 15. `gh` was not installed

PR operations need it. The installer now installs it best-effort (it is never
fatal, and it needs its own `gh auth login` regardless, so this only gets you
half way — but it removes a `doctor` warning from every fresh install).

---

## Open

### 14. The systemd install path is not end-to-end tested

`opensession service install` needs root, and the test box has no working sudo
(papercut #12), so installing the unit, boot-on-reboot and `opensession logs`
have not been exercised on a clean machine.

Partially mitigated: the rendered unit is validated with `systemd-analyze
verify`, which parses it and checks every directive. It comes back clean, with
`KillMode=mixed`, `TimeoutStopSec=80` and the `IPAddressDeny` metadata block
preserved from the template. That proves the file is correct; it does not prove
`systemctl enable --now` behaves.

Needs a re-provisioned instance (with the corrected user-data from #12) to
close properly.

### 17. Prompts run together when answers arrive faster than a human types

Cosmetic, and an artifact of the test harness rather than a real bug: feeding
newlines into a pty makes Bun's `prompt()` render several questions on one
line, because the newline that normally separates them comes from the user's
own keypress echoing. A real interactive session looks correct. Recorded in
case it ever shows up in a scripted install.

---

## Timings

Full clean install on `m7i-flex.xlarge`, piped as `curl | bash`, wiping to bare
Ubuntu between runs:

| Iteration | Result | Time |
| --- | --- | --- |
| 1 | failed — no `unzip` | — |
| 2 | failed — `unzip` install needed sudo | — |
| 3 | installed, no engine | 7s |
| 4 | installed with engine | 8s |

Server reaches a healthy `/backstage/api/health` on a fresh box, loading only
the self-gating Tella module — the correct state for an install with no
integrations enabled.
