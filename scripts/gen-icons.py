#!/usr/bin/env python3
"""Generate the web app icons from the approved native artwork.

Produces the three checked-in icons served by opensession.ts:

    src/frontend/apple-touch-icon.png  (180x180, iOS home screen)
    src/frontend/icon-192.png          (192x192, manifest)
    src/frontend/icon.png              (512x512, manifest)

Re-run after replacing the native master, then bump the ?v= cache-buster on
the icon URLs in src/frontend/index.html and the generated manifest route.

    python3 scripts/gen-icons.py
"""

import os
from PIL import Image

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "packages", "core", "opensession-server", "src", "frontend")
SOURCE = os.path.join(
    os.path.dirname(__file__),
    "..",
    "packages",
    "clients",
    "ios",
    "OS1",
    "Assets.xcassets",
    "AppIcon.appiconset",
    "AppIcon-1024.png",
)

ICONS = {
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon.png": 512,
}


def main():
    with Image.open(SOURCE) as source:
        source = source.convert("RGB")
        for name, size in ICONS.items():
            source.resize((size, size), Image.Resampling.LANCZOS).save(
                os.path.join(OUT_DIR, name)
            )
            print(f"{name} ({size}x{size})")


if __name__ == "__main__":
    main()
