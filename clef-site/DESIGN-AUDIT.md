# CLEF — design audit

Nothing-design system audit of the CLEF product surface (`clef-site/`):
marketing page, console, visualization component, logo, iconography, imagery,
and tokens. Reviewed at 1280×800 against `nothing-design/references/tokens.md`
and `components.md`, eight section captures, and a CSS census.

**Fonts in use (declared):** Doto `wght 100..900` · Space Grotesk 300/400/500/700 ·
Space Mono 400/700 — loaded via Google Fonts with system fallbacks.
**Mode:** dark only (OLED `#000`). Light mode does not exist. See P1-4.

---

## Verdict by dimension

| Dimension | Grade (before) | Grade (after) | One line |
|---|---|---|---|
| Anti-patterns | **A** | **A** | No gradients, shadows, blur, zebra, skeletons, toasts, or bounce. |
| Composition | **A−** | **A−** | Manifesto rhythm holds; P1 tally competition fixed. |
| Data visualization | **B+** | **B+** | Instrument-grade; gate meter segmentation still open (P2-5). |
| Typography | **B−** | **B−** | Type scale now tokenized; size collapse still open (P3-9). |
| Tokens | **C+** | **A** | Snapped to `tokens.md`, status vars renamed, scale tokenized. |
| Logo | **C** | **A** | Probe-ring mark + favicon + wordmark lockup. |
| Iconography | **C** | **A** | Monoline contract + set in `js/icons.js`, wired in. |
| Imagery | **A−** | **A−** | WebGL field adapts to both themes. |
| Light mode | **F** | **A** | First-class theme, toggle, persistent, field/viz adapt. |

### Resolved (P1)

1. Console competing primaries — tally demoted to Space Mono. ✓
2. Decorative red on mechanism step numbers — now `--text-secondary`. ✓
3. Light mode — full theme with toggle, `prefers-color-scheme` seeding,
   `localStorage` persistence; the 3D field and all SVG instruments read the
   live tokens. ✓

### Resolved (P2)

4. Token drift — `:root` matches `tokens.md` exactly; `--ok/--warn/--info` →
   `--success/--warning/--interactive`; type scale (`--display-xl … --label`)
   and spacing scale (`--space-2xs … --space-4xl`) tokenized. ✓
6. Logo mark — `assets/mark.svg` (residual ring + probe interrupt), favicon,
   strip/footer lockup. ✓
7. `--text-disabled` raised to `#666666` (4.0:1). ✓

### Resolved (P3)

8. Knob hint no longer wraps mid-glyph. ✓
11. `.DS_Store` ignored. ✓
12. Icon contract declared in DESIGN.md and implemented. ✓

### Still open

5. Gate meter should be segmented blocks (components.md §11).
9. Caption size collapse (9/10/11/12/13 → 10 + 12) and weight budget (2/screen).
10. `prefers-reduced-motion`: freeze the field instead of slowing it.

---

## 1. Tokens

`:root` against `tokens.md` — every neutrals value drifted darker:

| Token | Spec | Site | Δ |
|---|---|---|---|
| `--black` | `#000000` | `#000000` | — |
| `--surface` | `#111111` | `#0a0a0a` | −7 lightness |
| `--surface-raised` | `#1A1A1A` | `#121212` | −8 |
| `--border` | `#222222` | `#1e1e1e` | −4 |
| `--border-visible` | `#333333` | `#2c2c2c` | −7 |
| `--text-disabled` | `#666666` | `#5a5a5a` | −6 |
| `--text-secondary` | `#999999` | `#8c8c8c` | −12 |
| `--text-primary` | `#E8E8E8` | `#e4e4e4` | −4 |
| `--text-display` | `#FFFFFF` | `#ffffff` | — |
| `--accent` | `#D71921` | `#d71921` | — |
| `--success` | `#4A9E5C` | `--ok` `#3fa35c` | renamed + hue shift |
| `--warning` | `#D4A843` | `--warn` `#c9971f` | renamed + hue shift |
| `--interactive` | `#5B9BF6` | `--info` `#5b8def` | renamed |

