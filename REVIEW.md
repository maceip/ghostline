# zune code — code review

**Scope:** runtime performance, visual/UI quality, and interaction flow.
**Method:** source read of `src/` (3,012 LOC), production build + manifest analysis,
live DOM inspection at desktop and ≤760 px breakpoints, `npm test` (28/28 passing).

---

## 1 · Performance

### P1 — One 1,626-line component re-renders all seven pivot pages on every state change

`App()` spans `src/App.jsx:30–1626`. All seven pivot sections are rendered
unconditionally inside one `.canvas` flex row:

| pivot | line |
|---|---|
| hub | `App.jsx:837` |
| conversation | `App.jsx:926` |
| collection | `App.jsx:1139` |
| review | `App.jsx:1176` |
| terminal | `App.jsx:1297` |
| agents | `App.jsx:1309` |
| settings | `App.jsx:1369` |

`.page` is `flex:0 0 100%` (`src/index.css:58`), so all seven are **fully laid out**
at all times — the canvas is panned by `transform`, which does not remove them
from layout, from the tab order, or from the accessibility tree.

There is no `React.memo`, no component boundary, and no `content-visibility` on
the off-canvas pages. The consequence is direct:

- The fleet tick (`App.jsx:495–515`, `setInterval` 1,600 ms) rewrites the object
  identity of every *running* agent (`tickAgents` in `src/derive.js:161–178`
  allocates a new object per running agent). Every one of those ticks re-renders
  the entire seven-page tree.
- The same happens on every streamed token (see P2).

**Fix.** Extract `<HubPage>`, `<ConversationPage>`, `<ReviewPage>`, … into
separate components, each memoized on the slice it actually reads. Add
`content-visibility: auto; contain-intrinsic-size: <w> <h>` to
`.page:not(.isactive)` so the browser skips layout and paint for the six
off-canvas pages. Then render only the active page ±1.

**Honourable mentions (same family).**

- `moveCursor` (`App.jsx:226–242`) calls `getBoundingClientRect()` on the
  cursor *and on every candidate element inside its loop* — N forced reflows
  per `hjkl` press. `nodesCacheRef` (`App.jsx:215–225`) caches the element
  list but not the geometry; cache the rects too and invalidate on scroll/resize.
- `code.codeview` emits one `<span>` per line with no windowing
  (`App.jsx:1166`, `App.jsx:1220`); a 480-line file is 480 spans, and the
  review Z3 view renders the whole file.

---

### P2 — Every streamed token triggers a whole-app re-render *and* a synchronous localStorage write of the entire transcript

`App.jsx:597`:

```js
onToken: (soFar) => { patchTurn({ synthesis: soFar, full: soFar }); setRunProgress(...) }
```

`patchTurn` (`App.jsx:584–589`) copies the whole `turnsByThread` map and its
array. That invalidates every consumer in the tree. Immediately afterwards the
persistence effect fires:

```js
// App.jsx:76–78
useEffect(() => {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ threads, turnsByThread, threadId })) } catch { /* quota */ }
}, [threads, turnsByThread, threadId])
```

`localStorage.setItem` is **synchronous and main-thread blocking**, and the
serialized payload contains every turn's `full`, `trace` and `stdout` arrays.
For a 2,000-token answer that is roughly 2,000 full-tree renders and 2,000
multi-hundred-KB `JSON.stringify` + disk writes. This is the dominant source
of jank during the app's core interaction.

**Fix.**

1. Coalesce token updates — buffer the text in a ref, flush on
   `requestAnimationFrame` (or at ≥50 ms), not per token.
2. Debounce persistence to ~500 ms and write a trimmed snapshot without
   `trace`/`stdout`.
3. Move bulk transcripts to IndexedDB; keep localStorage for config + a
   session index.

---

### P3 — The first agent turn downloads ~1.04 MB of JS, including *both* provider SDKs

Measured from the production build manifest (`vite build --manifest`):

| chunk | bytes |
|---|---|
| entry (React 19 + app) | 351,282 |
| `json-parse` (partial-json) | 312,297 |
| `validation` (typebox) | 158,157 |
| `pi-agent-core` | 18,809 |
| Anthropic SDK | 103,931 |
| OpenAI SDK (`client` + `openai-completions`) | 123,662 |
| **total** | **≈ 1,068,000 (1.04 MB)** |

`src/llm/pi.js:11–24` always fetches both provider SDKs:

```js
const [core, anthropic, openai, ai] = await Promise.all([
  import('@mariozechner/pi-agent-core'),
  import('@mariozechner/pi-ai/anthropic'),
  import('@mariozechner/pi-ai/openai-completions'),
  import('@mariozechner/pi-ai'),
])
```

