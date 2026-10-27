# zune code

The standard agentic coding desktop interface ‚Äî conversations, subagents,
files, review/diff, terminal, artifacts, background tasks (the layout in
`~/dede.png` and tools like webclaw) ‚Äî rebuilt in **Pre-Win8 Desktop Metro
(2009‚Äì2011)**: the Zune 4.8 desktop language, modernized for high-DPI
monitors, trackpads, and keyboard-first work. No Windows 8 touch dogma.

## run

```powershell
npm install
npm run dev   # http://127.0.0.1:5177
npm test      # node:test data-integrity checks for turns/hunks
```

## the four resurrected mechanics

1. **Typographic pivots, no left sidebar.** Navigation is the header:
   oversized light lowercase words (`hub conversation collection review
   terminal agents settings`), active at 100% opacity on the left margin,
   the rest muted and bleeding off the right edge ‚Äî exactly as Zune's
   QUICKPLAY/COLLECTION strip. `Alt+‚Üê/‚Üí`, `Tab`, `Ctrl+1‚Äì7`, or a
   two-finger horizontal trackpad swipe pans the whole canvas laterally
   (420 ms cubic ease-out, Dorado's `PivotParallaxTransition` timing).
   The ~280 px a sidebar would eat is content width.

2. **Bento hub as root, killing master‚Äìdetail.** The hub is a spatial
   dashboard: pinned conversations as borderless typographic blocks (left, urgent = magenta type, focused = 3px gutter bar), the live agent
   run as huge type (center), recent activity + artifacts (right).
   Opening anything replaces the whole window via a 150 ms scale-and-fade
   into a full-bleed focus view ‚Äî nothing is ever squeezed beside a list.
   The conversation thread switcher is a typographic row, not a column.

3. **Semantic zoom as spatial minimap.** `Ctrl+‚àí`, `Ctrl+wheel`, `Esc`,
   or `map ‚àí` steps back to proportional architectural blocks of the
   project (conversations, folders, review, agents). Click a block to
   land inside it at full size. `Ctrl+=` / focus steps to a
   distraction-free single-thread zoom level.

4. **Typography as structural chrome.** `border-radius: 0` and no shadows
   anywhere (Dorado's Content-Before-Chrome rule). No cards, no 1 px
   dividers, no chat bubbles. Grouping comes from type scale (56 px
   display ‚Üí micro-labels), Segoe UI/Selawik Light vs Semibold, opacity
   states (100 / 85 / 40), and whitespace on a strict left grid.

**collection** is Zune's
artists/albums/songs triple-column as folders/files/code; **social**
became **agents**; accent swatches use the authentic Zune 4.8 magenta
family (`#F10DA2 / #FA6EC9 / #B9077B`) plus orange/cyan/lime/purple.

Everything is interactive against seeded local state: send a prompt
(streamed simulated run), pin to hub, approve the diff, run terminal
commands (`help`), pause agents, search (`Ctrl+K`), switch accent /
black-or-white theme / 100‚Äì150% type scale for high-DPI.

Reference projects in the parent folder: `dorado-main` + `dorado-hd`
(Zune desktop successor, source of the design tokens),
`bigaouette-metro-ui-main` (Selawik fonts used here), `NeoPod-main`.
## conversation + review: the turn matrix and hunk triage

Both pivots share one geometry: **25 / 35 / 40 columns, 32px whitespace
gutters, zero divider lines**, and neither has a monolithic scrollbar.

**conversation4** is Threads ? Turn Timeline ? Active Turn Payload.
Col 2 is a numbered 3-line-per-turn index (`01 user`,
`04 e2e_test_writer_1 ∑ 72%`) ó a 25-turn workflow fits on one screen.
Resting the cursor on a thread or turn instantly swaps cols 2ñ3. Col 3
shows prompt intent, distilled synthesis, big numeric callouts, and
emitted artifacts. `Enter` is the z-axis: the turn expands to a
full-width reader (raw text ∑ reasoning/tool trace ∑ stdout); `Esc`
snaps back. `i` (or `Space`) opens a borderless prompt at the top of
col 3 ó there is no persistent composer box. `r` jumps to review,
`y` copies the artifact.

**review≥** is Change Sets ? Mutation Hunks ? Hunk Diff & Rationale,
grouped by the task that produced the change, files indented by
whitespace with a secondary 2px bar. You review discrete logical hunks
(`02 ∑ lines 138ñ164 ∑ verifyToken() ∑ +31/-8 ∑ auth boundary`), not
files: `j` to the hunk, read the ~12-line diff (tint + left-margin
bars, never highlight boxes) and the writing agent's rationale +
verification status, then `a` approve/stage, `x` reject, `c`
instruct the agent inline. `Enter` expands the full file at the
hunk's line. The pivot badge counts UNREVIEWED hunks.

On a phone (=760px) the matrices become Zune HD drill-in pages: one
column per page, cropped-title back header, right-flick back, the
baseline as a tappable application bar, horizontal flick to pan
pivots. See MOBILE.md for the review that produced this model.

Motion (Settings ? motion, all per-card opt-in): WP-style press tilt,
grid-snapped square spotlight, flat offset-block glow, text shimmer on
running work, fold-in map blocks, a left-to-right column cascade when
a pivot activates, and two-face flip cards (pinned hub cards flip to
quick actions, [f] or their flip button) ó motion-primitives/motion-
panels ideas reimplemented in plain CSS under MDL law: zero radius,
no blur shadows, no radial gradients. `prefers-reduced-motion` kills
all of it.
## engines ó it's not a demo anymore

Sending a prompt runs a real agent turn through **pi**
(`@mariozechner/pi-agent-core` + `pi-ai`, lazily loaded ó the shell
bundle doesn't pay for it): tool calling, session/transcript state, and
provider streaming are off-the-shelf; only the routing glue is ours
(`src/llm/`). The Claude Agent SDK / OpenAI Agents SDK are Node-only
and can't run in a webview; pi's providers call the same Anthropic /
OpenAI-compatible APIs directly from the browser with your key.

Routing (`auto`, in Settings ? engine): **native bridge** (optional
sidecar, see BRIDGE.md) ? **remote** (Anthropic or any OpenAI-compatible
endpoint, with read-only workspace tools: `list_files`, `read_file`,
`get_diff`, `search`) ? **LiteRT-LM local** (`@litert-lm/core`,
WebGPU, adapted into the same pi loop as a custom StreamFn). Nothing is
bundled: Gemma 4 E2B downloads lazily on first chat when no key is set,
or in the background after your first successful remote turn. Any remote
error (bad key, quota, timeout ó 45s budget) routes to the local model,
which is told what failed so it can help you fix the config *and* still
answer. Every turn is tagged with the engine that produced it; `auto`
never silently fakes an answer ó `demo` (the old simulated replies) is
an explicit mode only. Threads, turns, and config persist in
localStorage; API keys never leave the browser except to the provider.
