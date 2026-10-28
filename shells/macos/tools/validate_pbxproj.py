#!/usr/bin/env python3
"""Validate the generated `Zode.xcodeproj/project.pbxproj`.

`plutil` does not exist on Linux, so this script parses the old style
(NeXTSTEP) property list on its own — it only needs the standard library.

The checks:

  1. the file parses as an old style plist,
  2. every object id that is referenced exists as a definition,
  3. every file reference points at a file that exists on disk,
  4. the `PBXNativeTarget` is an application (`com.apple.product-type.application`),
  5. the build settings contain the keys this track requires,
  6. the shared scheme exists and points at the target.

Usage:
    python3 tools/validate_pbxproj.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHELL_ROOT = HERE.parent
PBXPROJ = SHELL_ROOT / "Zode.xcodeproj" / "project.pbxproj"
SCHEME = SHELL_ROOT / "Zode.xcodeproj" / "xcshareddata" / "xcschemes" / "Zode.xcscheme"

OBJECT_ID = re.compile(r"^[0-9A-F]{24}$")

# The build settings the track requires (see deliverable.md).
REQUIRED_SETTINGS: dict[str, str] = {
    "PRODUCT_BUNDLE_IDENTIFIER": "com.zode.app",
    "PRODUCT_NAME": "Zode",
    "MACOSX_DEPLOYMENT_TARGET": "14.0",
    "SWIFT_VERSION": "5.0",
    "MARKETING_VERSION": "1.0.0",
    "CURRENT_PROJECT_VERSION": "1",
    "GENERATE_INFOPLIST_FILE": "NO",
    "INFOPLIST_FILE": "Zode/Info.plist",
    "CODE_SIGN_ENTITLEMENTS": "Zode/Zode.entitlements",
    "CODE_SIGN_STYLE": "Automatic",
    "ENABLE_HARDENED_RUNTIME": "YES",
    "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
    "COMBINE_HIDPI_IMAGES": "YES",
    "ENABLE_USER_SCRIPT_SANDBOXING": "NO",
    "DEVELOPMENT_TEAM": "$(ZODE_TEAM_ID)",
}


# =============================================================================
# A small old style plist parser
# =============================================================================

class PlistError(Exception):
    pass


class PlistParser:
    """Parses the old style (NeXTSTEP) property list Xcode writes."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.pos = 0

    def error(self, message: str) -> PlistError:
        line = self.text.count("\n", 0, self.pos) + 1
        return PlistError(f"line {line}: {message}")

    def skip(self) -> None:
        while self.pos < len(self.text):
            if self.text[self.pos] in " \t\n\r":
                self.pos += 1
            elif self.text.startswith("//", self.pos):
                end = self.text.find("\n", self.pos)
                self.pos = len(self.text) if end < 0 else end + 1
            elif self.text.startswith("/*", self.pos):
                end = self.text.find("*/", self.pos)
                if end < 0:
                    raise self.error("unterminated comment")
                self.pos = end + 2
            else:
                return

    def parse(self):
        self.skip()
        value = self.parse_value()
        self.skip()
        return value

    def parse_value(self):
        self.skip()
        if self.pos >= len(self.text):
            raise self.error("unexpected end of file")
        char = self.text[self.pos]
        if char == "{":
            return self.parse_dict()
        if char == "(":
            return self.parse_array()
        if char in "\"'":
            return self.parse_quoted()
        if char == "<":
            end = self.text.find(">", self.pos)
            if end < 0:
                raise self.error("unterminated data")
            self.pos = end + 1
            return "<data>"
        return self.parse_bare()

    def parse_dict(self):
        self.pos += 1  # '{'
        result: dict[str, object] = {}
        while True:
            self.skip()
            if self.pos >= len(self.text):
                raise self.error("unterminated dictionary")
            if self.text[self.pos] == "}":
                self.pos += 1
                return result
            key = self.parse_value()
            self.skip()
            if self.pos >= len(self.text) or self.text[self.pos] != "=":
                raise self.error(f"expected '=' after key '{key}'")
            self.pos += 1
            value = self.parse_value()
            self.skip()
            if self.pos < len(self.text) and self.text[self.pos] == ";":
                self.pos += 1
            result[str(key)] = value

    def parse_array(self):
        self.pos += 1  # '('
        result: list[object] = []
        while True:
            self.skip()
            if self.pos >= len(self.text):
                raise self.error("unterminated array")
            if self.text[self.pos] == ")":
                self.pos += 1
                return result
            result.append(self.parse_value())
            self.skip()
            if self.pos < len(self.text) and self.text[self.pos] == ",":
                self.pos += 1

    def parse_quoted(self) -> str:
        quote = self.text[self.pos]
        self.pos += 1
        out: list[str] = []
        escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "'": "'"}
        while True:
            if self.pos >= len(self.text):
                raise self.error("unterminated string")
            char = self.text[self.pos]
            if char == "\\":
                self.pos += 1
                out.append(escapes.get(self.text[self.pos], self.text[self.pos]))
                self.pos += 1
                continue
            if char == quote:
                self.pos += 1
                return "".join(out)
            out.append(char)
            self.pos += 1

    def parse_bare(self) -> str:
        start = self.pos
        while self.pos < len(self.text) and self.text[self.pos] not in " \t\n\r=;,(){}<>\"'":
            self.pos += 1
        if start == self.pos:
            raise self.error(f"unexpected character '{self.text[self.pos]}'")
        return self.text[start:self.pos]


