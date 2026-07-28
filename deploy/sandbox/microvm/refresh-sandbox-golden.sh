#!/bin/bash
# Build a credential-free, control-only Firecracker golden for the `microvm`
# sandbox provider. This intentionally does NOT reuse the preview-pool golden.
#
# Usage:
#   sudo -n bash refresh-sandbox-golden.sh [store-dir] [docker-image]
#
# The resulting store contains golden.{ext4,mem,vmstate} and can be selected
# with:
#   {"firecrackerMicrovm":{"enabled":true,"storeDir":"/opt/firecracker/sandbox-store"}}
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORE="${1:-/opt/firecracker/sandbox-store}"
IMAGE="${2:-backstage-runner:latest}"
API=/tmp/fc-sandbox-golden.sock
PID_FILE=/tmp/fc-sandbox-golden.pid
GUEST_IP=172.16.100.2

mkdir -p "$STORE"
EXPORT_NAME="bks-microvm-export-$$"
cleanup() {
  docker rm -f "$EXPORT_NAME" >/dev/null 2>&1 || true
  if [ -f "$PID_FILE" ]; then
    kill "$(cat "$PID_FILE")" >/dev/null 2>&1 || true
    rm -f "$PID_FILE"
  fi
  rm -f "$API"
}
trap cleanup EXIT

echo "[sandbox-golden] exporting $IMAGE…"
docker create --name "$EXPORT_NAME" "$IMAGE" true >/dev/null
docker export "$EXPORT_NAME" -o "$STORE/golden.next.tar"
docker rm "$EXPORT_NAME" >/dev/null

BKS_INIT="$HERE/bks-sandbox-init" \
  bash "$HERE/build-rootfs.sh" "$STORE/golden.next.tar" "$STORE/golden.next.ext4" 25
rm -f "$STORE/golden.next.tar"
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
echo "[sandbox-golden] ready: $STORE/golden.{ext4,mem,vmstate}"
