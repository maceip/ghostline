#!/usr/bin/env python3
"""Generate `ZodeMobile.xcodeproj` deterministically.

Standard library only. Run it from the repository root:

    python3 mobile/ios/tools/generate_xcodeproj.py

The generator walks `mobile/ios/ZodeMobile/`, mirrors the directory tree into
Xcode groups, and writes a `project.pbxproj` plus a shared scheme.

Everything is deterministic:

  * object IDs are the first 24 hex digits of the SHA-1 of the object's name,
    so the same source tree always produces the same project file;
  * files are visited in sorted order;
  * the output is byte-identical between runs (see `--check`).

Usage:
    python3 mobile/ios/tools/generate_xcodeproj.py            # write the project
    python3 mobile/ios/tools/generate_xcodeproj.py --check    # fail if stale
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[3]
IOS_DIR = REPO_ROOT / "mobile" / "ios"
SOURCE_DIR = IOS_DIR / "ZodeMobile"
PROJECT_DIR = IOS_DIR / "ZodeMobile.xcodeproj"
PBXPROJ = PROJECT_DIR / "project.pbxproj"
SCHEME_DIR = PROJECT_DIR / "xcshareddata" / "xcschemes"
SCHEME = SCHEME_DIR / "ZodeMobile.xcscheme"

TARGET_NAME = "ZodeMobile"
BUNDLE_ID = "com.zode.app.mobile"
DEPLOYMENT_TARGET = "17.0"
SWIFT_VERSION = "5.0"
OBJECT_VERSION = "56"
COMPATIBILITY_VERSION = "Xcode 15.0"

# Resources that are not part of the source tree walk.
EXTRA_RESOURCES = ["haptics.json", "library.json"]

# The folder inside the bundle that holds the web application.  It has to be
# a *folder reference*: Xcode copies a folder reference as a directory, while
# the files inside it would each be copied to the root of the bundle — and
# the web app carries its own assets/haptics.json and assets/library.json,
# which would then collide with the ones the app bundles next to them.
WEB_FOLDER = "web"

# The Info.plist is referenced by build settings, never copied as a resource.
INFO_PLIST = "ZodeMobile/Resources/Info.plist"


# ----------------------------------------------------------------------
# Identifiers


class Identifiers:
    """Stable 24 hex character object IDs, derived from an object's name."""

    def __init__(self) -> None:
        self._ids: Dict[str, str] = {}
        self._used: Dict[str, str] = {}

    def of(self, name: str) -> str:
        if name in self._ids:
            return self._ids[name]
        digest = hashlib.sha1(name.encode("utf-8")).hexdigest().upper()[:24]
        if digest in self._used and self._used[digest] != name:
            raise RuntimeError(
                "Object ID collision between %r and %r" % (self._used[digest], name)
            )
        self._used[digest] = name
        self._ids[name] = digest
        return digest


# ----------------------------------------------------------------------
# The project model


class FileNode:
    def __init__(self, path: Path, relative: str) -> None:
        self.path = path
        self.relative = relative
        self.name = path.name


class Group:
    def __init__(self, name: str, path: Optional[str]) -> None:
        self.name = name
        self.path = path
        self.children: List[object] = []  # Group | FileNode
        self.id_name = "group:" + (path or name)


def collect_files() -> Tuple[List[FileNode], List[FileNode], List[FileNode]]:
    """Return (swift sources, resource files, other references)."""
    sources: List[FileNode] = []
    resources: List[FileNode] = []
    others: List[FileNode] = []

    for path in sorted(SOURCE_DIR.rglob("*")):
        if path.is_dir():
            continue
        relative = path.relative_to(IOS_DIR).as_posix()
        if ".xcassets/" in relative + "/":
            # The asset catalog is referenced as a whole.
            continue
        if WEB_FOLDER + "/" in relative:
            # The bundled web application is a folder reference; its files
            # are copied as a directory, not flattened into the bundle root.
            continue
        if path.suffix == ".swift":
            sources.append(FileNode(path, relative))
        elif path.suffix == ".xcassets":
            resources.append(FileNode(path, relative))
        elif path.name in EXTRA_RESOURCES:
            resources.append(FileNode(path, relative))
        else:
            others.append(FileNode(path, relative))

    # The web application is referenced as a folder, so Xcode copies the
    # whole directory into the bundle.
    web_folder = SOURCE_DIR / "Resources" / WEB_FOLDER
    if web_folder.is_dir():
        resources.append(FileNode(web_folder, web_folder.relative_to(IOS_DIR).as_posix()))

    # Make sure the shared files are always bundled, even if they have not
    # been copied into the source tree yet.
    for name in EXTRA_RESOURCES:
        extra = SOURCE_DIR / "Resources" / name
        if extra.exists() and not any(r.relative.endswith(name) for r in resources):
            resources.append(FileNode(extra, extra.relative_to(IOS_DIR).as_posix()))

    return sources, resources, others


