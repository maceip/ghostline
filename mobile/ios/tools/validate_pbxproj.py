#!/usr/bin/env python3
"""Validate `ZodeMobile.xcodeproj/project.pbxproj`.

Standard library only. Run it from the repository root:

    python3 mobile/ios/tools/validate_pbxproj.py

It asserts that

  * the project file parses as an OpenStep property list;
  * every object ID that is referenced is also defined;
  * every file reference points at a file that exists on disk;
  * the build settings contain the keys the project needs
    (`IPHONEOS_DEPLOYMENT_TARGET`, `INFOPLIST_FILE`,
    `ASSETCATALOG_COMPILER_APPICON_NAME`, `CODE_SIGN_STYLE`,
    `DEVELOPMENT_TEAM`, `PRODUCT_BUNDLE_IDENTIFIER`);
  * the target is an application target with the right bundle id;
  * the shared scheme exists and points at the target.

Exits 0 when everything passes, 1 otherwise.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import openstep_plist  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
IOS_DIR = REPO_ROOT / "mobile" / "ios"
PBXPROJ = IOS_DIR / "ZodeMobile.xcodeproj" / "project.pbxproj"
SCHEME = (
    IOS_DIR
    / "ZodeMobile.xcodeproj"
    / "xcshareddata"
    / "xcschemes"
    / "ZodeMobile.xcscheme"
)

OBJECT_ID_RE = re.compile(r"^[0-9A-F]{24}$")

REQUIRED_TARGET_SETTINGS = {
    "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
    "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
    "CODE_SIGN_STYLE": "Automatic",
    "DEVELOPMENT_TEAM": "$(ZODE_TEAM_ID)",
    "PRODUCT_BUNDLE_IDENTIFIER": "com.zode.app.mobile",
}

REQUIRED_PROJECT_SETTINGS = {
    "IPHONEOS_DEPLOYMENT_TARGET": "17.0",
    "SDKROOT": "iphoneos",
    "SWIFT_VERSION": "5.0",
}

failures: list = []


def fail(message: str) -> None:
    failures.append(message)
    print("FAIL: %s" % message)


def ok(message: str) -> None:
    print("ok: %s" % message)


def check_references(objects: dict) -> None:
    defined = set(objects.keys())
    missing = set()

    def visit(value) -> None:
        if isinstance(value, str):
            if OBJECT_ID_RE.match(value) and value not in defined:
                missing.add(value)
        elif isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key != "isa":
                    visit(item)

    for identifier, entry in objects.items():
        visit(entry)

    if missing:
        fail("undefined object IDs referenced: %s" % ", ".join(sorted(missing)))
    else:
        ok("every referenced object ID is defined (%d objects)" % len(defined))


def resolve_paths(document: dict) -> dict:
    """Map every file reference ID to its path on disk."""
    objects = document["objects"]
    paths = {}
    project = objects[document["rootObject"]]

    def walk(group_id: str, prefix: str) -> None:
        group = objects.get(group_id)
        if group is None:
            return
        own_path = group.get("path")
        if own_path:
            prefix = prefix + own_path + "/"
        for child_id in group.get("children", []):
            child = objects.get(child_id)
            if child is None:
                continue
            if child.get("isa") == "PBXGroup":
                # `walk` applies the group's own path.
                walk(child_id, prefix)
            elif child.get("isa") == "PBXFileReference":
                source_tree = child.get("sourceTree")
                if source_tree == "BUILT_PRODUCTS_DIR":
                    continue
                paths[child_id] = prefix + child.get("path", "")

    walk(project["mainGroup"], "")
    return paths


def check_files(document: dict) -> None:
    paths = resolve_paths(document)
    if not paths:
        fail("no file references found")
        return
    missing = []
    for identifier, relative in sorted(paths.items(), key=lambda item: item[1]):
        target = IOS_DIR / relative
        if not target.exists():
            missing.append("%s (%s)" % (relative, identifier))
    if missing:
        for entry in missing:
            fail("file reference does not exist on disk: %s" % entry)
    else:
        ok("every file reference exists on disk (%d files)" % len(paths))


def target_configurations(document: dict):
    objects = document["objects"]
    project = objects[document["rootObject"]]
    targets = [objects[identifier] for identifier in project.get("targets", [])]
    applications = [t for t in targets if t.get("productType") == "com.apple.product-type.application"]
    if len(applications) != 1:
        fail("expected exactly one application target, found %d" % len(applications))
        return None, None
    target = applications[0]

    project_list = objects[project["buildConfigurationList"]]
    target_list = objects[target["buildConfigurationList"]]
    return project_list, target_list


def check_settings(document: dict) -> None:
    objects = document["objects"]
    project_list, target_list = target_configurations(document)
    if project_list is None or target_list is None:
        return

    project_settings = {}
    for identifier in project_list["buildConfigurations"]:
        configuration = objects[identifier]
        project_settings[configuration.get("name", "")] = configuration.get("buildSettings", {})

    target_settings = {}
    for identifier in target_list["buildConfigurations"]:
        configuration = objects[identifier]
        target_settings[configuration.get("name", "")] = configuration.get("buildSettings", {})

    for name, settings in project_settings.items():
        for key, expected in REQUIRED_PROJECT_SETTINGS.items():
            actual = settings.get(key)
            if actual != expected:
                fail("project %s: %s = %r (expected %r)" % (name, key, actual, expected))
            else:
                ok("project %s: %s = %s" % (name, key, actual))

    for name, settings in target_settings.items():
        for key, expected in REQUIRED_TARGET_SETTINGS.items():
            actual = settings.get(key)
            if actual != expected:
                fail("target %s: %s = %r (expected %r)" % (name, key, actual, expected))
            else:
                ok("target %s: %s = %s" % (name, key, actual))
        info_plist = settings.get("INFOPLIST_FILE")
        if not info_plist:
            fail("target %s: INFOPLIST_FILE is missing" % name)
        elif not (IOS_DIR / info_plist).exists():
            fail("target %s: INFOPLIST_FILE %s does not exist" % (name, info_plist))
        else:
            ok("target %s: INFOPLIST_FILE = %s" % (name, info_plist))


def check_target(document: dict) -> None:
    objects = document["objects"]
    project = objects[document["rootObject"]]
    targets = project.get("targets", [])
    if not targets:
        fail("the project has no targets")
        return
    for identifier in targets:
        target = objects[identifier]
        if target.get("productType") != "com.apple.product-type.application":
            fail(
                "target %s has productType %r"
                % (target.get("name"), target.get("productType"))
            )
            continue
        ok("target %s is an application target" % target.get("name"))
        phases = [objects[p].get("isa") for p in target.get("buildPhases", [])]
        for required in ("PBXSourcesBuildPhase", "PBXFrameworksBuildPhase", "PBXResourcesBuildPhase"):
            if required not in phases:
                fail("target %s is missing the %s phase" % (target.get("name"), required))
        if "PBXSourcesBuildPhase" in phases and "PBXFrameworksBuildPhase" in phases:
            ok("target %s has sources, frameworks and resources phases" % target.get("name"))


def check_scheme(document: dict) -> None:
    objects = document["objects"]
    if not SCHEME.exists():
        fail("the shared scheme is missing: %s" % SCHEME)
        return
    text = SCHEME.read_text(encoding="utf-8")
    project = objects[document["rootObject"]]
    target_ids = project.get("targets", [])
    for identifier in target_ids:
        if identifier not in text:
            fail("the shared scheme does not reference the target %s" % identifier)
            return
    if "ZodeMobile.app" not in text:
        fail("the shared scheme does not build ZodeMobile.app")
        return
    ok("the shared scheme references the target")


def main() -> int:
    if not PBXPROJ.exists():
        print("FAIL: %s does not exist -- run tools/generate_xcodeproj.py first" % PBXPROJ)
        return 1

    text = PBXPROJ.read_text(encoding="utf-8")
    try:
        document = openstep_plist.loads(text)
    except openstep_plist.ParseError as error:
        print("FAIL: the project file does not parse: %s" % error)
        return 1
    ok("the project file parses as an OpenStep property list")

    objects = document.get("objects", {})
    if not objects:
        print("FAIL: the project file has no objects")
        return 1

    if document.get("rootObject") not in objects:
        fail("rootObject %r is not defined" % document.get("rootObject"))
    else:
        ok("rootObject is defined")

    check_references(objects)
    check_files(document)
    check_settings(document)
    check_target(document)
    check_scheme(document)

    print("")
    if failures:
        print("%d check(s) failed." % len(failures))
        return 1
    print("All project checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
