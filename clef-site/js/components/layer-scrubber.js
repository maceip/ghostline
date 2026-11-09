/**
 * Component B: Layer-by-Layer Cosine Scrubber & Math Readout (`<ghostline-layer-scrubber>`)
 *
 * - Interactive `<input type="range" id="active-layer-slider" min="0" max="23" value="16">`
 * - Dynamic `<svg viewBox="0 0 600 240">` plotting `#curve-v-harm`, `#curve-v-drift`, and the decision threshold line.
 * - Live `.math-inspection-card` beside the chart showing the selected layer's exact metrics in `<samp>` tags:
 *   - L2 Norm ||h_l^cand||_2
 *   - Harm Projection cos(h_l^cand, v_harm^(l))
 *   - Task Drift 1 - cos(h_l^cand, h_l^anchor)
 *   - Combined Guard Logit z_guard
 *   - Raw tensor slice preview (h_l[0..7])
 * - Scrubbing the slider moves the vertical SVG cursor (#00F0FF) and dispatches `ghostline:layer-scrub`
 *   so the math readout and PCA projection update instantaneously.
 */

import { fmtSigned, fmtNum, isValidTraceFrame } from "./token-stream.js";

export class GhostlineLayerScrubber extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._activeLayerIdx = 16;
    this._onSelectLayer = null;
  }

  setFrame(frame, opts = {}) {
    this._frame = frame;
    const n = frame?.layers?.length || 24;
    const dec = frame?.decision_layer ?? Math.min(16, n - 1);
    if (opts.selectedLayer !== undefined) {
      this._activeLayerIdx = Math.max(0, Math.min(n - 1, Number(opts.selectedLayer)));
    } else {
      this._activeLayerIdx = dec;
    }
    if (typeof opts.onSelectLayer === "function") {
      this._onSelectLayer = opts.onSelectLayer;
    }
    this.render();
  }

  get activeLayer() {
    return this._activeLayerIdx;
  }

  render() {
    const frame = this._frame;
    if (!isValidTraceFrame(frame) || !frame.layers.length) {
      this.innerHTML = `<div class="gl-empty">No layer telemetry available.</div>`;
      return;
    }

    const layers = frame.layers;
    const n = layers.length;
    const decLayer = frame.decision_layer ?? Math.min(16, n - 1);
    let activeLayerIdx = Math.max(0, Math.min(n - 1, this._activeLayerIdx));

    const W = 600;
    const H = 240;
    const padL = 44;
    const padR = 18;
    const padT = 22;
    const padB = 30;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const thrLineVal =
      (frame.harm_baseline ?? 0) + (frame.excess_threshold ?? 0.011);

    const allVals = [thrLineVal, 0];
    for (const l of layers) {
      allVals.push(l.cos_harm ?? 0, (l.cos_drift ?? 0) * 0.5, l.guard_logit ?? 0);
    }
    const minV = Math.min(-0.18, ...allVals) - 0.02;
    const maxV = Math.max(0.28, ...allVals) + 0.02;
    const spanV = Math.max(1e-4, maxV - minV);

    const xOf = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
    const yOf = (v) => padT + (1 - (v - minV) / spanV) * plotH;

    const harmPoints = layers
      .map((l, i) => `${xOf(i).toFixed(1)},${yOf(l.cos_harm ?? 0).toFixed(1)}`)
      .join(" ");
    const driftPoints = layers
      .map((l, i) => `${xOf(i).toFixed(1)},${yOf((l.cos_drift ?? 0) * 0.5).toFixed(1)}`)
      .join(" ");
    const logitPath = layers
      .map(
        (l, i) =>
          `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(
            l.guard_logit ?? 0
          ).toFixed(1)}`
      )
      .join(" ");

    const zeroY = yOf(0);
    const thrY = yOf(thrLineVal);
    const decX = xOf(decLayer);

    const renderMathCard = (layerIdx) => {
      const l = layers[layerIdx] || layers[decLayer] || layers[0];
      const slice = Array.isArray(l.tensor_slice_preview)
        ? l.tensor_slice_preview
        : [];
      const sliceFormatted = slice.map((v) => fmtSigned(v, 4)).join(", ");

      return `
        <div class="math-inspection-card" data-testid="math-inspection-card">
          <div class="math-card-hdr">
            <span>LAYER READOUT</span>
            <strong data-testid="gl-scrub-layer-label">L${String(l.layer).padStart(
              2,
              "0"
            )}${l.layer === decLayer ? " ★ HOOK" : ""}</strong>
          </div>
          <div class="math-row">
            <span class="math-k">L2 Norm ||h_l^cand||₂</span>
            <samp data-testid="samp-l2-norm">${fmtNum(l.l2_norm, 3)}</samp>
          </div>
          <div class="math-row">
            <span class="math-k">Harm Projection cos(h_l^cand, v_harm^(l))</span>
            <samp class="is-harm" data-testid="samp-cos-harm">${fmtSigned(
              l.cos_harm,
              4
            )}</samp>
          </div>
          <div class="math-row">
            <span class="math-k">Task Drift 1 − cos(h_l^cand, h_l^anchor)</span>
            <samp class="is-drift" data-testid="samp-cos-drift">${fmtNum(
              l.cos_drift,
              4
            )}</samp>
          </div>
          <div class="math-row">
            <span class="math-k">Combined Guard Logit z_guard</span>
            <samp class="${
              l.guard_logit >= 0 ? "is-trip" : "is-safe"
            }" data-testid="samp-guard-logit">${fmtSigned(
        l.guard_logit,
        4
      )}</samp>
          </div>
          <div class="math-slice-block" data-testid="gl-tensor-preview">
            <span class="math-k">Raw Tensor Slice h_L${String(l.layer).padStart(
              2,
              "0"
            )}[0..7]</span>
            <samp class="math-slice-samp" data-testid="samp-tensor-slice">[${sliceFormatted}]</samp>
          </div>
        </div>
      `;
    };

    const dotsSvg = layers
      .map((l, i) => {
        const cx = xOf(i).toFixed(1);
        const cy = yOf(l.cos_harm ?? 0).toFixed(1);
        const isDec = i === decLayer;
        const isAct = i === activeLayerIdx;
        return `<circle cx="${cx}" cy="${cy}" r="${
          isAct ? 5.2 : isDec ? 4.2 : 2.8
        }" class="gl-layer-dot ${isDec ? "is-decision" : ""} ${
          isAct ? "is-active" : ""
        }" data-layer="${i}">
          <title>L${i}: cos_harm=${fmtSigned(
          l.cos_harm,
          4
        )}, cos_drift=${fmtNum(l.cos_drift, 4)}, z_guard=${fmtSigned(
          l.guard_logit,
          4
        )}</title>
        </circle>`;
      })
      .join("");

    this.innerHTML = `
      <div class="gl-comp gl-scrubber-comp" data-testid="gl-layer-scrubber-comp">
        <div class="gl-comp-hdr">
          <span class="gl-comp-title">COMPONENT B · LAYER-BY-LAYER COSINE SCRUBBER (L00 → L${String(
            n - 1
          ).padStart(2, "0")})</span>
          <div class="gl-scrub-ctrl">
            <label for="active-layer-slider">ACTIVE LAYER</label>
            <input type="range" id="active-layer-slider" data-testid="gl-layer-scrubber" min="0" max="${
              n - 1
            }" value="${activeLayerIdx}" />
          </div>
        </div>

        <div class="gl-scrubber-split">
          <div class="gl-svg-wrap">
            <svg viewBox="0 0 ${W} ${H}" class="gl-scrubber-svg" role="img" aria-label="Layer-by-layer cosine trajectory">
              <!-- Zero baseline -->
              <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${
      W - padR
    }" y2="${zeroY.toFixed(
      1
    )}" stroke="#94A3B8" stroke-opacity="0.22" stroke-dasharray="3 3" />

              <!-- Horizontal Decision Threshold Line -->
              <line id="line-decision-threshold" x1="${padL}" y1="${thrY.toFixed(
      1
    )}" x2="${W - padR}" y2="${thrY.toFixed(
      1
    )}" stroke="#FF3B5C" stroke-width="1.3" stroke-dasharray="5 3" stroke-opacity="0.85" />
              <text x="${W - padR - 4}" y="${(thrY - 5).toFixed(
      1
    )}" text-anchor="end" class="gl-svg-txt" fill="#FF3B5C">THRESHOLD (${fmtSigned(
      thrLineVal,
      3
    )})</text>

              <!-- Decision Layer L16 vertical marker -->
              <line x1="${decX.toFixed(1)}" y1="${padT}" x2="${decX.toFixed(
      1
    )}" y2="${
      H - padB
    }" stroke="#FF3B5C" stroke-width="1.1" stroke-dasharray="3 3" stroke-opacity="0.55" />

              <!-- Active Layer Vertical Cursor (Cyan #00F0FF) -->
              <line id="gl-active-layer-line" x1="${xOf(activeLayerIdx).toFixed(
                1
              )}" y1="${padT}" x2="${xOf(activeLayerIdx).toFixed(1)}" y2="${
      H - padB
    }" stroke="#00F0FF" stroke-width="2" />

              <!-- Guard Logit curve (emerald) -->
              <path d="${logitPath}" fill="none" stroke="#10B981" stroke-width="1.4" stroke-dasharray="2 2" />

              <!-- #curve-v-drift polyline (amber #FFB800) -->
              <polyline id="curve-v-drift" points="${driftPoints}" fill="none" stroke="#FFB800" stroke-width="1.8" />

              <!-- #curve-v-harm polyline (coral red #FF3B5C) -->
              <polyline id="curve-v-harm" points="${harmPoints}" fill="none" stroke="#FF3B5C" stroke-width="2.4" />

              ${dotsSvg}

              <text x="${padL}" y="${H - 8}" class="gl-svg-txt">L00</text>
              <text x="${decX.toFixed(1)}" y="${
      padT - 6
    }" text-anchor="middle" class="gl-svg-txt" fill="#00F0FF">L${decLayer} PROBE</text>
              <text x="${W - padR}" y="${H - 8}" text-anchor="end" class="gl-svg-txt">L${String(
      n - 1
    ).padStart(2, "0")}</text>
            </svg>
            <div class="gl-legend-row">
              <span><i style="background:#FF3B5C"></i> #curve-v-harm</span>
              <span><i style="background:#FFB800"></i> #curve-v-drift (0.5×)</span>
              <span><i style="background:#10B981"></i> z_guard logit</span>
              <span><i style="background:#00F0FF"></i> active layer cursor</span>
            </div>
          </div>

          <div class="gl-layer-detail-slot" data-testid="gl-layer-readout">
            ${renderMathCard(activeLayerIdx)}
          </div>
        </div>
      </div>
    `;

    const rangeInput = this.querySelector("#active-layer-slider");
    const detailSlot = this.querySelector(".gl-layer-detail-slot");
    const activeLine = this.querySelector("#gl-active-layer-line");

    const updateLayer = (newIdx) => {
      activeLayerIdx = Math.max(0, Math.min(n - 1, Number(newIdx)));
      this._activeLayerIdx = activeLayerIdx;
      if (rangeInput && Number(rangeInput.value) !== activeLayerIdx) {
        rangeInput.value = String(activeLayerIdx);
      }
      if (detailSlot) {
        detailSlot.innerHTML = renderMathCard(activeLayerIdx);
      }
      if (activeLine) {
        const lx = xOf(activeLayerIdx).toFixed(1);
        activeLine.setAttribute("x1", lx);
        activeLine.setAttribute("x2", lx);
      }
      this.querySelectorAll(".gl-layer-dot").forEach((dot) => {
        const li = Number(dot.dataset.layer);
        dot.classList.toggle("is-active", li === activeLayerIdx);
        dot.setAttribute(
          "r",
          li === activeLayerIdx ? "5.2" : li === decLayer ? "4.2" : "2.8"
        );
      });

      const layerMetric = layers[activeLayerIdx];
      this.dispatchEvent(
        new CustomEvent("ghostline:layer-scrub", {
          bubbles: true,
          composed: true,
          detail: {
            layerIdx: activeLayerIdx,
            layerMetrics: layerMetric,
            pcaCoords: layerMetric?.pca_coords || null,
          },
        })
      );
      if (typeof this._onSelectLayer === "function") {
        this._onSelectLayer(activeLayerIdx, layerMetric);
      }
    };

    if (rangeInput) {
      rangeInput.addEventListener("input", (e) => updateLayer(e.target.value));
    }
    for (const dot of this.querySelectorAll(".gl-layer-dot")) {
      dot.addEventListener("click", () => updateLayer(dot.dataset.layer));
    }
  }
}

if (!customElements.get("ghostline-layer-scrubber")) {
  customElements.define("ghostline-layer-scrubber", GhostlineLayerScrubber);
}