def build_groups(
    sources: List[FileNode], resources: List[FileNode], others: List[FileNode]
) -> Group:
    """Mirror the directory tree into Xcode groups."""
    root = Group(TARGET_NAME, TARGET_NAME)

    by_directory: Dict[str, List[FileNode]] = {}
    for node in sources + resources + others:
        # The group tree is rooted at the source folder, so the paths are
        # relative to `ZodeMobile/` (the root group carries the folder name).
        inside = node.path.relative_to(SOURCE_DIR).as_posix()
        directory = inside.rsplit("/", 1)[0] if "/" in inside else ""
        by_directory.setdefault(directory, []).append(node)

    directories = sorted(by_directory.keys())

    def group_for(directory: str) -> Group:
        parts = directory.split("/") if directory else []
        current = root
        for index in range(len(parts)):
            path = "/".join(parts[: index + 1])
            existing = None
            for child in current.children:
                if isinstance(child, Group) and child.path == path:
                    existing = child
                    break
            if existing is None:
                existing = Group(parts[index], path)
                current.children.append(existing)
            current = existing
        return current

    for directory in directories:
        parent = group_for(directory) if directory else root
        for node in sorted(by_directory[directory], key=lambda item: item.name):
            parent.children.append(node)

    def sort_children(group: Group) -> None:
        group.children.sort(
            key=lambda child: (0 if isinstance(child, Group) else 1, child.name)
        )
        for child in group.children:
            if isinstance(child, Group):
                sort_children(child)

    sort_children(root)
    return root


# ----------------------------------------------------------------------
# pbxproj writing


def file_type(node: FileNode) -> str:
    if node.path.is_dir():
        # A folder reference: Xcode copies the whole directory into the
        # bundle instead of flattening its files into the bundle root.
        return "folder"
    suffix = node.path.suffix.lower()
    if suffix == ".swift":
        return "sourcecode.swift"
    if suffix == ".xcassets":
        return "folder.assetcatalog"
    if suffix == ".png":
        return "image.png"
    if suffix == ".json":
        return "text.json"
    if suffix == ".plist":
        return "text.plist.xml"
    if node.path.name == "haptics.json":
        return "text.json"
    return "text"


def setting_value(value: object) -> str:
    """Render a build setting value.

    A list is a real property list array.  It has to be: a list written as a
    quoted string is read back as one string, and the build system then splits
    it on the commas, so `("DEBUG=1", "$(inherited)")` turns into three
    broken preprocessor definitions called `(`, `,` and `)`.
    """
    if isinstance(value, (list, tuple)):
        items = "\n".join("\t\t\t\t\t%s," % escape(str(item)) for item in value)
        return "(\n%s\n\t\t\t\t)" % items
    return escape(str(value))


def escape(value: str) -> str:
    """Quote a value when the OpenStep plist format needs it.

    The old-style plist reserves parentheses, so a build setting like
    `$(ZODE_TEAM_ID)` has to be written as `"$(ZODE_TEAM_ID)"`.  Xcode
    refuses to open a project whose plist is malformed, and it does not
    always say which file is at fault.

    A value that is already a quoted literal is left alone, so the caller
    can pre-quote a setting that needs a comma in it.
    """
    if value == "":
        return '""'
    if value.startswith('"') and value.endswith('"') and len(value) >= 2:
        return value
    safe = set(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$./"
    )
    if all(character in safe for character in value):
        return value
    return '"%s"' % value.replace("\\", "\\\\").replace('"', '\\"')


