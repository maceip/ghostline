# Zode Native Bridge — Contract v1

**Status:** frozen. Every platform track (web, macOS shell, Windows shell, iOS, Android)
implements *this* document. Do not extend the surface without bumping `version`.

The contract has two halves:

1. A **message envelope** that travels over the platform transport (§1).
2. A **canonical JavaScript API** (`window.zode`) that the web app talks to (§2).

The web app must *never* touch a platform transport directly. Each shell installs a thin
adapter that maps `window.zode` onto its transport, and the web app is fully functional
in a plain browser thanks to the web fallback shim (§6).

---

## 1. Message envelope

### 1.1 Transports

| Platform | JS → native | native → JS |
|---|---|---|
| macOS (WKWebView) | `window.webkit.messageHandlers.zode.postMessage(env)` | `window.__zodeNative__(msg)` via `WKUserContentController` + `WKScriptMessageHandler` |
| Windows (WebView2) | `window.chrome.webview.postMessage(env)` | `window.__zodeNative__(msg)` via `CoreWebView2.ExecuteScriptAsync` |
| Web / browser | — (shim answers locally) | — |

### 1.2 Envelope shapes

**Request (JS → native)**

```jsonc
{
  "id": "b7f1c0de-...",     // UUID, echoed back on the response
  "type": "haptic.play",   // one of the request types in §3
  "payload": { }           // type-specific, always an object (may be empty)
}
```

**Response (native → JS)** — success:

```jsonc
{ "id": "b7f1c0de-...", "ok": true, "result": { } }
```

**Response (native → JS)** — failure:

```jsonc
{ "id": "b7f1c0de-...", "ok": false, "error": { "code": "unsupported", "message": "…" } }
```

**Event (native → JS, unsolicited)**

```jsonc
{ "type": "event", "event": "attachment", "payload": { } }
```

Error `code` is one of: `unsupported`, `invalid`, `denied`, `cancelled`, `notFound`, `internal`.

### 1.3 Origin scheme

Bundled web assets are served from a **custom scheme**, never `file://`, so that the origin is
stable and CORS-clean:

- macOS: `zode://app/index.html` — handled by a `WKURLSchemeHandler`.
- Windows: `https://app.zode.local/index.html` — via
  `ICoreWebView2Environment3.SetVirtualHostNameToFolderMapping("app.zode.local", …, DENY_CORS)`.

Dev mode overrides the base URL:

| Platform | Override | Default |
|---|---|---|
| macOS | `ZODE_DEV_URL` env var / `UserDefaults` key `ZodeDevURL` | *(unset → bundled assets)* |
| Windows | `ZODE_DEV_URL` env var / `ZodeDevURL` in `appsettings.json` | *(unset → bundled assets)* |

---

## 2. Canonical JavaScript API (`window.zode`)

