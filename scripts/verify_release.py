#!/usr/bin/env python3
"""Validate the release tooling: the workflow, the installer source, the scripts.

None of this needs a Mac, a Windows box or an Apple account — it is a static
check that the release pipeline is wired together and that the files it
depends on exist and are well formed.  A mistake here only shows up as a red
CI run hours later, so it is worth catching now.

Run it directly, or through scripts/verify.sh.
"""

from __future__ import annotations

import os
import re
import sys
import xml.dom.minidom

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAILURES: list[str] = []
CHECKS = 0


def check(label: str, condition: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}" + (f" — {detail}" if detail else ""))
        FAILURES.append(label)


def read(*parts: str) -> str:
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as handle:
        return handle.read()


def exists(*parts: str) -> bool:
    return os.path.exists(os.path.join(ROOT, *parts))


# ---------------------------------------------------------------------------
# The release workflow
# ---------------------------------------------------------------------------
def check_release_workflow() -> None:
    path = ".github/workflows/release.yml"
    if not exists(path):
        check("the release workflow exists", False, f"{path} is missing")
        return
    text = read(path)

    check("the release workflow exists", True)
    check(
        "it runs on every push to main",
        bool(re.search(r"on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]", text)),
        "no push-to-main trigger",
    )
    check("it can write releases", "contents: write" in text)
    check("it cuts a GitHub Release", "gh release create" in text)
    check("it attaches the built artifacts", "artifacts/*" in text)

    for job in ("android:", "windows:", "macos:", "release:"):
        check(f"it has a '{job.rstrip(':')}' job", f"\n  {job}" in text)
    check("the release job waits for the three builds",
          "needs: [android, windows, macos]" in text)

    # The artefacts the README promises have to be the ones the workflow makes.
    check("it builds a Windows .msi", "build-msi.ps1" in text)
    check("it builds a macOS .dmg", "build-dmg.sh" in text)
    check("it builds an Android .apk", "assembleDebug" in text)

    # Notarisation.
    check("it can import a Developer ID certificate",
          "MACOS_CERTIFICATE" in text and "set-key-partition-list" in text)
    check("it stores the notarisation credentials",
          "notarytool store-credentials" in text)


# ---------------------------------------------------------------------------
# The macOS disk image
# ---------------------------------------------------------------------------
def check_macos_dmg() -> None:
    path = "shells/macos/build-dmg.sh"
    if not exists(path):
        check("the disk image script exists", False, f"{path} is missing")
        return
    text = read(path)

    check("the disk image script exists", True)
    # The six steps that stop Gatekeeper from deleting the app.
    check("it signs with the hardened runtime", "--options runtime" in text)
    check("it adds a secure timestamp", "--timestamp" in text)
    check("it applies the entitlements", "--entitlements" in text)
    check("it notarises", "notarytool submit" in text)
    check("it staples the ticket", "stapler staple" in text)
    check("it signs the disk image itself",
          text.count("codesign") >= 2, "the .dmg is not signed")
    check("it verifies with Gatekeeper", "spctl --assess" in text)

    # The order matters: the version has to be stamped before the signature,
    # because the Info.plist is part of the signed bundle.
    stamp = text.find("CFBundleShortVersionString")
    sign = text.find('log "Signing the app"')
    check("the version is stamped before the signature",
          stamp != -1 and sign != -1 and stamp < sign,
          "the Info.plist is edited after codesign, which breaks the signature")

    # The app has to be notarised AND stapled before the disk image is made.
    notarise = text.find("notarize_one")
    dmg = text.find('log "Building the disk image"')
    check("the app is notarised before the disk image is built",
          notarise != -1 and dmg != -1 and notarise < dmg)


# ---------------------------------------------------------------------------
# The Windows installer
# ---------------------------------------------------------------------------
def check_windows_msi() -> None:
    path = "shells/windows/msi/Zode.wxs"
    if not exists(path):
        check("the installer source exists", False, f"{path} is missing")
        return

    try:
        document = xml.dom.minidom.parse(os.path.join(ROOT, path))
        check("the installer source is well-formed XML", True)
    except Exception as error:  # noqa: BLE001
        check("the installer source is well-formed XML", False, str(error))
        return

    text = read(path)
    check("it uses the WiX v5 schema",
          "http://wixtoolset.org/schemas/v4/wxs" in text)
    check("it harvests the publish directory", "<Files Include=" in text)
    check("it installs per user", 'Scope="perUser"' in text)
    check("it creates a Start menu shortcut", "<Shortcut " in text)
    check("it has an upgrade code", "UpgradeCode=" in text)
    # A hard-coded path would break the build on every other machine.
    check("it has no hard-coded drive paths",
          not re.search(r"[A-Z]:\\\\", text),
          "an absolute path is baked into the installer source")

    script = "shells/windows/build-msi.ps1"
    if not exists(script):
        check("the installer build script exists", False, f"{script} is missing")
        return
    text = read(script)
    check("the installer build script exists", True)
    check("it invokes the wix tool", "wix build" in text)
    check("it passes the payload directory", "ZodeAppDir=" in text)
    check("it produces a portable zip too", "Compress-Archive" in text)