def write_pbxproj(
    identifiers: Identifiers,
    root: Group,
    sources: List[FileNode],
    resources: List[FileNode],
    others: List[FileNode],
) -> str:
    out: List[str] = []
    out.append("// !$*UTF8*$!")
    out.append("{")
    out.append("\tarchiveVersion = 1;")
    out.append("\tclasses = {")
    out.append("\t};")
    out.append("\tobjectVersion = %s;" % OBJECT_VERSION)
    out.append("\tobjects = {")
    out.append("")

    file_ref_ids: Dict[str, str] = {}
    for node in sources + resources + others:
        file_ref_ids[node.relative] = identifiers.of("fileref:" + node.relative)

    group_ids: Dict[str, str] = {}

    def group_id(group: Group) -> str:
        if group.id_name not in group_ids:
            group_ids[group.id_name] = identifiers.of(group.id_name)
        return group_ids[group.id_name]

    # ---- PBXBuildFile ------------------------------------------------
    out.append("/* Begin PBXBuildFile section */")
    for node in sources:
        out.append(
            "\t\t%s /* %s in Sources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };"
            % (
                identifiers.of("buildfile:sources:" + node.relative),
                node.name,
                file_ref_ids[node.relative],
                node.name,
            )
        )
    for node in resources:
        out.append(
            "\t\t%s /* %s in Resources */ = {isa = PBXBuildFile; fileRef = %s /* %s */; };"
            % (
                identifiers.of("buildfile:resources:" + node.relative),
                node.name,
                file_ref_ids[node.relative],
                node.name,
            )
        )
    out.append("/* End PBXBuildFile section */")
    out.append("")

    # ---- PBXFileReference --------------------------------------------
    out.append("/* Begin PBXFileReference section */")
    product_id = identifiers.of("product:" + TARGET_NAME)
    out.append(
        "\t\t%s /* %s.app */ = {isa = PBXFileReference; explicitFileType = wrapper.application; "
        "includeInIndex = 0; path = %s.app; sourceTree = BUILT_PRODUCTS_DIR; };"
        % (product_id, TARGET_NAME, TARGET_NAME)
    )
    for node in sorted(sources + resources + others, key=lambda item: item.relative):
        out.append(
            "\t\t%s /* %s */ = {isa = PBXFileReference; lastKnownFileType = %s; path = %s; sourceTree = \"<group>\"; };"
            % (
                file_ref_ids[node.relative],
                node.name,
                file_type(node),
                escape(node.name),
            )
        )
    out.append("/* End PBXFileReference section */")
    out.append("")

    # ---- PBXFrameworksBuildPhase -------------------------------------
    frameworks_id = identifiers.of("phase:frameworks")
    out.append("/* Begin PBXFrameworksBuildPhase section */")
    out.append(
        "\t\t%s /* Frameworks */ = {" % frameworks_id
    )
    out.append("\t\t\tisa = PBXFrameworksBuildPhase;")
    out.append("\t\t\tbuildActionMask = 2147483647;")
    out.append("\t\t\tfiles = (")
    out.append("\t\t\t);")
    out.append("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    out.append("\t\t};")
    out.append("/* End PBXFrameworksBuildPhase section */")
    out.append("")

    # ---- PBXGroup ----------------------------------------------------
    out.append("/* Begin PBXGroup section */")

    def emit_group(group: Group) -> None:
        identifier = group_id(group)
        out.append("\t\t%s /* %s */ = {" % (identifier, group.name))
        out.append("\t\t\tisa = PBXGroup;")
        out.append("\t\t\tchildren = (")
        for child in group.children:
            if isinstance(child, Group):
                out.append(
                    "\t\t\t\t%s /* %s */,"
                    % (group_id(child), child.name)
                )
            else:
                out.append(
                    "\t\t\t\t%s /* %s */," % (file_ref_ids[child.relative], child.name)
                )
        out.append("\t\t\t);")
        if group.path is not None and group is not root:
            out.append("\t\t\tpath = %s;" % escape(group.path.split("/")[-1]))
        elif group.path is not None:
            out.append("\t\t\tpath = %s;" % escape(group.path))
        out.append("\t\t\tsourceTree = \"<group>\";")
        out.append("\t\t};")

        for child in group.children:
            if isinstance(child, Group):
                emit_group(child)

    emit_group(root)

    products_id = identifiers.of("group:Products")
    out.append("\t\t%s /* Products */ = {" % products_id)
    out.append("\t\t\tisa = PBXGroup;")
    out.append("\t\t\tchildren = (")
    out.append("\t\t\t\t%s /* %s.app */," % (product_id, TARGET_NAME))
    out.append("\t\t\t);")
    out.append("\t\t\tname = Products;")
    out.append("\t\t\tsourceTree = \"<group>\";")
    out.append("\t\t};")
    out.append("/* End PBXGroup section */")
    out.append("")

    # ---- PBXNativeTarget ---------------------------------------------
    target_id = identifiers.of("target:" + TARGET_NAME)
    sources_phase = identifiers.of("phase:sources")
    resources_phase = identifiers.of("phase:resources")
    target_config_list = identifiers.of("configlist:target")

    out.append("/* Begin PBXNativeTarget section */")
    out.append("\t\t%s /* %s */ = {" % (target_id, TARGET_NAME))
    out.append("\t\t\tisa = PBXNativeTarget;")
    out.append("\t\t\tbuildConfigurationList = %s /* Build configuration list for PBXNativeTarget \"%s\" */;"
              % (target_config_list, TARGET_NAME))
    out.append("\t\t\tbuildPhases = (")
    out.append("\t\t\t\t%s /* Sources */," % sources_phase)
    out.append("\t\t\t\t%s /* Frameworks */," % frameworks_id)
    out.append("\t\t\t\t%s /* Resources */," % resources_phase)
    out.append("\t\t\t);")
    out.append("\t\t\tbuildRules = (")
    out.append("\t\t\t);")
    out.append("\t\t\tdependencies = (")
    out.append("\t\t\t);")
    out.append("\t\t\tname = %s;" % TARGET_NAME)
    out.append("\t\t\tproductName = %s;" % TARGET_NAME)
    out.append("\t\t\tproductReference = %s /* %s.app */;" % (product_id, TARGET_NAME))
    out.append("\t\t\tproductType = \"com.apple.product-type.application\";")
    out.append("\t\t};")
    out.append("/* End PBXNativeTarget section */")
    out.append("")

    # ---- PBXProject ---------------------------------------------------
    project_id = identifiers.of("project:" + TARGET_NAME)
    project_config_list = identifiers.of("configlist:project")
    out.append("/* Begin PBXProject section */")
    out.append("\t\t%s /* Project object */ = {" % project_id)
    out.append("\t\t\tisa = PBXProject;")
    out.append("\t\t\tattributes = {")
    out.append("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
    out.append("\t\t\t\tLastSwiftUpdateCheck = 1600;")
    out.append("\t\t\t\tLastUpgradeCheck = 1600;")
    out.append("\t\t\t\tTargetAttributes = {")
    out.append("\t\t\t\t\t%s = {" % target_id)
    out.append("\t\t\t\t\t\tCreatedOnToolsVersion = 16.0;")
    out.append("\t\t\t\t\t};")
    out.append("\t\t\t\t};")
    out.append("\t\t\t};")
    out.append("\t\t\tbuildConfigurationList = %s /* Build configuration list for PBXProject \"%s\" */;"
              % (project_config_list, TARGET_NAME))
    out.append("\t\t\tcompatibilityVersion = \"%s\";" % COMPATIBILITY_VERSION)
    out.append("\t\t\tdevelopmentRegion = en;")
    out.append("\t\t\thasScannedForEncodings = 0;")
    out.append("\t\t\tknownRegions = (")
    out.append("\t\t\t\ten,")
    out.append("\t\t\t\tBase,")
    out.append("\t\t\t);")
    out.append("\t\t\tmainGroup = %s;" % group_id(root))
    out.append("\t\t\tproductRefGroup = %s /* Products */;" % products_id)
    out.append("\t\t\tprojectDirPath = \"\";")
    out.append("\t\t\tprojectRoot = \"\";")
    out.append("\t\t\ttargets = (")
    out.append("\t\t\t\t%s /* %s */," % (target_id, TARGET_NAME))
    out.append("\t\t\t);")
    out.append("\t\t};")
    out.append("/* End PBXProject section */")
    out.append("")

    # ---- PBXResourcesBuildPhase ---------------------------------------
    out.append("/* Begin PBXResourcesBuildPhase section */")
    out.append("\t\t%s /* Resources */ = {" % resources_phase)
    out.append("\t\t\tisa = PBXResourcesBuildPhase;")
    out.append("\t\t\tbuildActionMask = 2147483647;")
    out.append("\t\t\tfiles = (")
    for node in resources:
        out.append(
            "\t\t\t\t%s /* %s in Resources */,"
            % (identifiers.of("buildfile:resources:" + node.relative), node.name)
        )
    out.append("\t\t\t);")
    out.append("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    out.append("\t\t};")
    out.append("/* End PBXResourcesBuildPhase section */")
    out.append("")

    # ---- PBXSourcesBuildPhase -----------------------------------------
    out.append("/* Begin PBXSourcesBuildPhase section */")
    out.append("\t\t%s /* Sources */ = {" % sources_phase)
    out.append("\t\t\tisa = PBXSourcesBuildPhase;")
    out.append("\t\t\tbuildActionMask = 2147483647;")
    out.append("\t\t\tfiles = (")
    for node in sources:
        out.append(
            "\t\t\t\t%s /* %s in Sources */,"
            % (identifiers.of("buildfile:sources:" + node.relative), node.name)
        )
    out.append("\t\t\t);")
    out.append("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
    out.append("\t\t};")
    out.append("/* End PBXSourcesBuildPhase section */")
    out.append("")

    # ---- XCBuildConfiguration -----------------------------------------
    shared_project_settings = [
        ("ALWAYS_SEARCH_USER_PATHS", "NO"),
        ("ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS", "YES"),
        ("CLANG_ANALYZER_NONNULL", "YES"),
        ("CLANG_ENABLE_MODULES", "YES"),
        ("CLANG_ENABLE_OBJC_ARC", "YES"),
        ("CLANG_WARN_DOCUMENTATION_COMMENTS", "YES"),
        ("COPY_PHASE_STRIP", "NO"),
        ("ENABLE_STRICT_OBJC_MSGSEND", "YES"),
        ("ENABLE_USER_SCRIPT_SANDBOXING", "YES"),
        ("GCC_C_LANGUAGE_STANDARD", "gnu17"),
        ("GCC_NO_COMMON_BLOCKS", "YES"),
        ("IPHONEOS_DEPLOYMENT_TARGET", DEPLOYMENT_TARGET),
        ("MTL_FAST_MATH", "YES"),
        ("SDKROOT", "iphoneos"),
        ("SWIFT_EMIT_LOC_STRINGS", "YES"),
        ("SWIFT_VERSION", SWIFT_VERSION),
    ]
    debug_project = shared_project_settings + [
        ("DEBUG_INFORMATION_FORMAT", "dwarf"),
        ("ENABLE_TESTABILITY", "YES"),
        ("GCC_OPTIMIZATION_LEVEL", "0"),
        ("GCC_PREPROCESSOR_DEFINITIONS", ["DEBUG=1", "$(inherited)"]),
        ("MTL_ENABLE_DEBUG_INFO", "INCLUDE_SOURCE"),
        ("ONLY_ACTIVE_ARCH", "YES"),
        ("SWIFT_ACTIVE_COMPILATION_CONDITIONS", "DEBUG"),
        ("SWIFT_OPTIMIZATION_LEVEL", "\"-Onone\""),
    ]
    release_project = shared_project_settings + [
        ("DEBUG_INFORMATION_FORMAT", "\"dwarf-with-dsym\""),
        ("ENABLE_NS_ASSERTIONS", "NO"),
        ("MTL_ENABLE_DEBUG_INFO", "NO"),
        ("SWIFT_COMPILATION_MODE", "wholemodule"),
        ("SWIFT_OPTIMIZATION_LEVEL", "\"-O\""),
        ("VALIDATE_PRODUCT", "YES"),
    ]

    shared_target_settings = [
        ("ASSETCATALOG_COMPILER_APPICON_NAME", "AppIcon"),
        ("ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME", "AccentColor"),
        ("CODE_SIGN_STYLE", "Automatic"),
        ("CURRENT_PROJECT_VERSION", "1"),
        ("DEVELOPMENT_TEAM", "$(ZODE_TEAM_ID)"),
        ("ENABLE_PREVIEWS", "YES"),
        ("GENERATE_INFOPLIST_FILE", "NO"),
        ("INFOPLIST_FILE", INFO_PLIST),
        ("IPHONEOS_DEPLOYMENT_TARGET", DEPLOYMENT_TARGET),
        ("LD_RUNPATH_SEARCH_PATHS", ["$(inherited)", "@executable_path/Frameworks"]),
        ("MARKETING_VERSION", "1.0"),
        ("PRODUCT_BUNDLE_IDENTIFIER", BUNDLE_ID),
        ("PRODUCT_NAME", "\"$(TARGET_NAME)\""),
        ("SUPPORTS_MACCATALYST", "NO"),
        ("SWIFT_EMIT_LOC_STRINGS", "YES"),
        ("SWIFT_VERSION", SWIFT_VERSION),
        ("TARGETED_DEVICE_FAMILY", "\"1,2\""),
    ]

    def emit_configuration(
        identifier: str, name: str, settings: List[Tuple[str, str]]
    ) -> None:
        out.append("\t\t%s /* %s */ = {" % (identifier, name))
        out.append("\t\t\tisa = XCBuildConfiguration;")
        out.append("\t\t\tbuildSettings = {")
        for key, value in settings:
            out.append("\t\t\t\t%s = %s;" % (key, setting_value(value)))
        out.append("\t\t\t};")
        out.append("\t\t\tname = %s;" % name)
        out.append("\t\t};")

    out.append("/* Begin XCBuildConfiguration section */")
    project_debug = identifiers.of("config:project:Debug")
    project_release = identifiers.of("config:project:Release")
    target_debug = identifiers.of("config:target:Debug")
    target_release = identifiers.of("config:target:Release")
    emit_configuration(project_debug, "Debug", debug_project)
    emit_configuration(project_release, "Release", release_project)
    emit_configuration(target_debug, "Debug", shared_target_settings)
    emit_configuration(target_release, "Release", shared_target_settings)
    out.append("/* End XCBuildConfiguration section */")
    out.append("")

    # ---- XCConfigurationList -------------------------------------------
    out.append("/* Begin XCConfigurationList section */")
    out.append(
        "\t\t%s /* Build configuration list for PBXProject \"%s\" */ = {"
        % (project_config_list, TARGET_NAME)
    )
    out.append("\t\t\tisa = XCConfigurationList;")
    out.append("\t\t\tbuildConfigurations = (")
    out.append("\t\t\t\t%s /* Debug */," % project_debug)
    out.append("\t\t\t\t%s /* Release */," % project_release)
    out.append("\t\t\t);")
    out.append("\t\t\tdefaultConfigurationIsVisible = 0;")
    out.append("\t\t\tdefaultConfigurationName = Release;")
    out.append("\t\t};")
    out.append(
        "\t\t%s /* Build configuration list for PBXNativeTarget \"%s\" */ = {"
        % (target_config_list, TARGET_NAME)
    )
    out.append("\t\t\tisa = XCConfigurationList;")
    out.append("\t\t\tbuildConfigurations = (")
    out.append("\t\t\t\t%s /* Debug */," % target_debug)
    out.append("\t\t\t\t%s /* Release */," % target_release)
    out.append("\t\t\t);")
    out.append("\t\t\tdefaultConfigurationIsVisible = 0;")
    out.append("\t\t\tdefaultConfigurationName = Release;")
    out.append("\t\t};")
    out.append("/* End XCConfigurationList section */")
    out.append("")

    out.append("\t};")
    out.append("\trootObject = %s /* Project object */;" % project_id)
    out.append("}")
    out.append("")
    return "\n".join(out)


# ----------------------------------------------------------------------
# Scheme


def write_scheme(target_id: str) -> str:
    buildable = (
        '            <BuildableReference\n'
        '               BuildableIdentifier = "primary"\n'
        '               BlueprintIdentifier = "%s"\n'
        '               BuildableName = "%s.app"\n'
        '               BlueprintName = "%s"\n'
        '               ReferencedContainer = "container:ZodeMobile.xcodeproj">\n'
        "            </BuildableReference>\n" % (target_id, TARGET_NAME, TARGET_NAME)
    )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<Scheme\n"
        '   LastUpgradeVersion = "1600"\n'
        '   version = "1.7">\n'
        "   <BuildAction\n"
        '      parallelizeBuildables = "YES"\n'
        '      buildImplicitDependencies = "YES">\n'
        "      <BuildActionEntries>\n"
        "         <BuildActionEntry\n"
        '            buildForTesting = "YES"\n'
        '            buildForRunning = "YES"\n'
        '            buildForProfiling = "YES"\n'
        '            buildForArchiving = "YES"\n'
        '            buildForAnalyzing = "YES">\n'
        + buildable
        + "         </BuildActionEntry>\n"
        "      </BuildActionEntries>\n"
        "   </BuildAction>\n"
        "   <TestAction\n"
        '      buildConfiguration = "Debug"\n'
        '      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"\n'
        '      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"\n'
        '      shouldUseLaunchSchemeArgsEnv = "YES">\n'
        "      <Testables>\n"
        "      </Testables>\n"
        "   </TestAction>\n"
        "   <LaunchAction\n"
        '      buildConfiguration = "Debug"\n'
        '      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"\n'
        '      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"\n'
        '      launchStyle = "0"\n'
        '      useCustomWorkingDirectory = "NO"\n'
        '      ignoresPersistentStateOnLaunch = "NO"\n'
        '      debugDocumentVersioning = "YES"\n'
        '      debugServiceExtension = "internal"\n'
        '      allowLocationSimulation = "YES">\n'
        "      <BuildableProductRunnable\n"
        '         runnableDebuggingMode = "0">\n'
        + buildable
        + "      </BuildableProductRunnable>\n"
        "   </LaunchAction>\n"
        "   <ProfileAction\n"
        '      buildConfiguration = "Release"\n'
        '      shouldUseLaunchSchemeArgsEnv = "YES"\n'
        '      savedToolIdentifier = ""\n'
        '      useCustomWorkingDirectory = "NO"\n'
        '      debugDocumentVersioning = "YES">\n'
        "      <BuildableProductRunnable\n"
        '         runnableDebuggingMode = "0">\n'
        + buildable
        + "      </BuildableProductRunnable>\n"
        "   </ProfileAction>\n"
        '   <AnalyzeAction buildConfiguration = "Debug">\n'
        "   </AnalyzeAction>\n"
        '   <ArchiveAction buildConfiguration = "Release" revealArchiveInOrganizer = "YES">\n'
        "   </ArchiveAction>\n"
        "</Scheme>\n"
    )


# ----------------------------------------------------------------------


def write_if_changed(path: Path, content: str, check: bool) -> bool:
    if check:
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if current != content:
            print("STALE: %s" % path)
            return False
        print("OK (unchanged): %s" % path)
        return True
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print("Wrote: %s" % path)
    return True


def main(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write; exit non-zero if the project is out of date.",
    )
    args = parser.parse_args(argv)

    if not SOURCE_DIR.exists():
        print("Missing %s" % SOURCE_DIR)
        return 1

    sources, resources, others = collect_files()
    print(
        "Found %d Swift sources, %d resources, %d other files"
        % (len(sources), len(resources), len(others))
    )

    identifiers = Identifiers()
    root = build_groups(sources, resources, others)
    pbxproj = write_pbxproj(identifiers, root, sources, resources, others)
    scheme = write_scheme(identifiers.of("target:" + TARGET_NAME))

    ok = write_if_changed(PBXPROJ, pbxproj, args.check)
    ok = write_if_changed(SCHEME, scheme, args.check) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
