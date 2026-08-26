#!/bin/bash
# Build a Firecracker rootfs from a Docker-exported filesystem. Used by both
# the preview pool and the separate minimal host-engine workspace golden. Usage:
#   OPENSESSION_INIT=/path/to/init build-rootfs.sh <golden.tar> <out.ext4> [size-gb]
#
# The image is sparse (only written blocks take disk). Injects:
#   /sbin/bks-init            guest PID 1 (see bks-init)
#   /opt/bks/control.py       exec agent (shared with the Lambda MicroVM image)
#   /opt/bks/busybox          static lifecycle fallback
# and fixes up resolv.conf ownership quirks from docker-export.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAR="$1"; OUT="$2"; SIZE_GB="${3:-25}"
INIT="${OPENSESSION_INIT:-$HERE/bks-init}"

BUSYBOX_VERSION=1.35.0
BUSYBOX_URL="https://busybox.net/downloads/binaries/${BUSYBOX_VERSION}-x86_64-linux-musl/busybox"
BUSYBOX_SOURCE_URL="https://busybox.net/downloads/busybox-${BUSYBOX_VERSION}.tar.bz2"
# Pinned digests of the upstream static binary and its complete corresponding
# source. Caches are verified too, so tampered or truncated files are rejected.
BUSYBOX_SHA256=6e123e7f3202a8c1e9b1f94d8941580a25135382b99e8d3e34fb858bba311348
BUSYBOX_SOURCE_SHA256=faeeb244c35a348a334f4a59e44626ee870fb07b6884d68c10ae8bc19f83a694

fetch_verified() {
  url="$1" cache="$2" digest="$3"
  if [ ! -f "$cache" ]; then
    incoming="${cache}.incoming.$$"
    trap 'rm -f "${incoming:-}"; sudo umount "${MNT:-}" 2>/dev/null || true; [ -z "${MNT:-}" ] || rmdir "$MNT" 2>/dev/null || true' EXIT
    curl -fsSL --retry 3 "$url" -o "$incoming"
    echo "$digest  $incoming" | sha256sum -c - >/dev/null || {
      echo "ERROR: upstream checksum mismatch for $url (want $digest)" >&2
      exit 1
    }
    mv "$incoming" "$cache"
  fi
  echo "$digest  $cache" | sha256sum -c - >/dev/null || {
    echo "ERROR: checksum mismatch for $cache (want $digest)" >&2
    echo "       delete the file and re-run to re-download." >&2
    exit 1
  }
}

fetch_verified "$BUSYBOX_URL" "$HERE/.cache-busybox" "$BUSYBOX_SHA256"
fetch_verified "$BUSYBOX_SOURCE_URL" "$HERE/.cache-busybox-source.tar.bz2" "$BUSYBOX_SOURCE_SHA256"

MNT="$(mktemp -d)"
trap 'rm -f "${incoming:-}"; sudo umount "$MNT" 2>/dev/null || true; rmdir "$MNT" 2>/dev/null || true' EXIT

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
# GPL-2.0 requires corresponding source to accompany redistributed images.
sudo install -d -m 0755 "$MNT/usr/share/opensession/source" "$MNT/usr/share/opensession/licenses"
sudo install -m 0644 "$HERE/.cache-busybox-source.tar.bz2" \
  "$MNT/usr/share/opensession/source/busybox-${BUSYBOX_VERSION}.tar.bz2"
sudo install -m 0644 "$HERE/../../../LICENSE" "$MNT/usr/share/opensession/licenses/LICENSE"
sudo install -m 0644 "$HERE/../../../THIRD-PARTY-NOTICES.md" "$MNT/usr/share/opensession/licenses/THIRD-PARTY-NOTICES.md"
sudo install -m 0644 "$HERE/../../../THIRD-PARTY-LICENSES/GPL-2.0.txt" \
  "$MNT/usr/share/opensession/licenses/GPL-2.0.txt"
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
