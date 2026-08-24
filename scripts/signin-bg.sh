#!/usr/bin/env bash
#
# Regenerate the sign-in screen's backdrop from the landing page's master.
#
# The site (packages/clients/website/TellaBackground.tsx) streams "Silver Silk" straight from
# its CDN at 3840x2160, 7.4MB, with an audio track it never plays. A login
# screen cannot do that: it is the one surface that has to render before
# anything is trusted, on a server that is usually private, so it ships from
# our own origin (src/server/routes/static-assets.ts) and has to be small.
#
# Four files, ~760KB total:
#   signin-bg.mp4/.webp        the silk as shot, for the light palette
#   signin-bg-dark.mp4/.webp   the same footage graded to charcoal
#
# The dark cut exists because a dimmed light background is still a light
# background: scrimmed, the silver stayed the brightest thing on a dark
# display. Inverting the luminance and flattening it into a narrow band keeps
# the material and the motion while landing the whole frame below the app's
# own text, and its darkest point (~39 of 255) still sits clear of the card's
# #1c1c1c fill so the card reads as the object in front.
#
# crf 30 is generous for 1080p and invisible here: the footage is all soft
# gradient, which is why 7.4MB comes down to 435KB without a visible step.
#
# Usage: scripts/signin-bg.sh [master.mp4]
# With no argument it fetches the site's master to a temp file.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=packages/core/opensession-server/src/frontend
MASTER=${1:-}
MASTER_URL=https://ucarecdn.com/b8c1a712-87c2-4884-8034-77e71fa4d7ac/

if [[ -z "$MASTER" ]]; then
	MASTER=$(mktemp /tmp/silk-master-XXXXXX.mp4)
	trap 'rm -f "$MASTER"' EXIT
	echo "fetching master…"
	curl -fsSL -o "$MASTER" "$MASTER_URL"
fi

# Inverted, desaturated, and compressed into [48, 128] of 255.
DARK_GRADE="negate,hue=s=0,lutyuv=y='48+(val-16)*80/219'"

encode() { # <filter> <basename>
	ffmpeg -v error -y -i "$MASTER" -an -vf "${1:+$1,}scale=1920:1080" \
		-c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -movflags +faststart \
		"$OUT/$2.mp4"
	# The poster is the encoded video's own first frame, so the handover when
	# the loop starts is invisible. It is also the entire backdrop for a
	# reduced-motion visitor, who gets the picture without the movement.
	ffmpeg -v error -y -i "$OUT/$2.mp4" -vframes 1 -vf scale=1280:720 -q:v 72 \
		"$OUT/$2.webp"
}

encode "" signin-bg
encode "$DARK_GRADE" signin-bg-dark

ls -l "$OUT"/signin-bg*.mp4 "$OUT"/signin-bg*.webp