…even though `config.provider` selects exactly one (`src/llm/config.js:7`).

**Fix.**

1. `loadPi(provider)` imports only the configured provider — saves 104–124 KB
   per turn and removes one parallel fetch from the critical path.
2. Warm the graph off the critical path: `requestIdleCallback(() => loadPi(config.provider))`
   on mount, so the payload is already resident when the user presses Enter.
3. The 351 KB entry cannot be code-split today because `App.jsx` is one file.
   Splitting the pivot pages (P1) lets Vite emit per-pivot chunks, so a user who
   never opens *review* never downloads it.

**Note — a trap worth avoiding.** The build also emits `mistral` (751 KB),
`google-shared` (293 KB), `openai-codex-responses` (17 KB), `otel` (23 KB) and
`validation`. These are **never fetched at runtime** — `register-builtins.js`
lazy-`import()`s each provider, so Rollup splits them and nothing requests them
unless that provider is selected. They are build-output bloat, not a runtime
cost, and `manualChunks` will not help. (Verified empirically: a probe build
importing only `@mariozechner/pi-ai/anthropic` produced 609 KB vs 2.38 MB for
the barrel — but the delta is unreachable chunks, not bytes on the wire.)

---

## 2 · UI

### U1 — Appearance settings silently reset on reload

`App.jsx:65–67`:

```js
const [accent, setAccent] = useState(ACCENTS[0])
const [theme, setTheme] = useState('dark')
const [density, setDensity] = useState(1)
```

Only `config` is persisted (`App.jsx:56` → `saveConfig`, `src/llm/config.js:30`),
and `DEFAULT_CONFIG` (`src/llm/config.js:5–18`) carries no appearance fields —
`accent`, `theme` and `density` never appear anywhere in `config.js`. A user who
picks the cyan accent, the white theme and 150% type scale loses all three on
every refresh, even though the README lists them as shipped features.

**Fix.** Move `accent`, `theme` and `density` into `config` (store the accent by
`name`, not by object) so `saveConfig` picks them up.

---

### U2 — The composer advertises five commands that do not exist

Three separate affordances promise them:

- `App.jsx:1096` — “ask anything. **@ to mention, / for actions**”
- `App.jsx:1014` — “instruct swarm, **: for command, ! for raw shell**”
- `App.jsx:1019` — “type **raw shell command into pty**…”

A search for `startsWith('@' | '/' | '!')`, `mention`, `raw shell` and
`for command` across `src/` returns **only these placeholder strings** — there
is no parser anywhere. `send()` (`App.jsx:567`) always routes the draft to the
engine.

Two of the advertised prefixes also already mean something else: `/` and `:` are
bound globally to open the search morph (`App.jsx:408`), so a user following the
placeholder lands in search instead of a command palette.

**Fix.** Either implement the prefixes — `!`-prefixed drafts route to `runTerm`,
`/` opens a real command registry, `@` inserts a file/agent reference — or
delete them from the copy. Leaving them is the worst option: the composer is
the one surface where a user forms their mental model of what the app can do.

---

### U3 — The opacity-based hierarchy is not contrast-safe, and light theme makes it worse

The entire visual system encodes hierarchy with `opacity` on `--fg` rather than
with distinct colours: `.label` .50, `.threadsub` / `.agentmeta` / `.turnmeta` /
`.setsub` / `.pinstatus` .55, `.faint` .52, `.rows .meta` .50, `.dim` .68.

Compositing `#000` at those opacities over the light theme's `--bg:#fff`
(`src/index.css:15`) gives effective contrast ratios of roughly:

| state | opacity | light theme | dark theme |
|---|---|---|---|
| `.label`, `.meta` | .50 | **3.9 : 1** | 5.3 : 1 |
| `.threadsub` etc. | .55 | **3.4 : 1** | 5.8 : 1 |
| `.dim` | .68 | **2.2 : 1** | 7.4 : 1 |

