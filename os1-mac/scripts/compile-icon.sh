#!/bin/sh
# Compile build/AppIcon.icon (Icon Composer document) into build/Assets.car +
# a fallback icns. Needs Xcode 26+ for .icon support; the compiled artifacts
# are committed so CI (older Xcode) doesn't need to run this — rerun after
# editing the icon. Source of truth for the artwork lives at the repository
# root: output/os1-icons/ (see its README).
set -e
cd "$(dirname "$0")/.."
DEV_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
out=$(mktemp -d)
DEVELOPER_DIR="$DEV_DIR" xcrun actool build/AppIcon.icon --compile "$out" \
  --platform macosx --minimum-deployment-target 26.0 \
  --app-icon AppIcon --output-partial-info-plist "$out/partial.plist"
cp "$out/Assets.car" build/Assets.car  # icon.icns/icon-512.png come from output/os1-icons/build-fallbacks.sh (padded to the 824/1024 grid)
rm -rf "$out"
echo "wrote build/Assets.car"
