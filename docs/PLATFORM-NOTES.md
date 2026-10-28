# Zode — Platform Notes

Per-platform implementation detail, the honest gaps, and exactly what has and has not been
verified. Read alongside [`packages/shared/contract.md`](../packages/shared/contract.md), which
is the normative spec.

---

## 0. The one thing to understand first

Zode is **one web app** hosted by native shells. The shells are not a port of the app — they are
a *window*, a *bridge*, and a set of *platform integrations*.

```
apps/web/  ──(window.zode)──▶  shells/macos   (WKWebView)
                           ─▶  shells/windows (WebView2)
                           ─▶  mobile/ios, mobile/android  (native re-implementation)
```

The web app never sees a platform transport. It calls `window.zode`, and a thin adapter maps
that onto whichever transport exists. In a browser with no bridge at all, the fallback shim
answers locally and the app is still completely usable.

**Consequence for you:** if you already have a `zune-code` web app, you can point the shells at
its build output instead of `apps/web/` and keep everything else. Set `ZODE_WEB_ROOT` (or replace
the staged `web/` folder) — the shells only require a static directory with an `index.html`.

---

## 1. Why the haptics are defined as data

`packages/shared/haptics.json` describes each program as a list of tracks:

```jsonc
{
  "kind": "continuous",
  "startMs": 0,
  "durationMs": 170,
  "carrierHz": 150,
  "intensity": [[0.0, 0.10], [0.42, 0.95], [0.62, 0.55], [1.0, 0.18]],
  "sharpness": [[0.0, 0.55], [0.42, 0.90], [1.0, 0.45]]
}
```

That maps cleanly onto four different engines without anybody rewriting the waveform:

| Platform | Engine | Mapping |
|---|---|---|
| iOS | `CoreHaptics` | `CHHapticEvent.hapticContinuous` + `CHHapticParameterCurve` control points — a **direct** mapping. |
| macOS | `CoreHaptics` | Same mapping, but `supportsHaptics` is usually `false` → audio fallback. |
| Android | `VibrationEffect.createWaveform` | Curve samples become `(timing, amplitude)` pairs, amplitude = `intensity × 255`. |
| Windows / Web | WebAudio / `waveOut` | Sine oscillator at `carrierHz`, amplitude enveloped by the intensity curve. |

**`done`** is a *triple roll*: three continuous events, each swelling to a peak and falling away.
Each roll is a swell, not a click — that is what makes it read as a "roll".

**`working`** is a *tiny, slow wave*: one continuous track, 2400 ms, intensity oscillating
between 0.02 and 0.20, `loop: true`. It runs for exactly as long as the agent is busy and stops
on `haptic.stop`.

### The honest part

| Platform | Real haptic hardware? | What you actually feel |
|---|---|---|
| iOS / iPadOS | ✅ Taptic Engine | The waveform, as designed. |
| macOS | ❌ no Taptic Engine | The same waveform, synthesised as audio. |
| Windows 11 desktop | ❌ no rich haptics | The same waveform as audio, plus a coarse `IVibrationDevice` pulse where supported. |
| Android | ✅ if the device has a vibrator | The stepped waveform, amplitude-quantised to 8 bits. |
| Browser | ❌ | WebAudio synthesis. |

So `capabilities.haptics` is `true` **only** where a real haptic engine exists. Everywhere else
the shape is preserved through audio, which is a genuine downgrade and is reported as such
rather than papered over.

---

## 2. macOS shell

`shells/macos/` — SwiftUI + AppKit + `WKWebView`, macOS 14+, no third-party dependencies.

### Window

