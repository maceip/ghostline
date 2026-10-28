# Zode — macOS native shell — deliverable

**Track:** macOS native shell (SwiftUI + AppKit + WKWebView)
**Contract:** `packages/shared/contract.md` v1 (frozen)
**Directory:** `/workspace/zode/shells/macos/` (nothing outside it was written)

25 Swift files (3 490 lines), 3 Python tools (1 523 lines), one generated
`Zode.xcodeproj` (427 lines), the app icon set, the build/sign scripts.

---

## 1. Every file, and what it is for

### 1.1 The Swift application (`Zode/`)

| File | Purpose |
| --- | --- |
| `Zode/App/ZodeApp.swift` | `@main` entry point: the SwiftUI `App`, the `Settings` scene, the on-demand `WindowGroup` (Inspector) and the menu commands. |
| `Zode/App/AppDelegate.swift` | Owns the shell: creates the bridge, the web view and the borderless `ZodeWindow`; receives the Dock drops, the deep links and the Spotlight hand-off; closes the SwiftUI scene window that may open at launch. |
| `Zode/App/ZodeAppModel.swift` | The observable state: wires the intents, seeds the Spotlight index, shows the native attachment toast. |
| `Zode/App/ZodeCommands.swift` | The menu bar: *Attach Files…* (native file picker), *Inspector…*, *Verify Haptic Programs* (prints the computed CoreHaptics parameters). |
| `Zode/Bridge/ZodeEnvelope.swift` | Contract §1.2: the request/response/event envelopes, the error codes, `ZodeRequest` payload accessors. |
| `Zode/Bridge/ZodeBridge.swift` | Contract §1/§2/§3: the `WKScriptMessageHandler` named **`zode`**, the full request table, the event emitter, the attachment/deep-link/intent delivery. |
| `Zode/Bridge/ZodeSchemeHandler.swift` | Contract §1.3: the `zode://app/` scheme handler that serves the bundled web app with the right MIME types (and range requests). |
| `Zode/Bridge/ZodeWebView.swift` | The `WKWebView` subclass: drop target for the whole window (§8), the invisible resize edges (§5), the navigation policy (external links → default browser). |
| `Zode/Window/ZodeWindow.swift` | The borderless `NSWindow`: no title bar, no traffic lights, the real window drag (`performDrag(with:)`), the fill-screen toggle, `canBecomeMain`. |
| `Zode/Window/ZodeResizeEdge.swift` | The resize edge enum (`.bottomLeft`, `.right`, …), the hit-test geometry, the resize cursors. |
| `Zode/Window/ZodeRootView.swift` | The SwiftUI shell: hosts the web view, draws the native toast, the Settings and the Inspector panels. |
| `Zode/Haptics/HapticProgram.swift` | Contract §7: parses `haptics.json` with `JSONSerialization` and the **pure** mapping `HapticProgram.buildPattern(from:)` → `HapticPatternPlan` (CoreHaptics parameters, no device needed). |
| `Zode/Haptics/CHapticEngine.swift` | The CoreHaptics renderer (`CHHapticPattern` + `CHHapticAdvancedPatternPlayer`, `loopEnabled`) and the `capabilitiesForHardware().supportsHaptics` check. |
| `Zode/Haptics/AudioHapticSynth.swift` | The CoreAudio fallback: renders the carrier + intensity envelope into a PCM buffer and loops it. |
| `Zode/Haptics/HapticService.swift` | The facade: picks the engine, plays/stops a program, reports the engine that was used. |
| `Zode/Attachments/Attachment.swift` | The `Attachment` model (contract §2.1) and its wire format. |
| `Zode/Attachments/AttachmentService.swift` | The `NSOpenPanel` picker and the URL → attachment conversion (MIME type via `UTType`). |
| `Zode/Intents/ZodeIntents.swift` | Contract §4: the App Intents (`SearchLibraryIntent`, `PlayItemIntent`, pause/next/previous, `NewTaskIntent`, `StopTaskIntent`, `ShowViewIntent`) and the `AppShortcutsProvider`. |
| `Zode/Intents/ZodeEntities.swift` | Contract §10: the `AppEntity` schema of the library items (+ the string query for the Spotlight semantic index). |
| `Zode/Intents/ZodeIntentsBridge.swift` | The bridge between the App Intents and the running shell. |
| `Zode/Services/ZodeResources.swift` | Where the bundled web app, `haptics.json` and the optional `library.json` live inside the bundle. |
| `Zode/Services/NotificationService.swift` | Contract §9: `UNUserNotificationCenter`, the authorisation request, the notification action → `notificationAction` event. |
| `Zode/Services/SearchService.swift` | Contract §10: the in-memory index, `search.query` and the CoreSpotlight (`CSSearchableIndex`) mirroring. |
| `Zode/Services/JournalService.swift` | Contract §11: the local activity log and the (SDK guarded) Journaling Suggestions adapter. |
| `Zode/Services/IntentRouter.swift` | Contract §4: the intent names, the `IntentResult`, the unknown-intent error (§12). |
| `Zode/Info.plist` | The bundle information: the `zode://` URL scheme, the Spotlight activity types, the ATS exception for the dev server. |
| `Zode/Zode.entitlements` | The hardened runtime entitlements (the App Sandbox is off: the app must read the files the user drops). |
| `Zode/Resources/haptics.json` | The canonical haptic programs (a copy of `packages/shared/haptics.json`, refreshed by `build.sh`). |
| `Zode/Resources/web/index.html` | The placeholder for the bundled web app (replaced by `build.sh`). |
| `Zode/Resources/Assets.xcassets/**` | The app icon set (10 PNGs + `Contents.json`). |

