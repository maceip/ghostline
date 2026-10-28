#!/usr/bin/env python3
"""Generate the Xcode project of the Zode macOS shell.

The project file is **generated**, never hand written: the group tree mirrors
the `Zode/` folder, so adding a Swift file is a matter of dropping it into
the right folder and re-running this script.

Determinism
-----------
Every object id is a 24 character uppercase hex string derived from a stable
hash of the object's *name* (`sha256("file:Zode/App/ZodeApp.swift")`), so the
generated `project.pbxproj` is byte identical on every run and the git diff
only shows the real changes.

Usage
-----
    python3 tools/generate_xcodeproj.py            # write the project
    python3 tools/generate_xcodeproj.py --check    # verify it is up to date
    python3 tools/generate_xcodeproj.py --print    # dump the pbxproj
"""

from __future__ import annotations

import argparse
import hashlib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHELL_ROOT = HERE.parent
SOURCE_ROOT = SHELL_ROOT / "Zode"
PROJECT_DIR = SHELL_ROOT / "Zode.xcodeproj"
PBXPROJ = PROJECT_DIR / "project.pbxproj"
SCHEME_DIR = PROJECT_DIR / "xcshareddata" / "xcschemes"
SCHEME = SCHEME_DIR / "Zode.xcscheme"

PRODUCT_NAME = "Zode"
BUNDLE_IDENTIFIER = "com.zode.app"
DEPLOYMENT_TARGET = "14.0"
MARKETING_VERSION = "1.0.0"
PROJECT_VERSION = "1"
OBJECT_VERSION = "56"
COMPATIBILITY_VERSION = "Xcode 14.0"
LAST_UPGRADE_CHECK = "1500"

# The folder inside the bundle that holds the web application. It is a folder
# reference, so the whole directory is copied into the app bundle.
WEB_FOLDER = "web"

# Folders that are referenced as a whole instead of being mirrored into the
# group tree: the asset catalogue is compiled by Xcode, and the bundled web
# application is copied as a folder.
def is_folder_reference(path: Path) -> bool:
    return path.suffix.lower() == ".xcassets" or path.name == WEB_FOLDER


# =============================================================================
# Object ids
# =============================================================================

def object_id(name: str) -> str:
    """A stable 24 character uppercase hex id for an object name."""
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest().upper()
    return digest[:24]


class IdRegistry:
    """Hands out object ids and makes sure that they never collide."""

    def __init__(self) -> None:
        self._by_name: dict[str, str] = {}
        self._by_id: dict[str, str] = {}

    def get(self, name: str) -> str:
        if name in self._by_name:
            return self._by_name[name]
        identifier = object_id(name)
        owner = self._by_id.get(identifier)
        if owner is not None and owner != name:
            raise RuntimeError(
                f"object id collision: '{name}' and '{owner}' both hash to {identifier}"
            )
        self._by_name[name] = identifier
        self._by_id[identifier] = name
        return identifier


# =============================================================================
# The file tree
# =============================================================================

class Node:
    """A file or a folder of the source tree."""

    def __init__(self, name: str, path: Path, relative: str) -> None:
        self.name = name
        self.path = path
        self.relative = relative
        self.is_folder = path.is_dir()
        self.children: dict[str, "Node"] = {}
        self.file_type = file_type_for(path)

    def sorted_children(self) -> list["Node"]:
        return [self.children[name] for name in sorted(self.children)]


def file_type_for(path: Path) -> str:
    """The `lastKnownFileType` Xcode uses for a file."""
    suffix = path.suffix.lower()
    if suffix == ".swift":
        return "sourcecode.swift"
    if suffix == ".plist":
        return "text.plist.xml"
    if suffix == ".entitlements":
        return "text.plist.entitlements"
    if suffix == ".json":
        return "text.json"
    if suffix == ".md":
        return "net.daringfireball.markdown"
    if suffix == ".html":
        return "text.html"
    if suffix == ".css":
        return "text.css"
    if suffix == ".js" or suffix == ".mjs":
        return "sourcecode.javascript"
    if suffix == ".png":
        return "image.png"
    if suffix == ".xcassets":
        return "folder.assetcatalog"
    if path.is_dir():
        return "folder"
    return "text"