WCAG AA requires 4.5 : 1 for body text, so the light theme fails across every
secondary text style — and the same token set in dark theme still misses AA at
the 0.35/0.40 states (`.state-queued` .35 → 3.0 : 1, `.pivot` .45 is borderline
at 4.6 : 1 but the README's stated 40 % tier is 3.7 : 1).

**Fix.** Replace opacity-derived greys with explicit per-theme tokens
(`--fg-1` / `--fg-2` / `--fg-3`) tuned for each theme, or at minimum raise the
light-theme opacity floor to ≥ 0.72 and the dark-theme floor to ≥ 0.55. The
Metro look survives intact — it is the *hue* that must change, not the hierarchy.

---

## 3 · UX performance

> “UX performance” read as **felt** speed and flow — how quickly the user reaches
> a result, and how much friction each interaction costs — as distinct from raw
> runtime cost (§1) and visual design (§2).

### X1 — The first seconds of every agent turn show a bare “…”

`send()` seeds the agent turn with `synthesis: ''` (`App.jsx:578`) and column 3
renders `{activeTurn.synthesis || '…'}` (`App.jsx:1111`).

The engine status text — “calling claude-sonnet-4-5…”, “loading local model
(first run downloads it)…” (`src/llm/engines.js:15–16`) — is delivered through
`onStatus`, which only appends to `turn.trace` (`App.jsx:599`). `trace` is
rendered **only** in the Z3 pinned pane and the split view (`App.jsx:1029`,
`App.jsx:1046`) — never in the Z1 column-3 payload where the user is actually
looking.

So during provider connect, the 1.04 MB JS fetch (P3) and first-token latency,
the user stares at “…” with no signal that the request is in flight, which
engine took it, or that it silently fell back to the local model.

**Fix.** Render the trace/status line inline in the Z1 payload column, and show
the live engine name plus an elapsed timer on the running turn. The fallback
event in particular deserves to be loud — `activeTurn.fallbackFrom` is only
surfaced *after* the answer arrives (`App.jsx:1112`).

---

### X2 — Review triage never advances; every hunk costs a manual cursor move

`cursorAction` (`App.jsx:291–292`) sets a hunk to `STAGED` / `REJECTED` but
leaves `selectedHunk` and the spatial cursor exactly where they were:

```js
if (key === 'a') { setHunkState('STAGED'); pushActivity(...); return true }
if (key === 'x') { setHunkState('REJECTED'); pushActivity(...); return true }
```

The information needed to advance is already computed — `unreviewed` at
`App.jsx:667`, shown as the pivot badge — it is simply not used. Triaging a
file of eight hunks means eight extra `hjkl` round-trips and eight re-reads of
the same diff column.

**Fix.** After approve/reject, jump to the next `UNREVIEWED` hunk in the file,
then to the next file with unreviewed hunks, and report the remaining count in
the baseline (`stripLabel` already owns that slot at `App.jsx:681`).

---

### X3 — The fallback engine receives the largest payload and the smallest window

`historyFromTurns` (`src/llm/router.js:17–25`) sends up to **24 turns of full
text**, bounded by turn count and not by tokens:

```js
out.push({ role: t.actor === 'user' ? 'user' : 'assistant', content: text })
return out.slice(-24)
```

The LiteRT-LM path hands that entire history to the model as the conversation
preface (`src/llm/litert.js:46–49`), while `localModel` declares
`contextWindow: 8192, maxTokens: 1024` (`src/llm/pi.js:46–52`).

As a session grows, that history exceeds the 8 k window — and the local model is
precisely the engine that runs *only after* the remote provider has already
failed. The fallback breaks exactly when it is needed. With the seed data it
still fits (~18 turns, ~2–3 k tokens), but the margin is thin and it shrinks
every turn.

**Fix.** Budget history per engine instead of by turn count. Have
`localModel()` / `remoteModel()` publish a `historyBudget`, and have
`historyFromTurns` truncate to it — roughly the last 4 k tokens for the local
path (reserving ~3 k for the 1024-token answer) and the 200 k window for
Anthropic. Prefer dropping the oldest turns and keeping the most recent
exchange intact.

---

## Summary

| # | Area | Finding | Primary file |
|---|---|---|---|
| P1 | perf | One component, seven live pages, full re-render every 1.6 s | `src/App.jsx:30` |
| P2 | perf | Per-token full re-render + per-token synchronous localStorage write | `src/App.jsx:597`, `:76` |
| P3 | perf | 1.04 MB first-turn payload; both provider SDKs always fetched | `src/llm/pi.js:11` |
| U1 | ui | Accent / theme / type scale never persisted | `src/App.jsx:65` |
| U2 | ui | Composer advertises five commands that are not implemented | `src/App.jsx:1096` |
| U3 | ui | Opacity hierarchy fails WCAG AA, worst in light theme | `src/index.css:15`, `:65` |
| X1 | ux | Agent turn shows a bare “…” until the first token | `src/App.jsx:1111` |
| X2 | ux | Review triage does not advance to the next hunk | `src/App.jsx:291` |
| X3 | ux | Token-blind history budget breaks the local fallback | `src/llm/router.js:24` |

**Suggested order:** U1 (one-line class of fix, user-visible immediately) →
X2 (the review tool's core loop) → P2 → P1 → X1 → X3 → P3 → U3 → U2.