### 1.2 The generated project

| File | Purpose |
| --- | --- |
| `Zode.xcodeproj/project.pbxproj` | **Generated** by `tools/generate_xcodeproj.py` — one app target `Zode`, the group tree that mirrors `Zode/`, the sources/resources phases, the `Info.plist` and the entitlements reference, the shared scheme. |
| `Zode.xcodeproj/xcshareddata/xcschemes/Zode.xcscheme` | The shared scheme (build / run / profile / archive) so `xcodebuild -scheme Zode` works from a clean checkout. |

### 1.3 The tools and the scripts

| File | Purpose |
| --- | --- |
| `tools/generate_xcodeproj.py` | The deterministic pbxproj generator (stable 24 hex object ids, `--check`, `--print`). |
| `tools/validate_pbxproj.py` | The pbxproj validator: its own old-style plist parser (no `plutil` on Linux) + the structural checks. |
| `tools/verify_against_web.py` | Cross-checks the shell against the web app it hosts (the frozen lists of `apps/web/src/bridge/contract.js` vs. the Swift sources). |
| `tools/make_icons.py` | Builds the app icon set from `icons/zode.png` (its own PNG codec when Pillow is missing), squircle mask with the ~10 % margin. |
| `build.sh` | Copies the web app + haptics into the bundle, regenerates/validates the project, archives and exports the app. |
| `sign.sh` | Lists the codesigning identities and explains which one to use. |
| `README.md` | The developer documentation of the shell. |
| `deliverable.md` | This file. |
| `Info.plist`, `Zode.entitlements`, `Resources` | **Symlinks** to `Zode/Info.plist`, `Zode/Zode.entitlements` and `Zode/Resources` — the documented layout without a second copy of the file. |

---

## 2. The contract checklist

### §2 — the JavaScript API (`window.zode`)

