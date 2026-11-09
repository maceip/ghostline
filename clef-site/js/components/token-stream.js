/**
 * Component A: Multi-Pass Trajectory & Token Salience Stream (`<ghostline-token-stream>`)
 *
 * - Renders Pass 1 (Trusted Task Anchor) and Pass 2 (Ingested Untrusted Context + Candidate Tool Call).
 * - Wraps each token in `<button type="button" class="tok-chip" data-tok-idx="..." data-harm="..." data-pc1="..." data-pc2="...">`.
 * - Uses CSS custom properties (`--harm`) to map `data-harm` (0.00 to 1.00) to background highlight saturation.
 * - Displays a side-by-side `.tool-diff-view` comparing the Proposed Call (Unclamped) against the Clamped Recovery.
 * - Clicking any `.tok-chip` dispatches a custom event (`ghostline:token-select`) that highlights that exact token's coordinate on the PCA canvas.
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

export class GhostlineTokenStream extends HTMLElement {
  constructor() {
    super();
    this._frame = null;
    this._clampTelemetry = null;
    this._selectedIdx = null;
    this._onSelectToken = null;
  }

  setFrame(frame, clampTelemetry = null, opts = {}) {
    this._frame = frame;
    if (clampTelemetry !== undefined) {
      this._clampTelemetry = clampTelemetry;
    }
    if (opts.selectedTokenIdx !== undefined) {
      this._selectedIdx = opts.selectedTokenIdx;
    }
    if (typeof opts.onSelectToken === "function") {
      this._onSelectToken = opts.onSelectToken;
    }
    this.render();
  }

  get frame() {
    return this._frame;
  }

  render() {
    const frame = this._frame;
    if (!isValidTraceFrame(frame)) {
      this.innerHTML = `<div class="gl-empty">No GhostlineTraceFrame loaded.</div>`;
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

    const selectedTokIdx =
      this._selectedIdx !== null && this._selectedIdx < tokens.length
        ? this._selectedIdx
        : peakIdx;

    const tokChips = tokens
      .map((t, i) => {
        const harm = Math.max(0, Math.min(1, Number(t.harm_score || 0)));
        const drift = Math.max(0, Math.min(1, Number(t.drift_score || 0)));
        const harmPct = Math.round(harm * 100);
        const driftPct = Math.round(drift * 100);
        const pc1 = Number(t.pca_coords?.[0] ?? 0);
        const pc2 = Number(t.pca_coords?.[1] ?? 0);
        const isPeak = i === peakIdx && tokens.length > 0;
        const isSel = i === selectedTokIdx;
        const sevClass =
          harm >= 0.55 ? "is-high" : harm >= 0.35 ? "is-mid" : "is-low";

        return `<button type="button"
          class="tok-chip gl-tok-chip ${sevClass} ${isPeak ? "is-peak" : ""} ${
          isSel ? "is-selected" : ""
        }"
          data-testid="gl-tok-chip"
          data-tok-idx="${i}"
          data-harm="${harm.toFixed(3)}"
          data-drift="${drift.toFixed(3)}"
          data-pc1="${pc1.toFixed(4)}"
          data-pc2="${pc2.toFixed(4)}"
          style="--harm: ${harm.toFixed(3)}; --drift: ${drift.toFixed(3)};"
          title="Token #${t.idx} '${escapeHtml(t.text)}' · harm=${harm.toFixed(
          3
        )} · drift=${drift.toFixed(3)} · PCA=[${fmtSigned(pc1, 3)}, ${fmtSigned(
          pc2,
          3
        )}]">
          <span class="gl-tok-head">
            <span class="gl-tok-idx">#${t.idx}</span>
            <code class="gl-tok-txt">${escapeHtml(t.text || "␣")}</code>
          </span>
          <span class="gl-tok-bars">
            <span class="gl-tok-bar"><i class="gl-bar-harm" style="width:${harmPct}%"></i></span>
            <span class="gl-tok-bar"><i class="gl-bar-drift" style="width:${driftPct}%"></i></span>
          </span>
          <span class="gl-tok-meta">H:${harm.toFixed(2)} · D:${drift.toFixed(2)}</span>
        </button>`;
      })
      .join("");

    const activeTok = tokens[selectedTokIdx] || tokens[0] || null;
    const tokDetail = activeTok
      ? `<div class="gl-tok-inspector" data-testid="gl-tok-detail">
          <span>TOKEN <samp>#${activeTok.idx}</samp> <code>${escapeHtml(
          activeTok.text || "␣"
        )}</code></span>
          <span>HARM SALIENCE (L${frame.decision_layer}): <samp>${fmtNum(
          activeTok.harm_score,
          3
        )}</samp></span>
          <span>TASK DRIFT: <samp>${fmtNum(activeTok.drift_score, 3)}</samp></span>
          <span>SUBSPACE [PC1, PC2]: <samp>[${fmtSigned(
            activeTok.pca_coords?.[0],
            3
          )}, ${fmtSigned(activeTok.pca_coords?.[1], 3)}]</samp></span>
        </div>`
      : "";

    const proposedCall = frame.passes?.proposed_tool_call || "—";
    const steeredCall =
      frame.passes?.steered_tool_call ||
      (frame.verdict === "allow" ? proposedCall : "cargo check --workspace");
    const ct = this._clampTelemetry;
    const beforeCos = ct?.reading_before ?? frame.harm_cosine ?? null;
    const afterCos = ct?.reading_after ?? null;

    this.innerHTML = `
      <div class="gl-comp gl-salience-comp" data-testid="gl-token-salience">
        <div class="gl-comp-hdr">
          <span class="gl-comp-title">COMPONENT A · MULTI-PASS TRAJECTORY &amp; TOKEN SALIENCE STREAM (L${
            frame.decision_layer
          })</span>
          <span class="gl-comp-sub">${tokens.length} SPAN TOKENS · ${escapeHtml(
      frame.model_id
    )} (${frame.hidden_dim}d · ${frame.prefill_ms.toFixed(1)} ms)</span>
        </div>

        <div class="gl-passes-strip">
          <div class="gl-pass-pill" data-testid="pass1-anchor-pill">
            <span class="gl-pass-tag">PASS 1 · TRUSTED TASK ANCHOR</span>
            <code>${escapeHtml(frame.passes?.anchor_prompt || "—")}</code>
          </div>
          <div class="gl-pass-pill" data-testid="pass2-context-pill">
            <span class="gl-pass-tag">PASS 2 · INGESTED UNTRUSTED CONTEXT + CANDIDATE TOOL CALL</span>
            <code>${escapeHtml(frame.passes?.candidate_context || proposedCall)}</code>
          </div>
        </div>

        <div class="gl-tok-stream" role="list">
          ${tokChips || `<span class="gl-empty">No span tokens recorded.</span>`}
        </div>

        ${tokDetail}

        <div class="tool-diff-view" data-testid="tool-diff-view">
          <div class="tool-diff-col is-proposed" data-testid="diff-proposed">
            <div class="tool-diff-hdr">
              <span>PROPOSED CALL (UNCLAMPED DECODER)</span>
              <samp>cos_harm=${fmtSigned(beforeCos, 3)} · Δ=${fmtSigned(
      frame.harm_excess,
      3
    )}</samp>
            </div>
            <pre class="tool-diff-code"><code>${escapeHtml(proposedCall)}</code></pre>
          </div>
          <div class="tool-diff-col is-clamped" data-testid="diff-clamped">
            <div class="tool-diff-hdr">
              <span>CLAMPED RECOVERY (KV ROLLBACK + SUBTRACTED v̂_harm, α=${Number(
                frame.clamp_alpha ?? 1.5
              ).toFixed(2)})</span>
              <samp>${
                afterCos !== null
                  ? `cos_after=${fmtSigned(afterCos, 3)}`
                  : `verdict=${escapeHtml(frame.verdict.toUpperCase())}`
              }</samp>
            </div>
            <pre class="tool-diff-code"><code>${escapeHtml(steeredCall)}</code></pre>
          </div>
        </div>
      </div>
    `;

    for (const btn of this.querySelectorAll(".tok-chip")) {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.tokIdx);
        const tok = tokens[idx];
        this._selectedIdx = idx;
        this.render();
        const detail = {
          tokIdx: idx,
          idx: tok?.idx ?? idx,
          text: tok?.text ?? "",
          harm: Number(btn.dataset.harm || 0),
          drift: Number(btn.dataset.drift || 0),
          pc1: Number(btn.dataset.pc1 || 0),
          pc2: Number(btn.dataset.pc2 || 0),
          token: tok,
        };
        this.dispatchEvent(
          new CustomEvent("ghostline:token-select", {
            bubbles: true,
            composed: true,
            detail,
          })
        );
        if (typeof this._onSelectToken === "function") {
          this._onSelectToken(idx, tok);
        }
      });
    }
  }
}

if (!customElements.get("ghostline-token-stream")) {
  customElements.define("ghostline-token-stream", GhostlineTokenStream);
}
