#!/bin/sh
# Rebuild the legacy fallback rasters for OS1Meridian on the standard macOS
# icon grid: the squircle must occupy 824/1024 of the canvas with transparent
# margins, or the Dock draws it oversized next to other apps. Renders each
# slot's artwork with ictool, pads it with pad.swift, packs an icns, and also
# emits icon-512.png (used by the dev shell's app.dock.setIcon).
set -e
cd "$(dirname "$0")"
ICTOOL="/Applications/Icon Composer.app/Contents/Executables/ictool"
DEV_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}

iconset="fallback-os1-meridian.iconset"
rm -rf "$iconset" && mkdir -p "$iconset"
for s in 16 32 64 128 256 512 1024; do
  art=$(( (s * 824 + 512) / 1024 ))
  "$ICTOOL" OS1Meridian.icon --export-image --output-file "$iconset/tmp-art-$s.png" \
    --platform macOS --rendition Default --width "$art" --height "$art" --scale 1 >/dev/null 2>&1
  DEVELOPER_DIR="$DEV_DIR" xcrun swift pad.swift "$iconset/tmp-art-$s.png" "$iconset/tmp-$s.png" "$s" "$art"
done
cp "$iconset/tmp-16.png"   "$iconset/icon_16x16.png"
cp "$iconset/tmp-32.png"   "$iconset/icon_16x16@2x.png"
cp "$iconset/tmp-32.png"   "$iconset/icon_32x32.png"
cp "$iconset/tmp-64.png"   "$iconset/icon_32x32@2x.png"
cp "$iconset/tmp-128.png"  "$iconset/icon_128x128.png"
cp "$iconset/tmp-256.png"  "$iconset/icon_128x128@2x.png"
cp "$iconset/tmp-256.png"  "$iconset/icon_256x256.png"
cp "$iconset/tmp-512.png"  "$iconset/icon_256x256@2x.png"
cp "$iconset/tmp-512.png"  "$iconset/icon_512x512.png"
cp "$iconset/tmp-1024.png" "$iconset/icon_512x512@2x.png"
cp "$iconset/tmp-512.png"  icon-512-padded.png
rm "$iconset"/tmp-*.png
iconutil -c icns "$iconset" -o os1-meridian.icns
echo "wrote os1-meridian.icns + icon-512-padded.png"
