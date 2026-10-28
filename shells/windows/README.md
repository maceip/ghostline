# Zode — Windows native shell

A native Windows desktop shell for the Zode web app.  It hosts the app in the
**Edge WebView2** runtime (the system webview on Windows 11) inside a
**borderless** window with **no native window controls**, and implements the
frozen native bridge contract in
[`packages/shared/contract.md`](../../packages/shared/contract.md).

```
┌──────────────────────────────────────────────────────────────┐
│  WS_POPUP | WS_THICKFRAME | WS_CLIPCHILDREN                   │
│  WM_NCCALCSIZE → 0  ⇒  no caption, no min/max/close          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ WebView2 child HWND — the whole client area           │  │
│  │  • drag strip (34 px) → window.dragStart              │  │
│  │  • 8 px invisible resize border (WM_NCHITTEST)        │  │
│  │  • drop target: the whole window accepts files        │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 1. Stack (deliberate, do not substitute)

| Piece | Choice | Why |
|---|---|---|
| Language | C# / .NET 10 (`net10.0-windows10.0.26100.0`) | Windows 11 24H2 projections |
| UI | **raw Win32 (P/Invoke)** — no WinUI 3, no WPF, no WinForms | total control over the window chrome |
| Webview | **Microsoft.Web.WebView2** | the system webview on Windows 11 |
| Packages | **exactly one**: `Microsoft.Web.WebView2` | everything else is Win32 / WinRT / BCL |

`UseWindowsForms=false`, `UseWPF=false`.  The Windows SDK projections
(`Microsoft.Windows.SDK.NET.Ref`) come with the target framework, they are not
a package reference of this shell.

---

## 2. Build

### 2.1 Unpackaged (no certificate, no admin rights)

```powershell
cd shells/windows
pwsh ./build.ps1                 # win-x64 + win-arm64
pwsh ./build.ps1 -Runtimes win-x64
```

`build.ps1` publishes the project, copies the web app into `<out>/web/` and the
icon next to the executable.  It **fails with a clear message** when the web
app is missing — the shell serves the bundled app from
`https://app.zode.local/index.html`, so a web app build is required.

The web app has **no build step** (plain ES modules): `apps/web` is copied
verbatim, which is why `build.ps1` picks `apps/web` (it looks for
`index.html` in `apps/web/{dist,build,public,src}` and `apps/web`).

Run it:

```powershell
& .\artifacts\win-x64\Zode.Shell.exe
```

### 2.2 Development against a dev server

```powershell
cd apps/web
node serve.mjs                 # → http://127.0.0.1:5173/

# in another shell
cd shells/windows
$env:ZODE_DEV_URL = "http://127.0.0.1:5173"
& .\artifacts\win-x64\Zode.Shell.exe
```

`ZODE_DEV_URL` (or `ZodeDevURL` in an `appsettings.json` next to the
executable) overrides the bundled assets — contract §1.3.

| Variable | Meaning |
|---|---|
| `ZODE_DEV_URL` | navigate to this URL instead of the bundled app |
| `ZODE_VHOST_ACCESS` | `allow` relaxes the virtual host from `DENY_CORS` to `Allow` (debug only) |

### 2.3 Packaged (MSIX — required for App Actions)

```powershell
pwsh ./build-msix.ps1 -CreateDevCertificate     # self-signed dev certificate
pwsh ./build-msix.ps1 -PfxPath cert.pfx -PfxPassword "…"
```

* The **unpackaged** build needs **no signing certificate**.
* The **MSIX** build **must** be signed: the `Publisher` of
  `msix/Package.appxmanifest` has to match the subject of the certificate.
  `build-msix.ps1` creates a self-signed development certificate in the
  current user store when `-CreateDevCertificate` is used.

---

## 3. Window chrome (contract §5)

| Rule | Implementation |
|---|---|
| No native controls | `CreateWindowEx` with `WS_POPUP | WS_THICKFRAME | WS_CLIPCHILDREN`, `WM_NCCALCSIZE` returns `0` |
| The web content owns the window | the class has no background brush, `WM_ERASEBKGND` is swallowed, the WebView2 child covers the client area |
| Drag strip = **34 px** | `ShellWindow.DRAG_ZONE_HEIGHT = 34` (contract §5.3).  The page raises `window.dragStart`; the shell answers with `ReleaseCapture()` + `SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)` — a native OS drag |
| Double click fills the screen | `window.toggleFill` → `FillScreenController`: `SetWindowPos` to the **entire monitor bounds** with `SWP_NOACTIVATE`, the previous `WINDOWPLACEMENT` is restored on the next toggle |
| No real fullscreen | the taskbar stays visible, no `SetWindowDisplayAffinity`, no Space switch |
| The rest is not draggable | only the strip reports `HTCAPTION`; everything below is `HTCLIENT` |
| Invisible resize border | 8 px band, answered in `WM_NCHITTEST` on the **parent** *and* on the **WebView2 child** (the child covers the client area, so the parent would never see the pointer) |
| Per-monitor DPI | `app.manifest` declares `PerMonitorV2`; `WM_DPICHANGED` re-applies the suggested bounds and resizes the WebView2 child.  WebView2 is DPI aware, so the shell does **not** scale it a second time |

