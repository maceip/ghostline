/**
 * icons.js — CLEF monoline icon set.
 *
 * Contract (nothing-design §5): 24×24 viewBox, 1.5px stroke, round caps/joins,
 * no fill, color inherits `currentColor`. Max 6 strokes per glyph. Never
 * filled, never multi-color — the one exception is the mark's accent bead,
 * which is the product's single red interrupt.
 */

const wrap = (inner, size = 20) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
  `stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ` +
  `aria-hidden="true">${inner}</svg>`;

export const icons = {
  /** The mark — residual ring + probe interrupt. */
  mark: (size = 20) =>
    `<svg class="icon icon-mark" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `aria-hidden="true">` +
    `<circle cx="12" cy="12" r="8.25" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linecap="round" stroke-dasharray="43 8.7" stroke-dashoffset="-19.2"/>` +
    `<circle cx="12" cy="3.75" r="2.1" fill="#D71921"/></svg>`,
  chevronDown: (size = 20) => wrap(`<path d="M6 9l6 6 6-6"/>`, size),
  chevronRight: (size = 20) => wrap(`<path d="M9 6l6 6-6 6"/>`, size),
  arrowDown: (size = 20) => wrap(`<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>`, size),
  play: (size = 20) => wrap(`<path d="M8 5l11 7-11 7z"/>`, size),
  plus: (size = 20) => wrap(`<path d="M12 5v14"/><path d="M5 12h14"/>`, size),
  minus: (size = 20) => wrap(`<path d="M5 12h14"/>`, size),
  check: (size = 20) => wrap(`<path d="M5 13l4 4L19 7"/>`, size),
  block: (size = 20) => wrap(`<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>`, size),
  external: (size = 20) => wrap(`<path d="M10 6H6v12h12v-4"/><path d="M14 4h6v6"/><path d="M20 4l-8 8"/>`, size),
};

/** Replace every [data-icon] element with its glyph. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    const fn = icons[el.dataset.icon];
    if (!fn) continue;
    const size = Number(el.dataset.iconSize) || 20;
    el.insertAdjacentHTML("afterbegin", fn(size));
  }
}
