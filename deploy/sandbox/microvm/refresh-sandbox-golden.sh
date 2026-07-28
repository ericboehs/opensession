#!/bin/bash
# Build a credential-free, control-only Firecracker golden for the `microvm`
# sandbox provider. This intentionally does NOT reuse the preview-pool golden.
#
# Usage:
#   sudo -n bash refresh-sandbox-golden.sh [store-dir] [docker-image]
#
# With no image argument, this builds the dedicated minimal workspace image
# from Dockerfile.workspace. Passing an image explicitly remains available for
# controlled experiments and skips that build.
#
# The resulting store contains golden.{ext4,mem,vmstate} and can be selected
# with:
#   {"firecrackerMicrovm":{"enabled":true,"storeDir":"/opt/firecracker/sandbox-store"}}
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE="${1:-/opt/firecracker/sandbox-store}"
IMAGE="${2:-opensession-workspace-microvm:latest}"
API=/tmp/fc-sandbox-golden.sock
PID_FILE=/tmp/fc-sandbox-golden.pid
GUEST_IP=172.16.100.2
SWAPPED=0
SUCCESS=0

mkdir -p "$STORE"
if [ "$#" -lt 2 ]; then
  echo "[sandbox-golden] building minimal workspace image $IMAGE…"
  docker build \
    --file "$HERE/Dockerfile.workspace" \
    --tag "$IMAGE" \
    "$HERE"
fi
EXPORT_NAME="bks-microvm-export-$$"
cleanup() {
  docker rm -f "$EXPORT_NAME" >/dev/null 2>&1 || true
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi
  rm -f "$API"
  if [ "$SWAPPED" = "1" ] && [ "$SUCCESS" != "1" ]; then
    echo "[sandbox-golden] refresh failed — restoring previous generation" >&2
    rm -f "$STORE/golden.ext4" "$STORE/golden.mem" "$STORE/golden.vmstate"
    [ ! -f "$STORE/golden.previous.ext4" ] || mv "$STORE/golden.previous.ext4" "$STORE/golden.ext4"
    [ ! -f "$STORE/golden.previous.mem" ] || mv "$STORE/golden.previous.mem" "$STORE/golden.mem"
    [ ! -f "$STORE/golden.previous.vmstate" ] || mv "$STORE/golden.previous.vmstate" "$STORE/golden.vmstate"
  fi
}
trap cleanup EXIT

echo "[sandbox-golden] exporting $IMAGE…"
docker create --name "$EXPORT_NAME" "$IMAGE" true >/dev/null
docker export "$EXPORT_NAME" -o "$STORE/golden.next.tar"
docker rm "$EXPORT_NAME" >/dev/null

BKS_INIT="$HERE/bks-sandbox-init" \
  bash "$HERE/build-rootfs.sh" "$STORE/golden.next.tar" "$STORE/golden.next.ext4" 25
rm -f "$STORE/golden.next.tar"

# The vmstate embeds this exact canonical disk path. Hold an exclusive lock
# from the disk swap through the matching memory/vmstate publication; clone.sh
# holds the shared side while creating a clone.
exec 9>"$STORE/.refresh.lock"
flock -x 9
SWAPPED=1
rm -f "$STORE/golden.previous.ext4" "$STORE/golden.previous.mem" "$STORE/golden.previous.vmstate"
[ ! -f "$STORE/golden.ext4" ] || mv "$STORE/golden.ext4" "$STORE/golden.previous.ext4"
[ ! -f "$STORE/golden.mem" ] || mv "$STORE/golden.mem" "$STORE/golden.previous.mem"
[ ! -f "$STORE/golden.vmstate" ] || mv "$STORE/golden.vmstate" "$STORE/golden.previous.vmstate"
mv -f "$STORE/golden.next.ext4" "$STORE/golden.ext4"

echo "[sandbox-golden] booting control-only VM…"
BKS_FIRECRACKER_PID_FILE="$PID_FILE" \
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
cat "$STORE/golden.mem" >/dev/null
SUCCESS=1
rm -f "$STORE/golden.previous.ext4" "$STORE/golden.previous.mem" "$STORE/golden.previous.vmstate"
echo "[sandbox-golden] ready: $STORE/golden.{ext4,mem,vmstate}"