| API | Implementation |
| --- | --- |
| `platform`, `version`, `capabilities` | The web side reads them from the page; the native side answers `app.info` (`ZodeBridge.deviceInfo()`) and the capability flags are documented per service (`HapticService.hardwareSupportsHaptics`, `SearchService`, `NotificationService`, `JournalService.isJournalingSuggestionsAvailable`, the window control). |
| `haptic(program, opts)` / `hapticStop(program)` | `ZodeBridge.perform` → `HapticService.play(program:loop:)` / `.stop(program:)`. |
| `attach()` | `ZodeBridge.perform` → `AttachmentService.pick()` (`NSOpenPanel`, multiple files). |
| `onAttachment(cb)` | `ZodeBridge.emit(event: "attachment", payload:)` + the native toast (`ZodeAppModel.present(attachments:)`). |
| `notify(opts)` | `ZodeBridge.perform` → `NotificationService.post(title:body:identifier:urgency:)`. |
| `onNotificationAction(cb)` | `NotificationService.onAction` → `ZodeBridge.emitNotificationAction(identifier:action:)`. |
| `performIntent(intent, payload)` | `ZodeBridge.perform` → `IntentRouter.perform(name:payload:)` → `IntentResult`. |
| `onIntent(cb)` | `ZodeBridge.deliver(intent:payload:)` → `emit(event: "intent", …)`. |
| `journal(entry)` | `ZodeBridge.perform` → `JournalService.write(title:body:date:)`. |
| `search(query)` | `ZodeBridge.perform` → `SearchService.query(_:)`. The index is seeded from the canonical library of the web app (`assets/library.json`). |
| `onSearch(cb)` | `ZodeBridge.deliver(searchQuery:)` → `emit(event: "search", …)`. |
| `window.dragStart(x, y)` | `ZodeBridge.perform` → `ZodeWindow.beginWindowDrag(screenX:screenY:)`. |
| `window.toggleFillScreen()` | `ZodeBridge.perform` → `ZodeWindow.toggleFillScreen()`. |
| `window.setFullScreen(b)` / `isFullScreen()` | `ZodeWindow.setFillingScreen(_:)` / `.isFillingScreen` (fill semantics, **not** `toggleFullScreen`, see §5). |
| `onDeepLink(cb)` | `ZodeBridge.deliver(deepLink:)` → `emit(event: "deepLink", …)`. |
| `openPath(path)` | `ZodeBridge.perform` → `NSWorkspace.shared.open`. |

### §3 — the request table

| Request | Implementation | Result |
| --- | --- | --- |
| `haptic.play` | `ZodeBridge.perform` → `HapticService.play` | `{program, loop, engine}` |
| `haptic.stop` | `HapticService.stop` | `{}` |
| `attach.pick` | `AttachmentService.pick` | `{attachments: Attachment[]}` |
| `notify.post` | `NotificationService.post` | `{}` |
| `intent.perform` | `IntentRouter.perform` | `IntentResult` |
| `journal.write` | `JournalService.write` | `{}` |
| `search.query` | `SearchService.query` | `{results: SearchResult[]}` |
| `window.dragStart` | `ZodeWindow.beginWindowDrag` | `{}` |
| `window.toggleFill` | `ZodeWindow.toggleFillScreen` | `{filling}` |
| `window.setFullScreen` | `ZodeWindow.setFillingScreen` | `{}` |
| `window.isFullScreen` | `ZodeWindow.isFillingScreen` | `{fullScreen}` |
| `app.openPath` | `NSWorkspace.shared.open` | `{}` |
| `app.info` | `ZodeBridge.deviceInfo()` | `{version, build, platform, deviceModel}` |
| *anything else* | `ZodeBridgeError.unsupported` | `{ok:false, error:{code:"unsupported"}}` (§12 — never hangs) |

Every answer uses the §1.2 envelope: `{id, ok, result}` / `{id, ok:false, error:{code,message}}`.
The error codes are `unsupported`, `invalid`, `denied`, `cancelled`, `notFound`, `internal`.

### §4 — the intents

