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

BG = (11, 8, 9)          # #0b0809
TILE = (10, 6, 8)        # #0a0608
RED = (255, 42, 42)      # #ff2a2a
BAR = (255, 34, 34)      # #ff2222
RED_TOP = (255, 77, 77)  # #ff4d4d (icon gradient top — keep in sync with gen-icons.py)
RED_BOTTOM = (193, 0, 0) # #c10000
DARK_LOBE = (30, 13, 16) # #1e0d10

# Portrait device pixel sizes for modern iPhones (the standard PWA set).
# (width_px, height_px)
DEVICES = [
    (640, 1136),   # SE 1st gen
    (750, 1334),   # 8, SE 2/3
    (828, 1792),   # XR, 11
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

    # Soft red glow behind the logo.
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    r = int(w * 0.42)
    cx, cy = w // 2, h // 2
    gd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 40, 40, 46))
    glow = glow.filter(ImageFilter.GaussianBlur(int(w * 0.12)))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)

    # Rounded logo tile.
    tile = int(w * 0.21)
    rad = int(tile * 0.26)
    tx0, ty0 = cx - tile // 2, cy - tile // 2
    tx1, ty1 = tx0 + tile, ty0 + tile
    d.rounded_rectangle(
        [tx0, ty0, tx1, ty1], radius=rad, fill=TILE,
        outline=(255, 40, 40), width=max(1, int(tile * 0.012)),
    )

    # Glowing red yin-yang (same construction as scripts/gen-icons.py).
    r = int(tile * 0.30)
    red_mask = Image.new("L", (w, h), 0)
    dark_mask = Image.new("L", (w, h), 0)
    rd, dd = ImageDraw.Draw(red_mask), ImageDraw.Draw(dark_mask)
    outer = [cx - r, cy - r, cx + r, cy + r]
    half = r / 2
    top = [cx - half, cy - r, cx + half, cy]
    bottom = [cx - half, cy, cx + half, cy + r]
    dot = r / 6
    top_dot = [cx - dot, cy - half - dot, cx + dot, cy - half + dot]
    bottom_dot = [cx - dot, cy + half - dot, cx + dot, cy + half + dot]
    rd.pieslice(outer, -90, 90, fill=255)   # right half red
    rd.ellipse(top, fill=0)
    rd.ellipse(bottom, fill=255)
    rd.ellipse(top_dot, fill=255)
    rd.ellipse(bottom_dot, fill=0)
    dd.pieslice(outer, 90, 270, fill=255)   # left half dark
    dd.ellipse(top, fill=255)
    dd.ellipse(bottom, fill=0)
    dd.ellipse(top_dot, fill=0)
    dd.ellipse(bottom_dot, fill=255)

    glow_alpha = red_mask.filter(ImageFilter.GaussianBlur(int(tile * 0.06))).point(
        lambda v: v * 60 // 100
    )
    mglow = Image.new("RGBA", (w, h), (255, 40, 40, 0))
    mglow.putalpha(glow_alpha)
    img = Image.alpha_composite(img.convert("RGBA"), mglow)

    dark_layer = Image.new("RGBA", (w, h), DARK_LOBE + (0,))
    dark_layer.putalpha(dark_mask)
    img = Image.alpha_composite(img, dark_layer)

    lin = Image.linear_gradient("L").resize((w, h))
    red_grad = Image.composite(
        Image.new("RGB", (w, h), RED_BOTTOM),
        Image.new("RGB", (w, h), RED_TOP),
        lin,
    ).convert("RGBA")
    red_grad.putalpha(red_mask)
    img = Image.alpha_composite(img, red_grad)

    ring = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse(outer, outline=RED + (180,), width=max(2, int(tile * 0.018)))
    img = Image.alpha_composite(img, ring).convert("RGB")
    d = ImageDraw.Draw(img)

    # Audio bars below the tile.
    bw = max(2, int(tile * 0.05))
    gap = bw
    heights = [0.18, 0.30, 0.42, 0.30, 0.18]
    alphas = [90, 153, 255, 153, 90]
    total = len(heights) * bw + (len(heights) - 1) * gap
    bx = cx - total // 2
    by = ty1 + int(tile * 0.22)
    bars = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bars)
    for hh, a in zip(heights, alphas):
        bh = int(tile * hh)
        bd.rounded_rectangle([bx, by, bx + bw, by + bh], radius=bw // 2, fill=BAR + (a,))
        bx += bw + gap
    img = Image.alpha_composite(img.convert("RGBA"), bars).convert("RGB")

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for w, h in DEVICES:
        render(w, h).save(os.path.join(OUT_DIR, f"apple-splash-{w}-{h}.png"))
        print(f"apple-splash-{w}-{h}.png")


if __name__ == "__main__":
    main()
