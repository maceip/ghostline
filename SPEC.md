# zune code — consolidated product specification

Authoritative layout/interaction spec (supplied 2026-10-26, restored after an
agent-side deletion — this file is the durable copy). Implementation lives in
`src/App.jsx` + `src/data.js` + `src/index.css`; each section notes where.

A high-concurrency, borderless Zune/Metro UI to manage N=50–500 autonomous
coding agents without a 3-pane sidebar or the chat "scroll of death".

## 1. Spatial viewport & two-tier header (zero left sidebar) — `App.jsx` topline/pivotrail

- 100% horizontal viewport: no persistent left rail. Every mode owns full width.
- **Tier 1** (10pt bold uppercase session strip): workstreams inline across the
  top edge with live status (`01 BOARD OF DIRECTORS [1 BLOCKED]  02 SIEM
  WORKBENCH [READY] …`), addressed via **Cmd+1..9**.
- **Tier 2** (42pt Segoe Light lowercase pivots): `hub conversation⁴
  collection review³ terminal agents² settings`, cropped type bleeding
  off-edge, superscript numerals instead of pill badges.
- **Faceted sub-pivots**: zoomed into a session, Tier 2 re-scopes to facets
  (`all turns¹⁴² my prompts²⁴ decisions⁹ mutations¹⁴ live pty³ artifacts⁷`).
- **Inline command ribbon** (`:` or Ctrl+K): the active 42pt header word
  morphs in place into the search/command cursor — no floating modal.

## 2. Borderless Swiss grid & polymorphic telemetry tiles — hub

- Typography as chrome: no borders/shadows/dividers; 25/35/40 columns,
  32px gutters; 36pt light numerals, 10pt bold uppercase labels.
- **Telemetry tiles** (N=4–10, cap 8 squares): only active, staged, or blocked
  workstreams earn a 2x2 square; idle sessions demote to 1-line text rows.
  Four zones: scope+age (top), polymorphic big numeral by phase
  (exploring=`18 files`, mutating=`+48 −12`, verifying=`12 / 14`,
  blocked=`FAIL :142`, ready=`04 hunks`), identity + live tail/blocker,
  bottom-edge progress. Nominal `#141414`; blocked = solid hot pink
  `#FF0097` with the exact question and inline **[y]/[n]** on the tile.
- **Epochs**: long sessions auto-segment (`[ E04 · KEYCHAIN VAULT SURVEY ·
  18 turns ]`); `z` collapses to a single-screen 2D epoch jump grid
  (alphabet-jump applied to time) for two-keystroke teleportation.

## 3. Four-stop semantic zoom (Ctrl+scroll, Enter/Esc, +/−) — `zoom` 0..3

- **Z0** macro fleet map (10%): proportional heat blocks, single-key
  home-row jump badges (a s d f…).
- **Z1** 3-column spatial hub (30%): the default workbench; compact 3-line
  turn/hunk indices; oversized telemetry (`35` tasks, `29/31` suites).
- **Z2** decisions & mutations ledger (60%): only prompts, decisions, and
  AST hunks side-by-side; no filler, no raw stdout.
- **Z3** full-bleed focus (100%): 60% terminal/turn stream + 40% pinned
  diff/invariant surface; `v` pins a second node 50/50. Enter dives, Esc
  steps back. Font size never shrinks — structure changes.

## 4. Keyboard-first 4-axis ergonomics & bottom baseline

- `h j k l` spatial plane across gutters; `[`/`]` or Alt+←/→ pan pivots;
  `f` arms two-letter gutter jump badges (`aa`, `as`, `sd`…); Tab slices
  facets at Z3.
- **Fleet heartbeat**: 2px segmented strip — running (magenta) / verified
  (green) / queued (gray) / blocked (amber) ratios across all agents.
- **Contextual baseline**: borderless keybinds for the focused node on the
  left (`[a] approve [x] reject [c] instruct [v] pin split`), token/compute
  velocity + engine on the right. Never media transport controls.

## 5. The three wireframes

1. **Z1 hub** — Tier1 sessions, Tier2 pivots; col1 telemetry tiles + idle
   rows + epochs, col2 subagent pipeline with phases, col3 mutation stream,
   staged artifacts, session metrics.
2. **Z3 session** — `← HUB [esc]` + sessions + `Z0─Z1─Z2─■Z3`; facet bar;
   epoch strip; stream with milestone headers, PTY output, interrupt gate
   with `[y]/[n]/[c]`; pinned live diff + invariant gates + epoch workers.
3. **Settings** — same 25/35/40 grid: col1 configuration domains
   (`01 AGENT POOL & ROUTING` … `06 DAEMONS & LOCAL ENDPOINTS`), col2
   parameters adjusted with h/l or Enter (no dropdowns/toggle pills),
   col3 live velocity, pool saturation, and a **live tile-escalation
   preview**. `[r]` resets a domain.

## Geometry rules

1. Strict 32px gutters, zero vertical lines. Alignment from text edges and
   9–10pt bold uppercase section headers only.
2. Tile cap N≤8; everything else is a text row.
3. Interrupt = solid `#FF0097` + inline `[y]`/`[n]` resolvable from hub,
   no zoom required.
4. Accent is themeable in-app; magenta `#f10da2/#FF0097` family is default.

## Verification

`npm test` (data contracts incl. tiles/epochs/gate invariants),
`npm run build`, and CDP screenshot passes per wireframe. CI
(`.github/workflows/ci.yml`): test → build → serve `dist` → fetch every
referenced asset → brand-asset guard.