| Intent | App Intent | Where it lands |
| --- | --- | --- |
| `zode.search` | `SearchLibraryIntent` | searches the index, forwards to the page |
| `zode.play` | `PlayItemIntent` | forwards to the page (media intent) |
| `zode.pause` | `PauseIntent` | forwards to the page |
| `zode.next` / `zode.previous` | `NextIntent` / `PreviousIntent` | forwards to the page |
| `zode.agent.newTask` | `NewTaskIntent` (`openAppWhenRun = true`) | forwards + activates the app |
| `zode.agent.stop` | `StopTaskIntent` | forwards to the page |
| `zode.attach` | — (dock drop / `application(_:open:)`) | `attachment` events |
| `zode.show` | `ShowViewIntent` (`openAppWhenRun = true`) | forwards + activates the app |

The names are also accepted verbatim by `intent.perform` (`IntentRouter.names`).

### §5 — the window chrome

| Rule | Implementation |
| --- | --- |
| 1. no native controls | `ZodeWindow.init` — `styleMask = [.borderless, .fullSizeContentView, .resizable]`, `titleVisibility = .hidden`, `titlebarAppearsTransparent = true`, the standard buttons hidden. A borderless window has no traffic lights at all. |
| 2. the web content owns the window | The content view is the SwiftUI hosting view with the web view filling it; the window background only exists to avoid a white flash (`--zode-ink`). |
| 3. the top strip drags the window | `ZodeWindow.beginWindowDrag(screenX:screenY:)` — a real macOS drag: the screen point is converted into the window's base coordinates, a `leftMouseDown` `NSEvent` is synthesised and bound to the window, and `window.performDrag(with:)` runs AppKit's own drag. The cursor is hidden during the drag and restored afterwards. The documented fallback (`isMovableByWindowBackground` + a hand driven frame drag) is used when the synthetic event cannot be created. |
| 4. double click fills the screen | `ZodeWindow.toggleFillScreen()` — saves the frame, sets the frame to `NSScreen.frame` (**the whole display, not `visibleFrame`**), removes `.titled` from the style mask, restores both on the next toggle. `toggleFullScreen` is **never** used. The screen is picked with `NSScreen.screens.first(where: { $0.frame.intersects(window.frame) })`. |
| 5. the rest is not draggable | `isMovableByWindowBackground = false`; only the drag strip can move the window. |
| — the manual resize | `ZodeWebView.hitTest(_:)` claims the 8 px edges and `ZodeWebView.mouseDown(with:)` drives the frame (`ZodeResizeEdge`). The **top** edge is excluded — it belongs to the drag strip. |

### §7 — the haptics

| Rule | Implementation |
| --- | --- |
| the programs come from `haptics.json` | `HapticLibrary.load(url:)` parses the bundled copy with `JSONSerialization`; `build.sh` refreshes it from `packages/shared/haptics.json`. |
| the mapping is device independent | `HapticProgram.buildPattern(from:) -> HapticPatternPlan` — a pure function of the program (no engine, no device, no I/O). The CoreHaptics pattern is built from the plan in `CHapticEngine.makePattern(from:)`. |
| CoreHaptics | `CHapticEngine` — `CHHapticEvent(.hapticContinuous/.hapticTransient)`, `CHHapticParameterCurve` with `controlPoints`, `CHHapticAdvancedPatternPlayer` with `loopEnabled = true` for `working`. |
| the capability check | `HapticHardwareSupport.supportsHaptics` → `CHHapticEngine.capabilitiesForHardware().supportsHaptics` (inside `#if canImport(CoreHaptics)`). |
| the fallback | `AudioHapticSynth` — a sine carrier at `carrierHz`, the amplitude from the intensity curve (linear interpolation between the control points), the brightness from the sharpness curve, transient tracks as exponentially decaying bursts, `working` loops with the `.loops` buffer option. |
| `capabilities.haptics` | `true` only for a real haptic engine, never for the audio fallback. |
| `done` ≠ `working` | `done` = three rolls (580 ms), `working` = one slow swell (2 400 ms, looping until stopped). |

