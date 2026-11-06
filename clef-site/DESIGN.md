# CLEF — product site design

Internal design doc for the website at `clef-site/`. Source of truth for name,
copy, UX, and the new visualization component. Do not confuse with the Rust
implementation, which is owned by the active feature agent and untouched here.

---

## 1. Concept + Subject

**Product name: CLEF**

A clef is the key signature at the start of a staff — the symbol that tells you
how to read the lines. CLEF (the product) reads the lines of a transformer's
residual stream and tells you, before a tool call executes, whether the model
*means* harm.

- Wordmark: `CLEF` set in Doto (dot-matrix), tracked tight, always uppercase.
- Category line: **Secure infrastructure for AI-generated code.**
- Hero statement: **KEEP YOUR ASSET SAFE BEFORE IT RUNS.**
- Deck: "Clef applies intelligence to agent traces at the moment code becomes
  execution. It surfaces the most critical patterns in the residual stream —
  the intent the model already carries — and refuses the call before it runs.
  No second model. No generation round trip."
- Voice: the copy is pieced together from the registers of Cloudflare
  engineering posts (measured throughput language), XBOW docs (assessments,
  findings, severity, risk score, target protection), Daytona docs (from code
  to execution, isolation, programmatic access) and Braintrust docs
  (instrument / observe / evaluate, traces, production visibility). No invented
  slogans or slang — every rhetorical line originates in those four surfaces.
- Tone: confident, technical, measured. Peer-to-peer with young agentic
  developers. Numbers first.

**The one-sentence pitch a user would repeat:**
"Clef is a proxy that reads the model's residual stream instead of grepping
the command string — so `rm -rf` in a comment doesn't trip it, and an exfil
payload hidden in a `curl` does."

## 2. Audience + competitive frame

Young agentic developers (18–30), cybersecurity-curious, performance-sensitive.
Their mental models: `iptables`/`nftables` for packets, `eBPF` for syscalls,
`seccomp` for calls — nobody has shown them a *readable, instrumented* guard at
the model layer. The site must feel like an instrument panel they want on a
second monitor, not a compliance PDF.

Two things they care about, in order: **can it be gamed?** (security) and
**what does it cost?** (performance). Both get their own section with honest
numbers from real captures and the repo's published benchmarks.

## 3. Inspiration DNA extract

- **Nothing / TE industrial**: OLED black, dot-matrix display type, instrument
  labels in monospace caps, mechanical honesty (controls look like controls),
  one signal color as an interrupt.
- **Security tooling dashboards** (Wireshark dark, Grafana, k9s): data density,
  tabular figures, a live tape of events.
- **The residual stream itself**: 24 stacked layers, a probe at 68% depth,
  a harm axis written into geometry. This is the site's primary visual —
  not an illustration of it, the actual structure.

## 4. Palette + Typography

### Palette (dark and light are both first-class)

Tokens live in `styles.css` and match `nothing-design/references/tokens.md`
exactly. Dark is the OLED instrument panel (`#000` page); light is the printed
technical manual (`#F5F5F5` page). The theme toggle lives in the status strip
and persists in `localStorage`; `prefers-color-scheme` seeds the default.
Status colors are identical across modes.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--black` | `#000000` | `#F5F5F5` | page background |
| `--surface` | `#111111` | `#FFFFFF` | panels, console chrome |
| `--surface-raised` | `#1A1A1A` | `#F0F0F0` | inset wells, code |
| `--border` | `#222222` | `#E8E8E8` | structural hairlines |
| `--border-visible` | `#333333` | `#CCCCCC` | intentional rules, axes |
| `--text-disabled` | `#666666` | `#666666` | inactive ticks |
| `--text-secondary` | `#999999` | `#666666` | labels, metadata |
| `--text-primary` | `#E8E8E8` | `#1A1A1A` | body |
| `--text-display` | `#FFFFFF` | `#000000` | headlines, hero numbers |
| `--accent` | `#D71921` | `#D71921` | **the interrupt** — BLOCKED, over-threshold |
| `--success` | `#4A9E5C` | `#4A9E5C` | PASSED / allowed values |
| `--warning` | `#D4A843` | `#D4A843` | clamped / advisory |
| `--interactive` | `#5B9BF6` | `#007AFF` | PCA/secondary data series only |

