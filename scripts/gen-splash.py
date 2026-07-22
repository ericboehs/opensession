#!/usr/bin/env python3
"""Generate iOS PWA launch images (apple-touch-startup-image).

iOS shows a native launch screen the instant you tap the home-screen icon,
before WebKit loads the page. Without a startup image it's plain black. iOS
only accepts PNGs matched to the exact device resolution via media query, so
we emit one PNG per modern iPhone (portrait). Re-run after editing the design
or adding a device; then update the <link> tags in src/frontend/index.html.

    python3 scripts/gen-splash.py

Output: src/frontend/splash/apple-splash-<w>-<h>.png
"""

import os
from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "frontend", "splash")
LOGO_PATH = os.path.join(
    os.path.dirname(__file__), "..", "os1-mac", "build", "icon-512.png"
)

BG = (27, 27, 27)  # #1b1b1b, matching the HTML launch splash
BAR = (236, 236, 236)  # #ececec

# Portrait device pixel sizes for modern iPhones (the standard PWA set).
# (width_px, height_px)
DEVICES = [
    (640, 1136),  # SE 1st gen
    (750, 1334),  # 8, SE 2/3
    (828, 1792),  # XR, 11
    (1125, 2436),  # X, XS, 11 Pro, 12/13 mini
    (1170, 2532),  # 12, 12 Pro, 13, 13 Pro, 14
    (1179, 2556),  # 14 Pro, 15, 15 Pro, 16
    (1206, 2622),  # 16 Pro
    (1242, 2208),  # 8 Plus
    (1242, 2688),  # XS Max, 11 Pro Max
    (1284, 2778),  # 12/13 Pro Max, 14 Plus
    (1290, 2796),  # 15 Plus, 15 Pro Max, 16 Plus
    (1320, 2868),  # 16 Pro Max
]


def render(w, h):
    img = Image.new("RGB", (w, h), BG)

    cx, cy = w // 2, h // 2
    logo_size = int(w * 0.21)

    # A subtle neutral glow keeps the dark half of the mark visible without
    # changing the logo itself.
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    glow_r = int(logo_size * 0.9)
    gd.ellipse(
        [cx - glow_r, cy - glow_r, cx + glow_r, cy + glow_r],
        fill=(210, 225, 232, 28),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(int(logo_size * 0.35)))
    img = Image.alpha_composite(img.convert("RGBA"), glow)

    logo = Image.open(LOGO_PATH).convert("RGBA")
    logo = logo.resize((logo_size, logo_size), Image.Resampling.LANCZOS)
    logo_x = cx - logo_size // 2
    logo_y = cy - logo_size // 2
    img.alpha_composite(logo, (logo_x, logo_y))

    # Audio bars below the tile.
    bw = max(2, int(logo_size * 0.05))
    gap = bw
    heights = [0.18, 0.30, 0.42, 0.30, 0.18]
    alphas = [90, 153, 255, 153, 90]
    total = len(heights) * bw + (len(heights) - 1) * gap
    bx = cx - total // 2
    by = logo_y + logo_size + int(logo_size * 0.22)
    bars = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bars)
    for hh, a in zip(heights, alphas):
        bh = int(logo_size * hh)
        bd.rounded_rectangle(
            [bx, by, bx + bw, by + bh], radius=bw // 2, fill=BAR + (a,)
        )
        bx += bw + gap
    img = Image.alpha_composite(img, bars).convert("RGB")

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for w, h in DEVICES:
        render(w, h).save(os.path.join(OUT_DIR, f"apple-splash-{w}-{h}.png"))
        print(f"apple-splash-{w}-{h}.png")


if __name__ == "__main__":
    main()