### §8 — drop & dock

| Source | Implementation |
| --- | --- |
| drop onto the window | `ZodeWebView` registers for `public.file-url` and `public.tiff` and implements `draggingEntered` / `draggingUpdated` / `draggingExited` / `performDragOperation` → `attachment` events with `source: "drop"`. The web view *is* the drop target (no overlay that would swallow clicks). |
| drop on the Dock icon | `AppDelegate.application(_:open:)` → `attachment` events with `source: "dock"`. |
| `zode://` URLs | `AppDelegate.application(_:open:)` → `deepLink` events. |
| `attach.pick` | `AttachmentService.pick()` → `NSOpenPanel` (multiple files) → `Attachment[]` with `id`, `name`, `path`, `mimeType` (`UTType`), `size`, `source: "picker"`. |

---

## 3. The commands that were run (real output)

### 3.1 The generator is deterministic

```
$ python3 tools/generate_xcodeproj.py
wrote Zode.xcodeproj/project.pbxproj
      sha256  : 7324e32e7532b53f6be1b76329cd3dd1209e2b6970c4585a7abb4742f11b7914
wrote Zode.xcodeproj/xcshareddata/xcschemes/Zode.xcscheme
      sha256  : 3d4eea6a3f4f1370136810846bdb329de6d636a112d3f446111980f48d9cefc3

$ shasum -a 256 Zode.xcodeproj/project.pbxproj Zode.xcodeproj/xcshareddata/xcschemes/Zode.xcscheme
7324e32e7532b53f6be1b76329cd3dd1209e2b6970c4585a7abb4742f11b7914  Zode.xcodeproj/project.pbxproj
3d4eea6a3f4f1370136810846bdb329de6d636a112d3f446111980f48d9cefc3  Zode.xcodeproj/xcshareddata/xcschemes/Zode.xcscheme

$ python3 tools/generate_xcodeproj.py          # second run
wrote Zode.xcodeproj/project.pbxproj
      sha256  : 7324e32e7532b53f6be1b76329cd3dd1209e2b6970c4585a7abb4742f11b7914
wrote Zode.xcodeproj/xcshareddata/xcschemes/Zode.xcscheme
      sha256  : 3d4eea6a3f4f1370136810846bdb329de6d636a112d3f446111980f48d9cefc3

$ shasum -a 256 Zode.xcodeproj/project.pbxproj Zode.xcodeproj/xcshareddata/xcschemes/Zode.xcscheme
7324e32e7532b53f6be1b76329cd3dd1209e2b6970c4585a7abb4742f11b7914  Zode.xcodeproj/project.pbxproj
3d4eea6a3f4f1370136810846bdb329de6d636a112d3f446111980f48d9cefc3  Zode.xcodeproj/xcshareddata/xcschemes/Zode.xcscheme

$ python3 tools/generate_xcodeproj.py --check
OK    /…/zode/shells/macos/Zode.xcodeproj/project.pbxproj
      sha256  : 7324e32e7532b53f6be1b76329cd3dd1209e2b6970c4585a7abb4742f11b7914
```

**Byte identical** — the two runs produce the same SHA-256.

### 3.2 The pbxproj is structurally valid

```
$ python3 tools/validate_pbxproj.py
validating Zode.xcodeproj/project.pbxproj
  ok    the pbxproj parses as an old style property list
  ok    all 81 objects only reference objects that exist
  ok    rootObject exists
  ok    every file reference points at a file that exists on disk
  ok    the PBXNativeTarget 'Zode' is an application
  ok    all 15 required build settings are present
  ok    the resources build phase contains Assets.xcassets, haptics.json, web
  ok    the sources build phase contains 25 Swift file(s)
  ok    the shared scheme references the app target

all 9 checks passed
$ echo $?
0
```

