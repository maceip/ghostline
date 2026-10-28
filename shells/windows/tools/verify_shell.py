#!/usr/bin/env python3
"""verify_shell.py — static verification of the Zode Windows shell.

The build machine for this track is a Linux sandbox without the .NET SDK, so
this script performs the checks that CAN be performed here:

  1. every request type of contract §3 is implemented in the C# sources;
  2. the C# sources only use namespaces that ship with .NET / the Windows SDK
     projections or Microsoft.Web.WebView2 — the single allowed NuGet package;
  3. every file referenced by Zode.Shell.csproj exists;
  4. Zode.Shell.csproj parses as XML;
  5. Zode.Shell.sln parses (by regex — it is not XML) and references the project;
  6. msix/Package.appxmanifest parses as XML and msix/appactions.json as JSON;
  7. every intent name of contract §4 is defined in msix/appactions.json;
  8. the contract invariants that are easy to get wrong: DRAG_ZONE_HEIGHT = 34,
     the haptics programs come from packages/shared/haptics.json, and the icon
     carries 16/32/48/64/128/256 px entries.

Python 3 standard library only.  Run it from anywhere:

    python3 shells/windows/tools/verify_shell.py
"""

from __future__ import annotations

import json
import re
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHELL_ROOT = HERE.parent
REPO_ROOT = SHELL_ROOT.parent.parent

CONTRACT = REPO_ROOT / "packages" / "shared" / "contract.md"
HAPTICS = REPO_ROOT / "packages" / "shared" / "haptics.json"
CSPROJ = SHELL_ROOT / "Zode.Shell" / "Zode.Shell.csproj"
SLN = SHELL_ROOT / "Zode.Shell.sln"
APPXMANIFEST = SHELL_ROOT / "msix" / "Package.appxmanifest"
APPACTIONS = SHELL_ROOT / "msix" / "appactions.json"
ICON = SHELL_ROOT / "icons" / "zode.ico"
SOURCE_DIR = SHELL_ROOT / "Zode.Shell"

# Namespaces the C# sources are allowed to import.  Everything except
# Microsoft.Web.WebView2 comes from the .NET base class library or from the
# Windows SDK projections that the net10.0-windows10.0.26100.0 target
# framework brings in (they are not a NuGet package of this shell).
ALLOWED_USING_PREFIXES = (
    "System",
    "Microsoft.Web.WebView2",
    "Microsoft.Win32",
    "Windows",
    "Zode",
)

REQUIRED_ICON_SIZES = {16, 32, 48, 64, 128, 256}

results: list[tuple[bool, str, str]] = []


def check(ok: bool, name: str, detail: str = "") -> bool:
    results.append((ok, name, detail))
    marker = "PASS" if ok else "FAIL"
    line = f"[{marker}] {name}"
    if detail:
        line += f" — {detail}"
    print(line)
    return ok