The WebView2 child is subclassed (`Native/WindowSubclass.cs`) so that the
resize border keeps working while the pointer is over the web content.  The
drag strip deliberately stays `HTCLIENT` for the child: the page has to see
`pointerdown`/`dblclick` to raise `window.dragStart` / `window.toggleFill`.

---

## 4. The bridge (contract §1/§2/§3)

* **JS → native**: `window.chrome.webview.postMessage(envelope)` →
  `CoreWebView2.WebMessageReceived`.
* **native → JS**: `CoreWebView2.ExecuteScriptAsync("window.__zodeNative__({…})")`.
* The envelope is exactly the one of §1.2: `{ id, type, payload }` →
  `{ id, ok, result }` / `{ id, ok:false, error:{ code, message } }`, and
  events are `{ type:"event", event, payload }`.
* Error codes: `unsupported`, `invalid`, `denied`, `cancelled`, `notFound`,
  `internal` (contract §1.2).  A request the shell does not implement answers
  with `unsupported` instead of hanging (contract §12).

| Request (§3) | Result | Where |
|---|---|---|
| `haptic.play` / `haptic.stop` | `{}` | `Haptics/HapticService.cs` |
| `attach.pick` | `{ attachments: Attachment[] }` | `Attachments/FilePicker.cs` |
| `notify.post` | `{}` | `Platform/NotificationService.cs` |
| `intent.perform` | `IntentResult` | `Platform/IntentService.cs` |
| `journal.write` | `{}` | `Platform/JournalService.cs` |
| `search.query` | `{ results: SearchResult[] }` | `Platform/SearchService.cs` |
| `window.dragStart` | `{}` | `Windowing/ShellWindow.cs` |
| `window.toggleFill` | `{ filling: boolean }` | `Windowing/FillScreenController.cs` |
| `window.setFullScreen` / `window.isFullScreen` | `{}` / `{ fullScreen: boolean }` | `Windowing/ShellWindow.cs` |
| `app.openPath` | `{}` | `Bridge/BridgeDispatcher.cs` |
| `app.info` | `{ version, build, platform, deviceModel }` | `Platform/SystemInfo.cs` |

Native events: `attachment`, `notificationAction`, `intent`, `search`,
`deepLink`.

---

## 5. Haptics (contract §7) — rendered, not invented

`packages/shared/haptics.json` is **embedded** in the assembly (and copied next
to the executable); no waveform is hard coded in C#.

Windows desktops have **no rich haptic engine** — only the coarse
`IVibrationDevice`.  The shell therefore:

1. **primary** — synthesises the canonical program as **audio**: a sine carrier
   at the program's `carrierHz` with the amplitude taken from the intensity
   curve (`Haptics/WaveformSynthesizer.cs`), played through the `winmm`
   `waveOut*` API (`Haptics/WaveOutPlayer.cs`, no third-party packages).  The
   shape of `done` (triple roll) and `working` (tiny slow wave) stays
   recognisable, and `working` loops (via `WHDR_LOOP`) until `haptic.stop`.
2. **secondary** — fires an `IVibrationDevice` pulse that matches the peak
   intensity of the program, when the device exists at all.

`capabilities.haptics` is reported as **false**: there is no haptic engine on
a desktop, the waveform is an audio fallback.

---

## 6. Attachments (contract §8)

* **Drop anywhere on the window** — the WebView2 child covers the whole client
  area, so the drop is intercepted in the webview path
  (`CoreWebView2.AllowExternalDrop = false` + `CoreWebView2.DragStarting`),
  and an OLE `IDropTarget` (`Attachments/FileDropTarget.cs`) is registered on
  the child window as the OLE-level fallback.  `CF_HDROP` is read with
  `DragQueryFileW`; every file becomes an `attachment` event with
  `source: "drop"`.
* **File picker** — `attach.pick` uses `IFileOpenDialog` with multi-select and
  answers `Attachment[]` with `source: "picker"`.
* **Taskbar / Jump List** — the Windows equivalent of the macOS dock drop.
  The shell owns an `AppUserModelID` and a per-user Start Menu shortcut, which
  is what gives the app a Jump List at all (no registry of our own is
  written).  Attachments are published with `SHAddToRecentDocs` ("Recent"
  section) and a custom task is added through `ICustomDestinationList`
  (best effort — see §9).

---

## 7. Windows 11 integration

