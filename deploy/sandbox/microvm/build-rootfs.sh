#!/bin/bash
# Build a Firecracker rootfs from a Docker-exported filesystem. Used by both
# the preview pool and the separate minimal host-engine workspace golden. Usage:
#   BKS_INIT=/path/to/init build-rootfs.sh <golden.tar> <out.ext4> [size-gb]
#
# The image is sparse (only written blocks take disk). Injects:
#   /sbin/bks-init            guest PID 1 (see bks-init)
#   /opt/bks/control.py       exec agent (shared with the Lambda MicroVM image)
#   /opt/bks/busybox          static lifecycle fallback
# and fixes up resolv.conf ownership quirks from docker-export.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAR="$1"; OUT="$2"; SIZE_GB="${3:-25}"
INIT="${BKS_INIT:-$HERE/bks-init}"

BUSYBOX_URL=https://busybox.net/downloads/binaries/1.35.0-x86_64-linux-musl/busybox
[ -f "$HERE/.cache-busybox" ] || curl -fsSL "$BUSYBOX_URL" -o "$HERE/.cache-busybox"

MNT="$(mktemp -d)"
trap 'sudo umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT

rm -f "$OUT"
truncate -s "${SIZE_GB}G" "$OUT"
mkfs.ext4 -q -F "$OUT"
sudo mount -o loop "$OUT" "$MNT"

echo "[build-rootfs] untarring golden ($(du -h "$TAR" | cut -f1))…"
sudo tar -xf "$TAR" -C "$MNT"

sudo install -m 0755 "$INIT" "$MNT/sbin/bks-init"
sudo mkdir -p "$MNT/opt/bks"
sudo install -m 0755 "$HERE/../lambda-microvm/control.py" "$MNT/opt/bks/control.py"
sudo install -m 0755 "$HERE/.cache-busybox" "$MNT/opt/bks/busybox"
# docker-export leaves resolv.conf as a broken bind-target; make it a file.
sudo rm -f "$MNT/etc/resolv.conf"
printf 'nameserver 8.8.8.8\n' | sudo tee "$MNT/etc/resolv.conf" >/dev/null

# 4G swapfile: cushions HMR recompile spikes (a 177-file branch flip OOMed
# next-server at 6.5GB anon in an 8GB guest). bks-init swapons it.
sudo fallocate -l 4G "$MNT/swapfile" && sudo chmod 600 "$MNT/swapfile" && sudo mkswap -q "$MNT/swapfile"

# umount can transiently report busy under heavy host load (something
# scanning the tree) — retry, then detach lazily as the last resort.
for i in $(seq 1 10); do sudo umount "$MNT" 2>/dev/null && break; sleep 2; done
mountpoint -q "$MNT" && sudo umount -l "$MNT"
echo "[build-rootfs] $OUT ready ($(du -h "$OUT" | cut -f1) used, ${SIZE_GB}G apparent)"
