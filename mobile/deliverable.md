# Zode — mobile clients: what was built and what was verified

Both mobile clients present the same app as the web version: the same five views
(Now Playing, Collection, Library, Search, Agent), the same canonical library, the same
intent names, and the same haptic programs — with a pre-2011 **Metro** visual language
for phones.

---

## What shipped

### iOS — `mobile/ios/`

| Area | Files |
|---|---|
| App | `ZodeMobile/App/ZodeMobileApp.swift`, `AppState.swift`, `Router.swift` |
| Views | `Views/NowPlayingView.swift`, `CollectionView.swift`, `LibraryView.swift`, `SearchView.swift`, `AgentView.swift`, `RootView.swift` |
| Design | `Design/Tokens.swift` *(generated)*, `MetroTheme.swift`, `Tile.swift`, `RevealTransition.swift` |
| Haptics | `Haptics/HapticEngine.swift`, `HapticPrograms.swift` *(generated)* |
| Model / Data | `Model/Models.swift`, `Data/Library.swift`, `Data/AgentEngine.swift` |
| Platform | `Platform/ZodeAppIntents.swift`, `IntentRouter.swift`, `SpotlightIndexer.swift`, `NotificationSupport.swift`, `JournalingSupport.swift` |
| Project | `ZodeMobile.xcodeproj` *(generated)* + shared scheme, `Resources/Info.plist`, asset catalog with a 1024 px AppIcon |
| Tools | `tools/generate_xcodeproj.py`, `tools/validate_pbxproj.py`, `tools/verify_swift.py`, `tools/make_ios_icon.py` |

### Android — `mobile/android/`

| Area | Files |
|---|---|
| App | `MainActivity.kt`, `ZodeApp.kt` |
| Views | `ui/NowPlaying.kt`, `Collection.kt`, `Library.kt`, `Search.kt`, `Agent.kt`, `Nav.kt` |
| Design | `design/Tokens.kt` *(generated)*, `Theme.kt`, `Tile.kt`, `Type.kt` |
| Haptics | `haptics/HapticEngine.kt`, `HapticPrograms.kt` *(generated)* |
| Model / Data | `data/Model.kt`, `data/Library.kt`, `data/AgentEngine.kt` |
| Platform | `intents/IntentRouter.kt`, `SearchIndexer.kt`, `NotificationSupport.kt` |
| Project | `build.gradle.kts`, `settings.gradle.kts`, `gradle/libs.versions.toml`, `gradlew` / `gradlew.bat`, `AndroidManifest.xml`, mipmaps, `res/xml/searchable.xml` |
| Tools | `tools/verify_android.py`, `tools/make_android_icons.py` |

### Shared tooling — `mobile/tools/`

`generate_tokens.py`, `generate_haptics.py`, `tokens_source.py`, `iconart.py`,
`openstep_plist.py`, `pnglib.py`, `sourcecheck.py`.

`Tokens.swift` and `Tokens.kt` and `HapticPrograms.swift` and `HapticPrograms.kt` are all
**generated** from `packages/shared/tokens.css` and `packages/shared/haptics.json`, so
the design tokens and the waveforms cannot drift between platforms.

---

## The library is one library

The mobile clients do **not** generate their own catalogue.

`packages/shared/library.json` is produced by `scripts/dump_library.mjs`, which imports
`apps/web/src/data/library.js` directly — so there is no possibility of drift. The file
holds 9 artists, 10 albums, 50 tracks and 3 playlists with ids, durations, track numbers,
genres, years, accent colours and the relationship lists.

It is published as byte-identical copies to:

- `packages/shared/library.json` (source of truth)
- `apps/web/assets/library.json`
- `mobile/ios/ZodeMobile/Resources/library.json`
- `mobile/android/app/src/main/res/raw/library.json`

Both clients read their copy at runtime, exactly as they already read `haptics.json`:

| JSON field | iOS (`Model/Models.swift`) | Android (`data/Model.kt`) |
|---|---|---|
| `artists[].id / name / genre / albumIds` | `Artist.id / name / genre / albumIDs` | `Artist.id / name / genre / albumIDs` |
| `albums[].id / title / artistId / year / genre / trackIds / accentHex` | `Album.id / title / artistID / year / genre / trackIDs / accentHex` (`"#f25022"` → `UInt32`) | `Album.id / title / artistID / year / genre / trackIDs / accent` (`"#f25022"` → `Long`) |
| `tracks[].id / title / artistId / albumId / duration / trackNumber / year / genre` | `Track.id / title / artistID / albumID / durationSeconds / trackNumber / year / genre` | `Track.id / title / artistID / albumID / durationSeconds / trackNumber / year / genre` |
| `playlists[].id / title / description / trackIds` | `Playlist.id / title / subtitle / trackIDs` | `Playlist.id / title / subtitle / trackIDs` |

`python3 scripts/export_library.py --check` verifies every copy is byte-identical and
that both clients map every field.

---

## Contract checklist