| Rule | Implementation |
|---|---|
| No native controls | `NSWindow` with `.borderless` + `.fullSizeContentView`, `titleVisibility = .hidden`. No traffic lights, no minimise/maximise/close. |
| Resizable anyway | Invisible 8 px resize edges via custom hit testing. |
| Drag zone | `window.dragStart` synthesises an `NSEvent` mouse-down at the reported screen point and calls `window.performDrag(with:)` — a genuine OS-level drag. |
| Double-click fills the screen | Saves the frame, sets it to `NSScreen.frame` (**full display bounds, not `visibleFrame`**), and drops `.titled` from `styleMask` while filled. Toggling restores both. |
| Not OS fullscreen | `toggleFullScreen` is deliberately **not** used — the menu bar stays visible and the Space is not switched. |

### Origin

The bundled web app is served from `zode://app/` via a `WKURLSchemeHandler`, never `file://`.
`ZODE_DEV_URL` (env var or `UserDefaults` key `ZodeDevURL`) points the shell at your dev server.

### Platform integrations

| Feature | API |
|---|---|
| Intents | `AppIntents` — entity schemas feed the Spotlight semantic index; intent schemas drive Siri/Shortcuts. |
| Media control | `MediaIntents` so Siri can drive playback. |
| Search | `CoreSpotlight` (`CSSearchableIndex`) indexes library items. |
| Journal | `JournalingSuggestions` (macOS 27), with a local activity-log fallback. |
| Notifications | `UNUserNotificationCenter`, with a notification action that raises an `intent` event. |
| Dock drop | `application(_:open urls:)` → `attachment` event with `source: "dock"`. |
| Window drop | The `WKWebView` subclass overrides `draggingEntered`/`performDragOperation`, so a drop anywhere over the window — including over web content — is accepted. |

### Signing

```bash
cd shells/macos
./sign.sh                          # lists codesigning identities via `security find-identity`
export ZODE_TEAM_ID=YOUR_TEAM_ID  # your Apple Developer Team ID
./build.sh                         # archive + export
```

`build.sh` runs:

```
xcodebuild -project Zode.xcodeproj -scheme Zode -configuration Release \
  -archivePath build/Zode.xcarchive -destination 'generic/platform=macOS' \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$ZODE_TEAM_ID" -allowProvisioningUpdates archive
```

`-allowProvisioningUpdates` is what lets Xcode use your existing developer profile to
provision the signing identity automatically.

Identity kinds, and when each applies:

| Identity | Use |
|---|---|
| `Developer ID Application` | Distribution outside the Mac App Store. |
| `Mac App Distribution` | Mac App Store. |
| `Apple Development` | Local development only. |

No certificate, team ID, or password is committed to this repository. `DEVELOPMENT_TEAM` is
`$(ZODE_TEAM_ID)` and is supplied from the command line.

---

## 3. Windows shell

`shells/windows/` — C# / .NET 10 / raw Win32 (`P/Invoke`) + **WebView2**. One NuGet package:
`Microsoft.Web.WebView2`.

Win32 rather than WinUI 3 is a deliberate choice: removing the native window controls and
faking a borderless-but-resizable window is far more reliable with `WM_NCCALCSIZE` and
`WM_NCHITTEST` than with any higher-level framework.

### Window

| Rule | Implementation |
|---|---|
| No native controls | `CreateWindowEx` with `WS_POPUP | WS_THICKFRAME | WS_CLIPCHILDREN`; `WM_NCCALCSIZE` returns `0`, which removes the whole non-client area — caption, buttons and all. |
| Resize anyway | `WM_NCHITTEST` returns `HTLEFT`/`HTRIGHT`/… for an invisible 8 px edge band. |
| Drag zone | `window.dragStart` → `ReleaseCapture()` + `SendMessage(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0)` — the canonical OS-level window drag. |
| Double-click fills the screen | `SetWindowPos` to the **full monitor bounds** (not the work area) with `SWP_NOACTIVATE`; the previous `WINDOWPLACEMENT` is saved and restored. |
| Not OS fullscreen | The taskbar stays visible — this is a window that fills the display, not a fullscreen app. |

### Origin