# =============================================================================
# Helpers
# =============================================================================

def walk_references(value) -> list[str]:
    """Every object id that is referenced by a value."""
    found: list[str] = []
    if isinstance(value, dict):
        for item in value.values():
            found.extend(walk_references(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(walk_references(item))
    elif isinstance(value, str) and OBJECT_ID.match(value):
        found.append(value)
    return found


def by_isa(objects: dict, isa: str) -> list[tuple[str, dict]]:
    return [(key, value) for key, value in objects.items()
            if isinstance(value, dict) and value.get("isa") == isa]


# =============================================================================
# The checks
# =============================================================================

def main() -> int:
    errors: list[str] = []
    checks: list[str] = []

    if not PBXPROJ.exists():
        print(f"FAIL  {PBXPROJ} does not exist")
        return 1

    text = PBXPROJ.read_text(encoding="utf-8")

    # 1 — the file parses
    try:
        plist = PlistParser(text).parse()
    except PlistError as error:
        print(f"FAIL  the pbxproj does not parse: {error}")
        return 1
    if not isinstance(plist, dict) or "objects" not in plist:
        print("FAIL  the pbxproj is not a property list with an 'objects' dictionary")
        return 1
    checks.append("the pbxproj parses as an old style property list")

    objects: dict = plist["objects"]

    # 2 — every referenced id exists
    missing: list[str] = []
    for key, obj in objects.items():
        for reference in walk_references(obj):
            if reference not in objects:
                missing.append(f"{key} references the unknown object {reference}")
    if missing:
        errors.extend(missing)
    else:
        checks.append(f"all {len(objects)} objects only reference objects that exist")

    root = plist.get("rootObject")
    if root not in objects:
        errors.append(f"rootObject {root} does not exist")
    else:
        checks.append("rootObject exists")

    # 3 — every file reference points at a file on disk
    groups = {key: value for key, value in by_isa(objects, "PBXGroup")}
    parent: dict[str, str] = {}
    for group_id, group in groups.items():
        for child in group.get("children", []):
            parent[child] = group_id

    def resolve(file_id: str) -> Path | None:
        parts: list[str] = []
        current: str | None = file_id
        while current is not None:
            obj = objects.get(current)
            if obj is None:
                return None
            if obj.get("isa") == "PBXGroup":
                if obj.get("path"):
                    parts.append(str(obj["path"]))
                current = parent.get(current)
                continue
            if obj.get("sourceTree") == "BUILT_PRODUCTS_DIR":
                return None  # the product is built, it is not on disk
            if obj.get("path"):
                parts.append(str(obj["path"]))
            current = parent.get(current)
        return SHELL_ROOT.joinpath(*reversed(parts)) if parts else None

    missing_files: list[str] = []
    for file_id, file_ref in by_isa(objects, "PBXFileReference"):
        path = resolve(file_id)
        if path is None:
            continue
        if not path.exists():
            missing_files.append(f"{file_ref.get('path')} -> {path} does not exist")
    if missing_files:
        errors.extend(missing_files)
    else:
        checks.append("every file reference points at a file that exists on disk")

    # 4 — the native target is an application
    targets = by_isa(objects, "PBXNativeTarget")
    app_targets = [(key, value) for key, value in targets
                   if value.get("productType") == "com.apple.product-type.application"]
    if not app_targets:
        errors.append("no PBXNativeTarget with productType com.apple.product-type.application")
    else:
        names = ", ".join(str(value.get("name")) for _, value in app_targets)
        checks.append(f"the PBXNativeTarget '{names}' is an application")

    # 5 — the build settings
    settings: dict[str, str] = {}
    for _, configuration in by_isa(objects, "XCBuildConfiguration"):
        for key, value in configuration.get("buildSettings", {}).items():
            settings[str(key)] = str(value)
    for key, expected in REQUIRED_SETTINGS.items():
        actual = settings.get(key)
        if actual is None:
            errors.append(f"the build settings do not contain '{key}'")
        elif actual != expected:
            errors.append(f"the build setting '{key}' is '{actual}', expected '{expected}'")
    if not any(error.startswith("the build setting") for error in errors):
        checks.append(f"all {len(REQUIRED_SETTINGS)} required build settings are present")

    # 6 — the build phases contain what they should
    def phase_files(isa: str) -> list[str]:
        names: list[str] = []
        for _, phase in by_isa(objects, isa):
            for build_file_id in phase.get("files", []):
                build_file = objects.get(build_file_id, {})
                file_ref = objects.get(build_file.get("fileRef"), {})
                names.append(str(file_ref.get("path", "?")))
        return names

    source_files = phase_files("PBXSourcesBuildPhase")
    resource_files = phase_files("PBXResourcesBuildPhase")
    for required in ("Assets.xcassets", "haptics.json", "web"):
        if required not in resource_files:
            errors.append(f"the resources build phase does not contain '{required}'")
    if not any("resources build phase" in error for error in errors):
        checks.append(f"the resources build phase contains {', '.join(sorted(resource_files))}")
    if not source_files:
        errors.append("the sources build phase is empty")
    else:
        checks.append(f"the sources build phase contains {len(source_files)} Swift file(s)")

    # 7 — the shared scheme
    if not SCHEME.exists():
        errors.append(f"{SCHEME} does not exist")
    else:
        scheme = SCHEME.read_text(encoding="utf-8")
        if app_targets:
            target_id = app_targets[0][0]
            if target_id not in scheme:
                errors.append("the shared scheme does not reference the app target")
            else:
                checks.append("the shared scheme references the app target")
        if 'BuildableName = "Zode.app"' not in scheme:
            errors.append("the shared scheme does not build Zode.app")
        if "<ArchiveAction" not in scheme:
            errors.append("the shared scheme has no archive action")

    # -- report ---------------------------------------------------------
    print(f"validating {PBXPROJ.relative_to(SHELL_ROOT)}")
    for check in checks:
        print(f"  ok    {check}")
    if errors:
        print()
        for error in errors:
            print(f"  FAIL  {error}")
        print(f"\n{len(errors)} problem(s) found")
        return 1
    print(f"\nall {len(checks)} checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
