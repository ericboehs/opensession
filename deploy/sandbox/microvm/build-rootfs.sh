#!/bin/bash
# Build a Firecracker rootfs for the preview pool from the docker golden's
# exported filesystem. Usage:
#   build-rootfs.sh <golden.tar> <out.ext4> [size-gb]
#
# The image is sparse (only written blocks take disk). Injects:
#   /sbin/bks-init            guest PID 1 (see bks-init)
#   /opt/bks/control.py       exec agent (shared with the Lambda MicroVM image)
#   /opt/bks/busybox          static busybox (the runner image has no iproute2)
# and fixes up resolv.conf ownership quirks from docker-export.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAR="$1"; OUT="$2"; SIZE_GB="${3:-25}"

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

sudo install -m 0755 "$HERE/bks-init" "$MNT/sbin/bks-init"
sudo mkdir -p "$MNT/opt/bks"
sudo install -m 0755 "$HERE/../lambda-microvm/control.py" "$MNT/opt/bks/control.py"
sudo install -m 0755 "$HERE/.cache-busybox" "$MNT/opt/bks/busybox"
# docker-export leaves resolv.conf as a broken bind-target; make it a file.
sudo rm -f "$MNT/etc/resolv.conf"
printf 'nameserver 8.8.8.8\n' | sudo tee "$MNT/etc/resolv.conf" >/dev/null

sudo umount "$MNT"
echo "[build-rootfs] $OUT ready ($(du -h "$OUT" | cut -f1) used, ${SIZE_GB}G apparent)"