```ts
type ZodePlatform = 'macos' | 'windows' | 'web';

interface Zode {
  readonly platform: ZodePlatform;
  readonly version: 1;
  readonly capabilities: {
    haptics: boolean;      // true only if a real haptic engine exists (not the audio fallback)
    attachments: boolean;  // file picker + drop
    notifications: boolean;
    intents: boolean;      // system intents / app actions
    journal: boolean;
    search: boolean;       // system search integration
    windowControl: boolean;// drag + fill-screen
  };

  // ---- haptics -----------------------------------------------------------
  /** Play a named program from packages/shared/haptics.json. Resolves when playback is scheduled. */
  haptic(program: string, opts?: { loop?: boolean }): Promise<void>;
  /** Stop a looping program (e.g. 'working'). */
  hapticStop(program: string): Promise<void>;

  // ---- attachments --------------------------------------------------------
  /** Show the native file picker and return the chosen attachments. */
  attach(): Promise<Attachment[]>;
  /** Subscribe to attachments arriving from the dock, a drop, or the share sheet. Returns an unsubscribe fn. */
  onAttachment(cb: (a: Attachment) => void): () => void;

  // ---- notifications ------------------------------------------------------
  notify(opts: { title: string; body: string; id?: string; urgency?: 'normal' | 'critical' }): Promise<void>;
  onNotificationAction(cb: (a: { id: string; action: string }) => void): () => void;

  // ---- intents ------------------------------------------------------------
  /** Run a named intent (see §4) inside the app. */
  performIntent(intent: string, payload?: Record<string, unknown>): Promise<IntentResult>;
  /** Subscribe to intents invoked from outside the app (Siri, Shortcuts, Spotlight, App Actions). */
  onIntent(cb: (i: { intent: string; payload: Record<string, unknown> }) => void): () => void;

  // ---- journal ------------------------------------------------------------
  /** Append an entry to the system journal (macOS Journaling Suggestions / Journal app). */
  journal(entry: { title: string; body: string; date?: string }): Promise<void>;

  // ---- search -------------------------------------------------------------
  /** Query the app's own search index. */
  search(query: string): Promise<SearchResult[]>;
  /** Subscribe to queries arriving from system search (Spotlight / Windows Search / Cortana). */
  onSearch(cb: (q: { query: string }) => void): () => void;

  // ---- window control -----------------------------------------------------
  window: {
    /** Begin a window drag. Called on pointer-down inside the drag zone. */
    dragStart(screenX: number, screenY: number): void;
    /** Double-click behaviour on the drag zone: fill the screen with this window. Toggles. */
    toggleFillScreen(): Promise<boolean>;   // resolves true when now filling
    setFullScreen(fullScreen: boolean): Promise<void>;
    isFullScreen(): Promise<boolean>;
  };

  // ---- misc ---------------------------------------------------------------
  /** Deep link into the app, e.g. `zode://collection/album/123`. */
  onDeepLink(cb: (url: string) => void): () => void;
  /** Open a local path with the system default handler. */
  openPath(path: string): Promise<void>;
}
```

### 2.1 Data shapes

```ts
interface Attachment {
  id: string;         // stable per-session id
  name: string;       // file name
  path: string;       // absolute path on disk
  mimeType: string;   // best-effort, e.g. 'image/png'
  size: number;       // bytes
  source: 'dock' | 'drop' | 'picker' | 'share' | 'intent';
}

interface IntentResult {
  ok: boolean;
  value?: unknown;
  message?: string;
}