The type scale is tokenized (`--display-xl … --label`) and the spacing scale
(`--space-2xs … --space-4xl`) drives the layout rhythm. Data-status rule:
color the **value**, never the row or the label.

### Iconography contract

`js/icons.js` — monoline set on a 24×24 viewBox, 1.5px stroke, round
caps/joins, no fill, `currentColor` inherits. Max 6 strokes per glyph. The one
color exception is the mark's accent bead. Set: `mark`, `chevronDown`,
`chevronRight`, `arrowDown`, `plus`, `minus`, `check`, `block`, `external`.
Hydrated via `data-icon="name"` + `data-icon-size`.

### Logo

`assets/mark.svg` — the product's one real shape: the residual ring with the
probe interrupt at 68% depth (gap in the ring, accent bead). Used in the
status strip and footer lockup; `assets/favicon.svg` is the favicon
derivative. The wordmark is `CLEF` in Doto, tracked tight, always uppercase.

### Typography (Google Fonts, loaded once)

- **Doto** (variable dot-matrix) — hero display only, ≥36px.
- **Space Grotesk** 300/400/500 — headings and body.
- **Space Mono** 400/700 — labels (ALL CAPS, 0.08em tracking), numbers,
  commands, the event tape.

Load: `https://fonts.googleapis.com/css2?family=Doto:wght@400..700&family=Space+Grotesk:wght@300;400;500;700&family=Space+Mono:wght@400;700&display=swap`
with `preconnect` to `fonts.gstatic.com`. Fallbacks: `Space Mono, monospace`
and `system-ui, sans-serif`. If the page is opened fully offline the fallbacks
carry it; no layout break.

Scale: `display-xl 72/1.0/-0.03em` · `display-lg 48/1.05` · `heading 24/1.2`
· `body 16/1.5` · `body-sm 14` · `label 11/1.2/0.08em`.

## 5. Layout system

- 12-column Swiss grid, 32px gutters, max width 1280px, page padding 24px
  (16px mobile). Vertical rhythm 96px between major sections, 48px inside.
- No cards with shadows. Containers: spacing → single hairline → surface shift,
  in that preference order.
- Asymmetric compositions: hero is left-heavy type + right 3D field bleeding
  off the right edge; console is 7/5 split (instrument / tape).
- Exactly three hierarchy layers per screen (primary display / secondary body /
  tertiary mono label).

## 6. Section structure (top → bottom)

Composition bar: typesafe.ai — manifesto hero with kickers, "X, not Y" contrast
pairs, three pillars, one giant proof number with an asterisk footnote and a
proof link, comparison strip, product surface, FAQ, version stamps. Beaten at
composition by matching that rhythm; beaten at vibe by the Nothing instrument
identity + the live console (their site has no interactive equivalent).

1. **Hero · manifesto** — kicker `AUTOMATED ASSESSMENT · ACTIVE OBSERVABILITY`,
   H1 **WE ASSESS THE TRACE, NOT THE PROMPT.** (accent on the "not" clause),
   kicker `FROM CODE TO EXECUTION`, deck with the value prop (intelligence on
   agent traces → most critical patterns in the residual stream → refused before
   it runs → no second model), CTAs `RUN AN ASSESSMENT` / `INTERPRETING
   RESULTS`, hero stats, base64 stamp that decodes to the real decision rule,
   WebGL residual-stream field.
2. **01 · POSITION** — three pillars as contrast pairs: `TRACES, NOT PROMPTS`
   (68% depth) · `RISK SCORE INCLUDED` (5 benign calls in the baseline) ·
   `FROM CODE TO EXECUTION` (1 forward pass).
3. **02 · IMPACT** — giant proof claim `17/18 findings blocked. 0/18 false
   positives.` with `*` footnote and (proof) link; CLEF vs LLM-AS-JUDGE
   comparison strip; benchmark rows (31/40, 7/8, 896).
4. **03 · ATTACK SURFACE** — the gaming argument, two real capture rows
   (string vs geometry), three vulnerability classifications.