# ---------------------------------------------------------------------------
# The repository the releases point at
# ---------------------------------------------------------------------------
def check_version() -> None:
    path = "VERSION"
    if not exists(path):
        check("the VERSION file exists", False, f"{path} is missing")
        return
    version = read(path).strip()
    check("the VERSION file exists", True)
    check("the version looks like a version",
          bool(re.fullmatch(r"\d+\.\d+\.\d+", version)),
          f"VERSION contains {version!r}")


def check_notarisation_fallback() -> None:
    """A failed notarisation must not take the whole release down.

    Before this, a wrong Apple password killed the macOS job, which killed
    the release, which meant no artifacts at all.  Now the image is still
    built, the status is written to a file, and the release notes say
    which of the two it is.
    """
    script = read("shells", "macos", "build-dmg.sh")

    check("the build script writes a notarisation status file",
          "notarization.status" in script)

    block = script
    start = block.find("notarytool submit")
    if start == -1:
        check("the build script submits to the notary service", False,
              "no `notarytool submit` in build-dmg.sh")
        return
    end = block.find('notarize_one "${APP}"', start)
    block = block[start:end if end != -1 else len(script)]

    check("a failed notarisation does not stop the build",
          "|| die" not in block,
          "`notarytool submit` still kills the build")
    check("a failed notarisation is reported",
          "NOTARIZED=\"no\"" in block,
          "the NOTARIZED flag is not set on failure")
    check("a successful notarisation is recorded",
          "NOTARIZED=\"yes\"" in block,
          "the NOTARIZED flag is not set on success")

    workflow = read(".github", "workflows", "release.yml")
    check("the macOS job exports the notarisation status",
          "notarized: ${{ steps.dmg.outputs.notarized }}" in workflow)
    check("the release notes read that status",
          "needs.macos.outputs.notarized" in workflow)
    check("the release notes say when the image is not notarised",
          "not notarised" in workflow or "not notarized" in workflow,
          "the notes do not warn about an un-notarised image")
    check("a wrong Apple password does not fail the release",
          "could not store the notarisation credentials" in workflow,
          "store-credentials is still fatal")


def check_no_bare_exe() -> None:
    """The bare .exe must not be shipped.

    The Windows publish is self-contained, so `Zode.Shell.exe` is only the
    ~520 KB apphost launcher.  It needs the ~100 MB of .NET runtime files
    and the `web/` folder next to it, so on its own it downloads fine and
    then fails to start.  The `.zip` is the portable build.
    """
    workflow = read(".github", "workflows", "release.yml")
    attached = [ln for ln in workflow.splitlines()
                if "Zode.Shell.exe" in ln and ("Copy-Item" in ln or "dist/" in ln)]
    check("the release does not ship a bare .exe",
          not attached
          and "zode-windows-${VERSION}-x64.exe" not in workflow,
          "the bare launcher is attached to the release again: "
          + (attached[0].strip() if attached else "the download link is back"))

    readme = read("README.md")
    check("the README does not link a bare .exe",
          "x64.exe" not in readme,
          "the README links the launcher that cannot run on its own")

    doc = read("docs", "RELEASING.md")
    check("the release notes explain why",
          "apphost launcher" in doc,
          "docs/RELEASING.md does not say why there is no bare .exe")


def check_self_test_wiring() -> None:
    """The shells must be able to prove themselves, and CI must ask them to.

    A release once shipped a bare `Zode.Shell.exe`: it downloaded fine and
    then did nothing, because the runtime and the web app were not next to
    it.  The guard against that is a `--selftest` mode in both shells and a
    CI job that runs it on the artifact it is about to publish.
    """
    check("the Windows shell has a self test",
          exists("shells", "windows", "Zode.Shell", "Diagnostics", "SelfTest.cs"))
    check("the macOS shell has a self test",
          exists("shells", "macos", "Zode", "Diagnostics", "SelfTest.swift"))
    check("the artifact inspector exists",
          exists("scripts", "check_artifacts.py"))

    for wf in (".github/workflows/ci.yml", ".github/workflows/release.yml"):
        text = read(*wf.split("/"))
        check(f"{wf} runs the shell self test",
              "--selftest" in text,
              "no --selftest in the workflow")

    # CI builds but publishes nothing, so the inspector belongs to the
    # release job — it is the one that opens the artifacts.
    release = read(".github", "workflows", "release.yml")
    check("the release opens every artifact before publishing it",
          "check_artifacts.py" in release,
          "the artifacts are never opened before they are published")

    # The self test has to run on the artifact, not on a build in the middle
    # of the process.
    release = read(".github", "workflows", "release.yml")
    check("the release mounts the disk image it is about to publish",
          "hdiutil attach" in release and "Zode.app/Contents/MacOS/Zode" in release)
    check("the release unpacks the zip it is about to publish",
          "Expand-Archive" in release and "Zode.Shell.exe" in release)


def main() -> int:
    print("  release tooling")
    check_release_workflow()
    check_macos_dmg()
    check_windows_msi()
    check_version()
    check_notarisation_fallback()
    check_no_bare_exe()
    check_self_test_wiring()

    print(f"\n  {CHECKS - len(FAILURES)}/{CHECKS} release checks passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