interface SearchResult {
  id: string;
  title: string;
  subtitle?: string;
  kind: 'track' | 'album' | 'artist' | 'playlist' | 'task' | 'file' | 'action';
  payload?: Record<string, unknown>;
}
```

### 2.2 Listener rules

- `on*` returns an **unsubscribe function**; calling it twice is safe.
- Listeners are per-`window`; the adapter owns them and forwards native events.
- A native event with no listener is dropped (never buffered) — except `attachment`, which the
  shell also surfaces natively (dock badge / toast) so it is never lost.

---

## 3. Request types

| `type` | payload | result |
|---|---|---|
| `haptic.play` | `{ program: string, loop?: boolean }` | `{}` |
| `haptic.stop` | `{ program: string }` | `{}` |
| `attach.pick` | `{}` | `{ attachments: Attachment[] }` |
| `notify.post` | `{ title, body, id?, urgency? }` | `{}` |
| `intent.perform` | `{ intent: string, payload?: object }` | `IntentResult` |
| `journal.write` | `{ title, body, date? }` | `{}` |
| `search.query` | `{ query: string }` | `{ results: SearchResult[] }` |
| `window.dragStart` | `{ screenX, screenY }` | `{}` |
| `window.toggleFill` | `{}` | `{ filling: boolean }` |
| `window.setFullScreen` | `{ fullScreen: boolean }` | `{}` |
| `window.isFullScreen` | `{}` | `{ fullScreen: boolean }` |
| `app.openPath` | `{ path: string }` | `{}` |
| `app.info` | `{}` | `{ version, build, platform, deviceModel }` |

---

## 4. Intent names

These are the **cross-platform intent names**. Each platform maps them onto its own system
mechanism; the *name* and the *payload shape* are what must match.

| Intent | Payload | Meaning |
|---|---|---|
| `zode.search` | `{ query: string }` | Search the library. |
| `zode.play` | `{ id: string, kind: 'track'|'album'|'artist'|'playlist' }` | Start playback of an item. |
| `zode.pause` | `{}` | Pause playback. |
| `zode.next` | `{}` / `{ id? }` | Skip to next track. |
| `zode.previous` | `{}` / `{ id? }` | Skip to previous track. |
| `zode.agent.newTask` | `{ prompt: string, attachments?: Attachment[] }` | Start a new agent task. |
| `zode.agent.stop` | `{}` | Stop the running agent task. |
| `zode.attach` | `{ attachments: Attachment[] }` | Hand files to the app. |
| `zode.show` | `{ view: 'now-playing'|'collection'|'library'|'search'|'agent' }` | Navigate to a view. |

### 4.1 Platform mapping

| Intent | macOS (App Intents / Shortcuts / Spotlight) | Windows (App Actions) |
|---|---|---|
| `zode.search` | `SearchLibraryIntent` → Spotlight `AppEntity` | App Action `zode.search`, input `Text` |
| `zode.play` | `PlayItemIntent` → also **Media Intents** for Siri | App Action `zode.play`, input `Document` |
| `zode.pause` / `zode.next` / `zode.previous` | Media Intents | App Actions |
| `zode.agent.newTask` | `NewTaskIntent` (App Intent, `openAppWhenRun = true`) | App Action `zode.agent.newTask` |
| `zode.agent.stop` | `StopTaskIntent` | App Action `zode.agent.stop` |
| `zode.attach` | `application(_:open:)` (dock drop) + `NSApp.open` | protocol activation + file drop |
| `zode.show` | `AppIntent` with `openAppWhenRun` | App Action `zode.show` |

---

## 5. Window chrome rules

Applies to **both** desktop shells.

1. **No native window controls.** No traffic lights, no min/max/close buttons, no title bar.
   The window shows the app's own content edge-to-edge.
2. **The web content owns the entire window.** The shell must not paint a background, a border,
   or a shadow over the content area.
3. **The top strip is a drag zone.** The web app renders a drag strip of height
   `--drag-zone-height` (default **34px**, exported as a CSS custom property and also
   declared in the contract as `DRAG_ZONE_HEIGHT = 34`) at the very top of the document.
   - `pointerdown` inside the strip → `zode.window.dragStart(screenX, screenY)`.
   - The strip is `user-select: none` and must not capture clicks meant for app controls that
     live inside it (the app may place controls there; those must call
     `stopPropagation()` on `pointerdown`).
4. **Double-click on the drag zone fills the screen with this app window.**
   - Detected in the web app (`dblclick` on the strip) → `zode.window.toggleFillScreen()`.
   - "Fill" = the window occupies the **entire display bounds**, not the work area, and the
     window enters a full-screen-like state *without* hiding the menu bar or switching Space.
   - Implementation guidance:
     - macOS: set the window frame to `NSScreen.frame` (full display bounds) and set
       `window.styleMask` to omit `.titled`; restore the previous frame on the next toggle.
       Do **not** use `NSWindow.toggleFullScreen` (that hides the menu bar and animates over
       the Space) — the brief asks for "fill the screen with this app window".
     - Windows: use `SetWindowPos` to the monitor bounds with `SWP_NOACTIVATE`, keeping the
       window borderless; restore the previous `WINDOWPLACEMENT` on toggle.
   - Double-click **must not** trigger the "fill" twice (guard with a 300ms debounce) and
     must not also trigger a text selection.
5. **The rest of the window is not draggable.** Clicking anywhere below the strip must not
   move the window.

---

## 6. Web fallback shim

When `window.chrome?.webview` and `window.webkit?.messageHandlers` are both absent, the web app
installs a shim that provides the same `window.zode` surface:

- `platform` = `'web'`
- `capabilities.haptics` = `false`; `haptic()` renders the program through **WebAudio** using
  `packages/shared/haptics.json` (sine carrier at `carrierHz`, amplitude envelope from the
  intensity curve). This is the same renderer the Windows shell uses.
- `attach()` opens an `<input type="file" multiple>` and returns `Attachment[]` with
  `path: ''` and `source: 'picker'`.
- `notify()` uses the **Notification API** when permitted, else no-ops.
- `search()` filters the in-memory library.
- `window.*` are no-ops except `toggleFillScreen()`, which requests **Fullscreen API**.

The shim MUST live in `packages/shared/` and be the single source of truth for the browser path.

---

## 7. Haptics contract

The waveform programs are defined once in `packages/shared/haptics.json` and are rendered by:

| Platform | Engine | Notes |
|---|---|---|
| macOS | `CoreHaptics` (`CHHapticPattern` + `CHHapticAdvancedPatternPlayer`) | `loopEnabled` for `working`. Check `CHHapticEngine.capabilitiesForHardware().supportsHaptics`; Macs generally have **no** Taptic Engine, so fall back to the WebAudio-style synthesiser and report `capabilities.haptics = false`. |
| iOS | `CoreHaptics` | Real Taptic Engine. |
| Windows | WASAPI / `AudioClient` sine synthesis | Windows desktops have **no** rich haptic API (only `IVibrationDevice`, a coarse on/off pulse). Synthesise the waveform as audio so the *shape* is preserved. Report `capabilities.haptics = false`. |
| Android | `Vibrator` / `VibrationEffect.createWaveform` | `VibrationEffect` amplitudes are 1..255, so map `intensity × 255` per curve sample and step the curve. Report `capabilities.haptics = true` only if the device has a vibrator. |
| Web | WebAudio `OscillatorNode` + `GainNode` envelope | Same synthesis as Windows. |

### 7.1 Required programs

`done` (triple roll) and `working` (tiny slow wave) are **mandatory** and must be recognisably
different from each other. `working` MUST loop until stopped.

---

## 8. Drop & dock semantics

| Source | macOS | Windows |
|---|---|---|
| Drop onto the window | `NSView`/`WKWebView` subclass implementing `registerForDraggedTypes([.fileURL])`, `draggingEntered`, `performDragOperation` → emit `attachment` event with `source: 'drop'` | `IDropTarget` / `WebView2` `DragEnter`/`Drop` → emit `attachment` event with `source: 'drop'` |
| Drop on the **Dock icon** | `NSApplicationDelegate.application(_:open:)` → emit `attachment` event with `source: 'dock'` | *(no dock icon drop on Windows)* — Windows equivalent is the taskbar icon drop / jump list, handled via `IDropTarget` on the taskbar button |
| Share sheet / "Open with" | `application(_:open:)` with `NSUserActivity` / `kAEGetURL` → `source: 'share'` | Protocol activation (`zode://`) → `source: 'intent'` |

