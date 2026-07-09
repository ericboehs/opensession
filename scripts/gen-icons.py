#!/usr/bin/env python3
"""Generate the app icon PNGs (yin-yang on dark, red brand palette).

Produces the three checked-in icons served by opensession.ts:

    src/frontend/apple-touch-icon.png  (180x180, iOS home screen)
    src/frontend/icon-192.png          (192x192, manifest)
    src/frontend/icon.png              (512x512, manifest)

Re-run after editing the design, then bump the ?v= cache-buster on the icon
URLs in src/frontend/index.html and the manifest in opensession.ts.

    python3 scripts/gen-icons.py
"""

import os
from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "src", "frontend")

SS = 4  # supersample factor for clean anti-aliased edges

BG_CENTER = (28, 4, 5)     # #1c0405 (matches the splash tile radial)
BG_EDGE = (10, 6, 8)       # #0a0608
RED_TOP = (255, 77, 77)    # #ff4d4d (favicon gradient top)
RED_BOTTOM = (193, 0, 0)   # #c10000 (favicon gradient bottom)
DARK_LOBE = (30, 13, 16)   # #1e0d10 — reads against the bg without shouting
RING = (255, 42, 42)       # #ff2a2a
GLOW = (255, 40, 40)

ICONS = {
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon.png": 512,
}


def yinyang_masks(w, cx, cy, r):
    """Red/dark region masks for a vertical yin-yang (dark left + top lobe,
    red right + bottom lobe, swapped dots)."""
    red = Image.new("L", (w, w), 0)
    dark = Image.new("L", (w, w), 0)
    rd, dd = ImageDraw.Draw(red), ImageDraw.Draw(dark)

    outer = [cx - r, cy - r, cx + r, cy + r]
    half = r / 2
    top = [cx - half, cy - r, cx + half, cy]
    bottom = [cx - half, cy, cx + half, cy + r]
    dot = r / 6
    top_dot = [cx - dot, cy - half - dot, cx + dot, cy - half + dot]
    bottom_dot = [cx - dot, cy + half - dot, cx + dot, cy + half + dot]

    # PIL angles: 0 = 3 o'clock, increasing clockwise (y-down).
    rd.pieslice(outer, -90, 90, fill=255)   # right half
    rd.ellipse(top, fill=0)
    rd.ellipse(bottom, fill=255)
    rd.ellipse(top_dot, fill=255)
    rd.ellipse(bottom_dot, fill=0)

    dd.pieslice(outer, 90, 270, fill=255)   # left half
    dd.ellipse(top, fill=255)
    dd.ellipse(bottom, fill=0)
    dd.ellipse(top_dot, fill=0)
    dd.ellipse(bottom_dot, fill=255)

    return red, dark


def render(size):
    w = size * SS
    cx = cy = w // 2
    r = int(w * 0.30)

    # Radial background: BG_CENTER in the middle fading to BG_EDGE.
    grad = Image.radial_gradient("L").resize((w, w))
    img = Image.composite(
        Image.new("RGB", (w, w), BG_EDGE),
        Image.new("RGB", (w, w), BG_CENTER),
        grad,
    ).convert("RGBA")

    red_mask, dark_mask = yinyang_masks(w, cx, cy, r)

    # Soft red glow behind the mark.
    glow_alpha = red_mask.filter(ImageFilter.GaussianBlur(int(w * 0.045))).point(
        lambda v: v * 45 // 100
    )
    glow = Image.new("RGBA", (w, w), GLOW + (0,))
    glow.putalpha(glow_alpha)
    img = Image.alpha_composite(img, glow)

    # Dark lobe, then the red lobe with a vertical gradient.
    dark_layer = Image.new("RGBA", (w, w), DARK_LOBE + (0,))
    dark_layer.putalpha(dark_mask)
    img = Image.alpha_composite(img, dark_layer)

    lin = Image.linear_gradient("L").resize((w, w))
    red_grad = Image.composite(
        Image.new("RGB", (w, w), RED_BOTTOM),
        Image.new("RGB", (w, w), RED_TOP),
        lin,
    ).convert("RGBA")
    red_grad.putalpha(red_mask)
    img = Image.alpha_composite(img, red_grad)

    # Thin ring so the dark half keeps a defined edge against the bg.
    ring = Image.new("RGBA", (w, w), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse(
        [cx - r, cy - r, cx + r, cy + r],
        outline=RING + (150,),
        width=max(SS, int(w * 0.008)),
    )
    img = Image.alpha_composite(img, ring)

    return img.convert("RGB").resize((size, size), Image.LANCZOS)


def main():
    for name, size in ICONS.items():
        render(size).save(os.path.join(OUT_DIR, name))
        print(f"{name} ({size}x{size})")


if __name__ == "__main__":
    main()
