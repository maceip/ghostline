#!/usr/bin/env python3
"""check_artifacts.py — prove the release artifacts are complete.

A release once shipped a bare `Zode.Shell.exe`.  It was the ~520 KB apphost
launcher of a self-contained publish, so it downloaded fine and then did
nothing at all: the ~100 MB of .NET runtime files and the `web/` folder were
not next to it.

This script is the guard against that class of mistake.  It opens every
artifact that is about to be published and checks that the pieces the app
needs at runtime are actually inside it.

    python3 scripts/check_artifacts.py artifacts/*

It is deliberately platform independent: the `.zip` and the `.apk` are zip
files, and the `.dmg` is read with 7z when it is available.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import zipfile

CHECKS = 0
FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if ok:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} — {detail}")
        FAILURES.append(label)


def members(path: str) -> list[str] | None:
    """The member names inside a zip-like file, or None if it is not one."""
    try:
        with zipfile.ZipFile(path) as z:
            return z.namelist()
    except (zipfile.BadZipFile, OSError):
        return None


def dmg_members(path: str) -> list[str] | None:
    """The member names inside a .dmg, via 7z, if it is installed."""
    for binary in ("7z", "7za", "7zr"):
        if shutil.which(binary) is None:
            continue
        result = subprocess.run(
            [binary, "l", "-slt", path], capture_output=True, text=True
        )
        if result.returncode != 0:
            continue
        names = []
        for line in result.stdout.splitlines():
            if line.startswith("Path = "):
                names.append(line[7:].strip())
        return names
    return None


def check_windows_zip(path: str) -> None:
    print(f"\n{os.path.basename(path)}")
    names = members(path)
    if names is None:
        check("the portable build is a readable zip", False, path)
        return
    check("the portable build is a readable zip", True)

    # The whole point: the launcher is worthless without the runtime.
    for required in (
        "Zode.Shell.exe",
        "System.Private.CoreLib.dll",
        "coreclr.dll",
        "hostfxr.dll",
    ):
        check(f"it contains {required}", required in names)

    for required in (
        "web/index.html",
        "web/assets/haptics.json",
        "web/assets/library.json",
        "web/zode-mark.svg",
    ):
        check(f"it contains {required}", any(n.endswith(required) for n in names))
    check("it contains compiled web JS assets", any(n.startswith("web/assets/") and n.endswith(".js") for n in names))


def check_android_apk(path: str) -> None:
    print(f"\n{os.path.basename(path)}")
    names = members(path)
    if names is None:
        check("the apk is a readable zip", False, path)
        return
    check("the apk is a readable zip", True)
    check("it contains AndroidManifest.xml", "AndroidManifest.xml" in names)
    check("it contains classes.dex", any(n.startswith("classes") and n.endswith(".dex") for n in names))
    check("it contains resources.arsc", "resources.arsc" in names)
    check("it contains the bundled web app", any(n.endswith("assets/web/index.html") for n in names))
    check("it contains the haptics", any(n.endswith("haptics.json") for n in names))


def check_macos_dmg(path: str) -> None:
    print(f"\n{os.path.basename(path)}")
    names = dmg_members(path)
    if names is None:
        print("  skip  7z is not installed, so the disk image cannot be read here")
        print("        (the macOS job mounts it and runs the shell self test)")
        return
    check("the disk image can be read", True)
    check(
        "it contains the application binary",
        any(n.endswith("Zode.app/Contents/MacOS/Zode") for n in names),
    )
    check(
        "it contains the web app",
        any(n.endswith("Zode.app/Contents/Resources/web/index.html") for n in names),
    )
    check(
        "it contains the haptics",
        any(n.endswith("Zode.app/Contents/Resources/haptics.json") for n in names),
    )
    check(
        "it contains the icon",
        any(n.endswith("Zode.app/Contents/Resources/AppIcon.icns") for n in names),
    )


def main(argv: list[str]) -> int:
    paths = argv[1:]
    if not paths:
        print("usage: check_artifacts.py <artifact>…")
        return 2

    print("release artifacts")
    for path in paths:
        name = os.path.basename(path)
        if name.endswith(".zip"):
            check_windows_zip(path)
        elif name.endswith(".apk"):
            check_android_apk(path)
        elif name.endswith(".dmg"):
            check_macos_dmg(path)
        elif name.endswith(".exe"):
            # The trap.  A lone apphost cannot start.
            check("no bare executable is published", False,
                  f"{name} is a launcher without its runtime beside it — "
                  "ship the .zip instead")
        elif name.endswith(".msi"):
            size = os.path.getsize(path)
            check("the installer is not empty", size > 1_000_000, f"{size} bytes")
        else:
            print(f"\n{name}\n  skip  no check for this kind of file")

    # The rule, stated once, so it is impossible to miss.
    print("\nglobal rules")
    exes = [p for p in paths if p.endswith(".exe")]
    check("no artifact is a lone .exe launcher", not exes,
          ", ".join(os.path.basename(e) for e in exes))

    print(f"\n{CHECKS - len(FAILURES)}/{CHECKS} artifact checks passed")
    if FAILURES:
        print("the release must not be cut with a broken artifact")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
