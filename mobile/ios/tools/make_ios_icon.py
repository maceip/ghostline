#!/usr/bin/env python3
"""Generate the iOS app icon for Zode.

Standard library only (plus `pnglib.py` / `iconart.py` from `mobile/tools/`).
Run it from the repository root:

    python3 mobile/ios/tools/make_ios_icon.py

It writes a 1024x1024 PNG into the asset catalog:

    mobile/ios/ZodeMobile/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png

iOS 17 accepts a single 1024x1024 "universal" app icon, so that is all the
catalog needs.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# `pnglib.py` and `iconart.py` live in the shared mobile/tools folder.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import iconart  # noqa: E402
import pnglib  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
SOURCE_ICON = REPO_ROOT / "icons" / "zode.png"
ICONSET = (
    REPO_ROOT
    / "mobile"
    / "ios"
    / "ZodeMobile"
    / "Resources"
    / "Assets.xcassets"
    / "AppIcon.appiconset"
)

SIZE = 1024


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)

    if not SOURCE_ICON.exists():
        raise SystemExit("Missing %s" % SOURCE_ICON)

    image = pnglib.read_png(str(SOURCE_ICON))
    plate, glyph = iconart.build_art(image)
    icon = iconart.legacy_icon(plate, glyph, SIZE)

    target = ICONSET / "AppIcon-1024.png"
    if args.check:
        print("would write %s" % target)
        return 0

    ICONSET.mkdir(parents=True, exist_ok=True)
    pnglib.write_png(str(target), icon)
    print("wrote %s (%dx%d)" % (target, icon.width, icon.height))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
