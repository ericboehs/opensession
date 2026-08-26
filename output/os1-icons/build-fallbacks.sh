#!/bin/sh
# Pack the approved native macOS icon renditions into Electron's legacy
# fallbacks. The asset catalog already contains the standard 824/1024 padding.
set -e

cd "$(dirname "$0")"
source_dir="../../packages/clients/ios/OS1/Assets.xcassets/AppIconMac.appiconset"
iconset="fallback-os1-meridian.iconset"

rm -rf "$iconset"
mkdir -p "$iconset"
cp "$source_dir/mac16.png" "$iconset/icon_16x16.png"
cp "$source_dir/mac16@2x.png" "$iconset/icon_16x16@2x.png"
cp "$source_dir/mac32.png" "$iconset/icon_32x32.png"
cp "$source_dir/mac32@2x.png" "$iconset/icon_32x32@2x.png"
cp "$source_dir/mac128.png" "$iconset/icon_128x128.png"
cp "$source_dir/mac128@2x.png" "$iconset/icon_128x128@2x.png"
cp "$source_dir/mac256.png" "$iconset/icon_256x256.png"
cp "$source_dir/mac256@2x.png" "$iconset/icon_256x256@2x.png"
cp "$source_dir/mac512.png" "$iconset/icon_512x512.png"
cp "$source_dir/mac512@2x.png" "$iconset/icon_512x512@2x.png"

cp "$source_dir/mac512.png" icon-512-padded.png
iconutil -c icns "$iconset" -o os1-meridian.icns
echo "wrote os1-meridian.icns + icon-512-padded.png"