| Contract clause | iOS | Android |
|---|---|---|
| §2.1 `Attachment` / `IntentResult` / `SearchResult` | `Model/Models.swift` | `data/Model.kt` |
| §4 intent names (`zode.search`, `zode.play`, `zode.pause`, `zode.next`, `zode.previous`, `zode.agent.newTask`, `zode.agent.stop`, `zode.attach`, `zode.show`) | `Platform/ZodeAppIntents.swift` | `intents/IntentRouter.kt` |
| §7 haptics rendered from `packages/shared/haptics.json` | `CoreHaptics` — `CHHapticPattern` + `CHHapticAdvancedPatternPlayer(loopEnabled)` | `VibrationEffect.createWaveform(timings, amplitudes, repeat)` |
| §7 `working` loops | `loopEnabled = true` | `repeat = 0` |
| §9 notifications | `UNUserNotificationCenter` | `NotificationManager` + channel |
| §10 system search | `CoreSpotlight` | `SearchManager` + `res/xml/searchable.xml` + a suggestion `ContentProvider` |
| §11 journal | `JournalingSupport.swift` (Journaling Suggestions) | n/a — see below |
| Deep links | `zode://` URL scheme | `zode://` intent filter |

---

## Android platform limits (discovered by compiling, not by reading)

The Android client is the only one that could be **compiled and assembled** in this
environment (JDK 17 + Android SDK 36 + Gradle 8.11.1). Doing so surfaced a set of
defects that no static audit would have caught:

**SDK APIs that were removed or moved**

| Removed | Replacement |
|---|---|
| `android.content.SearchRecentSuggestions` | `android.provider.SearchRecentSuggestions` |
| `SearchManager.ACTION_SEARCH` | `Intent.ACTION_SEARCH` |
| `SearchManager.SUGGEST_QUERY_PARAMETER` | the literal `"query"` |
| `SearchableInfo(XmlResourceParser)` | `SearchManager.getSearchableInfo(ComponentName)` |
| `NotificationManager.notify(String, Notification)` | `notify(Int, Notification)` |

**A capability that never existed**

`Vibrator` has **no** `compose` method, and `VibrationEffect.Composition` can only
compose the built-in *primitives* (`CLICK`, `TICK`, …). Two arbitrary waveforms cannot
be layered on Android. So every track of a program is merged onto **one** timeline and
emitted as a single waveform, and a one-shot that arrives while the `working` loop is
running replaces the loop and the loop resumes once the one-shot ends. The shape
survives; true polyphony is not possible.

**Generator bugs**

The Kotlin token generator emitted `0` and `0.6275` where Compose's `Color(...)` and
`floatArrayOf(...)` need Floats (`0.0f`, `0.6275f`), and `const val x: Double = 220`
where a Double literal is required. The Swift generator emits `CGFloat` and was
unaffected. The generator was fixed, not the generated files.

**A validator bug**

`mobile/tools/sourcecheck.py` looped forever on a Kotlin string containing a bare `$`
(e.g. `"$taskID-m0"`) — it treated the `$` as the start of an interpolation and then
skipped zero characters. The scanner now advances past a bare `$`.

---

## Verification

Run from the repository root:

```bash
python3 mobile/ios/tools/validate_pbxproj.py      # → All project checks passed.
python3 mobile/ios/tools/verify_swift.py          # → All iOS checks passed.
python3 mobile/android/tools/verify_android.py     # → All Android checks passed.
python3 scripts/export_library.py --check          # → library is in sync: 9 artists, 10 albums, 50 tracks, 3 playlists
```

And the real build:

```bash
cd mobile/android
export JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$(which javac)")")")"
export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
./gradlew :app:assembleDebug --console=plain --no-daemon
```

```
BUILD SUCCESSFUL in 1m 22s
```

→ `mobile/android/app/build/outputs/apk/debug/app-debug.apk` (≈10 MB, 8 dex files).

---

## NOT VERIFIED HERE

Everything below needs real hardware or a Mac, and is **not** claimed:

- **The iOS app compiling.** There is no Swift toolchain on this machine. The project
  *structure* is validated and the sources are statically audited, and CI compiles it on
  a macOS runner — but nobody has compiled it yet. Expect to fix things on first build.
- **How the haptics actually feel.** iOS has a real Taptic Engine and the waveform data
  is correct, but only a device can tell you whether the triple roll reads as a triple
  roll.
- **The Android app running.** The APK builds; it has not been launched on a device or
  emulator.
- **Siri, Shortcuts, Spotlight, App Search, the share sheet and the deep-link routing**
  end to end.
- **The Journal contribution on iOS** — `JournalingSupport.swift` is written against the
  Journaling Suggestions framework but has not been exercised.
- **Windows and Android have no system journal.** `journal.write` resolves and lands in
  a local activity log instead — that is a platform limit, not a missing feature.
- **Any device-matrix check** — different screen sizes, notches, dark/light mode, and
  large-type accessibility settings were not exercised.