`SetVirtualHostNameToFolderMapping("app.zode.local", webRoot, DENY_CORS)` and navigation to
`https://app.zode.local/index.html`. `ZODE_DEV_URL` overrides it for development.

### Platform integrations

| Feature | API | Caveat |
|---|---|---|
| Notifications | `Windows.UI.Notifications` | An **unpackaged** app must register an `AppUserModelID` and create a Start Menu shortcut, or notifications silently fail. `AppIdentity.cs` does both. The activation comes back through the `zode://notification` protocol. |
| Intents | App Actions (`msix/appactions.json`) | Requires **package identity** → MSIX. |
| Search | App Content Search (Windows App SDK 2.5.1) | Also MSIX-only. A protocol handler (`zode://search?q=…`) is the fallback that works unpackaged. |
| Journal | — | **Windows has no system journal.** `journal.write` resolves successfully and appends to `%LOCALAPPDATA%\Zode\journal.jsonl`. |
| Taskbar drop / recent files | `ICustomDestinationList` (Jump List) + taskbar `IDropTarget` | The Windows analogue of the macOS dock drop. |
| Window drop | `IDropTarget` + `RegisterDragDrop`, `CF_HDROP` via `DragQueryFileW` | Covers the whole window. |

### Signing

**No certificate is required for the default build.** `build.ps1` produces an unpackaged
`dotnet publish` output that runs as-is. `build-msix.ps1` produces the packaged variant — that
path *does* want a certificate, and is the only path that unlocks App Actions and App Content
Search.

---

## 4. iOS client

`mobile/ios/` — SwiftUI, iOS 17+, no third-party dependencies.

The same five views (Now Playing, Collection, Library, Search, Agent), the same seeded library,
the same intent names, and the same haptic programs as the web app — but with the Metro visual
language sized for a phone: square tiles with **zero** corner radius, flat fills, light-weight
large display type, uppercase tracked labels, and a horizontal collection carousel.

Real `CoreHaptics` here — iOS has a genuine Taptic Engine, so `capabilities.haptics` is `true`
and `working` uses `CHHapticAdvancedPatternPlayer` with `loopEnabled`.

`AppIntents` + `MediaIntents` + `CoreSpotlight` + local notifications, with `zode://` deep-link
routing.

---

## 5. Android client

`mobile/android/` — Kotlin, Jetpack Compose, `compileSdk`/`targetSdk` 36, `minSdk` 26, AGP 8.x,
Gradle Kotlin DSL. No UI libraries beyond Compose itself — no DI framework, no image loader.

**This client is compiled and assembles.** `./gradlew :app:assembleDebug` produces a real APK
against JDK 17 + Android SDK 36 + Gradle 8.11.1.

Haptics use `VibrationEffect.createWaveform`, with the intensity curve mapped to
`(timing, intensity × 255)` amplitude pairs and `working` set to loop indefinitely.
`Vibrator.hasVibrator()` decides whether `capabilities.haptics` is `true`.

> **Android cannot layer two arbitrary waveforms.** `VibrationEffect.Composition` only composes
> the built-in *primitives* (`CLICK`, `TICK`, …), and `Vibrator` has no `compose` at all. So
> every track of a program is merged onto **one** timeline and emitted as a single waveform,
> and a one-shot that arrives while the `working` loop is running replaces the loop and then
> resumes it afterwards. The shape survives; true polyphony is not possible.

Intents are handled through `AppSearch` / `ACTION_SEARCH`, `ACTION_SEND` (the share sheet),
`ACTION_VIEW` on `zode://` links, and a `NotificationManager` channel.

> **The `gradle-wrapper.jar` is committed**, so `./gradlew` works from a fresh clone with no
> extra setup. It was produced by `gradle wrapper --gradle-version 8.11.1` — not fabricated.
> `local.properties` is gitignored, because it points at your SDK.


---

## 6. What is verified, and what is not

### Verified in this repository

