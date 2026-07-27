#!/bin/sh
# Pinned Bun runtime for the bundled server sidecar (see
# build-server-sidecar.ts): local mode runs the sidecar with this binary so
# Local Sessions need no bun install on the user's machine.
set -eu

VERSION=1.3.14
SHA512=e3326748110f9bde48a3ca3083912cdbef3ca8792b18e752e56b380d960822e9e311b5001563b900a12027e85780d8e7457212421ab56e91f3c697e260055c54
URL="https://github.com/oven-sh/bun/releases/download/bun-v$VERSION/bun-darwin-aarch64.zip"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST="$ROOT/build/vendor/bun"

if [ -x "$DEST" ] && "$DEST" --version 2>/dev/null | grep -q "$VERSION"; then
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 300 "$URL" --output "$TMP/bun.zip"
printf '%s  %s\n' "$SHA512" "$TMP/bun.zip" | shasum -a 512 -c -
unzip -q "$TMP/bun.zip" -d "$TMP"
mkdir -p "$(dirname "$DEST")"
install -m 755 "$TMP/bun-darwin-aarch64/bun" "$DEST"
"$DEST" --version