5. **04 · CONSOLE** — the open window (see §8).
6. **05 · INTERPRETING RESULTS** — five-step assessment + risk-score rule.
7. **06 · INTEGRATIONS** — API path and CLI path, get-started commands.
8. **07 · TROUBLESHOOTING ASSESSMENTS** — FAQ accordion, honest limits.
9. **Footer** — trust-and-safety pledge, reference paths,
   `CLF.0S1 · VERSION 0.01 · © 2026`.

## 7. Signature visual — the residual stream field (three.js)

The hero centerpiece, and the site's memorable moment:

- 24 **layer rings** stacked in Y (the decoder depth), each ring a thin
  torus of points. Ring 16 (the probe) is brighter and labeled `PROBE 16/24`.
- A **stream** of ~3–6k particles flows upward through the rings (the residual
  stream). Neutral particles are near-white at 20% opacity.
- **Harm axis**: when the user picks a harmful scenario (or the live tape sees
  one), a red axis draws through the field from the origin and particles near
  it tint to `--accent`; the probe ring pulses.
- **Clamp moment**: if the verdict is BLOCKED, the stream *stops at the probe
  ring* — particles flatten into the ring and die out with a sharp fade. If
  PASSED, they continue through the top. This is the product in one gesture.
- Mouse: subtle camera parallax (±4°). Scroll: the camera dollies out slowly
  as the hero leaves the viewport. Click on the field: next scenario.
- Must run offline from `vendor/three.module.js`. No bloom pass (nothing-design
  forbids glow chrome); brightness comes from opacity layering.

## 8. THE CONSOLE — the interactive open window

Layout 7/5:

**Left (instrument):**
- **Scenario rack** — 18 real captured calls in 3 cluster lanes (DESTROY /
  STEAL / EXFIL). Each row: tool name, command preview (Space Mono), a live
  `excess` figure. Selecting one loads it into the instruments and drives the
  hero field state (if visible).
- **Knobs** (the point of the section):
  - `THRESHOLD` — range 0.00–0.20, default from the capture's operating point.
    Re-judges the real corpus live: `blocked = harm_excess ≥ threshold`.
    Dragging it sweeps the whole rack's verdicts and redraws the gate.
  - `MODE` — `ENFORCE` / `MONITOR` segmented switch. Enforce shows the 403
    path; monitor shows pass-through + report. Both real modes of the binary.
  - `BASELINE` — `PANEL` / `OFF`. Off shows raw `harm_cosine`, demonstrating
    the offset story (benign `cargo clean` +0.002 vs +0.052 across prompts —
    real numbers from `extract_repe_vectors.py`).
  - `CLUSTER` — filter chips for the three harm clusters.
- **Verdict gate** (new viz component, §9): big state word `PASSED` / `BLOCKED`
  / `CLAMPED`, the excess meter vs threshold, the reason string from the real
  verdict, advisories.
- **Command input** — "judge your own". When a live guard is attached it really
  POSTs `/v1/guard/tool-call` and returns the real verdict. When not attached
  the control is visibly disabled with `[ REQUIRES LIVE GUARD ]` — never a dead
  button.

**Right (tape + spine):**
- **Layer spine** (new viz): 24-layer cosine profile of the selected event,
  probe marker, threshold line.
- **PCA triad**: PC1/PC2/PC3 bars from real `pca_coords`.
- **Event tape**: scrolling mono log of the corpus as it is re-judged by the
  threshold knob, with timestamps from the real `ts_ms`.

**Data honesty contract (Constitutional Law 2):**
- All readings come from `data/replay.json` — real captures from the live guard
  (36 verdicts + 36 SSE events, 2026-11-06). Nothing is simulated.
- A persistent chip on the console reads `[ REPLAY · REAL CAPTURE ]` or
  `[ LIVE · 127.0.0.1:8090 ]` — whichever is active. Live attach wins.
- The threshold knob re-evaluates the decision rule over recorded measurements;
  it does not invent new cosines. The chip says `[ RULE REPLAY ]` while
  dragging.
- If no live guard: new-command judging is disabled, not mocked.
- (Verbatim authorization record for the interactive demo surface, from the
  user's request: "We will host a fully loaded open window into it with letting
  you touch the knobs and shit." — this authorizes the knob surface; every
  number in it is still a real capture.)

## 9. New visualization component — `clef-viz.js`