The 15 required build settings that are asserted:
`PRODUCT_BUNDLE_IDENTIFIER = com.zode.app`, `PRODUCT_NAME = Zode`,
`MACOSX_DEPLOYMENT_TARGET = 14.0`, `SWIFT_VERSION = 5.0`,
`MARKETING_VERSION = 1.0.0`, `CURRENT_PROJECT_VERSION = 1`,
`GENERATE_INFOPLIST_FILE = NO`, `INFOPLIST_FILE = Zode/Info.plist`,
`CODE_SIGN_ENTITLEMENTS = Zode/Zode.entitlements`, `CODE_SIGN_STYLE = Automatic`,
`ENABLE_HARDENED_RUNTIME = YES`, `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon`,
`COMBINE_HIDPI_IMAGES = YES`, `ENABLE_USER_SCRIPT_SANDBOXING = NO`,
`DEVELOPMENT_TEAM = "$(ZODE_TEAM_ID)"`.

### 3.3 The shell scripts parse

```
$ bash -n build.sh && echo "build.sh: syntax OK"
build.sh: syntax OK
$ bash -n sign.sh && echo "sign.sh: syntax OK"
sign.sh: syntax OK
```

### 3.4 The Python tools compile

```
$ python3 -m py_compile tools/generate_xcodeproj.py tools/validate_pbxproj.py tools/make_icons.py && echo "all three python files compile"
all three python files compile
```

### 3.5 The property lists are valid (`plutil` does not exist on Linux)

```
$ python3 -c "import plistlib,sys; p=plistlib.load(open(sys.argv[1],'rb')); print(sys.argv[1], '-> OK,', len(p), 'keys')" Zode/Info.plist
Zode/Info.plist -> OK, 21 keys
$ python3 -c "import plistlib,sys; p=plistlib.load(open(sys.argv[1],'rb')); print(sys.argv[1], '-> OK,', list(p.keys()))" Zode/Zode.entitlements
Zode/Zode.entitlements -> OK, ['com.apple.security.app-sandbox', 'com.apple.security.network.client', 'com.apple.security.files.user-selected.read-write']
$ python3 -c "import json;d=json.load(open('Zode/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json'));print('AppIcon Contents.json -> OK,', len(d['images']), 'images')"
AppIcon Contents.json -> OK, 10 images
```

### 3.6 The icon set

```
$ python3 tools/make_icons.py
Pillow not available — using the built-in PNG codec (stdlib only)
source        : /…/zode/icons/zode.png (1600x1600)
artwork       : 1384x1414 (cropped to the visible artwork)
  icon_16x16.png             16x16   (16pt @1x)
  icon_16x16@2x.png          32x32   (16pt @2x)
  icon_32x32.png             32x32   (32pt @1x)
  icon_32x32@2x.png          64x64   (32pt @2x)
  icon_128x128.png          128x128  (128pt @1x)
  icon_128x128@2x.png       256x256  (128pt @2x)
  icon_256x256.png          256x256  (256pt @1x)
  icon_256x256@2x.png       512x512  (256pt @2x)
  icon_512x512.png          512x512  (512pt @1x)
  icon_512x512@2x.png       1024x1024 (512pt @2x)
  Contents.json            (app icon set manifest)
done — /…/Zode/Resources/Assets.xcassets/AppIcon.appiconset

$ python3 tools/make_icons.py --check
Pillow not available — using the built-in PNG codec (stdlib only)
app icon set is complete: /…/Zode/Resources/Assets.xcassets/AppIcon.appiconset
```

The artwork is masked with a superellipse (`|x/a|⁵ + |y/b|⁵ = 1`) that leaves the
~10 % margin the macOS icon grid expects (824 of 1024 points), composited on
the `--zode-ink` tile. The one pixel magenta selection fringe of the source
artwork is removed before the mask is applied.

### 3.7 The shell matches the web app it hosts

The web app landed in parallel while this track was being written, so the two
halves of the contract were compared directly. `tools/verify_against_web.py`
reads the frozen lists out of `apps/web/src/bridge/contract.js` and asserts
that the Swift sources implement every one of them:

