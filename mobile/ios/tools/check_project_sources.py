#!/usr/bin/env python3
"""Check that the generated Xcode project compiles every source file.

A Swift file that exists on disk but is not in the Sources build phase is the
classic Xcode build failure: the code compiles, but every type it declares is
"cannot find type X in scope" somewhere else.  It is easy to miss by eye
because the project file is generated and the tree is deep.

This walks the PBXGroup tree, resolves each PBXFileReference to a real path
on disk, and compares the set of Swift files in the Sources build phase with
the set of Swift files on disk.

Usage:
    python3 shells/macos/tools/check_project_sources.py
    python3 mobile/ios/tools/check_project_sources.py
"""

from __future__ import annotations

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def find_project_root(start: str) -> str:
    """Walk up until a directory with a .xcodeproj is found."""
    current = start
    for _ in range(5):
        for entry in os.listdir(current):
            if entry.endswith(".xcodeproj"):
                return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return start


def read_pbxproj(project_dir: str) -> str:
    for entry in os.listdir(project_dir):
        if entry.endswith(".xcodeproj"):
            path = os.path.join(project_dir, entry, "project.pbxproj")
            if os.path.exists(path):
                with open(path, encoding="utf-8") as handle:
                    return handle.read()
    raise SystemExit(f"no project.pbxproj inside {project_dir}")


def parse_objects(pbx: str) -> dict[str, str]:
    """Map an object id to the text of its body.

    Xcode writes most objects on a single line and the larger ones across
    several, so both shapes have to be handled.
    """
    objects: dict[str, str] = {}
    pattern = re.compile(r"^\t\t([0-9A-F]{24}) /\*.*?\*/ = \{(.*?)\};", re.S | re.M)
    for match in pattern.finditer(pbx):
        objects[match.group(1)] = match.group(2)
    return objects


def field(body: str, name: str) -> str:
    match = re.search(rf"{name} = ([^;]+);", body)
    if not match:
        return ""
    value = match.group(1).strip()
    # Xcode often writes a trailing comment:  fileRef = ABC123 /* App.swift */
    value = re.sub(r"/\*.*?\*/", "", value).strip()
    return value.strip('"')


def child_ids(body: str) -> list[str]:
    match = re.search(r"children = \((.*?)\);", body, re.S)
    if not match:
        return []
    return re.findall(r"([0-9A-F]{24})", match.group(1))


def main() -> int:
    project_dir = find_project_root(HERE)
    pbx = read_pbxproj(project_dir)
    objects = parse_objects(pbx)

    # The root group is the one that is not a child of anything.
    child_of: set[str] = set()
    for body in objects.values():
        child_of.update(child_ids(body))
    roots = [oid for oid, body in objects.items()
             if "isa = PBXGroup" in body and oid not in child_of]
    if not roots:
        print("  no root group found")
        return 1

    # Resolve every file reference to a path relative to the project dir.
    def resolve(node: str, prefix: str, out: dict[str, str]) -> None:
        body = objects.get(node, "")
        # A group's own path is part of the path of everything under it.
        own = field(body, "path")
        if not own and node in roots:
            own = field(body, "name")
        current = os.path.join(prefix, own) if own else prefix
        for child in child_ids(body):
            child_body = objects.get(child, "")
            if "isa = PBXGroup" in child_body:
                resolve(child, current, out)
            elif "isa = PBXFileReference" in child_body:
                path = field(child_body, "path")
                if path:
                    out[child] = os.path.join(current, path)

    file_paths: dict[str, str] = {}
    for root in roots:
        resolve(root, "", file_paths)

    # Which of them are compiled?
    compiled: set[str] = set()
    for body in objects.values():
        if "isa = PBXSourcesBuildPhase" not in body:
            continue
        match = re.search(r"files = \((.*?)\);", body, re.S)
        if not match:
            continue
        for entry in re.findall(r"([0-9A-F]{24}) /\*.*?\*/", match.group(1)):
            build_file = objects.get(entry, "")
            ref = field(build_file, "fileRef")
            if ref in file_paths:
                compiled.add(file_paths[ref])

    # What is on disk?
    source_root = os.path.join(project_dir, "Zode")
    if not os.path.isdir(source_root):
        for entry in os.listdir(project_dir):
            candidate = os.path.join(project_dir, entry)
            if os.path.isdir(candidate) and entry.endswith("Mobile"):
                source_root = candidate
                break
    if not os.path.isdir(source_root):
        source_root = project_dir

    on_disk: set[str] = set()
    for base, _, files in os.walk(source_root):
        for name in files:
            if name.endswith(".swift"):
                on_disk.add(os.path.relpath(os.path.join(base, name), project_dir))

    # Only Swift files matter here: a build product like Zode.app lives in
    # BUILT_PRODUCTS_DIR and is never a file on disk.
    compiled = {p for p in compiled if p.endswith(".swift")}
    on_disk = {p for p in on_disk if p.endswith(".swift")}

    missing = sorted(p for p in on_disk if p not in compiled)
    extra = sorted(p for p in compiled if p not in on_disk)
    print(f"  {project_dir}")
    print(f"  swift files on disk      : {len(on_disk)}")
    print(f"  in the Sources phase     : {len(compiled)}")

    ok = True
    if missing:
        ok = False
        print("  NOT COMPILED (would be 'cannot find type in scope'):")
        for path in missing:
            print(f"    - {path}")
    if extra:
        ok = False
        print("  IN THE PROJECT BUT NOT ON DISK:")
        for path in extra:
            print(f"    - {path}")
    if ok:
        print("  every Swift file on disk is compiled")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
