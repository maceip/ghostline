# Zode — macOS native shell

A native macOS app that hosts the Zode web app (Zune × Microsoft Metro) in a
`WKWebView`. The window has **no native chrome at all** — no title bar, no
traffic lights, no minimise/maximise/close buttons — the web content owns the
whole window.

The shell implements the frozen native bridge contract
(`packages/shared/contract.md` v1) exactly: the same transport, the same
envelope, the same request table, the same intent names.

```
shells/macos/
├── Zode/                       the Swift sources
│   ├── App/                    @main, the app delegate, the model, the menu
│   ├── Bridge/                 the bridge, the envelope, the scheme handler, the web view
│   ├── Window/                 the borderless window, the resize edges, the SwiftUI shell
│   ├── Haptics/                the haptic programs, the CoreHaptics and the audio renderer
│   ├── Attachments/            the attachment model and the file picker
│   ├── Intents/                the App Intents and the AppEntity schemas
│   ├── Services/               notifications, search, journal, intents, resources
│   ├── Info.plist              the bundle information
│   ├── Zode.entitlements       the hardened runtime entitlements
│   └── Resources/              the bundled web app, haptics.json, the app icon
├── Zode.xcodeproj/             **generated** — do not edit by hand
├── tools/
│   ├── generate_xcodeproj.py   the deterministic pbxproj generator
│   ├── validate_pbxproj.py     the pbxproj validator (no `plutil` needed)
│   ├── verify_against_web.py   cross-checks the shell against the web app
│   └── make_icons.py           builds the app icon set from icons/zode.png
├── build.sh                    archive + export
├── sign.sh                     list the codesigning identities
├── deliverable.md              what was built, what was verified
├── Info.plist            -> Zode/Info.plist
├── Zode.entitlements     -> Zode/Zode.entitlements
└── Resources             -> Zode/Resources
```

> The three entries at the bottom are **symlinks** to the real files inside
> `Zode/`, so that both the documented layout and the build settings
> (`INFOPLIST_FILE = Zode/Info.plist`, `CODE_SIGN_ENTITLEMENTS =
> Zode/Zode.entitlements`) point at the same file. There is exactly one copy
> of every file.

## Requirements

* macOS 14 or newer, Xcode 26/27 (the sources use `@available` guards so they
  keep building against older SDKs)
* Python 3 (only the standard library — the tools do not need Pillow)
* an Apple Developer team for signing (`ZODE_TEAM_ID`)

## Build

```bash
cd shells/macos

# 1. see which signing identities this Mac has
./sign.sh

# 2. build (archive + export)
export ZODE_TEAM_ID=ABCDE12345          # <- your team id
export ZODE_SIGN_IDENTITY="Developer ID Application: …"   # optional
./build.sh

# 3. a quick debug build
./build.sh --debug
```

`build.sh`

* copies `apps/web` into `Zode/Resources/web` (the web app is bundled
  verbatim — no build step),
* copies `packages/shared/haptics.json` into `Zode/Resources/haptics.json`,
* regenerates and validates the Xcode project,
* archives with `xcodebuild … -archivePath build/Zode.xcarchive -destination
  'generic/platform=macOS' CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$ZODE_TEAM_ID"
  -allowProvisioningUpdates archive`,
* exports the `.app` with `xcodebuild -exportArchive`.

The team id is **never invented**: without `ZODE_TEAM_ID` the script explains
what is missing and stops (use `--unsigned` for a build without signing).

## The Xcode project is generated

```bash
python3 tools/generate_xcodeproj.py           # write Zode.xcodeproj
python3 tools/generate_xcodeproj.py --check   # is it up to date?
python3 tools/validate_pbxproj.py             # is it structurally valid?
python3 tools/verify_against_web.py           # does the shell match the web app?
```

The generator mirrors the `Zode/` folder into the group tree, so a new Swift
file only has to be dropped into the right folder. Every object id is a
24 character uppercase hex string derived from a stable hash of the object's
name, so the project file is byte identical on every run.

## Dev mode

```bash
ZODE_DEV_URL=http://localhost:5173 ./build.sh --debug
```

`ZODE_DEV_URL` (or the `ZodeDevURL` user default) makes the shell load that
URL instead of the bundled assets. Everything else — the bridge, the drop
target, the window chrome — works the same.

## The app icon

```bash
python3 tools/make_icons.py          # rebuild the icon set from icons/zode.png
python3 tools/make_icons.py --check  # is the icon set complete?
```

The script masks the artwork with the macOS rounded rectangle (a superellipse)
and leaves the ~10 % margin the system expects. It uses Pillow when it is
installed and falls back to its own PNG codec otherwise.

## What the shell does

| Contract | Where |
| --- | --- |
| §1 transport, envelope | `Bridge/ZodeBridge.swift`, `Bridge/ZodeEnvelope.swift` |
| §1.3 `zode://app/` origin | `Bridge/ZodeSchemeHandler.swift` |
| §2 the `window.zode` API | `Bridge/ZodeBridge.swift` |
| §2.2 events | `Bridge/ZodeBridge.swift` (`emit(event:payload:)`) |
| §3 request table | `Bridge/ZodeBridge.swift` (`perform(_:payload:)`) |
| §4 intents | `Intents/ZodeIntents.swift`, `Services/IntentRouter.swift` |
| §5 window chrome | `Window/ZodeWindow.swift`, `Window/ZodeResizeEdge.swift` |
| §7 haptics | `Haptics/HapticProgram.swift`, `Haptics/CHapticEngine.swift`, `Haptics/AudioHapticSynth.swift` |
| §8 drop & dock | `Bridge/ZodeWebView.swift`, `App/AppDelegate.swift` |
| §9 notifications | `Services/NotificationService.swift` |
| §10 system search | `Services/SearchService.swift`, `Intents/ZodeEntities.swift` |
| §11 journal | `Services/JournalService.swift` |

`deliverable.md` has the full checklist and the commands that were run.