def build_phase_for(node: Node) -> str | None:
    """The build phase a file belongs to (None: it is only referenced)."""
    if node.is_folder:
        # Only the asset catalogue and the bundled web application are
        # folder references; both are copied into the bundle.
        return "Resources" if is_folder_reference(node.path) else None
    suffix = node.path.suffix.lower()
    if suffix == ".swift":
        return "Sources"
    if suffix in (".plist", ".entitlements"):
        # The Info.plist and the entitlements are referenced by the build
        # settings, they must not be copied into the bundle.
        return None
    return "Resources"


def scan(root: Path) -> Node:
    """Scans the source folder into a tree of nodes."""
    node = Node(root.name, root, root.name)
    for entry in sorted(root.iterdir(), key=lambda item: item.name):
        if entry.name.startswith("."):
            continue
        child = Node(entry.name, entry, f"{node.relative}/{entry.name}")
        if entry.is_dir() and not is_folder_reference(entry):
            child.children = {c.name: c for c in scan(entry).children.values()}
        node.children[entry.name] = child
    return node


# =============================================================================
# Build settings
# =============================================================================

PROJECT_COMMON: dict[str, object] = {
    "ALWAYS_SEARCH_USER_PATHS": "NO",
    "CLANG_ANALYZER_NONNULL": "YES",
    "CLANG_ENABLE_MODULES": "YES",
    "CLANG_ENABLE_OBJC_ARC": "YES",
    "CLANG_WARN_DOCUMENTATION_COMMENTS": "YES",
    "CLANG_WARN_UNGUARDED_AVAILABILITY": "YES_AGGRESSIVE",
    "COPY_PHASE_STRIP": "NO",
    "ENABLE_STRICT_OBJC_MSGSEND": "YES",
    "ENABLE_USER_SCRIPT_SANDBOXING": "NO",
    "GCC_C_LANGUAGE_STANDARD": "gnu11",
    "GCC_NO_COMMON_BLOCKS": "YES",
    "GCC_WARN_UNDECLARED_SELECTOR": "YES",
    "MACOSX_DEPLOYMENT_TARGET": DEPLOYMENT_TARGET,
    "SDKROOT": "macosx",
    "SWIFT_VERSION": "5.0",
}

PROJECT_DEBUG: dict[str, object] = {
    "DEBUG_INFORMATION_FORMAT": "dwarf",
    "ENABLE_TESTABILITY": "YES",
    "GCC_DYNAMIC_NO_PIC": "NO",
    "GCC_OPTIMIZATION_LEVEL": "0",
    "GCC_PREPROCESSOR_DEFINITIONS": ["DEBUG=1", "$(inherited)"],
    "MTL_ENABLE_DEBUG_INFO": "INCLUDE_SOURCE",
    "ONLY_ACTIVE_ARCH": "YES",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS": "DEBUG $(inherited)",
    "SWIFT_OPTIMIZATION_LEVEL": "-Onone",
}

PROJECT_RELEASE: dict[str, object] = {
    "DEBUG_INFORMATION_FORMAT": "dwarf-with-dsym",
    "ENABLE_NS_ASSERTIONS": "NO",
    "MTL_ENABLE_DEBUG_INFO": "NO",
    "SWIFT_COMPILATION_MODE": "wholemodule",
    "SWIFT_OPTIMIZATION_LEVEL": "-O",
    "VALIDATE_PRODUCT": "YES",
}

# The settings the contract of this track requires (see deliverable.md).
TARGET_COMMON: dict[str, object] = {
    "ASSETCATALOG_COMPILER_APPICON_NAME": "AppIcon",
    "CODE_SIGN_ENTITLEMENTS": "Zode/Zode.entitlements",
    "CODE_SIGN_STYLE": "Automatic",
    "COMBINE_HIDPI_IMAGES": "YES",
    "CURRENT_PROJECT_VERSION": PROJECT_VERSION,
    "DEVELOPMENT_TEAM": "$(ZODE_TEAM_ID)",
    "ENABLE_HARDENED_RUNTIME": "YES",
    "ENABLE_USER_SCRIPT_SANDBOXING": "NO",
    "GENERATE_INFOPLIST_FILE": "NO",
    "INFOPLIST_FILE": "Zode/Info.plist",
    "LD_RUNPATH_SEARCH_PATHS": ["$(inherited)", "@executable_path/../Frameworks"],
    "MARKETING_VERSION": MARKETING_VERSION,
    "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE_IDENTIFIER,
    "PRODUCT_NAME": PRODUCT_NAME,
    "SWIFT_EMIT_LOC_STRINGS": "YES",
}

