/**
 * clef-site/js/components/index.js
 *
 * Shared Visualizer Components mounted by Surface 1 (`clef-site/demo.html`)
 * and Surface 2 (`clef-site/console.html`):
 *   - Component A: `<ghostline-token-stream>`
 *   - Component B: `<ghostline-layer-scrubber>`
 *   - Component C: `<ghostline-pca-canvas>`
 */

import {
  GhostlineTokenStream,
  fmtSigned,
  fmtNum,
  escapeHtml,
  isValidTraceFrame,
} from "./token-stream.js";
import { GhostlineLayerScrubber } from "./layer-scrubber.js";
import { GhostlinePcaCanvas } from "./pca-canvas.js";
import {
  ZERO_WAIT_ARENA_SNAPSHOT,
  ZERO_WAIT_TRACE_FRAME,
} from "./zero-wait-snapshot.js";

export {
  GhostlineTokenStream,
  GhostlineLayerScrubber,
  GhostlinePcaCanvas,
  ZERO_WAIT_ARENA_SNAPSHOT,
  ZERO_WAIT_TRACE_FRAME,
  fmtSigned,
  fmtNum,
  escapeHtml,
  isValidTraceFrame,
};

/**
 * Mount or update `<ghostline-token-stream>` inside `container` (or directly on `container` if it IS `<ghostline-token-stream>`).
 */
export function renderTokenSalienceStream(container, frame, opts = {}) {
  if (!container) return null;
  let el =
    container.tagName?.toLowerCase() === "ghostline-token-stream"
      ? container
      : container.querySelector("ghostline-token-stream");
  if (!el) {
    container.innerHTML = "";
    el = document.createElement("ghostline-token-stream");
    container.appendChild(el);
  }
  el.setFrame(frame, opts.clampTelemetry ?? null, opts);
  return el;
}

/**
 * Mount or update `<ghostline-layer-scrubber>` inside `container` (or directly on `container`).
 */
export function renderLayerCosineScrubber(container, frame, opts = {}) {
  if (!container) return null;
  let el =
    container.tagName?.toLowerCase() === "ghostline-layer-scrubber"
      ? container
      : container.querySelector("ghostline-layer-scrubber");
  if (!el) {
    container.innerHTML = "";
    el = document.createElement("ghostline-layer-scrubber");
    container.appendChild(el);
  }
  el.setFrame(frame, opts);
  return el;
}

/**
 * Mount or update `<ghostline-pca-canvas>` inside `container` (or directly on `container`).
 */
export function renderPcaSubspaceCanvas(container, frame, opts = {}) {
  if (!container) return null;
  let el =
    container.tagName?.toLowerCase() === "ghostline-pca-canvas"
      ? container
      : container.querySelector("ghostline-pca-canvas");
  if (!el) {
    container.innerHTML = "";
    el = document.createElement("ghostline-pca-canvas");
    container.appendChild(el);
  }
  el.setFrame(frame, opts.clampTelemetry ?? null, opts);
  return el;
}

/**
 * Backwards-compatible helper: if a separate clamp container is provided, or if `<ghostline-pca-canvas>`
 * already hosts the Live Activation Clamping Simulator, wire the `onRunClamp` callback onto `<ghostline-pca-canvas>`.
 */
export function renderCounterfactualClamping(
  container,
  frame,
  clampTelemetry = null,
  opts = {}
) {
  const pcaEl = document.querySelector("ghostline-pca-canvas");
  if (pcaEl) {
    pcaEl.setFrame(frame, clampTelemetry, opts);
  }
  if (container && container.tagName?.toLowerCase() !== "ghostline-pca-canvas") {
    container.innerHTML = "";
  }
}