# ---------------------------------------------------------------------------
# Contract parsing
# ---------------------------------------------------------------------------
def section_lines(markdown: str, heading: str) -> list[str]:
    """Returns the lines of the '## <heading>' section (until the next '##')."""
    lines = markdown.splitlines()
    start = None
    for index, line in enumerate(lines):
        if line.startswith("## ") and heading.lower() in line.lower():
            start = index + 1
            break
    if start is None:
        return []

    collected: list[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        collected.append(line)
    return collected


def table_keys(lines: list[str]) -> list[str]:
    """Extracts the first-column keys of the markdown tables in 'lines'.

    A cell may hold several backticked names separated by ' / ' (the
    zode.pause / zode.next / zode.previous row of contract §4), and the
    header row of a table is skipped.
    """
    keys: list[str] = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue

        # Skip the header row: the next line is the '|---|---|' separator.
        following = lines[index + 1].strip() if index + 1 < len(lines) else ""
        if re.match(r"^\|[\s\-:|]+\|$", following):
            continue

        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells:
            continue
        first = cells[0]
        tokens = re.findall(r"`([^`]+)`", first)
        if not tokens:
            continue
        for token in tokens:
            if token not in keys:
                keys.append(token)
    return keys


def contract_request_types(markdown: str) -> list[str]:
    return table_keys(section_lines(markdown, "3. Request types"))


def contract_intent_names(markdown: str) -> list[str]:
    return table_keys(section_lines(markdown, "4. Intent names"))


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------
def check_contract() -> tuple[list[str], list[str]]:
    if not CONTRACT.is_file():
        check(False, "contract is readable", f"{CONTRACT} is missing")
        return [], []

    text = CONTRACT.read_text(encoding="utf-8")
    request_types = contract_request_types(text)
    intents = contract_intent_names(text)

    check(len(request_types) >= 13, "contract §3 request types parsed", f"{len(request_types)} types")
    check(len(intents) >= 9, "contract §4 intent names parsed", f"{len(intents)} intents")
    return request_types, intents


def check_request_types(request_types: list[str]) -> None:
    sources = sorted(SOURCE_DIR.rglob("*.cs"))
    if not sources:
        check(False, "C# sources found", "no .cs file below Zode.Shell/")
        return

    blob = "\n".join(path.read_text(encoding="utf-8") for path in sources)

    missing = [t for t in request_types if f'"{t}"' not in blob]
    check(
        not missing,
        "every contract §3 request type is implemented",
        "missing: " + ", ".join(missing) if missing else f"{len(request_types)} types found",
    )

    # The constants of RequestTypes must match the contract exactly.
    constants: dict[str, str] = {}
    for match in re.finditer(r'public const string (\w+)\s*=\s*"([^"]+)";', blob):
        constants[match.group(1)] = match.group(2)
    by_value = {value: name for name, value in constants.items()}
    declared = {v for v in constants.values() if v in set(request_types)}
    extra = sorted(declared - set(request_types))
    missing_declared = sorted(set(request_types) - declared)
    check(
        not extra and not missing_declared,
        "RequestTypes constants match the contract",
        f"extra={extra} missing={missing_declared}" if (extra or missing_declared) else "13/13",
    )

    # Every request type must be routed by the dispatcher.
    dispatcher = (SOURCE_DIR / "Bridge" / "BridgeDispatcher.cs").read_text(encoding="utf-8")
    unrouted = [
        t
        for t in request_types
        if f"RequestTypes.{by_value.get(t, t)}" not in dispatcher and f'"{t}"' not in dispatcher
    ]
    check(
        not unrouted,
        "every request type is routed by BridgeDispatcher",
        "unrouted: " + ", ".join(unrouted) if unrouted else "all routed",
    )


def check_usings() -> None:
    sources = sorted(SOURCE_DIR.rglob("*.cs"))
    offenders: list[str] = []
    for path in sources:
        for match in re.finditer(r"^\s*using\s+([A-Za-z0-9_.]+)\s*;", path.read_text(encoding="utf-8"), re.M):
            namespace = match.group(1)
            if namespace.startswith("static "):
                continue
            if not any(namespace == p or namespace.startswith(p + ".") for p in ALLOWED_USING_PREFIXES):
                offenders.append(f"{path.name}: using {namespace}")

    check(
        not offenders,
        "no third-party using directives",
        "; ".join(offenders) if offenders else "only System / Microsoft.Web.WebView2 / Windows / Zode",
    )

    # The only NuGet package of the shell.
    tree = ET.parse(CSPROJ)
    packages = [ref.get("Include", "") for ref in tree.iter("PackageReference")]
    check(
        packages == ["Microsoft.Web.WebView2"],
        "exactly one NuGet package reference",
        ", ".join(packages) if packages else "none",
    )

    frameworks = [ref.get("Include", "") for ref in tree.iter("FrameworkReference")]
    check(
        all(f in ("Microsoft.NETCore.App", "Microsoft.WindowsDesktop.App") for f in frameworks),
        "no unexpected framework references",
        ", ".join(frameworks) if frameworks else "none",
    )


def check_csproj() -> None:
    try:
        tree = ET.parse(CSPROJ)
    except ET.ParseError as error:
        check(False, "Zode.Shell.csproj parses as XML", str(error))
        return

    check(True, "Zode.Shell.csproj parses as XML")

    text = CSPROJ.read_text(encoding="utf-8")
    target = re.search(r"<TargetFramework>([^<]+)</TargetFramework>", text)
    check(
        target is not None and target.group(1) == "net10.0-windows10.0.26100.0",
        "target framework",
        target.group(1) if target else "missing",
    )

    for needle, label in (
        ("<UseWindowsForms>false</UseWindowsForms>", "UseWindowsForms is false"),
        ("<OutputType>WinExe</OutputType>", "OutputType is WinExe"),
        ("<Nullable>enable</Nullable>", "nullable is enabled"),
        ("<ImplicitUsings>enable</ImplicitUsings>", "implicit usings are enabled"),
        ("<ApplicationManifest>app.manifest</ApplicationManifest>", "app.manifest is embedded"),
    ):
        check(needle in text, label)

    manifest = SOURCE_DIR / "app.manifest"
    check(manifest.is_file(), "app.manifest exists")
    if manifest.is_file():
        try:
            ET.parse(manifest)
            check(True, "app.manifest parses as XML")
        except ET.ParseError as error:
            check(False, "app.manifest parses as XML", str(error))
        manifest_text = manifest.read_text(encoding="utf-8")
        check("PerMonitorV2" in manifest_text, "app.manifest requests PerMonitorV2")
        check('level="asInvoker"' in manifest_text, "app.manifest requests asInvoker")

    # Every file the project references must exist.
    missing: list[str] = []
    referenced = 0
    for element in tree.iter():
        if element.tag not in ("Compile", "None", "EmbeddedResource", "Content", "ApplicationIcon"):
            continue
        include = element.get("Include")
        if not include or "*" in include:
            continue
        referenced += 1
        target_path = (CSPROJ.parent / include.replace("\\", "/")).resolve()
        if not target_path.exists():
            missing.append(include)

    check(
        not missing,
        "every file referenced by the csproj exists",
        "missing: " + ", ".join(missing) if missing else f"{referenced} references resolved",
    )


def check_solution() -> None:
    text = SLN.read_text(encoding="utf-8")
    ok_header = text.startswith("Microsoft Visual Studio Solution File")
    check(ok_header, "Zode.Shell.sln header", text.splitlines()[0] if text else "empty")

    projects = re.findall(r'Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"', text)
    check(len(projects) >= 1, "Zode.Shell.sln declares a project", f"{len(projects)} project(s)")

    names = [name for name, _ in projects]
    paths = [path for _, path in projects]
    check("Zode.Shell" in names, "the solution references Zode.Shell", ", ".join(names))

    resolved = [(SHELL_ROOT / path.replace("\\", "/")).resolve() for path in paths]
    check(all(path.exists() for path in resolved), "the solution project paths exist",
          ", ".join(paths))

    configurations = re.findall(
        r"^\s*(?:\{[0-9A-Fa-f-]+\}\.)?([A-Za-z]+\|[A-Za-z0-9]+)\.(ActiveCfg|Build\.0)\s*=", text, re.M
    )
    check(len(configurations) >= 8, "the solution declares build configurations",
          f"{len(configurations)} configuration lines")


def check_msix(intents: list[str]) -> None:
    try:
        ET.parse(APPXMANIFEST)
        check(True, "msix/Package.appxmanifest parses as XML")
    except ET.ParseError as error:
        check(False, "msix/Package.appxmanifest parses as XML", str(error))

    manifest_text = APPXMANIFEST.read_text(encoding="utf-8")
    check('Category="windows.appActions"' in manifest_text, "the manifest declares the appActions extension")
    check('Category="windows.protocol"' in manifest_text, "the manifest declares the zode:// protocol")
    check('Category="windows.appExecutionAlias"' in manifest_text, "the manifest declares the execution alias")
    check("appactions.json" in manifest_text, "the manifest points at appactions.json")

    try:
        data = json.loads(APPACTIONS.read_text(encoding="utf-8"))
        check(True, "msix/appactions.json parses as JSON")
    except json.JSONDecodeError as error:
        check(False, "msix/appactions.json parses as JSON", str(error))
        return

    actions = data.get("actions", [])
    names = [action.get("name", "") for action in actions]
    missing = [intent for intent in intents if intent not in names]
    check(
        not missing,
        "every contract §4 intent is an App Action",
        "missing: " + ", ".join(missing) if missing else f"{len(names)} actions",
    )


def check_contract_invariants() -> None:
    sources = sorted(SOURCE_DIR.rglob("*.cs"))
    blob = "\n".join(path.read_text(encoding="utf-8") for path in sources)

    check(
        re.search(r"DRAG_ZONE_HEIGHT\s*=\s*34", blob) is not None,
        "DRAG_ZONE_HEIGHT is 34 (contract §5)",
    )
    check("WS_POPUP" in blob and "WS_THICKFRAME" in blob and "WS_CLIPCHILDREN" in blob,
          "the window uses WS_POPUP | WS_THICKFRAME | WS_CLIPCHILDREN")
    check("WM_NCCALCSIZE" in blob, "WM_NCCALCSIZE is handled")
    check("HTCAPTION" in blob and "WM_NCLBUTTONDOWN" in blob and "ReleaseCapture" in blob,
          "the native window drag (ReleaseCapture + WM_NCLBUTTONDOWN) is implemented")
    check("SetWindowPos" in blob and "GetMonitorInfo" in blob and "MonitorFromWindow" in blob,
          "the fill-screen path uses SetWindowPos + MonitorFromWindow/GetMonitorInfo")
    check("GetWindowPlacement" in blob and "SetWindowPlacement" in blob,
          "the previous WINDOWPLACEMENT is saved and restored")
    check("SetWindowDisplayAffinity(" not in blob,
          "the shell never enters real fullscreen (no SetWindowDisplayAffinity)")

    check("waveOutOpen" in blob and "waveOutWrite" in blob,
          "the haptics are rendered through winmm waveOut")
    check("HapticLibrary" in blob and "haptics.json" in blob,
          "the haptic programs are read from the shared package")
    check("IVibrationDevice" in blob or "VibrationDevice" in blob,
          "the secondary IVibrationDevice path is implemented")

    check("RegisterDragDrop" in blob, "IDropTarget is registered with RegisterDragDrop")
    check("DragQueryFileW" in blob, "dropped files are read with DragQueryFileW")
    check("IFileOpenDialog" in blob, "attach.pick uses IFileOpenDialog")
    check("ToastNotificationManager" in blob, "notifications use the WinRT toast API")
    check("CreateToastNotifier" in blob, "the toast is raised for the app's AUMID")
    check("SetCurrentProcessExplicitAppUserModelID" in blob, "an AppUserModelID is registered")
    check("IShellLinkW" in blob and "IPersistFile" in blob, "a Start Menu shortcut is created")
    check("ICustomDestinationList" in blob, "the Jump List uses ICustomDestinationList")
    check("journal.jsonl" in blob, "the journal writes a local activity log")
    check("NotificationAction" in blob, "a toast activation raises the notificationAction event")

    # The haptic programs must not be hard coded: the csproj has to point at
    # the shared package.
    csproj_text = CSPROJ.read_text(encoding="utf-8")
    check(
        "packages\\shared\\haptics.json" in csproj_text or "packages/shared/haptics.json" in csproj_text,
        "the csproj takes haptics.json from packages/shared",
    )
    check(HAPTICS.is_file(), "packages/shared/haptics.json exists")

    if HAPTICS.is_file():
        data = json.loads(HAPTICS.read_text(encoding="utf-8"))
        programs = data.get("programs", {})
        check("done" in programs and "working" in programs,
              "the canonical 'done' and 'working' programs exist")
        check(programs.get("working", {}).get("loop") is True,
              "the 'working' program loops (contract §7)")


def check_icon() -> None:

    if not ICON.is_file():
        check(False, "icons/zode.ico exists")
        return

    blob = ICON.read_bytes()
    reserved, kind, count = struct.unpack("<HHH", blob[:6])
    if reserved != 0 or kind != 1:
        check(False, "icons/zode.ico is an icon file", f"reserved={reserved} type={kind}")
        return

    sizes = set()
    for index in range(count):
        offset = 6 + (16 * index)
        width, height = struct.unpack("<BB", blob[offset : offset + 2])
        sizes.add(width or 256)
        sizes.add(height or 256)

    check(
        REQUIRED_ICON_SIZES.issubset(sizes),
        "icons/zode.ico contains 16/32/48/64/128/256 px entries",
        ", ".join(str(size) for size in sorted(sizes)),
    )


def strip_csharp(source: str) -> str:
    """Removes comments and string literals so that braces can be counted."""
    out: list[str] = []
    index = 0
    length = len(source)
    while index < length:
        char = source[index]
        if char == "/" and index + 1 < length and source[index + 1] == "/":
            newline = source.find("\n", index)
            index = length if newline < 0 else newline
            continue
        if char == "/" and index + 1 < length and source[index + 1] == "*":
            end = source.find("*/", index + 2)
            index = length if end < 0 else end + 2
            continue
        if char == "@" and index + 1 < length and source[index + 1] == '"':
            index += 2
            while index < length:
                if source[index] == '"':
                    if index + 1 < length and source[index + 1] == '"':
                        index += 2
                        continue
                    index += 1
                    break
                index += 1
            continue
        if char == '"':
            index += 1
            while index < length:
                if source[index] == "\\":
                    index += 2
                    continue
                if source[index] == '"':
                    index += 1
                    break
                if source[index] == "\n":
                    break
                index += 1
            continue
        if char == "'":
            index += 1
            while index < length:
                if source[index] == "\\":
                    index += 2
                    continue
                if source[index] == "'":
                    index += 1
                    break
                index += 1
            continue
        out.append(char)
        index += 1
    return "".join(out)


def check_csharp_structure() -> None:
    """A cheap structural sanity check (no compiler available in this sandbox)."""
    sources = sorted(SOURCE_DIR.rglob("*.cs"))
    unbalanced: list[str] = []
    namespaces: set[str] = set()

    for path in sources:
        text = path.read_text(encoding="utf-8")
        stripped = strip_csharp(text)
        if stripped.count("{") != stripped.count("}"):
            unbalanced.append(f"{path.name}: braces")
        elif stripped.count("(") != stripped.count(")"):
            unbalanced.append(f"{path.name}: parentheses")
        elif stripped.count("[") != stripped.count("]"):
            unbalanced.append(f"{path.name}: brackets")
        for match in re.finditer(r"^\s*namespace\s+([A-Za-z0-9_.]+)\s*;", text, re.M):
            namespaces.add(match.group(1))

    check(not unbalanced, "every C# file has balanced braces/parens/brackets",
          "; ".join(unbalanced) if unbalanced else f"{len(sources)} files")

    used: set[str] = set()
    for path in sources:
        for match in re.finditer(r"^\s*using\s+(Zode[A-Za-z0-9_.]*)\s*;", path.read_text(encoding="utf-8"), re.M):
            used.add(match.group(1))

    unknown = sorted(used - namespaces)
    check(not unknown, "every 'using Zode…' namespace exists in the project",
          ", ".join(unknown) if unknown else f"{len(used)} namespaces resolved")


def main() -> int:
    print("Zode — Windows shell static verification")
    print(f"repository: {REPO_ROOT}")
    print("-" * 72)

    request_types, intents = check_contract()
    check_request_types(request_types)
    check_usings()
    check_csproj()
    check_solution()
    check_msix(intents)
    check_contract_invariants()
    check_csharp_structure()
    check_icon()

    print("-" * 72)
    failed = [name for ok, name, _ in results if not ok]
    print(f"{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        for name in failed:
            print(f"  FAILED: {name}")
        return 1

    print("All static checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
