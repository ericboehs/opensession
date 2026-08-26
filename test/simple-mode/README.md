# Simple-mode install harness

Checks the install path on a fresh Ubuntu box. Requirements and the bar it
measures against: [the simple-mode ADR](../../adrs/simple-mode.md).

Run from the repository root. The host needs Bun 1.4.0, the repository
dependencies, Git, curl, tar, and Lima 1.0.0 or newer. On macOS:

```sh
brew install lima                 # once
bun install --frozen-lockfile     # once per dependency update
bun test ./test/simple-mode/harness.test.ts
```

The first run downloads the Ubuntu image and Goss binary and can take
substantially longer than later runs. The Lima VM uses Ubuntu 24.04 with 4 CPUs, 8 GiB RAM,
and a 40 GiB disk.

## What it checks

By default the driver:

1. Builds the compiled release artefact for the target with
   `scripts/build-compile.ts`.
2. Creates an Ubuntu 24.04 Lima VM and mounts only the harness staging directory
   read-only.
3. Supplies the locally built tarball to `install.sh --artifact`, exercising
   the customer artefact path without installing Bun or cloning Open Session in
   the guest.
4. Requires the installer's persistent user service and health endpoint, runs
   the current Goss assertions, and creates a code session whose default repo
   reaches a checked-out worktree.
5. Runs uninstall and deletes the VM.

Goss 0.4.10 is downloaded and installed as test tooling by the driver. The
current assertions in `goss.yaml` cover installed files and commands, `doctor`,
the loopback listeners on ports 3850 and 3860, health, and embedded frontend
assets.

`SIMPLE_MODE_STRICT=1` additionally runs `goss.dod.yaml`, reboots a Lima VM and
checks it again, verifies that uninstall preserves a worktree with unpushed
commits, then checks a clean uninstall with `goss.uninstalled.yaml`. These are a
subset of the ADR's definition of done. In particular, a real turn is opt-in
and the five-minute install-inclusive target is not enforced.

For the strict rootless Linux path, use:

```sh
SIMPLE_MODE_STRICT=1 SIMPLE_MODE_NOSUDO=1 \
  bun test ./test/simple-mode/harness.test.ts
```

The normal Lima user has passwordless sudo. `SIMPLE_MODE_NOSUDO=1` instead uses
the provisioned `nosudo` guest account, although `lima.yaml` pre-enables linger
for that account and therefore does not prove installer-driven linger setup.

## Options

- `SIMPLE_MODE_TARGET=lima` is the default. `host` runs directly on the current
  machine and skips the reboot check. Use `host` only on a disposable CI runner
  or throwaway account: the harness installs into that user's home, changes its
  shell profiles, and may leave state behind if a test fails. With
  `SIMPLE_MODE_NOSUDO=1`, host mode also requires an existing `nosudo` account
  and permission to invoke `sudo -u nosudo`.
- `SIMPLE_MODE_VM=opensession-simple` sets the Lima instance name.
- `SIMPLE_MODE_KEEP=1` skips VM deletion. The uninstall tests have already run
  when the harness completes, so this preserves the final VM for inspection,
  not a running Open Session install.
- `SIMPLE_MODE_REUSE=1` reuses an existing named VM instead of recreating it.
  The VM must have been created by this harness with the expected mount and
  provisioning.
- `SIMPLE_MODE_NOSUDO=1` runs install and checks as the `nosudo` user.
- `SIMPLE_MODE_SOURCE=1` bundles the current committed branch or detached HEAD
  and passes it to `install.sh --repo`; the guest then installs Bun and runs
  `bun install`. Uncommitted host changes are not included. Do not combine this
  with strict mode, whose artefact-specific assertions require no source
  checkout.
- `OPENSESSION_TEST_CLAUDE_TOKEN` seeds a Claude account and enables one real
  agent turn. Without it, session coverage stops at worktree setup. The harness
  allows up to eight minutes after session creation for that turn.

To inspect a VM retained with `SIMPLE_MODE_KEEP=1`:

```sh
limactl shell opensession-simple
```

Build output and the cached Goss binary live under
`${XDG_CACHE_HOME:-~/.cache}/opensession-release/`. Files copied into the target
are staged in the ignored `test/simple-mode/.work/` directory.

## Files

- `harness.test.ts`: ordered `bun test` driver. It is not included in the
  repository's default `bun test` paths.
- `lima.yaml`: Ubuntu VM and `nosudo` provisioning.
- `goss.yaml`: current post-install assertions.
- `goss.dod.yaml`: strict service, linger, doctor, and critical-path
  assertions.
- `goss.uninstalled.yaml`: strict clean-uninstall assertions.
