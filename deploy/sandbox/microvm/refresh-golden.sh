#!/bin/bash
# Refresh the microvm golden snapshot from the docker golden image.
# Usage: refresh-golden.sh <repo-id> [store-dir]
# Env: BKS_AWS_B64 (base64 of an ~/.aws/credentials to seed), WARM_ROUTES
#      (space-separated, default "/ /home /videos /api/session /api/flags").
#
# Pipeline (each step proven live 2026-07-24): docker export the golden →
# ext4 rootfs (init + agents injected) → boot under Firecracker → seed creds
# → warm routes → pause → Full snapshot (memory+vmstate) → kill VM (the base
# disk is FROZEN at pause time — never boot it read-write again) → prefault
# the memory file into host page cache so restores fault against RAM.
# The whole cycle ≈ 12-15 min; runs while the previous generation keeps
# serving (new artifacts land under .next names, atomically renamed at the
# end — clones only ever open the canonical names at their moment of
# creation).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ID="$1"; STORE="${2:-/opt/firecracker/store}"
IMAGE="bks-preview-golden-$REPO_ID:latest"
GUEST_IP=172.16.100.2
log() { echo "[refresh-golden] $*"; }

command -v /opt/firecracker/firecracker >/dev/null || { echo "firecracker missing"; exit 1; }
[ -f /opt/firecracker/vmlinux ] || { echo "kernel missing at /opt/firecracker/vmlinux"; exit 1; }

log "exporting $IMAGE…"
docker create --name "bks-mvm-export-$$" "$IMAGE" true >/dev/null
docker export "bks-mvm-export-$$" -o "$STORE/golden.next.tar"
docker rm "bks-mvm-export-$$" >/dev/null

bash "$HERE/build-rootfs.sh" "$STORE/golden.next.tar" "$STORE/golden.next.ext4" 25
rm -f "$STORE/golden.next.tar"

# The vmstate embeds the disk's ABSOLUTE PATH, and clones bind their COW
# copies over that exact path — so the canonical name must be in place
# BEFORE the boot that gets snapshotted. rename() is atomic; in-flight
# clones hold open fds/binds to the old inode and never notice.
mv -f "$STORE/golden.next.ext4" "$STORE/golden.ext4"

log "booting golden VM…"
sudo pkill -f 'fc-goldenbuild.sock' 2>/dev/null || true
# Default tap/IPs on purpose: the vmstate embeds the tap NAME and the guest
# its IP — clones recreate exactly bkstap0/172.16.100.2 inside their private
# netns, so the golden must be snapshotted with those. (No conflict: only
# the golden build uses them in the HOST netns.)
bash "$HERE/boot-golden.sh" "$STORE/golden.ext4" /tmp/fc-goldenbuild.sock >/dev/null
GIP=172.16.100.2
up=""
for i in $(seq 1 60); do
  C=$(curl -s -o /dev/null -w '%{http_code}' -m 5 -H 'Host: localhost:3300' "http://$GIP:3300/" 2>/dev/null || true)
  [ "$C" != "000" ] && [ -n "$C" ] && { up=1; log "dev up (HTTP $C) after $((i*3))s"; break; }
  sleep 3
done
[ -n "$up" ] || { log "dev never came up"; sudo pkill -f 'fc-goldenbuild.sock' || true; exit 1; }

if [ -n "${BKS_AWS_B64:-}" ]; then
  curl -s -m 10 -X POST "http://$GIP:8080/exec" -H 'Content-Type: application/json' \
    -d "{\"command\":\"mkdir -p ~/.aws && echo $BKS_AWS_B64 | base64 -d > ~/.aws/credentials && echo ${BKS_AWS_CONFIG_B64:-} | base64 -d > ~/.aws/config && chmod 600 ~/.aws/credentials\",\"timeoutMs\":8000}" >/dev/null
  log "creds seeded"
fi

for r in ${WARM_ROUTES:-/ /home /videos /api/session /api/flags}; do
  C=$(curl -s -o /dev/null -w '%{http_code}' -m 240 -H 'Host: localhost:3300' "http://$GIP:3300$r" || true)
  log "warm $r: HTTP $C"
done

fc() { curl -s --unix-socket /tmp/fc-goldenbuild.sock -X "$1" "http://x$2" -H 'Content-Type: application/json' -d "$3"; }
fc PATCH /vm '{"state":"Paused"}' >/dev/null
log "snapshotting (memory dump, ~1-4 min)…"
fc PUT /snapshot/create "{\"snapshot_type\":\"Full\",\"snapshot_path\":\"$STORE/golden.next.vmstate\",\"mem_file_path\":\"$STORE/golden.next.mem\"}" >/dev/null
sudo pkill -f 'fc-goldenbuild.sock' || true

mv -f "$STORE/golden.next.mem" "$STORE/golden.mem"
mv -f "$STORE/golden.next.vmstate" "$STORE/golden.vmstate"
cat "$STORE/golden.mem" > /dev/null
log "generation ready: $STORE/golden.{ext4,mem,vmstate} (mem prefaulted)"
