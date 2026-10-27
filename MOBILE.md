# mobile review — zune code at phone size

Reviewed at a true **390×844 CSS viewport, DPR 2, touch emulation on**
(CDP `Emulation.setDeviceMetricsOverride`). Screenshots: `mv-hub.png`,
`mv-conversation.png`, `mv-review.png`, `mv-collection.png`,
`mv-agents.png`, `mv-map.png` in this folder.

> Method warning: desktop Edge headless enforces a ~479–518px minimum
> window width, so `--window-size=390,844` screenshots are a wider
> layout cropped to 390px and **lie about right-edge clipping**. The
> first batch of phone shots taken that way (`m-*.png`, deleted)
> overstated several overflow bugs. Everything below is from the
> emulated-viewport captures, with `innerWidth` read back as 390.

## what the native shells in this repo do

**Dorado-HD** (`../dorado-hd`, Android/Compose) is the authority — it
recreates the Zune HD *device* UI (2009) and is explicit about the
canon: white-on-black typography-first, a home menu in **lowercase
oversized type, right-edge cropped, kinetically scrollable**, a
horizontal **crossbar pivot strip** per section (380ms deceleration
slide), Quickplay as a "left and rear" 3D-parallax layer, **swipe
gestures** as primary input (swipe-to-skip, vertical-swipe volume),
and back navigation via **tapping the cropped header** — which they
*also* supplement with a faint explicit back arrow because, quoting
their rationale, the cropped header alone was hard to discover.
Original canvas: 480×272.

**NeoPod** (`../NeoPod-main`, iOS/SwiftUI) is looser: 64pt page
titles, a **48pt circular back button** in the accent color, black
background. Useful as touch-target evidence (nothing tappable is
small), less useful typographically (rounded system font, not
Segoe/Selawik metrics).

## so what is phone Metro supposed to look like?

Not desktop columns squeezed. On a phone, Metro (Zune HD → Windows
Phone) is:

1. **One column at a time, laterally flicked.** Pivots/panorama
   sections sit side-by-side on a horizontal canvas; you flick
   between them or tap the next cropped header. Vertical scrolling
   happens *within* one section only.
2. **Hierarchy by drill-in, not by stacking.** Tap an item → it
   becomes the page, its title becomes the cropped header you tap
   (or flick right / tap the back arrow) to return. Depth is pages,
   not a longer page.
3. **An application bar, not a hint line.** The bottom ~48px holds
   the current page's 2–4 commands as real tap targets.
4. **Type stays huge, targets stay ≥44px, margins 24px.** Display
   type barely shrinks from desktop; body/mono does.

Our desktop matrices translate 1:1 into this model: conversation's
three columns are really three *pages* (threads → timeline →
payload), and review's are three more (sets → hunks → diff). That
drill-in conversion is the recommended next pass (below). What we
ship today at ≤760px is the fallback form: the columns stacked in
reading order. Readable — but it quietly resurrects the vertical
scroll both pivots exist to kill.

## findings at 390×844 (after this pass's fixes)

**Works, genuinely.** The typographic lists are the best-looking
thing at phone size — hub, conversation col 1/2, and review col 1/2
already read like Windows Phone lists: left-aligned light type,
uppercase micro-subtitles, magenta for state, 60–90px row heights.
The pivot strip with cropped bleed is *more* at home here than on
desktop. Terminal is fine (mono wraps).

**B1 — Pivot header sat 24px off-grid (fixed).** The strip's
translate hardcoded the desktop 48px margin while ≤1100px pages use
24px, so the active pivot word floated right of every label under
it. Now breakpoint-aware.

**B2 — Semantic-zoom map was broken (fixed).** The desktop 4-column
grid with 56px gutters left ~65px columns at phone width; labels
clipped and blocks ran off-edge. Now a 2-up map with 84px rows.

**B3 — Display type clipped instead of wrapping (fixed).**
`e2e_test_writer_1` at 56px has no break points (underscores don't
wrap) and was truncated mid-name. Phone ramp (huge 36 / big 24 /
pivot 32) + `overflow-wrap:anywhere` on display type.

**B4 — Topline overflow (fixed).** Wordmark + workspace + MAP +
"+ new conversation" exceeds 390px. Workspace name hides and the
button shortens to "+ new" at ≤760px.

**B5 — The baseline was dead text on touch (fixed).** Keyboard
hints (`[enter]`, `[p]`) with no keyboard, clipped at both ends.
The strip's actions are now real buttons executing the same
actions — i.e. it functions as the WP application bar — with
44px-ish tap padding, model name dropped, horizontal scroll when
actions overflow.

**B6 — No touch navigation existed (fixed, basic).** Pivots were
keyboard/trackpad/wheel only; off-screen pivots needed repeated
taps on partial words. A horizontal flick anywhere now pans one
pivot (vertical-dominant touches still scroll), and tapping a turn
/ hunk / agent scrolls its payload column into view on narrow
screens.

**B7 — Matrices stack vertically (fixed, drill-in pass).** Payload
(col 3) sat below two full lists; agents telemetry below *three*
sections. Now at ≤760px each matrix column is its own page, in the
Dorado-HD detail-scaffold form: threads → timeline → payload,
change sets → hunks → diff, folders → files → code, agents →
telemetry. Back is a cropped parent-title header with a faint
`‹` arrow (also: rightward flick, or `Esc`); drilled-away columns
are `display:none`, and the spatial cursor skips invisible nodes.
Desktop is untouched — levels are inert state above 760px.
Verified with a CDP tap sequence at true 390×844:
`md-conv-L0-threads.png` → `md-conv-L1-timeline.png` →
`md-conv-L2-payload.png` → back, and the same for review
(`md-rev-L0/L1/L2`).

**B8 — Code on collection (open, minor).** Mono is now 0.78em and
the block scrolls horizontally, but there's no scroll affordance
and long lines just end at the edge. Options: wrap code, or keep
scroll and fade the right edge. Desktop reviews never hit this.

**B9 — Touch-irrelevant content (fixed, polish pass).** Settings
now swaps its keyboard manual for a touch gesture set under
`pointer:coarse` (flick, drill, pinch, baseline); the baseline
drops its `[key]` brackets on coarse pointers and shows plain
action labels; every sticky accent/opacity hover state is reset
under `@media (hover:none)` so taps leave no residue.

**B10 — Platform fit (fixed, polish pass).** `viewport-fit=cover`
plus safe-area insets as app padding (notch/home-indicator safe),
height is `100dvh` so mobile URL bars resizing the viewport don't
jump the layout, and two-finger **pinch is semantic zoom**: fingers
close → step out to the map, spread → step back in (thresholded,
one step per ~1.4× distance change). Verified causally over CDP
touch injection: zoommap absent → pinch-in → present → pinch-out →
absent, at 390×844 with `pointer:coarse` true
(`mp-pinch-out-map.png`, `mp-settings-touch.png`).

## verdict

As an experiment it landed closer than expected: because the design
is already "type on black, no boxes," the lists needed almost
nothing to look native at phone size, and the pivot header is
literally a phone pattern wearing a desktop suit. With the
drill-in pass (B7) done — one matrix column per page, cropped-title
back header, right-flick back, tappable application bar from B5 —
the phone form is now a real navigation model, not a squeezed
desktop. The polish pass (pinch semantic zoom, hover gating,
touch Settings/baseline, safe-area/`100dvh`) is also done. Only
B8's code-scroll affordance remains, deliberately: wrapping code
destroys alignment, and an edge fade is a gradient — both fight
the design language more than a clean horizontal scroll does.
