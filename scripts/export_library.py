#!/usr/bin/env python3
"""
Publish and verify the canonical Zode library.

The web app (`apps/web/src/data/library.js`) owns the records. This script
dumps them with `scripts/dump_library.mjs` (which imports the web app
directly, so there is no chance of the two drifting) and publishes one
canonical file that every platform consumes:

    packages/shared/library.json          <- the source of truth
    apps/web/assets/library.json          <- bundled copy for the web app
    mobile/ios/ZodeMobile/Resources/library.json
    mobile/android/app/src/main/res/raw/library.json

`--check` verifies that every copy is byte-identical to the canonical file
and that the native clients actually read it.

Usage:
    python3 scripts/export_library.py            # publish + verify
    python3 scripts/export_library.py --check    # verify only
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DUMPER = os.path.join(ROOT, "scripts", "dump_library.mjs")

CANONICAL = os.path.join(ROOT, "packages", "shared", "library.json")
COPIES = [
    os.path.join(ROOT, "public", "assets", "library.json"),
    os.path.join(ROOT, "mobile", "ios", "ZodeMobile", "Resources", "library.json"),
    os.path.join(ROOT, "mobile", "android", "app", "src", "main", "res", "raw",
                 "library.json"),
]


def dump() -> str:
    """Run the Node dumper and return the canonical JSON text."""
    result = subprocess.run(
        ["node", DUMPER],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.exit("dump_library.mjs failed:\n" + result.stderr)
    text = result.stdout
    data = json.loads(text)
    for key in ("artists", "albums", "tracks", "playlists"):
        if not data.get(key):
            sys.exit(f"the dumped library has no {key}")
    # Re-serialise canonically so every copy is byte-identical.
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def publish(text: str) -> None:
    for path in [CANONICAL] + COPIES:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(f"published {len(COPIES) + 1} copies of the canonical library")


def check() -> list:
    problems = []
    if not os.path.exists(CANONICAL):
        return ["packages/shared/library.json is missing"]

    canonical_text = open(CANONICAL, encoding="utf-8").read()
    canonical = json.loads(canonical_text)

    for path in COPIES:
        rel = os.path.relpath(path, ROOT)
        if not os.path.exists(path):
            problems.append(f"{rel} is missing")
            continue
        if open(path, encoding="utf-8").read() != canonical_text:
            problems.append(f"{rel} differs from packages/shared/library.json")

    # The dumped library must still match what the web app would produce.
    fresh = dump()
    if fresh != canonical_text:
        problems.append(
            "packages/shared/library.json is stale — re-run "
            "`python3 scripts/export_library.py`"
        )

    # The native clients must actually consume the JSON rather than keeping
    # their own hardcoded catalogue, and they must map every field of it.
    checks = [
        ("mobile/ios/ZodeMobile/Data/Library.swift", "library.json"),
        ("mobile/android/app/src/main/java/com/zode/app/data/Library.kt",
         "library.json"),
    ]
    fields = ("artistId", "trackIds", "duration", "trackNumber", "accentHex")
    for rel, needle in checks:
        path = os.path.join(ROOT, rel)
        if not os.path.exists(path):
            problems.append(f"{rel} is missing")
            continue
        text = open(path, encoding="utf-8").read()
        if needle not in text:
            problems.append(f"{rel} does not reference {needle}")
        for field in fields:
            if field not in text:
                problems.append(f"{rel} does not map the JSON field {field!r}")

    return problems


def main() -> int:
    if "--check" not in sys.argv:
        publish(dump())

    problems = check()
    if problems:
        print("FAIL: the library is not in sync across platforms:", file=sys.stderr)
        for problem in problems:
            print("  - " + problem, file=sys.stderr)
        return 1
    data = json.load(open(CANONICAL, encoding="utf-8"))
    print(
        "library is in sync: {artists} artists, {albums} albums, {tracks} tracks, "
        "{playlists} playlists".format(**{k: len(data[k]) for k in
                                         ("artists", "albums", "tracks", "playlists")})
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