**Drop target must cover the entire window** — not just a designated box. Dropping anywhere on
the window, including over web content, must work. This requires the native layer to
intercept drags **above** the web view (a transparent overlay that accepts drops but forwards
all other events), or the web view must be made drop-aware.

**Recommended macOS implementation:** a full-window `NSView` subclass placed *above* the
`WKWebView` in the view hierarchy that:
- accepts `NSPasteboardType.fileURL` and `NSPasteboardType.tiff` drags,
- returns `NSDragOperation.copy` from `draggingEntered`,
- and **forwards every non-drag mouse event** to the web view.

A simpler and more robust alternative on macOS is to implement the drop handling in the
`WKWebView` subclass itself and override `draggingEntered`/`performDragOperation`, which
AppKit calls before the web content sees the drag.

---

## 9. Notifications

- macOS: `UNUserNotificationCenter` (requires a bundled app, signed with the developer profile).
- Windows: `Windows.UI.Notifications` — the classic WinRT toast API. Unpackaged apps must register an
  `AppUserModelID` and a Start Menu shortcut for notifications to work, and the activation comes
  back through the app's own `zode://notification` protocol. (`Windows.AppNotifications` would mean
  taking a dependency on the Windows App SDK, and this shell deliberately depends on nothing but
  WebView2.)

---

## 10. System search

- macOS: `CoreSpotlight` (`CSSearchableIndex`) indexes library items; `AppIntents` entity
  schemas add them to the **Spotlight semantic index** (macOS 27).
- Windows: **App Content Search** APIs (Windows App SDK 2.5.1, limited access) *or* a
  packaged `AppAction`/`SearchHost` extension. Requires package identity (MSIX).

---

## 11. Journal

- macOS: **Journaling Suggestions** framework (macOS 27) lets an app offer structured
  suggestions that appear in the Journal app. The shell writes the app's own activity log
  through the same `journal.write` request.
- Windows: no equivalent system journal. The shell writes to a local activity log file and
  surfaces it in-app; `journal.write` resolves successfully but does not reach the OS.

---

## 12. Versioning

`window.zode.version` is `1`. The `haptics.json` `version` is `1`. A shell that implements a
subset MUST report the missing capability in `capabilities` and MUST resolve the corresponding
request with `{ ok: false, error: { code: 'unsupported' } }` rather than hanging.
