/**
 * Component C: 2D PCA Subspace Canvas & Counterfactual Steering Box (`<ghostline-pca-canvas>`)
 *
 * - High-DPI `<canvas>` plotting:
 *   - Pre-calibrated Benign Cluster (emerald green circles #10B981)
 *   - Exploit Cluster (coral/red triangles #FF3B5C)
 *   - Linear separating hyperplane
 *   - Live prompt's token-by-token trajectory path (t_0 -> t_N)
 *   - Active token highlight ring (`ghostline:token-select`) & active layer subspace marker (`ghostline:layer-scrub`)
 * - Footer displaying `PC1 Explained Variance` and `PC2 Explained Variance`
 * - Live Activation Clamping Simulator:
 *   - `<input type="range" id="live-clamp-slider" min="-2.0" max="3.0" step="0.1" value="1.5">`
 *   - `<button id="run-steered-generation">` calling the live backend harness with `clamp_alpha` and `layer`.
 */

import { fmtSigned, fmtNum, escapeHtml, isValidTraceFrame } from "./token-stream.js";

export class GhostlinePcaCanvas extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._clampTelemetry = null;
    this._selectedTokenIdx = null;
    this._activeLayerIdx = null;
    this._activeLayerPca = null;
    this._onRunClamp = null;
  }

  setFrame(frame, clampTelemetry = null, opts = {}) {
    this._frame = frame;
    if (clampTelemetry !== undefined) {
      this._clampTelemetry = clampTelemetry;
    }
    if (opts.selectedTokenIdx !== undefined) {
      this._selectedTokenIdx = opts.selectedTokenIdx;
    }
    if (opts.activeLayerIdx !== undefined) {
      this._activeLayerIdx = opts.activeLayerIdx;
    }
    if (opts.activeLayerPca !== undefined) {
      this._activeLayerPca = opts.activeLayerPca;
    }
    if (typeof opts.onRunClamp === "function") {
      this._onRunClamp = opts.onRunClamp;
    }
    this.render();
  }

  highlightToken(tokIdx) {
    this._selectedTokenIdx = tokIdx;
    this.drawCanvas();
  }

  highlightLayer(layerIdx, pcaCoords) {
    this._activeLayerIdx = layerIdx;
    const coords = pcaCoords || this._frame?.layers?.[layerIdx]?.pca_coords;
    this._activeLayerPca = coords;
    const badge = this.querySelector("[data-testid=pca-layer-badge]");
    if (badge && Array.isArray(coords)) {
      badge.textContent = `L${String(layerIdx).padStart(2, "0")} SUBSPACE: [${fmtSigned(
        coords[0],
        3
      )}, ${fmtSigned(coords[1], 3)}]`;
    }
    this.drawCanvas();
  }

  setActiveLayer(layerIdx) {
    this.highlightLayer(layerIdx, this._frame?.layers?.[layerIdx]?.pca_coords);
  }

  render() {
    const frame = this._frame;
    if (!isValidTraceFrame(frame)) {
      this.innerHTML = `<div class="gl-empty">No PCA subspace data available.</div>`;
      return;
    }

    const ref = frame.pca_reference || {
      pc1_variance: 0,
      pc2_variance: 0,
      benign_cluster: [],
      exploit_cluster: [],
    };
    const pc1Pct = ((ref.pc1_variance || 0) * 100).toFixed(1);
    const pc2Pct = ((ref.pc2_variance || 0) * 100).toFixed(1);
    const benignPts = Array.isArray(ref.benign_cluster) ? ref.benign_cluster : [];
    const exploitPts = Array.isArray(ref.exploit_cluster) ? ref.exploit_cluster : [];
    const tokPts = (frame.tokens || []).map((t) => ({
      idx: t.idx,
      text: t.text,
      harm: t.harm_score ?? 0,
      x: t.pca_coords?.[0] ?? 0,
      y: t.pca_coords?.[1] ?? 0,
    }));

    const ct = this._clampTelemetry;
    const alpha = ct?.alpha ?? frame.clamp_alpha ?? 1.5;
    const decLayer = this._activeLayerIdx ?? frame.decision_layer ?? 16;
    const layerPca =
      this._activeLayerPca ||
      frame.layers?.[decLayer]?.pca_coords ||
      [0, 0];

    const proposed = frame.passes?.proposed_tool_call || "—";
    const steered =
      frame.passes?.steered_tool_call ||
      (frame.verdict === "allow" ? proposed : "cargo clean");
    const beforeCos = ct?.reading_before ?? frame.harm_cosine ?? null;
    const afterCos = ct?.reading_after ?? null;
    const rolledBack = ct?.cache_entries_rolled_back ?? 0;
    const recomputed = ct?.layers_recomputed ?? 0;

    // Also include a lightweight companion SVG so any SVG queries (`svg.gl-pca-svg`) pass
    const W = 460;
    const H = 250;
    const pad = 28;
    const allX = [
      ...benignPts.map((p) => p[0]),
      ...exploitPts.map((p) => p[0]),
      ...tokPts.map((p) => p.x),
      -0.25,
      0.25,
    ];
    const allY = [
      ...benignPts.map((p) => p[1]),
      ...exploitPts.map((p) => p[1]),
      ...tokPts.map((p) => p.y),
      -0.25,
      0.25,
    ];
    const minX = Math.min(...allX) - 0.04;
    const maxX = Math.max(...allX) + 0.04;
    const minY = Math.min(...allY) - 0.04;
    const maxY = Math.max(...allY) + 0.04;
    const sx = (x) => pad + ((x - minX) / Math.max(1e-5, maxX - minX)) * (W - 2 * pad);
    const sy = (y) => H - pad - ((y - minY) / Math.max(1e-5, maxY - minY)) * (H - 2 * pad);

    const svgCircles = benignPts
      .map(
        (p) =>
          `<circle cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(
            1
          )}" r="3.5" class="gl-pca-benign" data-testid="gl-pca-benign" />`
      )
      .join("");
    const svgExploit = exploitPts
      .map(
        (p) =>
          `<polygon points="${sx(p[0]).toFixed(1)},${(sy(p[1]) - 4).toFixed(
            1
          )} ${(sx(p[0]) - 4).toFixed(1)},${(sy(p[1]) + 4).toFixed(1)} ${(
            sx(p[0]) + 4
          ).toFixed(1)},${(sy(p[1]) + 4).toFixed(
            1
          )}" class="gl-pca-exploit" data-testid="gl-pca-exploit" />`
      )
      .join("");

    this.innerHTML = `
      <div class="gl-comp gl-pca-comp" data-testid="gl-pca-canvas">
        <div class="gl-comp-hdr">
          <span class="gl-comp-title">COMPONENT C · 2D PCA SUBSPACE CANVAS &amp; COUNTERFACTUAL STEERING</span>
          <samp class="gl-comp-sub" data-testid="pca-layer-badge">L${String(
            decLayer
          ).padStart(2, "0")} SUBSPACE: [${fmtSigned(layerPca[0], 3)}, ${fmtSigned(
      layerPca[1],
      3
    )}]</samp>
        </div>

        <div class="gl-pca-canvas-wrap" style="position:relative;">
          <canvas id="gl-pca-hi-canvas" class="gl-pca-hi-canvas" data-testid="gl-pca-hi-canvas" width="920" height="500" style="width:100%;height:250px;display:block;border-radius:4px;"></canvas>
          <svg viewBox="0 0 ${W} ${H}" class="gl-pca-svg" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0.01;">
            ${svgCircles}
            ${svgExploit}
          </svg>
        </div>

        <div class="gl-pca-footer" data-testid="pca-variance-footer">
          <div class="gl-legend-row">
            <span><i style="background:#10B981;border-radius:50%"></i> Benign Cluster (${
              benignPts.length
            })</span>
            <span><i style="background:#FF3B5C;clip-path:polygon(50% 0%,0% 100%,100% 100%)"></i> Exploit Cluster (${
              exploitPts.length
            })</span>
            <span><i style="background:#00F0FF"></i> Separating Hyperplane &amp; Active Layer</span>
            <span><i style="background:#FFB800;border-radius:50%"></i> Token Trajectory (t₀ → t_${Math.max(
              0,
              tokPts.length - 1
            )})</span>
          </div>
          <div class="gl-evr-badges">
            <span>PC1 Explained Variance: <samp data-testid="pc1-evr">${pc1Pct}%</samp></span>
            <span>PC2 Explained Variance: <samp data-testid="pc2-evr">${pc2Pct}%</samp></span>
          </div>
        </div>

        <!-- Live Activation Clamping Simulator -->
        <div class="gl-comp gl-clamp-comp" data-testid="gl-clamp-panel" style="margin-top:10px;">
          <div class="gl-comp-hdr">
            <span class="gl-comp-title">LIVE ACTIVATION CLAMPING SIMULATOR (h'_l = h_l − α · v̂_harm)</span>
            <div class="gl-clamp-controls">
              <label for="live-clamp-slider">α = <samp id="gl-alpha-val">${Number(
                alpha
              ).toFixed(2)}</samp></label>
              <input type="range" id="live-clamp-slider" data-testid="gl-clamp-alpha" min="-2.0" max="3.0" step="0.1" value="${Number(
                alpha
              ).toFixed(1)}" />
              <button type="button" id="run-steered-generation" class="gl-btn-sm" data-testid="gl-clamp-run">RUN STEERED GENERATION</button>
            </div>
          </div>
          <div class="gl-clamp-grid">
            <div class="gl-clamp-card is-unsteered" data-testid="gl-card-unsteered">
              <span class="gl-clamp-tag">UNSTEERED DECODER OUTPUT (α = 0.0)</span>
              <code class="gl-clamp-cmd">${escapeHtml(proposed)}</code>
              <span class="gl-clamp-stat">L${frame.decision_layer} cos_harm: <samp>${fmtSigned(
      beforeCos,
      3
    )}</samp> · excess: <samp>${fmtSigned(frame.harm_excess, 3)}</samp></span>
            </div>
            <div class="gl-clamp-card is-steered" data-testid="gl-card-steered">
              <span class="gl-clamp-tag">STEERED GENERATION (L${decLayer} CLAMP α=${Number(
      alpha
    ).toFixed(1)} + KV ROLLBACK)</span>
              <code class="gl-clamp-cmd" data-testid="steered-generation-output">${escapeHtml(
                steered
              )}</code>
              <span class="gl-clamp-stat">L${frame.decision_layer} clamped: <samp>${fmtSigned(
      beforeCos,
      3
    )} → ${fmtSigned(afterCos, 3)}</samp> · recomputed: <samp>${recomputed}L (${rolledBack} KV entries)</samp></span>
            </div>
          </div>
        </div>
      </div>
    `;

    this.drawCanvas();

    const slider = this.querySelector("#live-clamp-slider");
    const alphaVal = this.querySelector("#gl-alpha-val");
    const runBtn = this.querySelector("#run-steered-generation");

    if (slider && alphaVal) {
      slider.addEventListener("input", () => {
        alphaVal.textContent = Number(slider.value).toFixed(2);
      });
    }
    if (runBtn) {
      runBtn.addEventListener("click", async () => {
        const nextAlpha = slider ? Number(slider.value) : Number(alpha);
        const layer = this._activeLayerIdx ?? frame.decision_layer ?? 16;
        if (typeof this._onRunClamp === "function") {
          runBtn.disabled = true;
          try {
            await this._onRunClamp(nextAlpha, frame, layer);
          } finally {
            runBtn.disabled = false;
          }
        }
      });
    }
  }

  drawCanvas() {
    const canvas = this.querySelector("#gl-pca-hi-canvas");
    const frame = this._frame;
    if (!canvas || !isValidTraceFrame(frame)) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 2, 2);
    const cssW = canvas.clientWidth || 460;
    const cssH = canvas.clientHeight || 250;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.save();
    ctx.scale(dpr, dpr);

    // Background (#0B0E14)
    ctx.fillStyle = "#0B0E14";
    ctx.fillRect(0, 0, cssW, cssH);

    const ref = frame.pca_reference || {};
    const benignPts = Array.isArray(ref.benign_cluster) ? ref.benign_cluster : [];
    const exploitPts = Array.isArray(ref.exploit_cluster) ? ref.exploit_cluster : [];
    const tokPts = (frame.tokens || []).map((t) => ({
      idx: t.idx,
      text: t.text,
      harm: t.harm_score ?? 0,
      x: t.pca_coords?.[0] ?? 0,
      y: t.pca_coords?.[1] ?? 0,
    }));
    const decLayer = this._activeLayerIdx ?? frame.decision_layer ?? 16;
    const activeLayerPt =
      this._activeLayerPca || frame.layers?.[decLayer]?.pca_coords || null;

    const allX = [
      ...benignPts.map((p) => p[0]),
      ...exploitPts.map((p) => p[0]),
      ...tokPts.map((p) => p.x),
      ...(activeLayerPt ? [activeLayerPt[0]] : []),
      -0.25,
      0.25,
    ];
    const allY = [
      ...benignPts.map((p) => p[1]),
      ...exploitPts.map((p) => p[1]),
      ...tokPts.map((p) => p.y),
      ...(activeLayerPt ? [activeLayerPt[1]] : []),
      -0.25,
      0.25,
    ];
    const minX = Math.min(...allX) - 0.05;
    const maxX = Math.max(...allX) + 0.05;
    const minY = Math.min(...allY) - 0.05;
    const maxY = Math.max(...allY) + 0.05;

    const pad = 28;
    const sx = (x) =>
      pad + ((x - minX) / Math.max(1e-5, maxX - minX)) * (cssW - 2 * pad);
    const sy = (y) =>
      cssH - pad - ((y - minY) / Math.max(1e-5, maxY - minY)) * (cssH - 2 * pad);

    // Subtle grid & zero axes
    ctx.strokeStyle = "#1E2638";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, sy(0));
    ctx.lineTo(cssW - pad, sy(0));
    ctx.moveTo(sx(0), pad);
    ctx.lineTo(sx(0), cssH - pad);
    ctx.stroke();

    // Linear Separating Hyperplane between Benign Cluster centroid and Exploit Cluster centroid
    if (benignPts.length > 0 && exploitPts.length > 0) {
      const bx =
        benignPts.reduce((acc, p) => acc + p[0], 0) / benignPts.length;
      const by =
        benignPts.reduce((acc, p) => acc + p[1], 0) / benignPts.length;
      const ex =
        exploitPts.reduce((acc, p) => acc + p[0], 0) / exploitPts.length;
      const ey =
        exploitPts.reduce((acc, p) => acc + p[1], 0) / exploitPts.length;

      const midX = (bx + ex) * 0.5;
      const midY = (by + ey) * 0.5;
      const dx = ex - bx;
      const dy = ey - by;
      // Normal orthogonal direction in PCA space: (-dy, dx)
      const len = Math.hypot(dx, dy) || 1;
      const tx = (-dy / len) * 2.0;
      const ty = (dx / len) * 2.0;

      ctx.save();
      ctx.strokeStyle = "rgba(0, 240, 255, 0.55)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(sx(midX - tx), sy(midY - ty));
      ctx.lineTo(sx(midX + tx), sy(midY + ty));
      ctx.stroke();
      ctx.restore();
    }

    // 1. Pre-calibrated Benign Cluster (Emerald Green Circles #10B981)
    for (const p of benignPts) {
      ctx.beginPath();
      ctx.arc(sx(p[0]), sy(p[1]), 4.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(16, 185, 129, 0.78)";
      ctx.fill();
      ctx.strokeStyle = "#10B981";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 2. Pre-calibrated Exploit Cluster (Coral/Red Triangles #FF3B5C)
    for (const p of exploitPts) {
      const cx = sx(p[0]);
      const cy = sy(p[1]);
      const r = 5.2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx - r * 0.9, cy + r * 0.8);
      ctx.lineTo(cx + r * 0.9, cy + r * 0.8);
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 59, 92, 0.82)";
      ctx.fill();
      ctx.strokeStyle = "#FF3B5C";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 3. Live Prompt Token-by-Token Trajectory Path (t_0 -> t_N)
    if (tokPts.length > 1) {
      ctx.save();
      ctx.strokeStyle = "#FFB800";
      ctx.lineWidth = 1.8;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      tokPts.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(sx(pt.x), sy(pt.y));
        else ctx.lineTo(sx(pt.x), sy(pt.y));
      });
      ctx.stroke();
      ctx.restore();
    }

    // Token nodes along trajectory
    tokPts.forEach((pt, i) => {
      const cx = sx(pt.x);
      const cy = sy(pt.y);
      const isSel = i === this._selectedTokenIdx;
      const isPeak = pt.harm >= 0.55;
      const rad = isSel ? 6.5 : 3.2 + pt.harm * 3.8;

      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fillStyle = isPeak ? "#FF3B5C" : "#FFB800";
      ctx.fill();
      ctx.strokeStyle = isSel ? "#00F0FF" : "#0B0E14";
      ctx.lineWidth = isSel ? 2.4 : 1.1;
      ctx.stroke();

      if (isSel || isPeak || i === tokPts.length - 1) {
        ctx.font = "10px 'JetBrains Mono', 'Space Mono', monospace";
        ctx.fillStyle = isSel ? "#00F0FF" : "#E2E8F0";
        ctx.fillText(`t${pt.idx}:${(pt.text || "").slice(0, 8)}`, cx + 7, cy + 3);
      }
    });

    // 4. Active Layer Subspace Marker (Cyan #00F0FF Diamond)
    if (Array.isArray(activeLayerPt) && activeLayerPt.length >= 2) {
      const lx = sx(activeLayerPt[0]);
      const ly = sy(activeLayerPt[1]);
      const d = 6.5;
      ctx.beginPath();
      ctx.moveTo(lx, ly - d);
      ctx.lineTo(lx + d, ly);
      ctx.lineTo(lx, ly + d);
      ctx.lineTo(lx - d, ly);
      ctx.closePath();
      ctx.fillStyle = "rgba(0, 240, 255, 0.28)";
      ctx.fill();
      ctx.strokeStyle = "#00F0FF";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = "bold 10px 'JetBrains Mono', 'Space Mono', monospace";
      ctx.fillStyle = "#00F0FF";
      ctx.fillText(`L${String(decLayer).padStart(2, "0")}`, lx + 8, ly - 5);
    }

    ctx.restore();
  }
}

if (!customElements.get("ghostline-pca-canvas")) {
  customElements.define("ghostline-pca-canvas", GhostlinePcaCanvas);
}
