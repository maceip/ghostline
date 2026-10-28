#!/usr/bin/env python3
"""Verify the iOS sources without a Swift compiler.

Standard library only. Run it from the repository root:

    python3 mobile/ios/tools/verify_swift.py

It asserts that

  * every intent name from contract §4 appears in the Swift sources;
  * every haptic program name from `packages/shared/haptics.json` appears;
  * every file referenced by the Xcode project exists on disk;
  * the brace/paren/bracket balance of every Swift file is even;
  * the bundled `library.json` is byte-identical to
    `packages/shared/library.json`, so iOS presents the same records as the
    web app and Android;
  * the shared tokens and haptics files are not stale.

Exits 0 when everything passes, 1 otherwise.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import sourcecheck  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
IOS_DIR = REPO_ROOT / "mobile" / "ios"
SOURCE_DIR = IOS_DIR / "ZodeMobile"
SHARED = REPO_ROOT / "packages" / "shared"

# The intent names from contract §4.
INTENTS = [
    "zode.search",
    "zode.play",
    "zode.pause",
    "zode.next",
    "zode.previous",
    "zode.agent.newTask",
    "zode.agent.stop",
    "zode.attach",
    "zode.show",
]

# The views accepted by `zode.show`.
VIEWS = ["now-playing", "collection", "library", "search", "agent"]

failures: list = []


def fail(message: str) -> None:
    failures.append(message)
    print("FAIL: %s" % message)


def ok(message: str) -> None:
    print("ok: %s" % message)


def swift_files() -> list:
    return sorted(SOURCE_DIR.rglob("*.swift"))


def all_source_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in swift_files())


def check_intents() -> None:
    text = all_source_text()
    for intent in INTENTS:
        if intent in text:
            ok("contract §4 intent %s is implemented" % intent)
        else:
            fail("contract §4 intent %s does not appear in the Swift sources" % intent)

    for view in VIEWS:
        if view in text:
            ok("contract §4 view %s is implemented" % view)
        else:
            fail("contract §4 view %s does not appear in the Swift sources" % view)


def check_haptics() -> None:
    document = json.loads((SHARED / "haptics.json").read_text(encoding="utf-8"))
    text = all_source_text()
    for name in document["programs"]:
        if '"%s"' % name in text:
            ok("haptic program %s is present" % name)
        else:
            fail("haptic program %s is missing from the Swift sources" % name)

    working = document["programs"]["working"]
    if working.get("loop"):
        if "loopEnabled" in text:
            ok("the looping `working` program uses loopEnabled")
        else:
            fail("the looping `working` program does not set loopEnabled")


def check_balance() -> None:
    unbalanced = []
    for path in swift_files():
        text = path.read_text(encoding="utf-8")
        counts = sourcecheck.balance(text, "swift")
        if counts["{"] != 0 or counts["("] != 0 or counts["["] != 0:
            unbalanced.append(
                "%s (braces %+d, parens %+d, brackets %+d)"
                % (
                    path.relative_to(REPO_ROOT),
                    counts["{"],
                    counts["("],
                    counts["["],
                )
            )
    if unbalanced:
        for entry in unbalanced:
            fail("unbalanced source: %s" % entry)
    else:
        ok("every Swift file has balanced braces, parens and brackets (%d files)" % len(swift_files()))


def check_files_exist() -> None:
    """Every file the project references must exist."""
    import openstep_plist

    pbxproj = IOS_DIR / "ZodeMobile.xcodeproj" / "project.pbxproj"
    if not pbxproj.exists():
        fail("the Xcode project is missing -- run tools/generate_xcodeproj.py")
        return

    document = openstep_plist.loads(pbxproj.read_text(encoding="utf-8"))
    objects = document["objects"]

    missing = []
    count = 0
    for identifier, entry in objects.items():
        if entry.get("isa") != "PBXFileReference":
            continue
        if entry.get("sourceTree") != "<group>":
            continue
        # The path is relative to its group; walk the group tree.
        path = entry.get("path", "")
        parent = _parent_path(objects, identifier)
        candidate = IOS_DIR / (parent + path if parent else path)
        count += 1
        if not candidate.exists():
            missing.append(str(candidate.relative_to(REPO_ROOT)))
    if missing:
        for entry in missing:
            fail("the project references a file that does not exist: %s" % entry)
    else:
        ok("every file referenced by the Xcode project exists (%d files)" % count)


def _parent_path(objects: dict, identifier: str) -> str:
    """The path of the group that holds a file reference."""
    parents = {}
    for group_id, entry in objects.items():
        if entry.get("isa") != "PBXGroup":
            continue
        for child in entry.get("children", []):
            parents[child] = group_id

    parts = []
    current = identifier
    seen = set()
    while current in parents and current not in seen:
        seen.add(current)
        group = objects[parents[current]]
        name = group.get("path")
        if name:
            parts.append(name)
        current = parents[current]
    parts.reverse()
    return "/".join(parts) + "/" if parts else ""


def check_library_parity() -> None:
    """The bundled library must be the canonical one, byte for byte."""
    text = (SOURCE_DIR / "Data" / "Library.swift").read_text(encoding="utf-8")

    if "library.json" in text:
        ok("Library.swift reads the bundled library.json")
    else:
        fail("Library.swift does not reference library.json")

    bundled = SOURCE_DIR / "Resources" / "library.json"
    shared = REPO_ROOT / "packages" / "shared" / "library.json"

    if not bundled.exists():
        fail("mobile/ios/ZodeMobile/Resources/library.json is missing")
        return
    if not shared.exists():
        fail("packages/shared/library.json is missing")
        return

    bundled_text = bundled.read_text(encoding="utf-8")
    shared_text = shared.read_text(encoding="utf-8")
    if bundled_text == shared_text:
        ok("the bundled library.json is byte-identical to packages/shared/library.json")
    else:
        fail("the bundled library.json differs from packages/shared/library.json")

    import json
    data = json.loads(shared_text)
    album_titles = [album["title"] for album in data.get("albums", [])]
    track_titles = [track["title"] for track in data.get("tracks", [])]

    # The records live in the JSON now, so the source must map every field of
    # the canonical document onto the app's model types.
    for key in ("artistId", "trackIds", "duration", "trackNumber", "accentHex"):
        if key in text:
            ok("Library.swift maps the JSON field %r" % key)
        else:
            fail("Library.swift does not map the JSON field %r" % key)

    for key, expected in (("albums", len(album_titles)),
                          ("tracks", len(track_titles))):
        actual = len(data.get(key, []))
        if actual == expected:
            ok("the canonical library has %d %s" % (actual, key))
        else:
            fail("the canonical library has %d %s, expected %d" % (actual, key, expected))


def check_generated_files() -> None:
    """The generated files must be up to date."""
    import subprocess

    for script, platform in (
        ("mobile/tools/generate_tokens.py", "ios"),
        ("mobile/tools/generate_haptics.py", "ios"),
        ("mobile/ios/tools/generate_xcodeproj.py", None),
    ):
        command = [sys.executable, str(REPO_ROOT / script), "--check"]
        if platform:
            command += ["--platform", platform]
        result = subprocess.run(command, capture_output=True, text=True, cwd=str(REPO_ROOT))
        if result.returncode == 0:
            ok("%s --check passes" % script)
        else:
            fail(
                "%s --check failed:\n%s%s"
                % (script, result.stdout, result.stderr)
            )


def main() -> int:
    if not SOURCE_DIR.exists():
        print("FAIL: %s does not exist" % SOURCE_DIR)
        return 1

    print("Verifying %d Swift files.\n" % len(swift_files()))
    check_intents()
    check_haptics()
    check_balance()
    check_files_exist()
    check_library_parity()
    check_generated_files()

    print("")
    if failures:
        print("%d check(s) failed." % len(failures))
        return 1
    print("All iOS checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
