#!/bin/sh
set -eu

VERSION=1.18.4
SHA512=fc675c52fddac411589a9742637c8c191081ab77f00096b27e59e7f6cb57b481cab9c91ced96946199b2b9d214a66ce464fe56f17b0054c268991e116ebdbe22
PACKAGE="opencode-darwin-arm64"
URL="https://registry.npmjs.org/$PACKAGE/-/$PACKAGE-$VERSION.tgz"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST="$ROOT/build/vendor/opencode"

if [ -x "$DEST" ] && "$DEST" --version 2>/dev/null | grep -q "$VERSION"; then
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl --fail --location --retry 3 --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 300 "$URL" --output "$TMP/opencode.tgz"
printf '%s  %s\n' "$SHA512" "$TMP/opencode.tgz" | shasum -a 512 -c -
tar -xzf "$TMP/opencode.tgz" -C "$TMP" package/bin/opencode
mkdir -p "$(dirname "$DEST")"
install -m 755 "$TMP/package/bin/opencode" "$DEST"
"$DEST" --version