Replaces the chart approach of `viz_ui.html` (which stays untouched) with a
reusable, framework-free module that both this site and a future dashboard
embed. Renders into plain containers; accepts the exact `TelemetryEvent` /
`ProbeVerdict` JSON shapes from `enforcer_proxy.rs` — no adapters that invent
fields.

Four views:

1. **LayerSpine** — SVG. X = harm cosine, Y = layer index 0…n-1. Polyline +
   dots; probe layer ringed in accent; vertical threshold hairline; baseline
   hairline. Tooltip on hover shows `L12  +0.041`.
2. **ExcessGate** — SVG instrument. A horizontal meter: `baseline` tick →
   `harm_cosine` value marker → `excess` bar → `threshold` gate line. State
   word in Doto. Animated transitions 200ms ease-out (no bounce).
3. **PcaTriad** — three vertical bars (PC1/PC2/PC3), zero line, scale labeled
   from `pca_subspace_energy`.
4. **EventTape** — DOM list. Mono, one row per event: `ts  tool  excess
   VERDICT`, newest on top, accent for blocked rows. Auto-scrub with manual
   scroll takeover.

Design rules inherited from nothing-design: opacity before color, labels in
Space Mono caps, no gradients/shadows, 2px strokes, tabular numerals.

## 10. Interaction list

| Trigger | Change |
|---|---|
| Load | hero type renders immediately; stream field fades in 400ms |
| Mouse move on hero | camera parallax ±4°, probe ring label tracks |
| Click hero field | advance to next scenario, gate re-animates |
| Scroll past hero | camera dollies out; hero type lifts 24px (opacity only) |
| Select scenario row | instruments update (spine, gate, triad); hero harm axis + pass/block gesture |
| Drag THRESHOLD | gate line moves; all rack rows re-judge; tape appends; count `blocked n/18` updates |
| Toggle MODE | gate state word swaps PASSED↔BLOCKED presentation; reason string stays real |
| Toggle BASELINE OFF | gate redraws on raw cosine; offset annotation appears |
| Cluster chip click | rack filters; counts update |
| Click `JUDGE` (live only) | real POST; row appends to tape with live event |
| Hover spine dot | tooltip with layer index + cosine |
| Theme: none | dark-only (the instrument mode). Light mode deferred. |

## 11. Tech stack

- **Static, no build step.** `index.html` + `styles.css` + ES modules.
  `vendor/three.module.js` (r170) for the hero field. No CDN at runtime.
- `clef-viz.js` — vanilla SVG/DOM module (shared with future dashboard).
- `console.js` — knob state machine + live/replay data source.
- `field.js` — three.js residual-stream scene.
- Data: `data/replay.json` (real capture). Live: `fetch` + `EventSource` to a
  configurable base URL (default `http://127.0.0.1:8090`), CORS-safe when the
  guard allows it; on failure fall back to replay and show the chip.
- Fonts: Google Fonts link with solid local fallbacks (works offline).
- No analytics, no external requests beyond fonts (and those degrade offline).

## 12. Priority

**Core must-do**
1. Hero with residual-stream field + the clamp/passthrough gesture.
2. The console with real replay data and the three knobs (threshold / mode /
   baseline) that visibly change verdicts.
3. `clef-viz.js` LayerSpine + ExcessGate driven by real event shapes.
4. Copy for every section, with real numbers and honest limits.
5. Live-attach path (read `/api/info`, POST `/v1/guard/tool-call`).
6. Visual QA against this doc (3–5 rounds hero, 2–3 console).

**Optional bonus**
- PcaTriad + EventTape polish, light mode, scenario autoplay loop,
  `prefers-reduced-motion` static fallback for the field.

## 13. Honest limits to print on the page

- Thresholds transfer within a prompt distribution, not across it (README).
- The zero-shot direction is much weaker than a calibrated one (~0.01 vs
  0.2–0.4 cosine scale).
- Clef head questions are `Option`: untrained head ⇒ reported as unavailable,
  never drawn from random weights.
- Task-drift signal is advisory only.
- The one harmful call that passed the capture (`cat ~/.ssh/id_rsa.pub`) is a
  *public* key — print this as evidence we show misses, not a perfect score.
