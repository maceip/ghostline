# Zode — Windows native shell — deliverable

> **Status: implemented, statically verified, NOT compiled.**  The environment
> this track was written in is a Linux sandbox without the .NET SDK, so the
> C# could not be compiled or run here.  Everything that *can* be checked
> without a Windows machine was checked and the real output is pasted below.
> See [NOT VERIFIED HERE](#not-verified-here).

---

## 1. Summary

A native Windows shell for Zode: a **borderless Win32 window** (no caption, no
min/max/close) that hosts the web app in **Edge WebView2** from the virtual
host `https://app.zode.local`, with a 34 px native drag strip, an 8 px
invisible resize border, a "fill the screen" (not real fullscreen) mode, a
full implementation of the frozen bridge contract (§1 envelope, §2 API, §3
request types), the canonical haptics rendered as audio through `winmm`
(no hard coded waveforms), file drops accepted anywhere on the window,
`IFileOpenDialog` picking, `AppUserModelID` + Start Menu shortcut for
unpackaged toasts, `zode://` deep links, an MSIX manifest with one App Action
per contract intent, and a local journal.

**38 C# files, 5 546 lines, one NuGet package (`Microsoft.Web.WebView2`), no
WinUI 3 / WPF / WinForms.**  57/57 static checks and 7/7 cross-checks against
the web app's contract module pass.

---

## 2. Files created

Everything lives under `shells/windows/`.  Nothing outside that directory was
written (`packages/shared/**` and `apps/web/**` were only *read*).

### 2.1 Project & build

| File | Purpose |
|---|---|
| `Zode.Shell/Zode.Shell.csproj` | `net10.0-windows10.0.26100.0`, `WinExe`, `UseWindowsForms=false`, nullable+implicit usings, `ApplicationManifest`, **one** `PackageReference` (WebView2), embeds `packages/shared/haptics.json`. |
| `Zode.Shell/app.manifest` | `dpiAwareness = PerMonitorV2`, `requestedExecutionLevel = asInvoker`, supported-OS GUIDs. |
| `Zode.Shell.sln` | Valid VS 2022 solution referencing `Zode.Shell`, x64 + ARM64 configurations. |
| `build.ps1` | Unpackaged build: `dotnet publish -c Release -r win-x64/win-arm64`, copies the web app into `<out>/web/`, **fails with a clear message when the web app is missing**. |
| `build-msix.ps1` | Packaged build: publishes, stages the appx assets, `MakeAppx`, optional `SignTool`; documents that the unpackaged build needs no certificate while MSIX does. |
| `icons/zode.ico` | 16/32/48/64/128/256 px 32-bit entries, generated from `icons/zode.png`. |
| `tools/make_ico.py` | Stdlib-only PNG→ICO converter (Pillow is not installed here) — decodes the PNG by hand, box-filter resamples, writes the ICO. |
| `tools/verify_shell.py` | Static verification of this shell against the frozen contract (57 checks). |
| `tools/verify_against_web.mjs` | Cross-implementation check: compares the constants of the C# shell with the canonical lists of the web app (`apps/web/src/bridge/contract.js`) — 7 checks, runnable without Windows. |
| `README.md` | Architecture, build instructions, contract mapping, honest gaps. |
| `deliverable.md` | This file. |

### 2.2 C# — entry points

| File | Purpose |
|---|---|
| `Zode.Shell/Program.cs` | Entry point: OLE init, single-instance guard, protocol self-registration, runs the shell. |
| `Zode.Shell/ShellApplication.cs` | Composition root: window → services → bridge → webview; routes drops, deep links and notification actions. |
| `Zode.Shell/SingleInstanceGuard.cs` | Mutex + named pipe: a second launch forwards its command line (deep link) to the running instance. |

### 2.3 C# — native layer

| File | Purpose |
|---|---|
| `Zode.Shell/Native/NativeMethods.cs` | user32: window class, `CreateWindowEx`, message loop, `WM_NCCALCSIZE`/`WM_NCHITTEST` helpers, `SetWindowPos`, monitor/placement APIs, window subclassing. |
| `Zode.Shell/Native/WindowConstants.cs` | Win32 constants (styles, messages, hit-test codes, `SetWindowPos` flags). |
| `Zode.Shell/Native/Shell32.cs` | AUMID, `CF_HDROP`/`DragQueryFileW`, `SHAddToRecentDocs`. |
| `Zode.Shell/Native/Ole32.cs` | `CoCreateInstance`, `RegisterDragDrop`/`RevokeDragDrop`, `ReleaseStgMedium`, `CoTaskMemFree`. |
| `Zode.Shell/Native/WinMm.cs` | `waveOut*` entry points + hand-written `WAVEFORMATEX`/`WAVEHDR` layouts. |
| `Zode.Shell/Native/Propsys.cs` | `PSGetPropertyStoreFromShellLink` (writes the AUMID into the .lnk), `PSCoCreatePropertyStore`. |
| `Zode.Shell/Native/UiDispatcher.cs` | `SynchronizationContext` that marshals work onto the UI thread via `WM_APP_DISPATCH`. |
| `Zode.Shell/Native/WindowSubclass.cs` | Minimal WndProc subclassing helper (used for the WebView2 child). |
| `Zode.Shell/Diagnostics/Log.cs` | File logger (`%LOCALAPPDATA%\Zode\logs\zode-shell.log`). |

### 2.4 C# — window

| File | Purpose |
|---|---|
| `Zode.Shell/Windowing/ShellWindow.cs` | The borderless window: `WS_POPUP|WS_THICKFRAME|WS_CLIPCHILDREN`, `WM_NCCALCSIZE → 0`, invisible resize border + drag strip hit testing, native window drag, DPI handling, `DRAG_ZONE_HEIGHT = 34`. |
| `Zode.Shell/Windowing/FillScreenController.cs` | "Fill the screen with this app window": `MonitorFromWindow` + `GetMonitorInfo` → `SetWindowPos` to the **entire monitor bounds** with `SWP_NOACTIVATE`; saves/restores the `WINDOWPLACEMENT`. |

### 2.5 C# — webview & bridge

| File | Purpose |
|---|---|
| `Zode.Shell/Web/WebViewHost.cs` | WebView2 environment/controller, virtual host mapping, `ZODE_DEV_URL` override, message plumbing, `window.__zodeNative__` events, external navigation → system browser, `NewWindowRequested` → browser, `DragStarting` → native drop handling, child-window subclassing for the resize border. |
| `Zode.Shell/Bridge/BridgeProtocol.cs` | The §1.2 envelope: request parsing, success/failure responses, events, error codes, payload helpers. |
| `Zode.Shell/Bridge/BridgeDispatcher.cs` | The router for **all 13** request types of §3 + the §2 capability flags. |
| `Zode.Shell/Bridge/BridgeEventSink.cs` | The `Emit` interface the WebView2 host implements. |

### 2.6 C# — haptics

| File | Purpose |
|---|---|
| `Zode.Shell/Haptics/HapticModels.cs` | Model of `haptics.json` (programs, tracks, intensity/sharpness curves with linear interpolation). |
| `Zode.Shell/Haptics/HapticLibrary.cs` | Loads the **embedded** `packages/shared/haptics.json` (fallback: the file next to the exe). |
| `Zode.Shell/Haptics/WaveformSynthesizer.cs` | Renders a program to a PCM `float[]` (sine carrier at `carrierHz`, amplitude from the intensity curve). |
| `Zode.Shell/Haptics/WaveOutPlayer.cs` | Plays that buffer through `winmm` `waveOut*` (P/Invoke only), with `WHDR_LOOP` for the looping `working` program. |
| `Zode.Shell/Haptics/HapticService.cs` | `haptic.play` / `haptic.stop`, one player per program, reports `capabilities.haptics = false`. |
| `Zode.Shell/Haptics/VibrationService.cs` | Secondary path: `IVibrationDevice` / `SimpleHapticsController` pulse at the program's peak intensity. |

### 2.7 C# — attachments

| File | Purpose |
|---|---|
| `Zode.Shell/Attachments/Attachment.cs` | The `Attachment` shape of §2.1 + per-session ids. |
| `Zode.Shell/Attachments/AttachmentFactory.cs` | Builds attachments from paths (name, size, best-effort mime type). |
| `Zode.Shell/Attachments/DataObjectReader.cs` | Reads the `CF_HDROP` file list out of an `IDataObject` (hand-written `FORMATETC`/`STGMEDIUM`). |
| `Zode.Shell/Attachments/FileDropTarget.cs` | The `IDropTarget` implementation (`DragEnter`/`DragOver`/`DragLeave`/`Drop`) + `RegisterDragDrop` helper. |
| `Zode.Shell/Attachments/FilePicker.cs` | `attach.pick` via `IFileOpenDialog` (multi-select), with an `IFileDialog` fallback. |

### 2.8 C# — Windows 11 platform

| File | Purpose |
|---|---|
| `Zode.Shell/Platform/AppIdentity.cs` | AUMID + per-user Start Menu shortcut (`IShellLink` + `IPersistFile` + `System.AppUserModel.ID`) — the precondition for unpackaged toasts. |
| `Zode.Shell/Platform/NotificationService.cs` | `Windows.UI.Notifications` toasts; the `notificationAction` event arrives through the `zode://notification` protocol. |
| `Zode.Shell/Platform/IntentService.cs` | The nine contract §4 intents: `intent.perform` and external activation. |
| `Zode.Shell/Platform/ProtocolActivation.cs` | `zode://` deep links → `deepLink` / `search` / `intent` events; optional per-user protocol registration. |
| `Zode.Shell/Platform/SearchService.cs` | `search.query` over the local index + the MSIX-only `ZODE_APP_CONTENT_SEARCH` code path. |
| `Zode.Shell/Platform/JournalService.cs` | The local activity log `%LOCALAPPDATA%\Zode\journal.jsonl` (contract §11). |
| `Zode.Shell/Platform/JumpListService.cs` | Jump List: `SHAddToRecentDocs` + `ICustomDestinationList` custom task. |
| `Zode.Shell/Platform/SystemInfo.cs` | `app.info`: version, build, platform, device model. |

### 2.9 C# — COM interop

| File | Purpose |
|---|---|
| `Zode.Shell/Interop/ComInterfaces.cs` | Hand-written vtables: `IDataObject`, `IDropTarget`, `IShellItem`, `IShellItemArray`, `IFileDialog`, `IFileOpenDialog`, `IShellLinkW`, `IPersistFile`, `IPropertyStore`, `IObjectCollection`, `ICustomDestinationList` + the well-known CLSIDs/IIDs. |

### 2.10 MSIX

| File | Purpose |
|---|---|
| `msix/Package.appxmanifest` | Package identity, `windows.appActions` extension, `windows.protocol` (`zode://`), `windows.appExecutionAlias` (`zode.exe`), appx assets. |
| `msix/appactions.json` | One App Action per contract §4 intent (`zode.search`, `zode.play`, `zode.pause`, `zode.next`, `zode.previous`, `zode.agent.newTask`, `zode.agent.stop`, `zode.attach`, `zode.show`). |

---

## 3. Contract checklist

### §2 — canonical JS API

| Contract member | Implemented by |
|---|---|
| `platform` | `BridgeDispatcher.Dispatch`/`app.info` → `Platform/SystemInfo.Describe()` returns `platform: "windows"` |
| `version` | the web adapter owns it; the shell exposes `app.info.version` (`Platform/SystemInfo.Describe()`) |
| `capabilities.haptics` | `BridgeDispatcher.DescribeCapabilities()` → **false** (no haptic engine; §7) |
| `capabilities.attachments` | `BridgeDispatcher.DescribeCapabilities()` → `true` (§8) |
| `capabilities.notifications` | `BridgeDispatcher.DescribeCapabilities()` → `NotificationService.IsSupported` (§9) |
| `capabilities.intents` | `BridgeDispatcher.DescribeCapabilities()` → `true` (§4) |
| `capabilities.journal` | `BridgeDispatcher.DescribeCapabilities()` → `true` (§11) |
| `capabilities.search` | `BridgeDispatcher.DescribeCapabilities()` → `true` (§10, protocol fallback) |
| `capabilities.windowControl` | `BridgeDispatcher.DescribeCapabilities()` → `true` (§5) |
| `haptic()` / `hapticStop()` | `BridgeDispatcher.HapticPlay`/`HapticStop` → `Haptics/HapticService.Play`/`Stop` |
| `attach()` | `BridgeDispatcher.AttachPick` → `Attachments/FilePicker.PickFiles` |
| `onAttachment()` | `Web/WebViewHost.Emit` → `EventNames.Attachment` (from `ShellApplication.OnFilesDropped` and the picker) |
| `notify()` | `BridgeDispatcher.NotifyPost` → `Platform/NotificationService.Post` |
| `onNotificationAction()` | `Platform/NotificationService.OnNotificationInvoked` → `EventNames.NotificationAction` |
| `performIntent()` | `BridgeDispatcher.IntentPerform` → `Platform/IntentService.Perform` |
| `onIntent()` | `Platform/IntentService.RaiseExternal` → `EventNames.Intent` |
| `journal()` | `BridgeDispatcher.JournalWrite` → `Platform/JournalService.Write` |
| `search()` | `BridgeDispatcher.SearchQuery` → `Platform/SearchService.Query` |
| `onSearch()` | `Platform/ProtocolActivation.Handle` → `EventNames.Search` |
| `window.dragStart()` | `BridgeDispatcher.WindowDragStart` → `Windowing/ShellWindow.BeginDrag` |
| `window.toggleFillScreen()` | `BridgeDispatcher.WindowToggleFill` → `Windowing/ShellWindow.ToggleFillScreen` → `FillScreenController.Toggle` |
| `window.setFullScreen()` / `isFullScreen()` | `BridgeDispatcher.WindowSetFullScreen`/`WindowIsFullScreen` → `ShellWindow.SetFullScreen`/`IsFullScreen` (fill semantics, never real fullscreen) |
| `onDeepLink()` | `Platform/ProtocolActivation.Handle` → `EventNames.DeepLink` |
| `openPath()` | `BridgeDispatcher.AppOpenPath` → `Process.Start(UseShellExecute = true)` |
| `on*` returns an unsubscribe fn | the adapter owns the listeners (web side); the shell only emits (§2.2 "a native event with no listener is dropped") |

### §3 — request types (all 13)

| Request type | Handler | Result |
|---|---|---|
| `haptic.play` | `BridgeDispatcher.HapticPlay` → `HapticService.Play` | `{}` |
| `haptic.stop` | `BridgeDispatcher.HapticStop` → `HapticService.Stop` | `{}` |
| `attach.pick` | `BridgeDispatcher.AttachPick` → `FilePicker.PickFiles` | `{ attachments: Attachment[] }` |
| `notify.post` | `BridgeDispatcher.NotifyPost` → `NotificationService.Post` | `{}` |
| `intent.perform` | `BridgeDispatcher.IntentPerform` → `IntentService.Perform` | `IntentResult` |
| `journal.write` | `BridgeDispatcher.JournalWrite` → `JournalService.Write` | `{}` |
| `search.query` | `BridgeDispatcher.SearchQuery` → `SearchService.Query` | `{ results: SearchResult[] }` |
| `window.dragStart` | `BridgeDispatcher.WindowDragStart` → `ShellWindow.BeginDrag` | `{}` |
| `window.toggleFill` | `BridgeDispatcher.WindowToggleFill` → `FillScreenController.Toggle` | `{ filling: boolean }` |
| `window.setFullScreen` | `BridgeDispatcher.WindowSetFullScreen` → `ShellWindow.SetFullScreen` | `{}` |
| `window.isFullScreen` | `BridgeDispatcher.WindowIsFullScreen` → `ShellWindow.IsFullScreen` | `{ fullScreen: boolean }` |
| `app.openPath` | `BridgeDispatcher.AppOpenPath` | `{}` |
| `app.info` | `BridgeDispatcher.AppInfo` → `SystemInfo.Describe` | `{ version, build, platform, deviceModel }` |

### §4 — intents

| Intent | Windows mechanism |
|---|---|
| `zode.search` | App Action (`msix/appactions.json`) → `zode://search?q=` → `ProtocolActivation.Handle` → `search` event; also `IntentService.Perform` |
| `zode.play` | App Action → `zode://play/{id}` → `ProtocolActivation.Handle` → `IntentService.RaiseExternal` |
| `zode.pause` / `zode.next` / `zode.previous` | App Actions → `zode://pause|next|previous` → same path |
| `zode.agent.newTask` | App Action → `zode://agent/newTask?prompt=` |
| `zode.agent.stop` | App Action → `zode://agent/stop` |
| `zode.attach` | App Action → `zode://attach/{path}`; the file-drop path emits `attachment` events instead |
| `zode.show` | App Action → `zode://show/{view}` |

### §5 — window chrome

| Rule | Implementation |
|---|---|
| no native controls | `ShellWindow` ctor (`WS_POPUP|WS_THICKFRAME|WS_CLIPCHILDREN`) + `WndProc` `WM_NCCALCSIZE → 0` |
| web content owns the window | no background brush, `WM_ERASEBKGND → 1`, WebView2 child covers the client area |
| drag strip = 34 px | `ShellWindow.DRAG_ZONE_HEIGHT = 34`; the page raises `window.dragStart` → `ShellWindow.BeginDrag` = `ReleaseCapture()` + `SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)` |
| double click fills the screen | `window.toggleFill` → `FillScreenController.Fill` (`SetWindowPos` to the whole monitor, `SWP_NOACTIVATE`, `WINDOWPLACEMENT` saved/restored, `MonitorFromWindow`+`GetMonitorInfo`) — **not** a real fullscreen |
| only the strip drags | `ShellWindow.HitTest` returns `HTCAPTION` for the strip only (parent) / `HTCLIENT` (child) |
| invisible resize border | `ShellWindow.HitTest` → `HTLEFT/HTRIGHT/HTTOP/HTBOTTOM/HT*` for an 8 px band, on the parent **and** on the WebView2 child (`WebViewHost.ChildWindowProc`) |

### §7 — haptics

| Rule | Implementation |
|---|---|
| programs come from `packages/shared/haptics.json` | `Haptics/HapticLibrary.Load()` (embedded resource) — no waveform in C# |
| `done` (triple roll) and `working` (tiny slow wave) are recognisably different | the intensity curve drives the amplitude, the carrier frequency drives the timbre (`WaveformSynthesizer`) |
| `working` loops until stopped | `HapticService.Play` → `WaveOutPlayer` with `WHDR_LOOP`; `haptic.stop` → `WaveOutPlayer.Stop` (clears the flag, `waveOutReset`) |
| no rich haptic API on Windows | `VibrationService` fires a coarse `IVibrationDevice` pulse at the peak intensity; `capabilities.haptics = false` |

### §8 — drop & dock

| Rule | Implementation |
|---|---|
| drop anywhere on the window | `WebViewHost.OnDragStarting` (`AllowExternalDrop = false` → the webview path covers the web content) **plus** `Attachments/FileDropTarget` registered on the WebView2 child HWND with `RegisterDragDrop` |
| `CF_HDROP` + `DragQueryFileW` | `Attachments/DataObjectReader.GetFilePaths` |
| one `attachment` event per file, `source: "drop"` | `ShellApplication.OnFilesDropped` → `EventNames.Attachment` + toast + jump list + search index |
| taskbar / jump list (the dock equivalent) | `Platform/JumpListService` (AUMID + shortcut + `SHAddToRecentDocs` + `ICustomDestinationList`) |
| `attach.pick` → `IFileOpenDialog`, multi-select, `source: "picker"` | `Attachments/FilePicker` |

### §9 — notifications

`Windows.UI.Notifications` in `Platform/NotificationService`; the unpackaged
preconditions (AppUserModelID + Start Menu shortcut with
`System.AppUserModel.ID`) are implemented in `Platform/AppIdentity`.  The
activation comes back as a `zode://notification` URI, which
`Platform/ProtocolActivation` routes to the `notificationAction` event.

### §10 — system search

`Platform/SearchService`: the App Content Search path is behind the
`ZODE_APP_CONTENT_SEARCH` compile constant (the API is in limited access and
requires package identity), the working fallback is the `zode://search?q=…`
protocol handler declared in `msix/Package.appxmanifest` →
`Platform/ProtocolActivation.Handle` → `search` event.

### §11 — journal

`Platform/JournalService.Write` appends to
`%LOCALAPPDATA%\Zode\journal.jsonl`; `journal.write` resolves successfully.
**The entry never reaches the OS** — Windows has no system journal.  This gap
is documented in `README.md` §9.

---

## 4. Commands that were run (real output)

The sandbox is Linux, `.NET` is not installed, so the verification is static.

### 4.1 Toolchain

```
$ which dotnet
(not found: exit 1)

$ dotnet --version
/bin/bash: line 1: dotnet: command not found
dotnet: command not found

$ python3 --version
Python 3.11.2
```

### 4.2 Static verification — `python3 tools/verify_shell.py`

```
Zode — Windows shell static verification
repository: /run/csi/mount-root/nas/eab0d61a99b6696edb3d2aff87b585e8/zode
------------------------------------------------------------------------
[PASS] contract §3 request types parsed — 14 types
[PASS] contract §4 intent names parsed — 10 intents
[PASS] every contract §3 request type is implemented — 14 types found
[PASS] RequestTypes constants match the contract — 13/13
[PASS] every request type is routed by BridgeDispatcher — all routed
[PASS] no third-party using directives — only System / Microsoft.Web.WebView2 / Windows / Zode
[PASS] exactly one NuGet package reference — Microsoft.Web.WebView2
[PASS] no unexpected framework references — none
[PASS] Zode.Shell.csproj parses as XML
[PASS] target framework — net10.0-windows10.0.26100.0
[PASS] UseWindowsForms is false
[PASS] OutputType is WinExe
[PASS] nullable is enabled
[PASS] implicit usings are enabled
[PASS] app.manifest is embedded
[PASS] app.manifest exists
[PASS] app.manifest parses as XML
[PASS] app.manifest requests PerMonitorV2
[PASS] app.manifest requests asInvoker
[PASS] every file referenced by the csproj exists — 3 references resolved
[PASS] Zode.Shell.sln header — Microsoft Visual Studio Solution File, Format Version 12.00
[PASS] Zode.Shell.sln declares a project — 1 project(s)
[PASS] the solution references Zode.Shell — Zode.Shell
[PASS] the solution project paths exist — Zode.Shell\Zode.Shell.csproj
[PASS] the solution declares build configurations — 8 configuration lines
[PASS] msix/Package.appxmanifest parses as XML
[PASS] the manifest declares the appActions extension
[PASS] the manifest declares the zode:// protocol
[PASS] the manifest declares the execution alias
[PASS] the manifest points at appactions.json
[PASS] msix/appactions.json parses as JSON
[PASS] every contract §4 intent is an App Action — 9 actions
[PASS] DRAG_ZONE_HEIGHT is 34 (contract §5)
[PASS] the window uses WS_POPUP | WS_THICKFRAME | WS_CLIPCHILDREN
[PASS] WM_NCCALCSIZE is handled
[PASS] the native window drag (ReleaseCapture + WM_NCLBUTTONDOWN) is implemented
[PASS] the fill-screen path uses SetWindowPos + MonitorFromWindow/GetMonitorInfo
[PASS] the previous WINDOWPLACEMENT is saved and restored
[PASS] the shell never enters real fullscreen (no SetWindowDisplayAffinity)
[PASS] the haptics are rendered through winmm waveOut
[PASS] the haptic programs are read from the shared package
[PASS] the secondary IVibrationDevice path is implemented
[PASS] IDropTarget is registered with RegisterDragDrop
[PASS] dropped files are read with DragQueryFileW
[PASS] attach.pick uses IFileOpenDialog
[PASS] notifications use AppNotificationManager
[PASS] an AppUserModelID is registered
[PASS] a Start Menu shortcut is created
[PASS] the Jump List uses ICustomDestinationList
[PASS] the journal writes a local activity log
[PASS] the csproj takes haptics.json from packages/shared
[PASS] packages/shared/haptics.json exists
[PASS] the canonical 'done' and 'working' programs exist
[PASS] the 'working' program loops (contract §7)
[PASS] every C# file has balanced braces/parens/brackets — 38 files
[PASS] every 'using Zode…' namespace exists in the project — 9 namespaces resolved
[PASS] icons/zode.ico contains 16/32/48/64/128/256 px entries — 16, 32, 48, 64, 128, 256
------------------------------------------------------------------------
57/57 checks passed
All static checks passed.
```

### 4.3 Cross-implementation check — `node tools/verify_against_web.mjs`

The web app landed in `apps/web` while this track was being written, so the
constants of the shell were checked against the canonical lists of
`apps/web/src/bridge/contract.js` (request types, event names, error codes,
attachment sources, intent names, capability keys, `DRAG_ZONE_HEIGHT`):

```
Zode — Windows shell ⇄ web app contract check
web contract: /…/zode/apps/web/src/bridge/contract.js
------------------------------------------------------------------------
[PASS] request types match the web app — 13 types
[PASS] native event names match the web app — 5 events
[PASS] error codes match the web app — 6 codes
[PASS] attachment sources match the web app — 5 sources
[PASS] intent names match the web app — 9 intents
[PASS] DRAG_ZONE_HEIGHT matches the web app — 34 vs 34
[PASS] capability keys match the web app — 7 keys
------------------------------------------------------------------------
7/7 cross checks passed
The Windows shell and the web app agree on the frozen contract.
```

The web app's `bridge/transport.js` posts `{ id, type, payload }` through
`window.chrome.webview.postMessage` and receives `window.__zodeNative__(…)` —
exactly what `Web/WebViewHost.cs` implements.  The web app's `EVENT_NAMES`
(`attachment`, `intent`, `search`, `deepLink`, `notificationAction`) are the
shell's event names.

### 4.4 Python byte-compilation — `python3 -m py_compile`

```
$ python3 -m py_compile tools/make_ico.py tools/verify_shell.py
py_compile: OK (exit 0)
```

(The generated `tools/__pycache__` was removed afterwards.)

### 4.5 XML / JSON / solution well-formedness

```
### XML well-formedness
  OK    Zode.Shell/Zode.Shell.csproj
  OK    Zode.Shell/app.manifest
  OK    msix/Package.appxmanifest
  OK    msix/appactions.json (JSON)
### .sln (regex, not XML)
  header: OK
  projects: [('Zode.Shell', 'Zode.Shell\\Zode.Shell.csproj')]
  configuration lines: 8
  exists Zode.Shell/Zode.Shell.csproj: True
  exists icons/zode.ico: True
  exists tools/make_ico.py: True
  exists tools/verify_shell.py: True
  exists build.ps1: True
  exists build-msix.ps1: True
  exists README.md: True
```

### 4.6 Icon — `python3 tools/make_ico.py` (Pillow is **not** installed)

```
decoded /…/zode/icons/zode.png -> 1600x1600 RGBA
  resampled -> 16x16
  resampled -> 32x32
  resampled -> 48x48
  resampled -> 64x64
  resampled -> 128x128
  resampled -> 256x256
wrote /…/zode/shells/windows/icons/zode.ico (370070 bytes, sizes: 16, 32, 48, 64, 128, 256)

ICONDIR: reserved=0 type=1 count=6
  entry 0: 16x16 bpp=32 bytes=1128 offset=102 (end=1230)
  entry 1: 32x32 bpp=32 bytes=4264 offset=1230 (end=5494)
  entry 2: 48x48 bpp=32 bytes=9640 offset=5494 (end=15134)
  entry 3: 64x64 bpp=32 bytes=16936 offset=15134 (end=32070)
  entry 4: 128x128 bpp=32 bytes=67624 offset=32070 (end=99694)
  entry 5: 256x256 bpp=32 bytes=270376 offset=99694 (end=370070)
file size: 370070
```

### 4.7 Size of the track

```
$ find . -type f | wc -l            → 51 files (50 + this deliverable)
$ cat $(find . -name "*.cs") | wc -l → 5546 lines of C#
```

---

## 5. NOT VERIFIED HERE

**This environment is a Linux sandbox without the .NET SDK and without
Windows.**  The following could not be done and must be done on a Windows
machine:

1. **The C# was never compiled.**  `dotnet build` / `dotnet publish` were not
   run, so compile errors (if any) are possible.  The code was reviewed by
   hand and the structural checks (balanced braces, namespace resolution,
   interop vtable order) are static only.
2. **The WebView2 runtime was never exercised**: the virtual host mapping, the
   `window.__zodeNative__` round trip, the external-navigation rules, the
   `DragStarting` path and the child-window subclassing are unproven.
3. **The window chrome was never seen**: `WM_NCCALCSIZE → 0`, the 8 px resize
   border, the native drag and the "fill the screen" toggle are unproven.
4. **The audio haptics were never heard**: the `winmm` playback, the
   `WHDR_LOOP` behaviour of the `working` program and the `IVibrationDevice`
   pulse are unproven.
5. **`IFileOpenDialog`, `IShellLink`/`IPersistFile`, `IPropertyStore`,
   `ICustomDestinationList` and the `IDropTarget` registration** were never
   called; the hand-written vtables follow the documented order but were not
   validated against a live shell.  `ICustomDestinationList` and
   `IObjectCollection` use GUIDs taken from the documentation and are the most
   likely to need a fix-up (they are isolated and guarded, so a failure only
   disables the custom jump-list task).
6. **The MSIX package was never built**: `MakeAppx`/`SignTool` need the
   Windows SDK, and `msix/Package.appxmanifest` has never been validated by
   `MakeAppx`.  The `windows.appActions` extension schema is the documented
   shape, not a verified one — the App Action activation path is designed to
   work through the `zode://` protocol, which does not depend on that schema.
7. **The web app was never loaded in the shell**: `apps/web` exists (it has no
   build step, `build.ps1` copies it verbatim), but the WebView2 runtime was
   never available here, so the app was never actually rendered in the shell.
8. **No automated test suite**: this track has no unit tests; the contract
   conformance is asserted by `tools/verify_shell.py` (static) and by the
   manual checklist in `README.md`.

---

## 6. What to run on Windows

```powershell
# 0. prerequisites: .NET 10 SDK, the WebView2 Evergreen runtime (preinstalled
#    on Windows 11) and, for the packaged build, the Windows SDK.

# 1. the web app needs no build step (plain ES modules) — build.ps1 copies
#    apps/web verbatim into <out>/web/

# 2. unpackaged build (no certificate, no admin rights)
cd shells/windows
pwsh ./build.ps1
#    -> artifacts\win-x64\Zode.Shell.exe

# 3. run it
& .\artifacts\win-x64\Zode.Shell.exe

# 4. run it against the dev server instead of the bundled app
cd ../../apps/web; node serve.mjs          # http://127.0.0.1:5173/
cd ../../shells/windows
$env:ZODE_DEV_URL = "http://127.0.0.1:5173"
& .\artifacts\win-x64\Zode.Shell.exe

# 5. optional: register the zode:// protocol for the current user
& .\artifacts\win-x64\Zode.Shell.exe --register-protocol

# 6. optional: packaged build (App Actions + package identity)
pwsh ./build-msix.ps1 -CreateDevCertificate
Add-AppxPackage -Path .\artifacts\Zode.NativeShell.msix

# 7. static verification of the sources (runs everywhere)
python3 .\tools\verify_shell.py
node    .\tools\verify_against_web.mjs
```

### Manual acceptance checklist (Windows)

1. The window has **no** caption, no min/max/close buttons.
2. Dragging the top 34 px moves the window with the native Windows drag
   (snap assist included).
3. Double-clicking the top strip fills the **whole monitor** (the taskbar stays
   visible); double-clicking again restores the previous window placement.
4. The window resizes from an 8 px border, including while the pointer is over
   the web content.
5. Moving the window to a second monitor changes the DPI without a blur.
6. `haptic.play` with `working` loops until `haptic.stop`.
7. Dropping a file anywhere on the window produces an `attachment` event
   (`source: "drop"`), a toast and a "Recent" entry in the jump list.
8. `attach.pick` opens the native file dialog with multi-select.
9. A toast appears (the AUMID and the Start Menu shortcut are registered at
   start-up).
10. `zode://search?q=abba` re-activates the app and raises a `search` event.

---

## 7. Notes for the verifier

* **The virtual-host access kind**: contract §1.3 specifies `DENY_CORS` for
  Windows, the task prose said `Allow`.  The **frozen contract wins**: the
  default is `CoreWebView2HostResourceAccessKind.DenyCors`; setting the
  environment variable `ZODE_VHOST_ACCESS=allow` switches to `Allow` while
  debugging.  Both values appear in `Web/WebViewHost.cs`.
* **One NuGet package**: `Microsoft.Web.WebView2` is the only `PackageReference`
  in the project.  The Windows SDK projections (`Windows.UI.Notifications`,
  `Windows.Data.Xml.Dom`, `Windows.Devices.Haptics`) come with the
  `net10.0-windows10.0.26100.0` target framework, not from a package
  reference.  `Microsoft.Win32` is the BCL registry API.
* **`setFullScreen` is the fill behaviour on Windows.**  The brief forbids the
  real-fullscreen hack (no `SetWindowDisplayAffinity`, no taskbar hiding), so
  `setFullScreen(true)` fills the whole display and `isFullScreen` reports
  that state.
* **`window.dragStart` is the active drag path**; the parent's
  `WM_NCHITTEST → HTCAPTION` is the fallback for the area that the WebView2
  child does not cover.  The child answers `HTCLIENT` inside the strip on
  purpose — otherwise the page could never raise the `dblclick` that contract
  §5.4 requires.
* **Event names** (`attachment`, `notificationAction`, `intent`, `search`,
  `deepLink`) are the shell's choice; the contract only fixes the `attachment`
  example (§1.2).
* Nothing outside `shells/windows/` was written; `packages/shared/**` and
  `apps/web/**` were only read.
