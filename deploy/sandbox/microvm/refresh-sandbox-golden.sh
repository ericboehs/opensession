#!/bin/bash
# Build the credential-free Firecracker golden for the `microvm` sandbox
# provider. This intentionally does NOT reuse the preview-pool golden.
#
# Usage:
#   sudo -n bash refresh-sandbox-golden.sh [store-dir] [docker-image]
#
# With no image argument this builds two images and exports the second:
#   1. Dockerfile.workspace — the minimal guest tool baseline, and
#   2. Dockerfile.runner    — the full opensession runner payload on top,
#      laid out exactly like `bootstrapRemoteSandbox` would install it
#      (docs/self-hosting-sandboxes.md, Slice A). The payload pins
#      (runnerSha, runner version, bootstrap signature) are computed from
#      the live sandbox config via bootstrap.ts, so the baked marker is
#      byte-identical to what ensure() expects and the bootstrap
#      short-circuits to a no-op.
#
# Passing an image explicitly remains available for controlled experiments and
# skips both builds.
#
# The resulting store contains golden.{ext4,mem,vmstate} plus golden.json
# ({ signature, builtAt, runner, runnerSha } — the store's build metadata,
# for staleness reporting; the in-VM marker stays the source of truth) and can
# be selected with:
#   {"firecrackerMicrovm":{"enabled":true,"storeDir":"/opt/firecracker/sandbox-store"}}
#
# Publication is locked against concurrent clone creation (.refresh.lock) and
# rolls back disk/memory/vmstate/metadata as one generation on failure. The
# golden stays credential-free: the clone token only ever exists in a BuildKit
# secret during the runner build, and the baked checkout's origin is scrubbed
# back to plain https.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
STORE="${1:-/opt/firecracker/sandbox-store}"
IMAGE="${2:-opensession-runner-microvm:latest}"
WORKSPACE_IMAGE="opensession-workspace-microvm:latest"
API=/tmp/fc-sandbox-golden.sock
PID_FILE=/tmp/fc-sandbox-golden.pid
GUEST_IP=172.16.100.2
SWAPPED=0
SUCCESS=0
SECRET_FILE=""

# The pin computation must read the operator's sandbox config
# (~/.opensession-sandbox.json) even under sudo, and needs a bun binary.
CFG_HOME="${HOME:-/root}"
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  CFG_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
fi
BUN_BIN="$(command -v bun || true)"
[ -n "$BUN_BIN" ] || BUN_BIN="$CFG_HOME/.bun/bin/bun"
[ -x "$BUN_BIN" ] || { echo "[sandbox-golden] bun not found (looked at PATH and $CFG_HOME/.bun/bin/bun)" >&2; exit 1; }

