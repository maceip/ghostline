/**
 * ghostline-core.js — Shared Visualizer Core for Ghostline Surface 1 (Public Interactive Arena)
 * and Surface 2 (Operator Control Plane).
 *
 * Consumes the unified `GhostlineTraceFrame` wire contract and mounts three reusable
 * inspection DOM components plus the Counterfactual Activation Clamping inspector:
 *   1. Token Salience Stream (`renderTokenSalienceStream`)
 *   2. Layer-by-Layer Cosine Scrubber L0 -> LN (`renderLayerCosineScrubber`)
 *   3. 2D/3D PCA Subspace Projection & Per-Token Salience Trail (`renderPcaSubspaceCanvas`)
 *   4. Live Counterfactual Activation Clamping (`renderCounterfactualClamping`)
 *
 * Constitutional Law 2: Zero fabricated, mocked, or synthetic data. Every coordinate,
 * norm, cosine, logit, variance ratio, and tensor slice comes directly from the real
 * MLX forward pass inside `GhostlineTraceFrame`.
 */

export function fmtSigned(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(digits);
}

export function fmtNum(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  return Number(v).toFixed(digits);
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Validate that an object conforms to the `GhostlineTraceFrame` wire contract.
 */
export function isValidTraceFrame(frame) {
  return Boolean(
    frame &&
      typeof frame.turn_id === "string" &&
      typeof frame.model_id === "string" &&
      typeof frame.hidden_dim === "number" &&
      typeof frame.num_layers === "number" &&
      typeof frame.decision_layer === "number" &&
      typeof frame.prefill_ms === "number" &&
      frame.passes &&
      Array.isArray(frame.tokens) &&
      Array.isArray(frame.layers) &&
      frame.pca_reference
  );
}

/**
 * Component 1: Token Salience Stream
 * Renders per-token `harm_score` [0, 1], `drift_score` [0, 1], and `[PC1, PC2]` coordinates
 * at `decision_layer`, along with Pass 1 Anchor and Pass 2 Candidate Context metadata.
 */
export function renderTokenSalienceStream(container, frame, opts = {}) {
  if (!container) return;
  if (!isValidTraceFrame(frame)) {
    container.innerHTML = `<div class="gl-empty">No GhostlineTraceFrame selected.</div>`;
    return;
  }

  const tokens = frame.tokens || [];
  let peakIdx = 0;
  let peakHarm = -1;
  tokens.forEach((t, i) => {
    if (t.harm_score > peakHarm) {
      peakHarm = t.harm_score;
      peakIdx = i;
    }
  });

  const selectedTokIdx = opts.selectedTokenIdx ?? peakIdx;
  const tokChips = tokens
    .map((t, i) => {
      const harmPct = Math.round(Math.max(0, Math.min(1, t.harm_score)) * 100);
      const driftPct = Math.round(Math.max(0, Math.min(1, t.drift_score)) * 100);
      const isPeak = i === peakIdx && tokens.length > 0;
      const isSel = i === selectedTokIdx;
      const pc1 = t.pca_coords?.[0] ?? 0;
      const pc2 = t.pca_coords?.[1] ?? 0;
      const sevClass =
        t.harm_score >= 0.55
          ? "is-high"
          : t.harm_score >= 0.35
          ? "is-mid"
          : "is-low";
      return `<button type="button" class="gl-tok-chip ${sevClass} ${isPeak ? "is-peak" : ""} ${
        isSel ? "is-selected" : ""
      }" data-tok-idx="${i}" data-testid="gl-tok-chip" title="Token #${t.idx} '${escapeHtml(
        t.text
      )}' · harm=${fmtNum(t.harm_score, 3)} · drift=${fmtNum(
        t.drift_score,
        3
      )} · PCA=[${fmtSigned(pc1, 3)}, ${fmtSigned(pc2, 3)}]">
        <span class="gl-tok-head">
          <span class="gl-tok-idx">#${t.idx}</span>
          <code class="gl-tok-txt">${escapeHtml(t.text || "␣")}</code>
        </span>
        <span class="gl-tok-bars">
          <span class="gl-tok-bar"><i class="gl-bar-harm" style="width:${harmPct}%"></i></span>
          <span class="gl-tok-bar"><i class="gl-bar-drift" style="width:${driftPct}%"></i></span>
        </span>
        <span class="gl-tok-meta">H:${fmtNum(t.harm_score, 2)} · D:${fmtNum(
        t.drift_score,
        2
      )}</span>
      </button>`;
    })
    .join("");

  const activeTok = tokens[selectedTokIdx] || tokens[0] || null;
  const tokDetail = activeTok
    ? `<div class="gl-tok-inspector" data-testid="gl-tok-detail">
        <span>TOKEN <b>#${activeTok.idx}</b> <code>${escapeHtml(activeTok.text || "␣")}</code></span>
        <span>HARM SALIENCE (L${frame.decision_layer}): <b>${fmtNum(activeTok.harm_score, 3)}</b></span>
        <span>ANCHOR DRIFT: <b>${fmtNum(activeTok.drift_score, 3)}</b></span>
        <span>SUBSPACE [PC1, PC2]: <b>[${fmtSigned(activeTok.pca_coords?.[0], 3)}, ${fmtSigned(
        activeTok.pca_coords?.[1],
        3
      )}]</b></span>
      </div>`
    : "";

  container.innerHTML = `
    <div class="gl-comp gl-salience-comp" data-testid="gl-token-salience">
      <div class="gl-comp-hdr">
        <span class="gl-comp-title">1 · TOKEN SALIENCE STREAM (L${frame.decision_layer} PROJECTION)</span>
        <span class="gl-comp-sub">${tokens.length} SPAN TOKENS · ${escapeHtml(frame.model_id)} (${frame.hidden_dim}d)</span>
      </div>
      <div class="gl-passes-strip">
        <div class="gl-pass-pill">
          <span class="gl-pass-tag">PASS 1 · ANCHOR</span>
          <code>${escapeHtml(frame.passes?.anchor_prompt || "—")}</code>
        </div>
        <div class="gl-pass-pill">
          <span class="gl-pass-tag">PASS 2 · PROPOSED TOOL CALL</span>
          <code>${escapeHtml(frame.passes?.proposed_tool_call || "—")}</code>
        </div>
      </div>
      <div class="gl-tok-stream" role="list">
        ${tokChips || `<span class="gl-empty">No span tokens recorded.</span>`}
      </div>
      ${tokDetail}
    </div>
  `;

  for (const btn of container.querySelectorAll(".gl-tok-chip")) {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.tokIdx);
      renderTokenSalienceStream(container, frame, {
        ...opts,
        selectedTokenIdx: idx,
      });
      if (typeof opts.onSelectToken === "function") {
        opts.onSelectToken(idx, tokens[idx]);
      }
    });
  }
}