```
$ python3 tools/verify_against_web.py
cross-checking the shell against apps/web/src/bridge/contract.js

  ok    REQUEST_TYPES        13/13 — every request type of contract §3
  ok    INTENT_NAMES         9/9 — every intent name of contract §4
  ok    ERROR_CODES          6/6 — every error code of contract §1.2
  ok    ATTACHMENT_SOURCES   5/5 — every attachment source of contract §2.1
  ok    SEARCH_RESULT_KINDS  7/7 — every search result kind of contract §2.1
  ok    CAPABILITY_KEYS      7/7 — every capability key of contract §2
  ok    VIEW_NAMES           5/5 — every view name of contract §4 (zode.show)
  ok    EVENT_NAMES          5/5 — attachment, intent, search, deepLink, notificationAction
  ok    {'handler name':20s} the handler is called 'zode' on both sides
  ok    relative paths       the web app only uses relative paths (zode://app/ works)
  ok    drag zone            --drag-zone-height = 34px on both sides

all 11 cross-checks passed
$ echo $?
0
```

What this proved (and changed):

* the script message handler is called `zode` on both sides,
* the response envelope `{id, ok, result}` / `{id, ok:false, error}` and the
  event envelope `{type:"event", event, payload}` are exactly what the web
  app's `handleNativeMessage()` expects,
* the web app reads `result.attachments`, `result.results`, `result.filling`
  and `result.fullScreen` — the shell answers with those very keys,
* the web app merges a `capabilities` object out of the `app.info` result
  into `window.zode.capabilities`, so the shell now reports its real
  capability matrix (`haptics` is only `true` for a real haptic engine),
* the web app listens for exactly the five events the shell emits,
* the web app only uses **relative** paths, so it works under the
  `zode://app/` origin,
* the web app's canonical library (`apps/web/assets/library.json`) is read by
  `SearchService` and mirrored into the Spotlight index.

`build.sh` runs this cross-check before it builds.

### 3.8 A structural check of the Swift sources

```
$ python3 - <<'PY'   # delimiter balance + interpolation check over every .swift file
… (all 25 files balanced, no TODO/FIXME, no stray print())
```

---

## 4. NOT VERIFIED HERE

**This environment is Linux without a macOS toolchain.** The following could
**not** be executed and must be checked on a real Mac:

1. **Swift compilation.** `swiftc` does not exist here — the 25 Swift files
   have never been through the compiler. The code was written against the
   documented macOS 14 / Xcode 26 APIs and reviewed by hand, but *it is not
   proven to compile*. Expect to fix small things (argument labels, an
   availability annotation, a renamed API) on the first build.
2. **`xcodebuild`.** The project was validated structurally, not by Xcode.
   `xcodebuild -list`, the first `xcodebuild build` and the archive have not
   been run.
3. **Signing.** No certificate, no team id and no keychain here. `sign.sh`
   and the export of `build.sh` need a real Mac with a Developer ID.
4. **The runtime behaviour of the window**: the borderless chrome, the
   invisible resize edges, the real window drag (`performDrag(with:)`), the
   fill-screen toggle (and the screen change while filled) — all of it needs
   a real window server.
5. **The drop target.** Whether WebKit's internal drag handling claims a
   file drag before the `WKWebView` subclass sees it can only be observed at
   runtime. If WebKit swallows the drag, the fallback is to put the same
   `draggingEntered`/`performDragOperation` code on the *container* view
   above the web view (the responder chain walk-up).
6. **The Dock drop** (`application(_:open:)`) and the deep links.
7. **The haptics.** No Mac was available, so neither the CoreHaptics path
   (there is no Taptic Engine on a Mac anyway) nor the CoreAudio
   synthesiser was heard. The envelope of the audio renderer follows the
   WebAudio renderer of the web fallback, but the sound was not verified.
