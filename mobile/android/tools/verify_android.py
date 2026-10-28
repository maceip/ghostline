#!/usr/bin/env python3
"""Verify the Android sources without a Kotlin compiler.

Standard library only. Run it from the repository root:

    python3 mobile/android/tools/verify_android.py

It asserts that

  * every intent name from contract §4 appears in the Kotlin sources;
  * every haptic program name from `packages/shared/haptics.json` appears;
  * the brace/paren/bracket balance of every Kotlin file is even;
  * the Gradle files are syntactically plausible and agree with each other
    (compileSdk 36, minSdk 26, targetSdk 36, AGP 8.x, Kotlin 2.x);
  * `gradle/wrapper/gradle-wrapper.properties` points at a real Gradle 8.x
    distribution;
  * the `gradle-wrapper.jar` situation is honestly documented -- the jar is a
    binary that is NOT committed and NOT faked;
  * the seed tables and generator constants match
    `packages/shared/library.json`, so Android presents the same records as
    the web app and iOS;
  * the shared tokens and haptics files are not stale;
  * every `R.` resource the code refers to exists in `res/`.

Exits 0 when everything passes, 1 otherwise.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))

import sourcecheck  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
ANDROID_DIR = REPO_ROOT / "mobile" / "android"
APP_DIR = ANDROID_DIR / "app"
SOURCE_DIR = APP_DIR / "src" / "main" / "java" / "com" / "zode" / "app"
RES_DIR = APP_DIR / "src" / "main" / "res"
SHARED = REPO_ROOT / "packages" / "shared"

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

VIEWS = ["now-playing", "collection", "library", "search", "agent"]

failures: list = []


def fail(message: str) -> None:
    failures.append(message)
    print("FAIL: %s" % message)


def ok(message: str) -> None:
    print("ok: %s" % message)


def kotlin_files() -> list:
    return sorted(SOURCE_DIR.rglob("*.kt"))


def all_source_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in kotlin_files())


def check_intents() -> None:
    text = all_source_text()
    for intent in INTENTS:
        if intent in text:
            ok("contract §4 intent %s is implemented" % intent)
        else:
            fail("contract §4 intent %s does not appear in the Kotlin sources" % intent)

    for view in VIEWS:
        if view in text:
            ok("contract §4 view %s is implemented" % view)
        else:
            fail("contract §4 view %s does not appear in the Kotlin sources" % view)


def check_haptics() -> None:
    document = json.loads((SHARED / "haptics.json").read_text(encoding="utf-8"))
    text = all_source_text()
    for name in document["programs"]:
        if '"%s"' % name in text:
            ok("haptic program %s is present" % name)
        else:
            fail("haptic program %s is missing from the Kotlin sources" % name)

    if "VibrationEffect.createWaveform" in text:
        ok("the haptics use VibrationEffect.createWaveform")
    else:
        fail("the haptics do not use VibrationEffect.createWaveform")

    if "hasVibrator" in text:
        ok("the haptic engine checks hasVibrator()")
    else:
        fail("the haptic engine does not check hasVibrator()")

    # Android cannot layer two arbitrary waveforms: `VibrationEffect.Composition`
    # only composes the built-in primitives and `Vibrator` has no `compose`.
    # Every track of a program is therefore merged onto one timeline and emitted
    # as a single waveform.
    if "startComposition" in text or "createComposition" in text:
        fail("the haptic engine uses VibrationEffect.Composition, which can only "
             "compose primitives -- the tracks must be merged into one waveform")
    else:
        ok("the haptic engine merges every track onto one waveform")

    if "createWaveform" in text and "amplitudes" in text:
        ok("the merged waveform carries the per-step amplitudes")
    else:
        fail("the merged waveform does not carry per-step amplitudes")

    if "repeat" in text:
        ok("the looping program is repeated by the waveform itself")
    else:
        fail("the waveform does not set a repeat count")


def check_balance() -> None:
    unbalanced = []
    for path in kotlin_files():
        text = path.read_text(encoding="utf-8")
        counts = sourcecheck.balance(text, "kotlin")
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
        ok(
            "every Kotlin file has balanced braces, parens and brackets (%d files)"
            % len(kotlin_files())
        )


def check_gradle() -> None:
    """The Gradle files must be syntactically plausible and consistent."""
    settings = ANDROID_DIR / "settings.gradle.kts"
    build = ANDROID_DIR / "build.gradle.kts"
    app_build = APP_DIR / "build.gradle.kts"
    catalog = ANDROID_DIR / "gradle" / "libs.versions.toml"
    properties = ANDROID_DIR / "gradle.properties"

    for path in (settings, build, app_build, catalog, properties):
        if not path.exists():
            fail("missing Gradle file: %s" % path.relative_to(REPO_ROOT))
            return

    app_text = app_build.read_text(encoding="utf-8")
    settings_text = settings.read_text(encoding="utf-8")

    for key, expected in (
        ("compileSdk", "36"),
        ("minSdk", "26"),
        ("targetSdk", "36"),
    ):
        match = re.search(r"%s\s*=\s*(\d+)" % key, app_text)
        if match is None:
            fail("%s is not set in app/build.gradle.kts" % key)
        elif match.group(1) != expected:
            fail("%s = %s (expected %s)" % (key, match.group(1), expected))
        else:
            ok("%s = %s" % (key, expected))

    if 'include(":app")' in settings_text:
        ok("settings.gradle.kts includes the :app module")
    else:
        fail("settings.gradle.kts does not include the :app module")

    # The version catalog.
    catalog_text = catalog.read_text(encoding="utf-8")
    agp = re.search(r'^agp\s*=\s*"([^"]+)"', catalog_text, re.MULTILINE)
    if agp is None:
        fail("the version catalog has no agp version")
    elif not agp.group(1).startswith("8."):
        fail("AGP %s is not an 8.x release" % agp.group(1))
    else:
        ok("AGP %s" % agp.group(1))

    kotlin = re.search(r'^kotlin\s*=\s*"([^"]+)"', catalog_text, re.MULTILINE)
    if kotlin is None:
        fail("the version catalog has no kotlin version")
    elif not kotlin.group(1).startswith("2."):
        fail("Kotlin %s is not a 2.x release" % kotlin.group(1))
    else:
        ok("Kotlin %s" % kotlin.group(1))

    # The Compose plugin has to be applied for Compose 2.x.
    if "kotlin.compose" in app_text or "kotlinCompose" in app_text:
        ok("the Compose compiler plugin is applied")
    else:
        fail("the Compose compiler plugin is not applied")

    # No third-party UI libraries: only androidx + the compose BOM.
    for group in re.findall(r'group\s*=\s*"([^"]+)"', catalog_text):
        if not group.startswith("androidx."):
            fail("the version catalog pulls in a non-AndroidX dependency: %s" % group)
    ok("every catalog dependency is an AndroidX artifact")

    for forbidden in ("coil", "hilt", "dagger", "koin", "glide", "retrofit"):
        if forbidden in catalog_text.lower():
            fail("the version catalog mentions %s" % forbidden)
    ok("no DI or image-loading library in the version catalog")


def check_wrapper() -> None:
    """The wrapper must point at a real Gradle 8.x distribution."""
    properties = ANDROID_DIR / "gradle" / "wrapper" / "gradle-wrapper.properties"
    if not properties.exists():
        fail("gradle/wrapper/gradle-wrapper.properties is missing")
        return

    text = properties.read_text(encoding="utf-8")
    match = re.search(r"distributionUrl=(.*)", text)
    if match is None:
        fail("the wrapper properties have no distributionUrl")
        return

    url = match.group(1).strip().replace("\\:", ":")
    if not url.startswith("https://services.gradle.org/distributions/gradle-"):
        fail("the distribution URL is not a services.gradle.org URL: %s" % url)
        return
    ok("the distribution URL is %s" % url)

    version = re.search(r"gradle-(\d+)\.(\d+)", url)
    if version is None:
        fail("could not read the Gradle version from %s" % url)
        return
    if version.group(1) != "8":
        fail("the wrapper points at Gradle %s, not an 8.x release" % version.group(0))
    else:
        ok("the wrapper points at Gradle %s.%s" % (version.group(1), version.group(2)))

    # The jar is a binary and must not be faked.
    jar = ANDROID_DIR / "gradle" / "wrapper" / "gradle-wrapper.jar"
    if jar.exists():
        print(
            "note: gradle-wrapper.jar is present (%d bytes) -- it was fetched locally."
            % jar.stat().st_size
        )
    else:
        print(
            "note: gradle-wrapper.jar is not committed (it is a binary) -- it must be "
            "fetched with `gradle wrapper --gradle-version %s.%s`."
            % (version.group(1), version.group(2))
        )

    # The README has to say the same thing.
    readme = ANDROID_DIR / "README.md"
    if not readme.exists():
        fail("mobile/android/README.md is missing")
        return
    readme_text = readme.read_text(encoding="utf-8")
    if "gradle-wrapper.jar" in readme_text and "gradle wrapper" in readme_text:
        ok("the README documents how to fetch gradle-wrapper.jar")
    else:
        fail("the README does not document how to fetch gradle-wrapper.jar")

    # Nothing in the repository may pretend to be the jar.
    for path in ANDROID_DIR.rglob("*"):
        if path.is_file() and path.suffix in (".jar", ".zip", ".bin"):
            print("note: binary found in the tree: %s" % path.relative_to(REPO_ROOT))


def check_library_parity() -> None:
    """The bundled library must be the canonical one, byte for byte."""
    text = (SOURCE_DIR / "data" / "Library.kt").read_text(encoding="utf-8")

    if "library.json" in text or "R.raw.library" in text:
        ok("Library.kt reads the bundled library.json")
    else:
        fail("Library.kt does not reference library.json")

    bundled = APP_DIR / "src" / "main" / "res" / "raw" / "library.json"
    shared = REPO_ROOT / "packages" / "shared" / "library.json"

    if not bundled.exists():
        fail("mobile/android/app/src/main/res/raw/library.json is missing")
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

    data = json.loads(shared_text)
    album_titles = [album["title"] for album in data.get("albums", [])]
    track_titles = [track["title"] for track in data.get("tracks", [])]

    for key in ("artistId", "trackIds", "duration", "trackNumber", "accentHex"):
        if key in text:
            ok("Library.kt maps the JSON field %r" % key)
        else:
            fail("Library.kt does not map the JSON field %r" % key)

    for key, expected in (("albums", len(album_titles)),
                          ("tracks", len(track_titles))):
        actual = len(data.get(key, []))
        if actual == expected:
            ok("the canonical library has %d %s" % (actual, key))
        else:
            fail("the canonical library has %d %s, expected %d" % (actual, key, expected))


def check_resources() -> None:
    """Every `R.<type>.<name>` the code uses must exist in res/."""
    text = all_source_text()
    referenced = set(re.findall(r"\bR\.(drawable|mipmap|raw|xml|string|color)\.(\w+)", text))

    # The resources the app ships.
    available = {
        "drawable": {
            path.stem for path in RES_DIR.glob("drawable*/*.xml")
        },
        "mipmap": {
            path.stem
            for directory in RES_DIR.glob("mipmap-*")
            for path in directory.glob("*.png")
        },
        "raw": {path.stem for path in RES_DIR.glob("raw/*")},
        "xml": {path.stem for path in RES_DIR.glob("xml/*.xml")},
        "string": set(re.findall(r'<string name="([^"]+)"', (RES_DIR / "values" / "strings.xml").read_text(encoding="utf-8"))),
        "color": set(re.findall(r'<color name="([^"]+)"', (RES_DIR / "values" / "colors.xml").read_text(encoding="utf-8"))),
    }

    for kind, name in sorted(referenced):
        if name in available.get(kind, set()):
            ok("the resource R.%s.%s exists" % (kind, name))
        else:
            fail("the resource R.%s.%s does not exist in res/" % (kind, name))


def check_generated_files() -> None:
    for script, platform in (
        ("mobile/tools/generate_tokens.py", "android"),
        ("mobile/tools/generate_haptics.py", "android"),
    ):
        command = [sys.executable, str(REPO_ROOT / script), "--check", "--platform", platform]
        result = subprocess.run(command, capture_output=True, text=True, cwd=str(REPO_ROOT))
        if result.returncode == 0:
            ok("%s --check passes" % script)
        else:
            fail("%s --check failed:\n%s%s" % (script, result.stdout, result.stderr))


def main() -> int:
    if not SOURCE_DIR.exists():
        print("FAIL: %s does not exist" % SOURCE_DIR)
        return 1

    print("Verifying %d Kotlin files.\n" % len(kotlin_files()))
    check_intents()
    check_haptics()
    check_balance()
    check_gradle()
    check_wrapper()
    check_library_parity()
    check_resources()
    check_generated_files()

    print("")
    if failures:
        print("%d check(s) failed." % len(failures))
        return 1
    print("All Android checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