| Feature | Status |
|---|---|
| **Notifications** (§9) | `Windows.UI.Notifications`.  An unpackaged app needs an `AppUserModelID` **and** a Start Menu shortcut, otherwise the toast silently disappears — `Platform/AppIdentity.cs` does both at start-up.  The activation comes back through the `zode://notification` protocol, which `ProtocolActivation.cs` already handles. |
| **App Actions / intents** (§4) | `msix/Package.appxmanifest` declares the `windows.appActions` extension and `msix/appactions.json` defines one action per contract intent.  **Requires package identity (MSIX).**  The actions activate the app through the `zode://` protocol, so the same intents work unpackaged too. |
| **Deep links** (§2) | `zode://` is registered in the manifest (`windows.protocol`).  `Platform/ProtocolActivation.cs` turns the URI into `deepLink` / `search` / `intent` events.  For the unpackaged build `Zode.Shell.exe --register-protocol` writes the per-user `HKCU\Software\Classes\zode` entry. |
| **System search** (§10) | **Not fully available.**  The "App Content Search" APIs (Windows App SDK 2.5.1) are in limited access and require package identity, so the real implementation sits behind the `ZODE_APP_CONTENT_SEARCH` compile constant.  The working fallback is the protocol handler: Windows Search can call `zode://search?q=…`, which re-activates the app and raises a `search` event.  `search.query` answers from the shell's local index (everything that was attached). |
| **Journal** (§11) | Windows has no system journal.  `journal.write` resolves successfully and appends to `%LOCALAPPDATA%\Zode\journal.jsonl` (one JSON object per line).  The entry never reaches the OS — this is a documented gap. |
| **Single instance** | a second launch forwards its command line (deep link) to the running instance through a named pipe. |

---

## 8. Files

```
shells/windows/
├── Zode.Shell/                  C# project (Win32 + WebView2)
│   ├── Zode.Shell.csproj        net10.0-windows10.0.26100.0, one NuGet package
│   ├── app.manifest             PerMonitorV2 DPI awareness, asInvoker
│   ├── Program.cs               entry point, single instance, OLE init
│   ├── ShellApplication.cs      composition root
│   ├── SingleInstanceGuard.cs   named-pipe command line forwarding
│   ├── Native/                  P/Invoke: user32, shell32, ole32, winmm, propsys
│   ├── Windowing/               the borderless window + fill-screen logic
│   ├── Web/                     the WebView2 host (virtual host, bridge, drops)
│   ├── Bridge/                  envelope, request types, dispatcher
│   ├── Haptics/                 haptics.json → PCM → winmm + IVibrationDevice
│   ├── Attachments/             IDropTarget, CF_HDROP, IFileOpenDialog
│   ├── Platform/                identity, notifications, intents, search, journal
│   ├── Interop/                 the COM interfaces (hand written vtables)
│   └── Diagnostics/             file logger
├── Zode.Shell.sln
├── msix/
│   ├── Package.appxmanifest     package identity, appActions, zode:// protocol
│   └── appactions.json          one action per contract §4 intent
├── tools/
│   ├── make_ico.py              stdlib-only PNG → ICO converter
│   ├── verify_shell.py          static verification of this shell
│   └── verify_against_web.mjs   the shell ⇄ web app contract cross check
├── icons/zode.ico               16/32/48/64/128/256 px
├── build.ps1                    unpackaged build
├── build-msix.ps1               packaged build (needs a certificate)
├── README.md
└── deliverable.md
```

---

## 9. Honest gaps

| Gap | Why | What the shell does instead |
|---|---|---|
| No haptic engine | Windows desktops only have the coarse `IVibrationDevice` | renders the canonical program as audio; `capabilities.haptics = false` |
| No system journal | no equivalent to the macOS Journaling Suggestions | local activity log, `journal.write` resolves |
| No public App Content Search | the API is in limited access and needs package identity | `zode://search?q=…` protocol fallback + a local index |
| App Actions need an MSIX | they require package identity | the same intents are reachable through `zode://` and `intent.perform` |
| `setFullScreen` is not a real fullscreen | the brief forbids the fullscreen hack | "full screen" = the window fills the entire display bounds |
| The Jump List custom task is best effort | `ICustomDestinationList` is a private-ish shell API | the reliable part (AUMID + shortcut + `SHAddToRecentDocs`) is always active |

---

## 10. Verification

```bash
python3 shells/windows/tools/verify_shell.py     # 57 static checks
node    shells/windows/tools/verify_against_web.mjs  # 7 cross checks against apps/web
python3 shells/windows/tools/make_ico.py          # regenerates icons/zode.ico
```

The verifier parses the frozen contract and checks that every request type and
every intent is implemented, that the shell only uses allowed namespaces, that
the project/solution/manifest files parse, that the referenced files exist and
that the icon carries all six sizes.

`verify_against_web.mjs` compares the constants of the C# shell with the
canonical lists of the web app (`apps/web/src/bridge/contract.js`): the
request types, the event names, the error codes, the attachment sources, the
intent names, the capability keys and `DRAG_ZONE_HEIGHT`.  It is the part of
the contract that can be verified without Windows.

Neither script can replace a real build: see `deliverable.md` →
**NOT VERIFIED HERE**.
