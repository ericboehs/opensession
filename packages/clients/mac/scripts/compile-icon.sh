#!/bin/sh
# Build every Electron icon representation from the approved native master.
# Needs Xcode 26+ for .icon support; compiled artifacts are committed so CI
# never needs to run Icon Composer.
set -e
root=$(CDPATH= cd -- "$(dirname "$0")/../../../.." && pwd)
shell_dir="$root/packages/clients/mac"
DEV_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}

cd "$root"
bun run output/os1-icons/generate.ts
rm -rf "$shell_dir/build/AppIcon.icon"
cp -R "$root/output/os1-icons/OS1Meridian.icon" "$shell_dir/build/AppIcon.icon"

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
DEVELOPER_DIR="$DEV_DIR" xcrun actool "$shell_dir/build/AppIcon.icon" --compile "$out" \
  --platform macosx --minimum-deployment-target 26.0 \
  --app-icon AppIcon --output-partial-info-plist "$out/partial.plist"
cp "$out/Assets.car" "$shell_dir/build/Assets.car"

sh "$root/output/os1-icons/build-fallbacks.sh"
cp "$root/output/os1-icons/os1-meridian.icns" "$shell_dir/build/icon.icns"
cp "$root/output/os1-icons/icon-512-padded.png" "$shell_dir/build/icon-512.png"
echo "wrote Electron Assets.car + icon.icns + icon-512.png"