- Status colors were renamed (`--ok/--warn/--info`) and re-hued. Spec expects
  `--success/--warning/--interactive`.
- The type scale from tokens.md (`--display-xl … --label`) is **not tokenized**;
  sizes are hardcoded per rule. Spacing scale (`--space-2xs … --space-4xl`) is
  also unused; only `--gut 32`, `--pad 24`, `--max 1280` exist.
- Contrast check: `--text-secondary #8c8c8c` on `#000` ≈ 6.8:1 — fine.
  `--text-disabled #5a5a5a` ≈ 3.4:1 — below the 4.0:1 the spec annotates.
  Acceptable for decorative/timestamp use only; not for meaningful text.

## 2. Typography

Families obey the rule (Doto hero-only, Grotesk body, Mono labels/numbers).
The **size and weight budget does not**.

- **Sizes in stylesheet:** 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 28,
  36, 40, 44, 56, 64, plus five clamps. Spec budget per screen: **3**.
  Worst zone is caption/label: 9/10/11/12/13px all in play — that is five sizes
  distinguishing what should be one label style and at most one caption.
- **Weights:** 300/400/500/700/900. Spec budget: **2** per screen.
  900 is only for Doto display; 700 for Doto numerals and the strip mark;
  500 for h2/faq; 300 for body. Per-screen this can be defended, but the
  stylesheet as a system has no enforcement.
- Mono at 10px with 0.08em tracking is used correctly as the tertiary layer.
- Doto `ROND 0 / wght 900` renders as block-dot numerals — legible and
  on-motif, kept.

## 3. Logo

- **Wordmark:** `CLEF` in Doto, tight tracking, used in strip and footer.
  Type-as-logo is consistent with the system. **Pass.**
- **Mark:** none. The favicon is a data-URI: black square + one red vertical
  bar. It reads as a placeholder, not a mark. At 16px it is indistinguishable
  from a generic red dash.
- **Lockup:** no composed logo/lockup asset for OG, docs, or external use.
- Recommendation: derive a mark from the product's one real shape — the probe
  ring on the residual stream (a ring with one bright bead at the 68% point) —
  as a 2px monoline glyph. That becomes favicon, OG image, and the field's
  visual anchor.

## 4. Iconography

- **Zero icons** on the site. Buttons, chips, controls, FAQ (+/−), and tape
  are type-only. For a Nothing-style instrument this is a legitimate choice
  ("structure is ornament"), but no system is defined for when icons are
  needed (nav arrows, status, external-link).
- Spec when needed: Lucide/Phosphor thin, monoline 1.5px, 24×24, no fill,
  color inherits text. Recommend declaring this in DESIGN.md as the icon
  contract rather than inventing glyphs later.

## 5. Imagery

- **Hero field (three.js):** the residual stream — 24 layer rings, probe ring
  at 16, particle stream, harm axis, clamp gesture. This is the right imagery
  for this product: data as beauty, procedural, no stock. **Pass.**
- **Charts:** SVG layer spine, gate meter, PCA triad — flat, 1–2px strokes,
  numeric readouts adjacent. Consistent with components.md §12.
- **No photos, no illustrations, no mascots.** Correct for the system.
- One asset gap: no OG/social image and no static fallback for
  `prefers-reduced-motion` beyond a slowed field (the field still animates at
  2% speed rather than freezing). Spec prefers a static fallback.

## 6. Components

| Component | Spec | Site | Note |
|---|---|---|---|
| Primary button | white pill, mono caps | ✓ `btn-primary` | hover swaps to accent — spec allows destructive accent; hover-tint is a reasonable event |
| Ghost button | transparent, no border | ~ border visible | close enough, slightly heavier |
| Segmented control | inverted active, 36–44px | ✓ | best-built control on the page |
| Chips/tags | 1px border, no fill, 4px | ✓ | LIVE chip green border = status, allowed |
| Cards | surface, 1px border, 8–16px radius | ✓ 8px | no shadows — pass |
| Inputs | underline or 8px border, mono text | ✓ | judge input correct |
| Data rows | dividers, label L / value R | ✓ tape, rack, kv | no zebra — pass |
| Progress bar | **segmented blocks** | ✗ smooth bar | gate meter is a continuous track — should be discrete segments |
| Charts | line 1.5–2px, no legend boxes | ✓ spine | legend inline as labels — pass |
| Empty state | centered, no mascots | ✓ `viz-empty` | bracket text style, pass |
| Loading | `[LOADING]` / segmented | ✓ `[ REQUIRES … ]` chip style | no skeletons — pass |

