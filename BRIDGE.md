# native bridge protocol (v1)

zune code's agent loop lives in the webview by default (pi). A **native
bridge** is an optional per-platform sidecar that takes over the loop
entirely â€” this is how a local `claude` / `codex` CLI or the Claude Agent
SDK / OpenAI Agents SDK (with real filesystem + shell tools) plugs in
later, with **zero UI changes**. The webview is multiplatform; the bridge
is the per-platform part, and it's optional.

Set the bridge URL in Settings (`native bridge`, e.g.
`http://127.0.0.1:17861`). In `auto`/`remote` mode the webview pings it
(cached 30s) and prefers it over direct provider calls; if it's down,
routing falls through to remote â†’ LiteRT-LM local (`src/llm/router.js`).

## endpoints

### `GET /health`
`200` with any JSON body, e.g. `{"name": "zune-bridge-macos", "version": 1}`.

### `POST /v1/turn`
Request JSON:

```json
{
  "sessionId": "board",
  "system": "â€¦system promptâ€¦",
  "messages": [{ "role": "user", "content": "â€¦" }, { "role": "assistant", "content": "â€¦" }],
  "prompt": "the new user prompt"
}
```

Response: `text/event-stream`, one JSON object per `data:` line:

```
data: {"type":"trace","text":"tool read_file(AuthAndVaultStore.kt)"}
data: {"type":"token","text":"partial ans"}
data: {"type":"token","text":"wer"}
data: {"type":"done"}
```

- `token` â€” append `text` to the answer being streamed into the turn payload.
- `trace` â€” a line for the turn's reasoning/tool trace column.
- `error` â€” `{"type":"error","message":"â€¦"}` fails the turn over to the next engine.
- `done` (or simply closing the stream) ends the turn.

## semantics

- The bridge owns its loop completely: model choice, tools, retries,
  session state keyed by `sessionId` (the thread id). `messages` is the
  webview's view of history; a bridge with its own session store may
  ignore all but `prompt`.
- CORS: respond with `Access-Control-Allow-Origin: *` and handle
  `OPTIONS` preflight (`content-type` is the only non-simple header).
- Bind loopback only. The webview sends no secrets to the bridge.

A minimal bridge is ~50 lines: spawn `claude -p` / `codex exec` (or an
Agent SDK `query()`), translate its streamed output into the events
above. That's the intended per-platform work â€” everything else
(routing, fallback to LiteRT-LM on error, the whole UI) already exists.
## Native chrome alignment (zode shells)

`maceip/zode` ships mature borderless shells (macOS WKWebView, Windows
WebView2) governed by a frozen contract: no native window controls, the web
content owns every pixel, and a 34 px top drag strip whose height is shared
between shell and web app as the CSS variable `--drag-zone-height`.
Double-clicking the strip fills the display bounds (never real fullscreen);
content below the strip is not draggable.

This web app honors the same surface so it can be hosted by such a shell
unchanged (point the shell's dev URL — zode: `ZODE_DEV_URL` — at the Vite
server):

- `--drag-zone-height: 34px` in `src/index.css` — must stay in step with
  the shell constant (`DRAG_ZONE_HEIGHT`).
- The topline carries `data-drag-zone="true"`, uses
  `app-region: drag` (with `no-drag` on interactive children) for
  Chromium-based frameless hosts, and double-click toggles fullscreen as the
  browser approximation of fill-screen. A real shell owns fill/drag itself.
- `index.html` paints a black ground before first paint, mirroring the
  shells painting the token canvas behind the webview (no white flash).
- Brand assets (`public/zode-mark.svg`, `favicon.ico`, `zode-256.png`)
  are carried over byte-identical from zode's `icons/` — do not redraw them.

Layer note: zode's `window.zode` envelope bridge serves *shell services*
(haptics, attachments, window ops); the bridge specified above serves *agent
turns* from a sidecar. They are complementary, not interchangeable — a native
build would run both.