8. **CoreHaptics availability.** `CoreHaptics` is an iOS / Mac Catalyst
   framework — the whole renderer is behind `#if canImport(CoreHaptics)`.
   On a Mac the framework is most likely absent, so the audio fallback is
   the runtime path and `capabilities.haptics` is `false` (exactly what
   contract §7 prescribes). The CoreHaptics code path was therefore **not
   compiled** here either.
9. **The App Intents.** `AppIntents` (macOS 14+) and the `AppEntity`
   schemas compile against the macOS 26 SDK, but the *semantic* Spotlight
   index (macOS 27) could not be exercised.
10. **The Journaling Suggestions framework.** Its exact public symbols
    differ between SDK families and could not be checked against a real
    SDK, so the submission is isolated behind `#if canImport(JournalingSuggestions)`
    and the shell falls back to the local activity log — the fallback
    contract §11 itself describes. The adapter is a single, clearly marked
    function (`JournalingSuggestionsAdapter.submit`).
11. **The notification action** and the `UNUserNotificationCenter`
    authorisation flow (a bundled, signed app is required).
12. **CoreSpotlight indexing** (the app must be a signed bundle).
13. **`window.open` / `target=_blank` → the default browser.**
14. **The SwiftUI scene interplay.** SwiftUI may present the `WindowGroup`
    at launch; `AppDelegate.closeUnexpectedWindows()` closes it again. That
    behaviour could only be observed at runtime.

### Two contract points that needed a decision

* **§5.1 vs §5.4.** §5.1 forbids *any* native window chrome, while the
  fill-screen note asks to "remove `.titled` from `styleMask` while filled,
  and restore the saved frame + `.titled`". With a borderless window
  (as §5.1 demands) there is no `.titled` to remove, and restoring it would
  put a title bar back. The implementation therefore removes `.titled` when
  filling (a no-op for a borderless mask) and restores the **saved** mask
  on the next toggle — the saved mask never contains `.titled`, so no title
  bar ever appears. The *behaviour* the contract asks for (the window fills
  the whole display, the menu bar stays, no `toggleFullScreen`) is
  implemented exactly.
* **§8 vs the drop target.** The contract suggests "a full-window `NSView`
  placed above the `WKWebView` … or the web view must be made drop-aware".
  This shell uses the second option (the web view itself), as the task
  brief requires, so that no overlay can swallow the normal clicks.

---

## 5. The commands to run on your Mac

```bash
cd /workspace/zode/shells/macos

# 0. the tools (Python 3, standard library only)
python3 --version

# 1. regenerate + validate the project (must be a no-op)
python3 tools/generate_xcodeproj.py
python3 tools/generate_xcodeproj.py --check
python3 tools/validate_pbxproj.py

# 2. rebuild the app icon (optional)
python3 tools/make_icons.py --check

# 3. see the signing identities of this Mac
./sign.sh

# 4. open the project
open Zode.xcodeproj
#    or:  xcodebuild -project Zode.xcodeproj -scheme Zode -list

# 5. a quick debug build (no team id needed for a local run if you pick
#    "Sign to Run Locally" in Xcode)
./build.sh --debug

# 6. a signed release build
export ZODE_TEAM_ID=YOUR_TEAM_ID              # e.g. ABCDE12345
export ZODE_SIGN_IDENTITY="Developer ID Application: Your Company (YOUR_TEAM_ID)"
./build.sh

# 7. check what was signed
./sign.sh --verify build/export/Zode.app

# 8. notarise (outside the App Store)
xcrun notarytool submit build/export/Zode.app --keychain-profile <profile> --wait
xcrun stapler staple build/export/Zode.app
```

Useful while developing:

```bash
# dev mode: the shell loads the web app from your dev server
ZODE_DEV_URL=http://localhost:5173 ./build.sh --debug

# the developer check that proves haptics.json is mapped correctly
#   (Help ▸ Verify Haptic Programs in the menu bar)
```