# Compute the payload pins the same way the server does — by importing
# bootstrap.ts. Output lines: 1) bootstrapSignature(), 2) cfg.runnerSha (may
# be empty = unpinned), 3) the clone URL (only when requested — it can carry
# a token, so it is never echoed and rides into docker as a BuildKit secret).
compute_pins() {
  (
  cd "$ROOT"
  # Server-env parity: the systemd unit loads ~/.opensession.env
  # (EnvironmentFile=), and injectToken prefers a live GITHUB_API_TOKEN from
  # the environment over persisted config tokens. Load the same file here so
  # the pin computation resolves the clone URL exactly like the server would
  # (a real env var also outranks the repo-local .env bun auto-loads).
  if [ -f "$CFG_HOME/.opensession.env" ]; then
    set -a; . "$CFG_HOME/.opensession.env"; set +a
  fi
  HOME="$CFG_HOME" GOLDEN_WANT_CLONE_URL="${1:-}" "$BUN_BIN" -e '
import { bootstrapSignature, remoteCloneUrl } from "./src/server/sandbox/adapters/bootstrap.ts";
import { sandboxConfig } from "./src/server/sandbox/config.ts";
import { REPO_ROOT } from "./src/runner-host/protocol.ts";
const cfg = sandboxConfig();
console.log(bootstrapSignature());
console.log(cfg.runnerSha || "");
if (process.env.GOLDEN_WANT_CLONE_URL) {
  let url;
  if (cfg.runnerRepoUrl) {
    // Mirror bootstrap.ts toHttpsUrl+injectToken for the explicit-URL case.
    let https = cfg.runnerRepoUrl;
    const scp = https.match(/^git@([^:]+):(.+?)(\.git)?$/);
    const ssh = https.match(/^ssh:\/\/git@([^/]+)\/(.+?)(\.git)?$/);
    if (scp) https = `https://${scp[1]}/${scp[2]}.git`;
    else if (ssh) https = `https://${ssh[1]}/${ssh[2]}.git`;
    if (!/^https:\/\//.test(https)) {
      throw new Error(`runnerRepoUrl is not https-reachable: ${cfg.runnerRepoUrl}`);
    }
    const cred = cfg.cloneCredential;
    if (cred?.type === "https-token") {
      const live = /^https:\/\/github\.com\//i.test(https) ? process.env.GITHUB_API_TOKEN : undefined;
      const token = live || cred.token;
      if (token) https = https.replace(/^https:\/\//, `https://x-access-token:${token}@`);
    }
    url = https;
  } else {
    url = await remoteCloneUrl({ id: "opensession", repo: REPO_ROOT });
  }
  console.log(url);
}
process.exit(0);
'
  )
}

EXPORT_NAME="bks-microvm-export-$$"
cleanup() {
  [ -z "$SECRET_FILE" ] || rm -f "$SECRET_FILE"
  docker rm -f "$EXPORT_NAME" >/dev/null 2>&1 || true
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi
  rm -f "$API"
  if [ "$SWAPPED" = "1" ] && [ "$SUCCESS" != "1" ]; then
    echo "[sandbox-golden] refresh failed — restoring previous generation" >&2
    rm -f "$STORE/golden.ext4" "$STORE/golden.mem" "$STORE/golden.vmstate" "$STORE/golden.json"
    [ ! -f "$STORE/golden.previous.ext4" ] || mv "$STORE/golden.previous.ext4" "$STORE/golden.ext4"
    [ ! -f "$STORE/golden.previous.mem" ] || mv "$STORE/golden.previous.mem" "$STORE/golden.mem"
    [ ! -f "$STORE/golden.previous.vmstate" ] || mv "$STORE/golden.previous.vmstate" "$STORE/golden.vmstate"
    [ ! -f "$STORE/golden.previous.json" ] || mv "$STORE/golden.previous.json" "$STORE/golden.json"
  fi
}
trap cleanup EXIT

mkdir -p "$STORE"
if [ "$#" -lt 2 ]; then
  echo "[sandbox-golden] building minimal workspace image $WORKSPACE_IMAGE…"
  docker build \
    --file "$HERE/Dockerfile.workspace" \
    --tag "$WORKSPACE_IMAGE" \
    "$HERE"

  echo "[sandbox-golden] computing payload pins from sandbox config…"
  PINS="$(compute_pins 1)"
  SIGNATURE="$(sed -n 1p <<<"$PINS")"
  RUNNER_SHA="$(sed -n 2p <<<"$PINS")"
  CLONE_URL="$(sed -n 3p <<<"$PINS")"
  if [ -z "$RUNNER_SHA" ]; then
    # Unpinned config: bake the remote default-branch head (what a fresh
    # bootstrap clone would land on), recorded explicitly so the build and
    # golden.json agree even if the branch moves mid-build.
    RUNNER_SHA="$(git ls-remote "$CLONE_URL" HEAD | awk '{print $1; exit}')"
    [ -n "$RUNNER_SHA" ] || { echo "[sandbox-golden] could not resolve remote HEAD for the runner repo" >&2; exit 1; }
  fi
  echo "[sandbox-golden] signature=$SIGNATURE runnerSha=$RUNNER_SHA"

  echo "[sandbox-golden] building runner payload image $IMAGE…"
  SECRET_FILE="$(mktemp)"
  chmod 600 "$SECRET_FILE"
  printf '%s' "$CLONE_URL" > "$SECRET_FILE"
  DOCKER_BUILDKIT=1 docker build \
    --file "$HERE/Dockerfile.runner" \
    --build-arg "BASE_IMAGE=$WORKSPACE_IMAGE" \
    --build-arg "RUNNER_SHA=$RUNNER_SHA" \
    --build-arg "BOOTSTRAP_SIGNATURE=$SIGNATURE" \
    --secret "id=runner_clone_url,src=$SECRET_FILE" \
    --tag "$IMAGE" \
    "$HERE"
  rm -f "$SECRET_FILE"; SECRET_FILE=""
else
  echo "[sandbox-golden] using explicit image $IMAGE (skipping builds)…"
  PINS="$(compute_pins "")"
  SIGNATURE="$(sed -n 1p <<<"$PINS")"
fi

# Metadata for golden.json: the runner pin rides in the signature
# ("<base>+runner@<ver>"); the runnerSha is whatever the exported image
# actually has checked out (authoritative even for explicit images).
BAKED_SHA="$(docker run --rm "$IMAGE" git -C /home/ubuntu/projects/opensession rev-parse HEAD 2>/dev/null || true)"
[ -n "$BAKED_SHA" ] || BAKED_SHA="unknown"

echo "[sandbox-golden] exporting $IMAGE…"
docker create --name "$EXPORT_NAME" "$IMAGE" true >/dev/null
docker export "$EXPORT_NAME" -o "$STORE/golden.next.tar"
docker rm "$EXPORT_NAME" >/dev/null

OPENSESSION_INIT="$HERE/bks-sandbox-init" \
  bash "$HERE/build-rootfs.sh" "$STORE/golden.next.tar" "$STORE/golden.next.ext4" 25
rm -f "$STORE/golden.next.tar"

# The vmstate embeds this exact canonical disk path. Hold an exclusive lock
# from the disk swap through the matching memory/vmstate publication; clone.sh
# holds the shared side while creating a clone.
exec 9>"$STORE/.refresh.lock"
flock -x 9
SWAPPED=1
rm -f "$STORE/golden.previous.ext4" "$STORE/golden.previous.mem" "$STORE/golden.previous.vmstate" "$STORE/golden.previous.json"
[ ! -f "$STORE/golden.ext4" ] || mv "$STORE/golden.ext4" "$STORE/golden.previous.ext4"
[ ! -f "$STORE/golden.mem" ] || mv "$STORE/golden.mem" "$STORE/golden.previous.mem"
[ ! -f "$STORE/golden.vmstate" ] || mv "$STORE/golden.vmstate" "$STORE/golden.previous.vmstate"
[ ! -f "$STORE/golden.json" ] || mv "$STORE/golden.json" "$STORE/golden.previous.json"
mv -f "$STORE/golden.next.ext4" "$STORE/golden.ext4"

echo "[sandbox-golden] booting control-only VM…"
OPENSESSION_FIRECRACKER_PID_FILE="$PID_FILE" \
  bash "$HERE/boot-golden.sh" "$STORE/golden.ext4" "$API" >/dev/null
ready=""
for _ in $(seq 1 60); do
  if curl -fsS -m 2 "http://$GUEST_IP:8080/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ -n "$ready" ] || { echo "[sandbox-golden] control API never became ready" >&2; exit 1; }

fc() {
  curl -fsS --unix-socket "$API" -X "$1" "http://x$2" \
    -H 'Content-Type: application/json' -d "$3"
}
fc PATCH /vm '{"state":"Paused"}' >/dev/null
echo "[sandbox-golden] snapshotting…"
fc PUT /snapshot/create \
  "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"$STORE/golden.next.vmstate\",\"mem_file_path\":\"$STORE/golden.next.mem\"}" \
  >/dev/null
mv -f "$STORE/golden.next.mem" "$STORE/golden.mem"
mv -f "$STORE/golden.next.vmstate" "$STORE/golden.vmstate"
printf '{\n  "signature": "%s",\n  "builtAt": "%s",\n  "runner": "%s",\n  "runnerSha": "%s"\n}\n' \
  "$SIGNATURE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RUNNER_PIN" "$BAKED_SHA" \
  > "$STORE/golden.next.json"
mv -f "$STORE/golden.next.json" "$STORE/golden.json"
cat "$STORE/golden.mem" >/dev/null
SUCCESS=1
rm -f "$STORE/golden.previous.ext4" "$STORE/golden.previous.mem" "$STORE/golden.previous.vmstate" "$STORE/golden.previous.json"
echo "[sandbox-golden] ready: $STORE/golden.{ext4,mem,vmstate,json}"