/**
 * Component 2: Layer-by-Layer Cosine Scrubber (L_0 -> L_N)
 * Renders interactive layer scrubber, multi-curve SVG (`cos_harm`, `cos_drift`, `guard_logit`),
 * `l2_norm`, and the 8-float `tensor_slice_preview` of `h_l[last_token]`.
 */
export function renderLayerCosineScrubber(container, frame, opts = {}) {
  if (!container) return;
  if (!isValidTraceFrame(frame) || !frame.layers.length) {
    container.innerHTML = `<div class="gl-empty">No layer telemetry available.</div>`;
    return;
  }

  const layers = frame.layers;
  const n = layers.length;
  const decLayer = frame.decision_layer ?? Math.min(16, n - 1);
  let activeLayerIdx =
    opts.selectedLayer !== undefined
      ? Math.max(0, Math.min(n - 1, Number(opts.selectedLayer)))
      : decLayer;

  // Build SVG coordinates for cos_harm, cos_drift, and guard_logit across L0..LN
  const W = 620;
  const H = 165;
  const padL = 42;
  const padR = 16;
  const padT = 16;
  const padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const allVals = [];
  for (const l of layers) {
    allVals.push(l.cos_harm ?? 0, l.guard_logit ?? 0, (l.cos_drift ?? 0) * 0.5);
  }
  const minV = Math.min(-0.18, ...allVals);
  const maxV = Math.max(0.28, ...allVals);
  const spanV = Math.max(1e-4, maxV - minV);

  const xOf = (i) => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const yOf = (v) => padT + (1 - (v - minV) / spanV) * plotH;
  const zeroY = yOf(0);

  const buildPath = (getter) =>
    layers
      .map((l, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(getter(l)).toFixed(1)}`)
      .join(" ");

  const harmPath = buildPath((l) => l.cos_harm ?? 0);
  const logitPath = buildPath((l) => l.guard_logit ?? 0);
  const driftPath = buildPath((l) => (l.cos_drift ?? 0) * 0.5);

  const decX = xOf(decLayer);

  const renderLayerDetail = (layerIdx) => {
    const l = layers[layerIdx] || layers[decLayer] || layers[0];
    const slice = Array.isArray(l.tensor_slice_preview) ? l.tensor_slice_preview : [];
    const sliceHtml = slice
      .map(
        (val, idx) =>
          `<span class="gl-tensor-cell" title="h_L${l.layer}[last_token][${idx}]"><em>[${idx}]</em>${fmtSigned(
            val,
            4
          )}</span>`
      )
      .join("");

    return `
      <div class="gl-layer-metrics" data-testid="gl-layer-readout">
        <div class="gl-lm-item">
          <span class="gl-lm-label">LAYER</span>
          <strong class="gl-lm-val" data-testid="gl-scrub-layer-label">L${String(l.layer).padStart(
            2,
            "0"
          )}${l.layer === decLayer ? " ★ DECISION" : ""}</strong>
        </div>
        <div class="gl-lm-item">
          <span class="gl-lm-label">||h_l||₂ NORM</span>
          <strong class="gl-lm-val">${fmtNum(l.l2_norm, 2)}</strong>
        </div>
        <div class="gl-lm-item">
          <span class="gl-lm-label">COS_HARM</span>
          <strong class="gl-lm-val is-harm">${fmtSigned(l.cos_harm, 4)}</strong>
        </div>
        <div class="gl-lm-item">
          <span class="gl-lm-label">COS_DRIFT (1−cos)</span>
          <strong class="gl-lm-val is-drift">${fmtNum(l.cos_drift, 4)}</strong>
        </div>
        <div class="gl-lm-item">
          <span class="gl-lm-label">GUARD_LOGIT</span>
          <strong class="gl-lm-val ${l.guard_logit >= 0 ? "is-trip" : "is-safe"}">${fmtSigned(
            l.guard_logit,
            4
          )}</strong>
        </div>
      </div>
      <div class="gl-tensor-strip" data-testid="gl-tensor-preview">
        <span class="gl-tensor-tag">h_L${String(l.layer).padStart(2, "0")}[last_token][0..7]:</span>
        <div class="gl-tensor-cells">${sliceHtml}</div>
      </div>
    `;
  };

  const dotsSvg = layers
    .map((l, i) => {
      const cx = xOf(i).toFixed(1);
      const cy = yOf(l.cos_harm ?? 0).toFixed(1);
      const isDec = i === decLayer;
      const isAct = i === activeLayerIdx;
      return `<circle cx="${cx}" cy="${cy}" r="${isAct ? 5.2 : isDec ? 4.2 : 2.8}" class="gl-layer-dot ${
        isDec ? "is-decision" : ""
      } ${isAct ? "is-active" : ""}" data-layer="${i}">
        <title>L${i}: cos_harm=${fmtSigned(l.cos_harm, 4)}, guard_logit=${fmtSigned(
        l.guard_logit,
        4
      )}, l2=${fmtNum(l.l2_norm, 2)}</title>
      </circle>`;
    })
    .join("");

  container.innerHTML = `
    <div class="gl-comp gl-scrubber-comp" data-testid="gl-layer-scrubber-comp">
      <div class="gl-comp-hdr">
        <span class="gl-comp-title">2 · LAYER-BY-LAYER COSINE SCRUBBER (L00 → L${String(
          n - 1
        ).padStart(2, "0")})</span>
        <div class="gl-scrub-ctrl">
          <label for="gl-scrub-range-${container.id || "main"}">SCRUB LAYER</label>
          <input id="gl-scrub-range-${container.id || "main"}" data-testid="gl-layer-scrubber" type="range" min="0" max="${
    n - 1
  }" value="${activeLayerIdx}" />
        </div>
      </div>
      <div class="gl-svg-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="gl-scrubber-svg" role="img" aria-label="Layer-by-layer cosine trajectory">
          <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(
    1
  )}" stroke="currentColor" stroke-opacity="0.22" stroke-dasharray="3 3" />
          <line x1="${decX.toFixed(1)}" y1="${padT}" x2="${decX.toFixed(1)}" y2="${
    H - padB
  }" stroke="#D71921" stroke-width="1.2" stroke-dasharray="4 3" />
          <line id="gl-active-layer-line" x1="${xOf(activeLayerIdx).toFixed(
            1
          )}" y1="${padT}" x2="${xOf(activeLayerIdx).toFixed(1)}" y2="${
    H - padB
  }" stroke="currentColor" stroke-opacity="0.45" stroke-width="1.5" />
          <path d="${driftPath}" fill="none" stroke="#C9971F" stroke-width="1.5" stroke-opacity="0.75" />
          <path d="${logitPath}" fill="none" stroke="#4A9E5C" stroke-width="1.6" stroke-dasharray="2 2" />
          <path d="${harmPath}" fill="none" stroke="#D71921" stroke-width="2.2" />
          ${dotsSvg}
          <text x="${padL}" y="${H - 6}" class="gl-svg-txt">L00</text>
          <text x="${decX.toFixed(1)}" y="${padT - 4}" text-anchor="middle" class="gl-svg-txt" fill="#D71921">L${decLayer} HOOK</text>
          <text x="${W - padR}" y="${H - 6}" text-anchor="end" class="gl-svg-txt">L${String(
    n - 1
  ).padStart(2, "0")}</text>
        </svg>
        <div class="gl-legend-row">
          <span><i style="background:#D71921"></i> cos_harm</span>
          <span><i style="background:#4A9E5C"></i> guard_logit</span>
          <span><i style="background:#C9971F"></i> 0.5 × cos_drift</span>
        </div>
      </div>
      <div class="gl-layer-detail-slot">
        ${renderLayerDetail(activeLayerIdx)}
      </div>
    </div>
  `;

  const rangeInput = container.querySelector('[data-testid="gl-layer-scrubber"]');
  const detailSlot = container.querySelector(".gl-layer-detail-slot");
  const activeLine = container.querySelector("#gl-active-layer-line");

  const updateLayer = (newIdx) => {
    activeLayerIdx = Math.max(0, Math.min(n - 1, Number(newIdx)));
    if (rangeInput && Number(rangeInput.value) !== activeLayerIdx) {
      rangeInput.value = String(activeLayerIdx);
    }
    if (detailSlot) {
      detailSlot.innerHTML = renderLayerDetail(activeLayerIdx);
    }
    if (activeLine) {
      const lx = xOf(activeLayerIdx).toFixed(1);
      activeLine.setAttribute("x1", lx);
      activeLine.setAttribute("x2", lx);
    }
    container.querySelectorAll(".gl-layer-dot").forEach((dot) => {
      const li = Number(dot.dataset.layer);
      dot.classList.toggle("is-active", li === activeLayerIdx);
      dot.setAttribute("r", li === activeLayerIdx ? "5.2" : li === decLayer ? "4.2" : "2.8");
    });
    if (typeof opts.onSelectLayer === "function") {
      opts.onSelectLayer(activeLayerIdx, layers[activeLayerIdx]);
    }
  };

  if (rangeInput) {
    rangeInput.addEventListener("input", (e) => updateLayer(e.target.value));
  }
  for (const dot of container.querySelectorAll(".gl-layer-dot")) {
    dot.addEventListener("click", () => updateLayer(dot.dataset.layer));
  }
}

/**
 * Component 3: 2D/3D PCA Subspace Projection & Per-Token Salience Trail
 * Renders calibrated `benign_cluster` and `exploit_cluster` coordinates alongside
 * the live token-by-token salience trail in `[PC1, PC2]` space.
 */
export function renderPcaSubspaceCanvas(container, frame, opts = {}) {
  if (!container) return;
  if (!isValidTraceFrame(frame)) {
    container.innerHTML = `<div class="gl-empty">No PCA subspace data available.</div>`;
    return;
  }

  const ref = frame.pca_reference || {
    pc1_variance: 0,
    pc2_variance: 0,
    benign_cluster: [],
    exploit_cluster: [],
  };
  const benignPts = Array.isArray(ref.benign_cluster) ? ref.benign_cluster : [];
  const exploitPts = Array.isArray(ref.exploit_cluster) ? ref.exploit_cluster : [];
  const tokPts = (frame.tokens || []).map((t) => ({
    idx: t.idx,
    text: t.text,
    harm: t.harm_score ?? 0,
    x: t.pca_coords?.[0] ?? 0,
    y: t.pca_coords?.[1] ?? 0,
  }));

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

  const W = 440;
  const H = 250;
  const pad = 28;
  const sx = (x) => pad + ((x - minX) / Math.max(1e-5, maxX - minX)) * (W - 2 * pad);
  const sy = (y) => H - pad - ((y - minY) / Math.max(1e-5, maxY - minY)) * (H - 2 * pad);

  const zeroX = sx(0);
  const zeroY = sy(0);

  const benignCircles = benignPts
    .map(
      (p, i) =>
        `<circle cx="${sx(p[0]).toFixed(1)}" cy="${sy(p[1]).toFixed(
          1
        )}" r="4" class="gl-pca-benign" data-testid="gl-pca-benign">
          <title>Calibrated Benign #${i + 1}: [${fmtSigned(p[0], 3)}, ${fmtSigned(p[1], 3)}]</title>
        </circle>`
    )
    .join("");

  const exploitCircles = exploitPts
    .map(
      (p, i) =>
        `<rect x="${(sx(p[0]) - 3.5).toFixed(1)}" y="${(sy(p[1]) - 3.5).toFixed(
          1
        )}" width="7" height="7" class="gl-pca-exploit" data-testid="gl-pca-exploit">
          <title>Calibrated Exploit Direction #${i + 1}: [${fmtSigned(p[0], 3)}, ${fmtSigned(
          p[1],
          3
        )}]</title>
        </rect>`
    )
    .join("");

  const trailPath =
    tokPts.length > 1
      ? `<path d="${tokPts
          .map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`)
          .join(" ")}" fill="none" stroke="#D71921" stroke-width="1.6" stroke-dasharray="3 2" />`
      : "";

  const tokCircles = tokPts
    .map((p, i) => {
      const r = (3.2 + p.harm * 4.5).toFixed(1);
      const cx = sx(p.x).toFixed(1);
      const cy = sy(p.y).toFixed(1);
      const isPeak = p.harm >= 0.55;
      return `<g class="gl-pca-tok" data-tok-idx="${i}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="${
        isPeak ? "#D71921" : "#1a1a1a"
      }" fill-opacity="0.88" stroke="#fff" stroke-width="1">
          <title>Token #${p.idx} '${escapeHtml(p.text)}' · PC1=${fmtSigned(
        p.x,
        3
      )}, PC2=${fmtSigned(p.y, 3)} · harm=${fmtNum(p.harm, 3)}</title>
        </circle>
        ${
          isPeak || i === tokPts.length - 1
            ? `<text x="${Number(cx) + 6}" y="${
                Number(cy) + 3
              }" class="gl-svg-txt">${escapeHtml(p.text.slice(0, 10))}</text>`
            : ""
        }
      </g>`;
    })
    .join("");

  const pc1Pct = ((ref.pc1_variance || 0) * 100).toFixed(1);
  const pc2Pct = ((ref.pc2_variance || 0) * 100).toFixed(1);

  container.innerHTML = `
    <div class="gl-comp gl-pca-comp" data-testid="gl-pca-canvas">
      <div class="gl-comp-hdr">
        <span class="gl-comp-title">3 · PCA SUBSPACE PROJECTION &amp; SALIENCE TRAIL</span>
        <span class="gl-comp-sub">PC1 (${pc1Pct}% EVR) × PC2 (${pc2Pct}% EVR)</span>
      </div>
      <div class="gl-svg-wrap">
        <svg viewBox="0 0 ${W} ${H}" class="gl-pca-svg" role="img" aria-label="2D PCA subspace projection">
          <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${W - pad}" y2="${zeroY.toFixed(
    1
  )}" stroke="currentColor" stroke-opacity="0.16" />
          <line x1="${zeroX.toFixed(1)}" y1="${pad}" x2="${zeroX.toFixed(1)}" y2="${
    H - pad
  }" stroke="currentColor" stroke-opacity="0.16" />
          ${benignCircles}
          ${exploitCircles}
          ${trailPath}
          ${tokCircles}
          <text x="${W - pad}" y="${H - 6}" text-anchor="end" class="gl-svg-txt">PC1 (${pc1Pct}%)</text>
          <text x="${pad}" y="${pad - 8}" class="gl-svg-txt">PC2 (${pc2Pct}%)</text>
        </svg>
        <div class="gl-legend-row">
          <span><i style="background:#4A9E5C;border-radius:50%"></i> benign cluster (${
            benignPts.length
          })</span>
          <span><i style="background:#C9971F"></i> exploit basis (${exploitPts.length})</span>
          <span><i style="background:#D71921;border-radius:50%"></i> token salience trail (${
            tokPts.length
          })</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Component 4: Live Counterfactual Activation Clamping (h_l' = h_l - alpha * v_harm)
 * Compares unclamped `proposed_tool_call` vs post-clamp / KV-rollback `steered_tool_call`
 * and allows interactive alpha steering.
 */
export function renderCounterfactualClamping(container, frame, clampTelemetry = null, opts = {}) {
  if (!container) return;
  if (!isValidTraceFrame(frame)) {
    container.innerHTML = `<div class="gl-empty">Run a probe to inspect counterfactual clamping.</div>`;
    return;
  }

  const alpha = clampTelemetry?.alpha ?? frame.clamp_alpha ?? 1.15;
  const proposed = frame.passes?.proposed_tool_call || "—";
  const steered =
    frame.passes?.steered_tool_call ||
    (frame.verdict === "allow" ? proposed : "cargo clean");
  const beforeCos = clampTelemetry?.reading_before ?? frame.harm_cosine ?? null;
  const afterCos = clampTelemetry?.reading_after ?? null;
  const rolledBack = clampTelemetry?.cache_entries_rolled_back ?? 0;
  const recomputed = clampTelemetry?.layers_recomputed ?? 0;

  container.innerHTML = `
    <div class="gl-comp gl-clamp-comp" data-testid="gl-clamp-panel">
      <div class="gl-comp-hdr">
        <span class="gl-comp-title">4 · COUNTERFACTUAL ACTIVATION CLAMPING (h' = h − α·v̂_harm)</span>
        <div class="gl-clamp-controls">
          <label>α = <strong id="gl-alpha-val">${Number(alpha).toFixed(2)}</strong></label>
          <input type="range" data-testid="gl-clamp-alpha" min="0.20" max="2.20" step="0.05" value="${alpha}" />
          <button type="button" class="gl-btn-sm" data-testid="gl-clamp-run">STEER &amp; ROLL BACK</button>
        </div>
      </div>
      <div class="gl-clamp-grid">
        <div class="gl-clamp-card is-unsteered" data-testid="gl-card-unsteered">
          <span class="gl-clamp-tag">UNCLAMPED DECODER PROPOSAL</span>
          <code class="gl-clamp-cmd">${escapeHtml(proposed)}</code>
          <span class="gl-clamp-stat">L${frame.decision_layer} cos_harm: <b>${fmtSigned(
    beforeCos,
    3
  )}</b> · excess: <b>${fmtSigned(frame.harm_excess, 3)}</b></span>
        </div>
        <div class="gl-clamp-card is-steered" data-testid="gl-card-steered">
          <span class="gl-clamp-tag">POST-CLAMP KV-ROLLBACK STEER (α=${Number(alpha).toFixed(
            2
          )})</span>
          <code class="gl-clamp-cmd">${escapeHtml(steered)}</code>
          <span class="gl-clamp-stat">L${frame.decision_layer} clamped: <b>${fmtSigned(
    beforeCos,
    3
  )} → ${fmtSigned(afterCos, 3)}</b> · recomputed: <b>${recomputed}L (${rolledBack} KV entries)</b></span>
        </div>
      </div>
    </div>
  `;

  const slider = container.querySelector('[data-testid="gl-clamp-alpha"]');
  const alphaVal = container.querySelector("#gl-alpha-val");
  const runBtn = container.querySelector('[data-testid="gl-clamp-run"]');

  if (slider && alphaVal) {
    slider.addEventListener("input", () => {
      alphaVal.textContent = Number(slider.value).toFixed(2);
    });
  }
  if (runBtn && typeof opts.onRunClamp === "function") {
    runBtn.addEventListener("click", () => {
      const nextAlpha = slider ? Number(slider.value) : alpha;
      opts.onRunClamp(nextAlpha, frame);
    });
  }
}
