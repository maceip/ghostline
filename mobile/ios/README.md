# Zode — iOS client

The same app as the web version, in SwiftUI, with a pre-2011 **Metro** look:
square tiles with zero corner radius, flat fills, a near-black or warm-paper canvas,
light-weight large display type, uppercase tracked labels, and a horizontal collection
carousel.

Five views — **Now Playing**, **Collection**, **Library**, **Search**, **Agent** — with
the same intents and the same haptic programs as every other Zode surface.

## Build

```bash
open ZodeMobile.xcodeproj      # then ⌘R
```

Or from the command line:

```bash
xcodebuild \
  -project ZodeMobile.xcodeproj \
  -scheme ZodeMobile \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

The Xcode project is **generated**, not hand-written:

```bash
python3 tools/generate_xcodeproj.py     # deterministic — re-runs produce identical output
python3 tools/validate_pbxproj.py       # structural validation
```

### Signing

`DEVELOPMENT_TEAM` is `$(ZODE_TEAM_ID)`, so no team ID is committed. Supply yours:

```bash
export ZODE_TEAM_ID=YOUR_TEAM_ID
xcodebuild -project ZodeMobile.xcodeproj -scheme ZodeMobile \
  -destination 'generic/platform=iOS' \
  DEVELOPMENT_TEAM="$ZODE_TEAM_ID" -allowProvisioningUpdates archive
```

## Toolchain

| | |
|---|---|
| Language | Swift 5.9 / Swift 6 |
| UI | SwiftUI |
| Deployment target | iOS 17.0 |
| Dependencies | none — Apple frameworks only |

## Where things live

```
ZodeMobile/
  App/          the @main entry point, app state, the router
  Views/        the five views
  Design/       Metro theme, tiles, reveal transition, generated tokens
  Haptics/      CoreHaptics rendering of the shared programs
  Model/        the shared data model
  Data/         the canonical library, the agent engine
  Platform/     App Intents, Spotlight, notifications, journaling, deep links
  Resources/    Info.plist, the asset catalog, haptics.json, library.json
```

## The shared files

`Resources/haptics.json` and `Resources/library.json` are **byte-identical copies** of
`packages/shared/haptics.json` and `packages/shared/library.json`. The library is
generated from the web app, so this client presents exactly the same records as
`apps/web` — it never invents its own catalogue.

```bash
python3 ../../scripts/export_library.py           # republish
python3 ../../scripts/export_library.py --check   # verify every copy agrees
```

## Haptics

`packages/shared/haptics.json` is rendered with **CoreHaptics** — a real Taptic Engine.
Each track becomes a `CHHapticEvent` (`.hapticContinuous` or `.hapticTransient`) and
each intensity/sharpness curve becomes a `CHHapticParameterCurve` with control points.
`working` uses a `CHHapticAdvancedPatternPlayer` with `loopEnabled = true`.

`capabilities.haptics` is reported as `true` here — iOS has genuine haptic hardware.

## Intents

`AppIntents` expose the library to Siri, Shortcuts and Spotlight (`zode.search`,
`zode.play`, `zode.pause`, `zode.next`, `zode.previous`, `zode.agent.newTask`,
`zode.agent.stop`, `zode.show`), `MediaIntents` let Siri drive playback, `CoreSpotlight`
indexes the library, and the `zode://` deep-link scheme routes into the app.

## Verify it

```bash
python3 tools/validate_pbxproj.py
python3 tools/verify_swift.py
```

## Not verified here

The project **compiles in CI** on a macOS runner (`.github/workflows/ci.yml`). What has
*not* been confirmed on hardware is the runtime behaviour: how the haptics actually
feel, the Spotlight and Siri integrations end to end, and the Journal contribution.