## 7. Hierarchy and composition (squint test)

- **Hero:** pass. One primary (the manifesto), deck secondary, strip/stats
  tertiary. The field is the single expressive break.
- **Position/pillars:** pass. Three columns, one number each, labels tertiary.
- **Impact/proof:** pass. Giant Doto claim is the only primary; footnote is
  properly small.
- **Attack surface:** pass. Two cards symmetric — this is the one place
  symmetry is right (direct comparison).
- **Console:** **fail — two primaries compete.** The verdict gate (`BLOCKED`,
  Doto 44px) and the tally (`17/18`, Doto 40px) are the same visual weight on
  one screen. Squinting, both scream. The verdict must win; the tally should
  drop to the hero-stats treatment (Space Mono ~22px).
- **Mechanism:** pass on layers; **five red step numerals (01–05) are
  decorative accent** — red is an interrupt, not ordinal decoration. These
  should be `--text-secondary`.
- **Integrations/FAQ:** pass.

## 8. Anti-patterns — full pass

No gradients · no shadows · no blur · no parallax/scroll-jacking · no spring
easing (only `cubic-bezier(0.25,0.1,0.25,1)`) · no skeletons · no toasts · no
zebra · no filled icons · no emoji-as-UI · no radius > 8px on cards (pill 999px
only on buttons) · no empty-state mascots. **Clean.**

---

## Ranked findings

### P1 — fix now

1. **Console competing primaries.** Demote the tally to Space Mono ~22px
   (`count-num` → non-Doto) so `BLOCKED`/`PASSED` is the screen's only primary.
2. **Decorative red on mechanism step numbers.** `01–05` → `--text-secondary`.
   Red stays for: hero clause, section-head clause (one per screen, the single
   allowed break), BLOCKED state, over-threshold values.
3. **Light mode missing.** The spec makes dark and light first-class. Until
   light exists, the system is half-built. (Deliberate scope decision — needs
   a call on whether to build it now.)

### P2 — should fix

4. **Token drift + untokenized scale.** Either snap neutrals/status colors to
   `tokens.md` values (and rename `--ok/--warn/--info` → `--success/--warning/
   --interactive`), or document the deltas in DESIGN.md as intentional. Also
   tokenize the type scale (`--display-xl … --label`) so sizes stop drifting.
   Recommendation: adopt spec values — the drift buys little contrast and
   loses the shared contract.
5. **Gate meter is a smooth bar.** Rebuild as segmented blocks (components.md
   §11) — this is the system's signature data viz and the one place the site
   currently looks generic.
6. **No logo mark / placeholder favicon.** Build the probe-ring mark; ship
   favicon + OG image from it.
7. **`--text-disabled` contrast (3.4:1).** Raise to `#666` per spec (4.0:1)
   if it carries meaning; keep darker only for pure ornament.

### P3 — polish

8. Knob hint `harm_excess ≥ thr` wraps mid-glyph at 1280 — shorten hint or set
   `white-space: nowrap` on the code chip.
9. Type budget: collapse caption sizes 9/10/11/12/13 → 10 (label) and 12
   (caption); collapse weights to 300/500 + Doto 900.
10. `prefers-reduced-motion`: freeze the field instead of slowing it.
11. `.DS_Store` is in `clef-site/` — add to `.gitignore`.
12. Declare the icon contract (Lucide thin, 1.5px) in DESIGN.md even though
    the site ships zero icons.

### Already good — do not touch

- Anti-pattern discipline, segmented controls, chips, tape/rack data rows,
  the WebGL field as imagery, Doto-as-display discipline, flat surfaces,
  the mechanical hover/press feel, the console's information density.
