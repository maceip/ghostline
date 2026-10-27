// Motion primitives, translated into MDL: inspiration from motion-primitives
// (spotlight / tilt / glow / text-shimmer / transition-panel) and motion-panels'
// old fold — reimplemented in plain CSS + rAF-free pointer math so the laws hold:
// zero radius, no blurred shadows, no gradients-as-chrome, type stays the surface.
// Every effect is opt-in per card and globally toggleable in Settings.

/**
 * WP-style press tilt + grid-snapped square spotlight.
 * Spread the returned handlers on any element with class "tiltcard" and/or "spotcard".
 * Writes styles imperatively (no re-render per pointer move).
 */
export function useTiltSpotlight({ tilt = false, spotlight = false } = {}) {
  if (!tilt && !spotlight) return {}
  const apply = (e) => {
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width
    const py = (e.clientY - r.top) / r.height
    if (spotlight) {
      const snap = 12
      el.style.setProperty('--mx', `${Math.round((e.clientX - r.left) / snap) * snap - 60}px`)
      el.style.setProperty('--my', `${Math.round((e.clientY - r.top) / snap) * snap - 60}px`)
      el.style.setProperty('--spot', '1')
    }
    if (tilt) {
      const rx = (0.5 - py) * 7 // WP TiltEffect territory: max ~7deg
      const ry = (px - 0.5) * 7
      el.style.transform = `perspective(700px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`
    }
  }
  const clear = (e) => {
    const el = e.currentTarget
    if (tilt) el.style.transform = ''
    if (spotlight) el.style.setProperty('--spot', '0')
  }
  return { onPointerMove: apply, onPointerDown: apply, onPointerLeave: clear, onPointerUp: clear }
}

/**
 * Two-face flip card (rotateX "swing" around the horizontal axis — the fold
 * motion-panels used to ship). Faces stack in one grid cell so height is the
 * taller face; both keep the flat black ground, so a flipped card never
 * becomes a filled box from nowhere.
 */
export function FlipCard({ flipped, front, back, className = '' }) {
  return (
    <div className={`flipwrap ${flipped ? 'flipped' : ''} ${className}`}>
      <div className="flipinner">
        <div className="flipface flipfront">{front}</div>
        <div className="flipface flipback">{back}</div>
      </div>
    </div>
  )
}