TARGET_DEBUG: dict[str, object] = {}
TARGET_RELEASE: dict[str, object] = {}


# =============================================================================
# Emitting the pbxproj
# =============================================================================

def quote(value: str) -> str:
    """Quotes a value the way Xcode does."""
    if value == "":
        return '""'
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./$")
    if all(character in allowed for character in value):
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def setting_value(value: object) -> str:
    if isinstance(value, list):
        return "(" + ", ".join(quote(str(item)) for item in value) + ")"
    return quote(str(value))


def emit_settings(settings: dict[str, object], indent: str) -> list[str]:
    lines = []
    for key in sorted(settings):
        lines.append(f"{indent}{key} = {setting_value(settings[key])};")
    return lines


def comment(text: str) -> str:
    return f"/* {text} */"


class Project:
    """Builds the pbxproj text."""

    def __init__(self, tree: Node) -> None:
        self.tree = tree
        self.ids = IdRegistry()
        # (build file id, name, phase, file reference id)
        self.build_files: list[tuple[str, str, str, str]] = []
        # (id, name, path, lastKnownFileType, sourceTree)
        self.file_refs: list[tuple[str, str, str, str, str]] = []
        # (id, name, children, path)
        self.groups: list[tuple[str, str, list[str], str]] = []

    # -- collecting --------------------------------------------------------

    def collect(self) -> None:
        """Walks the tree and records every object."""
        root_children = [self.ids.get(f"group:{self.tree.relative}")]
        self.collect_group(self.tree, path_prefix="")

        product_id = self.ids.get("product:Zode.app")
        self.file_refs.append((
            product_id,
            f"{PRODUCT_NAME}.app",
            f"{PRODUCT_NAME}.app",
            "wrapper.application",
            "BUILT_PRODUCTS_DIR",
        ))
        products_id = self.ids.get("group:Products")
        self.groups.append((products_id, "Products", [product_id], ""))
        root_children.append(products_id)

        self.root_group_id = self.ids.get("group:root")
        self.groups.append((self.root_group_id, "", root_children, ""))

    def collect_group(self, node: Node, path_prefix: str) -> str:
        """Records a group and returns its id."""
        group_path = path_prefix + node.name
        group_id = self.ids.get(f"group:{group_path}")
        children: list[str] = []

        for child in node.sorted_children():
            if child.is_folder and child.children:
                children.append(self.collect_group(child, group_path + "/"))
                continue

            # A leaf: a file or a folder reference.
            file_id = self.ids.get(f"file:{child.relative}")
            source_tree = '"<group>"'
            self.file_refs.append((
                file_id,
                child.name,
                child.name,
                child.file_type,
                source_tree,
            ))
            phase = build_phase_for(child)
            if phase:
                build_id = self.ids.get(f"buildfile:{child.relative}:{phase}")
                self.build_files.append((build_id, child.name, phase, file_id))
            children.append(file_id)

        self.groups.append((group_id, node.name, children, node.name))
        return group_id

    # -- rendering ---------------------------------------------------------

    def render(self) -> str:
        lines: list[str] = []
        lines.append("// !$*UTF8*$!")
        lines.append("{")
        lines.append("\tarchiveVersion = 1;")
        lines.append("\tclasses = {")
        lines.append("\t};")
        lines.append(f"\tobjectVersion = {OBJECT_VERSION};")
        lines.append("\tobjects = {")
        lines.append("")

        # PBXBuildFile
        lines.append("/* Begin PBXBuildFile section */")
        for build_id, name, phase, file_id in sorted(self.build_files, key=lambda item: item[1]):
            lines.append(
                f"\t\t{build_id} {comment(f'{name} in {phase}')} = "
                f"{{isa = PBXBuildFile; fileRef = {file_id} {comment(name)}; }};"
            )
        lines.append("/* End PBXBuildFile section */")
        lines.append("")

        # PBXFileReference
        lines.append("/* Begin PBXFileReference section */")
        for file_id, name, path, file_type, source_tree in sorted(self.file_refs, key=lambda item: item[1]):
            if file_type == "wrapper.application":
                lines.append(
                    f"\t\t{file_id} {comment(name)} = {{isa = PBXFileReference; "
                    f"explicitFileType = {file_type}; includeInIndex = 0; path = {path}; "
                    f"sourceTree = {source_tree}; }};"
                )
            else:
                lines.append(
                    f"\t\t{file_id} {comment(name)} = {{isa = PBXFileReference; "
                    f"lastKnownFileType = {file_type}; path = {path}; sourceTree = {source_tree}; }};"
                )
        lines.append("/* End PBXFileReference section */")
        lines.append("")

        # PBXFrameworksBuildPhase
        frameworks_id = self.ids.get("phase:Frameworks")
        lines.append("/* Begin PBXFrameworksBuildPhase section */")
        lines.append(f"\t\t{frameworks_id} {comment('Frameworks')} = {{")
        lines.append("\t\t\tisa = PBXFrameworksBuildPhase;")
        lines.append("\t\t\tbuildActionMask = 2147483647;")
        lines.append("\t\t\tfiles = (")
        lines.append("\t\t\t);")
        lines.append("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
        lines.append("\t\t};")
        lines.append("/* End PBXFrameworksBuildPhase section */")
        lines.append("")

        # PBXGroup
        lines.append("/* Begin PBXGroup section */")
        for group_id, name, children, path in sorted(self.groups, key=lambda item: (item[1], item[3])):
            if name:
                lines.append(f"\t\t{group_id} {comment(name)} = {{")
            else:
                lines.append(f"\t\t{group_id} = {{")
            lines.append("\t\t\tisa = PBXGroup;")
            lines.append("\t\t\tchildren = (")
            for child in children:
                lines.append(f"\t\t\t\t{child},")
            lines.append("\t\t\t);")
            if path:
                lines.append(f"\t\t\tpath = {path};")
            if name == "Products":
                lines.append("\t\t\tname = Products;")
            lines.append("\t\t\tsourceTree = \"<group>\";")
            lines.append("\t\t};")
        lines.append("/* End PBXGroup section */")
        lines.append("")

        # PBXNativeTarget
        target_id = self.ids.get("target:Zode")
        lines.append("/* Begin PBXNativeTarget section */")
        target_list_comment = 'Build configuration list for PBXNativeTarget "Zode"'
        project_list_comment = 'Build configuration list for PBXProject "Zode"'
        lines.append(f"\t\t{target_id} {comment(PRODUCT_NAME)} = {{")
        lines.append("\t\t\tisa = PBXNativeTarget;")
        lines.append(f"\t\t\tbuildConfigurationList = {self.ids.get('configlist:target')} {comment(target_list_comment)};")
        lines.append("\t\t\tbuildPhases = (")
        lines.append(f"\t\t\t\t{self.ids.get('phase:Sources')} {comment('Sources')},")
        lines.append(f"\t\t\t\t{frameworks_id} {comment('Frameworks')},")
        lines.append(f"\t\t\t\t{self.ids.get('phase:Resources')} {comment('Resources')},")
        lines.append("\t\t\t);")
        lines.append("\t\t\tbuildRules = (")
        lines.append("\t\t\t);")
        lines.append("\t\t\tdependencies = (")
        lines.append("\t\t\t);")
        lines.append(f"\t\t\tname = {PRODUCT_NAME};")
        lines.append(f"\t\t\tproductName = {PRODUCT_NAME};")
        lines.append(f"\t\t\tproductReference = {self.ids.get('product:Zode.app')} {comment(f'{PRODUCT_NAME}.app')};")
        lines.append("\t\t\tproductType = \"com.apple.product-type.application\";")
        lines.append("\t\t};")
        lines.append("/* End PBXNativeTarget section */")
        lines.append("")

        # PBXProject
        project_id = self.ids.get("project:Zode")
        lines.append("/* Begin PBXProject section */")
        lines.append(f"\t\t{project_id} {comment('Project object')} = {{")
        lines.append("\t\t\tisa = PBXProject;")
        lines.append("\t\t\tattributes = {")
        lines.append("\t\t\t\tBuildIndependentTargetsInParallel = 1;")
        lines.append(f"\t\t\t\tLastSwiftUpdateCheck = {LAST_UPGRADE_CHECK};")
        lines.append(f"\t\t\t\tLastUpgradeCheck = {LAST_UPGRADE_CHECK};")
        lines.append("\t\t\t\tTargetAttributes = {")
        lines.append(f"\t\t\t\t\t{target_id} = {{")
        lines.append("\t\t\t\t\t\tCreatedOnToolsVersion = 15.0;")
        lines.append("\t\t\t\t\t};")
        lines.append("\t\t\t\t};")
        lines.append("\t\t\t};")
        lines.append(f"\t\t\tbuildConfigurationList = {self.ids.get('configlist:project')} {comment(project_list_comment)};")
        lines.append(f"\t\t\tcompatibilityVersion = \"{COMPATIBILITY_VERSION}\";")
        lines.append("\t\t\tdevelopmentRegion = en;")
        lines.append("\t\t\thasScannedForEncodings = 0;")
        lines.append("\t\t\tknownRegions = (")
        lines.append("\t\t\t\ten,")
        lines.append("\t\t\t\tBase,")
        lines.append("\t\t\t);")
        lines.append(f"\t\t\tmainGroup = {self.root_group_id};")
        lines.append(f"\t\t\tproductRefGroup = {self.ids.get('group:Products')} {comment('Products')};")
        lines.append("\t\t\tprojectDirPath = \"\";")
        lines.append("\t\t\tprojectRoot = \"\";")
        lines.append("\t\t\ttargets = (")
        lines.append(f"\t\t\t\t{target_id} {comment(PRODUCT_NAME)},")
        lines.append("\t\t\t);")
        lines.append("\t\t};")
        lines.append("/* End PBXProject section */")
        lines.append("")

        # PBXResourcesBuildPhase
        lines.append("/* Begin PBXResourcesBuildPhase section */")
        lines.append(f"\t\t{self.ids.get('phase:Resources')} {comment('Resources')} = {{")
        lines.append("\t\t\tisa = PBXResourcesBuildPhase;")
        lines.append("\t\t\tbuildActionMask = 2147483647;")
        lines.append("\t\t\tfiles = (")
        for build_id, name, phase, _file_id in sorted(self.build_files, key=lambda item: item[1]):
            if phase == "Resources":
                lines.append(f"\t\t\t\t{build_id} {comment(f'{name} in Resources')},")
        lines.append("\t\t\t);")
        lines.append("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
        lines.append("\t\t};")
        lines.append("/* End PBXResourcesBuildPhase section */")
        lines.append("")

        # PBXSourcesBuildPhase
        lines.append("/* Begin PBXSourcesBuildPhase section */")
        lines.append(f"\t\t{self.ids.get('phase:Sources')} {comment('Sources')} = {{")
        lines.append("\t\t\tisa = PBXSourcesBuildPhase;")
        lines.append("\t\t\tbuildActionMask = 2147483647;")
        lines.append("\t\t\tfiles = (")
        for build_id, name, phase, _file_id in sorted(self.build_files, key=lambda item: item[1]):
            if phase == "Sources":
                lines.append(f"\t\t\t\t{build_id} {comment(f'{name} in Sources')},")
        lines.append("\t\t\t);")
        lines.append("\t\t\trunOnlyForDeploymentPostprocessing = 0;")
        lines.append("\t\t};")
        lines.append("/* End PBXSourcesBuildPhase section */")
        lines.append("")

        # XCBuildConfiguration
        lines.append("/* Begin XCBuildConfiguration section */")
        for name, settings in (
            ("Debug", {**PROJECT_COMMON, **PROJECT_DEBUG}),
            ("Release", {**PROJECT_COMMON, **PROJECT_RELEASE}),
        ):
            lines.append(f"\t\t{self.ids.get(f'config:project:{name}')} {comment(name)} = {{")
            lines.append("\t\t\tisa = XCBuildConfiguration;")
            lines.append("\t\t\tbuildSettings = {")
            lines.extend(emit_settings(settings, "\t\t\t\t"))
            lines.append("\t\t\t};")
            lines.append(f"\t\t\tname = {name};")
            lines.append("\t\t};")
        for name, settings in (
            ("Debug", {**TARGET_COMMON, **TARGET_DEBUG}),
            ("Release", {**TARGET_COMMON, **TARGET_RELEASE}),
        ):
            lines.append(f"\t\t{self.ids.get(f'config:target:{name}')} {comment(name)} = {{")
            lines.append("\t\t\tisa = XCBuildConfiguration;")
            lines.append("\t\t\tbuildSettings = {")
            lines.extend(emit_settings(settings, "\t\t\t\t"))
            lines.append("\t\t\t};")
            lines.append(f"\t\t\tname = {name};")
            lines.append("\t\t};")
        lines.append("/* End XCBuildConfiguration section */")
        lines.append("")

        # XCConfigurationList
        lines.append("/* Begin XCConfigurationList section */")
        for scope, title in (("project", 'Build configuration list for PBXProject "Zode"'),
                             ("target", 'Build configuration list for PBXNativeTarget "Zode"')):
            lines.append(f"\t\t{self.ids.get(f'configlist:{scope}')} {comment(title)} = {{")
            lines.append("\t\t\tisa = XCConfigurationList;")
            lines.append("\t\t\tbuildConfigurations = (")
            lines.append(f"\t\t\t\t{self.ids.get(f'config:{scope}:Debug')} {comment('Debug')},")
            lines.append(f"\t\t\t\t{self.ids.get(f'config:{scope}:Release')} {comment('Release')},")
            lines.append("\t\t\t);")
            lines.append("\t\t\tdefaultConfigurationIsVisible = 0;")
            lines.append("\t\t\tdefaultConfigurationName = Release;")
            lines.append("\t\t};")
        lines.append("/* End XCConfigurationList section */")

        lines.append("\t};")
        lines.append(f"\trootObject = {project_id} {comment('Project object')};")
        lines.append("}")
        return "\n".join(lines) + "\n"

    def _relative_of(self, name: str, phase: str) -> str:
        """The relative path of a build file (kept for debugging)."""
        return name


# =============================================================================
# The scheme
# =============================================================================

def render_scheme(target_id: str) -> str:
    buildable = (
        '            <BuildableReference\n'
        '               BuildableIdentifier = "primary"\n'
        f'               BlueprintIdentifier = "{target_id}"\n'
        f'               BuildableName = "{PRODUCT_NAME}.app"\n'
        f'               BlueprintName = "{PRODUCT_NAME}"\n'
        '               ReferencedContainer = "container:Zode.xcodeproj">\n'
        '            </BuildableReference>\n'
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "{LAST_UPGRADE_CHECK}"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
{buildable}         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
      </Testables>
   </TestAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
{buildable}      </BuildableProductRunnable>
   </LaunchAction>
   <ProfileAction
      buildConfiguration = "Release"
      shouldUseLaunchSchemeArgsEnv = "YES"
      savedToolIdentifier = ""
      useCustomWorkingDirectory = "NO"
      debugDocumentVersioning = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
{buildable}      </BuildableProductRunnable>
   </ProfileAction>
   <AnalyzeAction
      buildConfiguration = "Debug">
   </AnalyzeAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
"""


# =============================================================================
# Driver
# =============================================================================

def build() -> tuple[str, str]:
    """Returns the pbxproj text and the scheme text."""
    if not SOURCE_ROOT.is_dir():
        raise SystemExit(f"error: the source folder {SOURCE_ROOT} does not exist")
    tree = scan(SOURCE_ROOT)
    project = Project(tree)
    project.collect()
    pbxproj = project.render()
    scheme = render_scheme(project.ids.get("target:Zode"))
    return pbxproj, scheme


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate the Zode Xcode project.")
    parser.add_argument("--check", action="store_true",
                        help="only verify that the project on disk is up to date")
    parser.add_argument("--print", dest="print_only", action="store_true",
                        help="print the pbxproj instead of writing it")
    args = parser.parse_args()

    pbxproj, scheme = build()
    pbxproj_digest = digest(pbxproj)

    if args.print_only:
        print(pbxproj, end="")
        return 0

    if args.check:
        if not PBXPROJ.exists():
            print(f"FAIL  {PBXPROJ} does not exist")
            return 1
        on_disk = PBXPROJ.read_text(encoding="utf-8")
        on_disk_digest = digest(on_disk)
        if on_disk != pbxproj:
            print(f"FAIL  {PBXPROJ} is out of date")
            print(f"      on disk : {on_disk_digest}")
            print(f"      expected: {pbxproj_digest}")
            return 1
        print(f"OK    {PBXPROJ}")
        print(f"      sha256  : {on_disk_digest}")
        return 0

    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    SCHEME_DIR.mkdir(parents=True, exist_ok=True)
    PBXPROJ.write_text(pbxproj, encoding="utf-8")
    SCHEME.write_text(scheme, encoding="utf-8")

    print(f"wrote {PBXPROJ.relative_to(SHELL_ROOT)}")
    print(f"      sha256  : {pbxproj_digest}")
    print(f"wrote {SCHEME.relative_to(SHELL_ROOT)}")
    print(f"      sha256  : {digest(scheme)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