- The **Android client compiles and assembles** — a real APK, built against JDK 17, Android SDK
  36 and Gradle 8.11.1.
- Every JavaScript module in `apps/web` parses.
- `apps/web/selfcheck.mjs` asserts the full `window.zode` surface, every request type, and
  every intent name.
- The dev server serves the app and every asset it references.
- The web app was **rendered in headless Chromium** (`scripts/shoot-web.mjs`): all five views
  render with no console errors, and the drag strip measures exactly 34 px.
- No bare-specifier imports anywhere in `apps/web/src` — the shells can bundle it verbatim.
- The generated Xcode projects are structurally valid and **byte-deterministic**.
- The haptic programs parse, `done` really has three tracks, and `working` really loops.
- `Info.plist` / `Zode.entitlements` parse as plists.
- The MSIX manifest and `appactions.json` are valid XML/JSON and cover every intent.
- The Windows shell passes 57/57 static checks plus a cross-check against the web app.
- The macOS shell passes a structural audit plus a contract cross-check.
- `packages/shared/library.json` is byte-identical across the web app, iOS and Android.
- Icons regenerate byte-identically.
- No credential material is committed.


### Verified in CI, on real runners

`.github/workflows/ci.yml` runs on genuine macOS, Windows, and Android machines and therefore
does what this environment cannot:

- `xcodebuild` actually **compiles** the macOS shell.
- `dotnet build` actually **compiles** the Windows shell.
- `xcodebuild` actually **compiles** the iOS client for the simulator.
- `./gradlew :app:assembleDebug` actually **assembles** the Android APK.
- `swiftc -parse` runs over every Swift source.

### Not verified anywhere yet — needs a human with the hardware

- **Runtime window behaviour.** That the drag strip actually moves the window with the right
  feel, that double-click really fills the display, that nothing below the strip moves the
  window. This is behaviour only a human can confirm.
- **Audio/visual output of the haptics.** The waveforms are correct *as data*; whether the
  triple roll *sounds* like a triple roll needs ears.
- **Dock / taskbar drop.** Whether dragging a file onto the Dock icon really delivers an
  attachment.
- **Signing.** The macOS archive has never been signed with a real developer profile.
- **Siri, Spotlight, App Actions, and the Journal integration** end to end.

---

## 7. Adding a new platform

1. Read `packages/shared/contract.md`. It is the whole spec.
2. Implement the §2 surface, the §3 request table, the §4 intents, and the §5 window rules.
3. Render `packages/shared/haptics.json` with whatever engine you have.
4. Add a validator under `tools/` and wire it into `.github/workflows/ci.yml`.
5. Ship a `deliverable.md` that separates *verified* from *not verified*.

Do not extend the contract in place — bump `version` and update every platform at once.

---

## 8. Android API notes

Three SDK surfaces the Android client relies on were **removed** in recent API levels. The
compiler is the only thing that catches these, which is why the Android client is built rather
than merely written:

| Removed | Replacement | Why it matters |
|---|---|---|
| `android.content.SearchRecentSuggestions` | `android.provider.SearchRecentSuggestions` | The class moved packages; the old import no longer resolves. |
| `SearchManager.ACTION_SEARCH` | `Intent.ACTION_SEARCH` | The constant was dropped from `android.app.SearchManager`. |
| `SearchManager.SUGGEST_QUERY_PARAMETER` | the literal `"query"` | Same — the constant is gone; the system still passes the text that way. |
| `SearchableInfo(XmlResourceParser)` | `SearchManager.getSearchableInfo(ComponentName)` | The public constructor was removed; only a package-private no-arg one remains. |
| `NotificationManager.notify(String, Notification)` | `notify(Int, Notification)` | The String overload was removed in API 33. |

And one thing that was never there: **`Vibrator` has no `compose`**, and
`VibrationEffect.Composition` only composes built-in primitives. See §5.

If you add a platform, expect the same: a static audit is not a compiler.
