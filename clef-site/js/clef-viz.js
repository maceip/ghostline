/**
 * clef-viz — visualization component for CLEF residual stream telemetry.
 *
 * Renders the exact event shapes produced by qwen-clef-repe-guard
 * (`TelemetryEvent` / `ProbeVerdict` in src/enforcer_proxy.rs). No field is
 * invented here: a missing value renders as an explicit "—" or "unavailable",
 * never as a substitute number.
 *
 * Views: LayerSpine · ExcessGate · PcaTriad · EventTape
 */

const NS = "http://www.w3.org/2000/svg";

/** Resolve a design token from the live stylesheet (dark and light both work). */
function token(name, fallback) {
  if (typeof getComputedStyle !== "function" || typeof document === "undefined") {
    return fallback;
  }
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function palette() {
  return {
    accent: token("--accent", "#d71921"),
    success: token("--success", "#00d66b"),
    warning: token("--warning", "#d4a843"),
    interactive: token("--interactive", "#5b9bf6"),
    display: token("--text-display", "#ffffff"),
    primary: token("--text-primary", "#e8e8e8"),
    secondary: token("--text-secondary", "#999999"),
    disabled: token("--text-disabled", "#666666"),
    border: token("--border", "#222222"),
    borderVisible: token("--border-visible", "#333333"),
    surfaceRaised: token("--surface-raised", "#1a1a1a"),
  };
}

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmt(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(digits);
}

function fmtBare(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

/* ------------------------------------------------------------------ */
/* LayerSpine — per-layer LAT harm cosine profile (Layers 00..23)      */
/* ------------------------------------------------------------------ */

export class LayerSpine {
  constructor(container, opts = {}) {
    this.container = container;
    this.height = opts.height || 276;
    this.render(null);
  }

  /** @param {object|null} ev TelemetryEvent with layer_profile, probe_layer, harm_baseline */
  render(ev) {
    const C = palette();
    this.container.textContent = "";
    const W = Math.max(300, this.container.clientWidth || 520);
    const H = this.height;
    const padL = 48, padR = 68, padT = 28, padB = 30;
    const svg = el("svg", {
      width: "100%",
      height: H,
      viewBox: `0 0 ${W} ${H}`,
      class: "viz-svg",
      role: "img",
      "aria-label": "Per-layer LAT cosine trajectory across 24 decoder layers",
    });

    const profile = ev && ev.layer_profile ? ev.layer_profile : null;
    const n = profile ? profile.length : (ev && ev.num_layers) || 24;
    const probe = ev && ev.probe_layer != null ? ev.probe_layer : Math.round(n * 0.68);

    if (!profile || profile.length === 0) {
      svg.appendChild(
        el(
          "text",
          {
            x: W / 2,
            y: H / 2,
            "text-anchor": "middle",
            class: "viz-empty",
          },
          ev ? "layer profile unavailable" : "no event selected"
        )
      );
      this.container.appendChild(svg);
      return;
    }

    const baseVal = ev.harm_baseline != null ? ev.harm_baseline : 0;
    const lo = Math.min(-0.05, 0, baseVal, ...profile);
    const hi = Math.max(0.05, 0, baseVal, ...profile);
    const span = Math.max(hi - lo, 0.04);
    const x = (v) => padL + ((v - lo) / span) * (W - padL - padR);
    const y = (i) => padT + (i / (n - 1)) * (H - padT - padB);

    // Depth grid lines & labels (L00, L08, L16, L23)
    const tickLayers = [0, 8, probe, n - 1];
    for (const li of tickLayers) {
      const ly = y(li);
      const isProbe = li === probe;
      svg.appendChild(
        el("line", {
          x1: padL,
          x2: W - padR,
          y1: ly,
          y2: ly,
          stroke: isProbe ? C.accent : C.border,
          "stroke-width": isProbe ? 1.2 : 1,
          "stroke-dasharray": isProbe ? "3 3" : "1 4",
          opacity: isProbe ? 0.85 : 0.55,
        })
      );
      svg.appendChild(
        el(
          "text",
          {
            x: 6,
            y: ly + 3,
            class: "viz-tick",
            fill: isProbe ? C.accent : C.secondary,
          },
          `L${String(li).padStart(2, "0")}`
        )
      );
    }

    // Zero cosine vertical hairline
    svg.appendChild(
      el("line", {
        x1: x(0),
        x2: x(0),
        y1: padT - 4,
        y2: H - padB + 4,
        stroke: C.borderVisible,
        "stroke-width": 1,
      })
    );

    // Panel baseline vertical dashed line
    const bx = x(baseVal);
    if (ev.harm_baseline != null) {
      svg.appendChild(
        el("line", {
          x1: bx,
          x2: bx,
          y1: padT - 4,
          y2: H - padB + 4,
          stroke: C.secondary,
          "stroke-width": 1,
          "stroke-dasharray": "3 3",
        })
      );
      svg.appendChild(
        el(
          "text",
          {
            x: bx + 4,
            y: padT - 8,
            class: "viz-tick",
            fill: C.secondary,
          },
          `BASE ${fmt(baseVal, 2)}`
        )
      );
    }

    // Shaded area between baseline and profile trajectory
    const areaPts = [
      `${bx.toFixed(2)},${y(0).toFixed(2)}`,
      ...profile.map((v, i) => `${x(v).toFixed(2)},${y(i).toFixed(2)}`),
      `${bx.toFixed(2)},${y(n - 1).toFixed(2)}`,
    ].join(" ");
    const probeVal = profile[probe] ?? 0;
    const isExcessPos = probeVal - baseVal >= 0.015;
    svg.appendChild(
      el("polygon", {
        points: areaPts,
        fill: isExcessPos ? C.accent : C.success,
        opacity: 0.09,
      })
    );

    // Highlighted delta bar at Layer 16 (between baseline and L16 cosine)
    const py = y(probe);
    const px = x(probeVal);
    svg.appendChild(
      el("line", {
        x1: bx,
        x2: px,
        y1: py,
        y2: py,
        stroke: isExcessPos ? C.accent : C.success,
        "stroke-width": 3,
        opacity: 0.9,
      })
    );

    // Profile polyline
    const d = profile
      .map((v, i) => `${i === 0 ? "M" : "L"}${x(v).toFixed(2)},${y(i).toFixed(2)}`)
      .join(" ");
    svg.appendChild(
      el("path", {
        d,
        fill: "none",
        stroke: C.primary,
        "stroke-width": 1.65,
        opacity: 0.92,
      })
    );

    // Layer nodes
    profile.forEach((v, i) => {
      const isP = i === probe;
      const c = el("circle", {
        cx: x(v),
        cy: y(i),
        r: isP ? 4.8 : 2.3,
        fill: isP ? (isExcessPos ? C.accent : C.success) : v > baseVal ? C.primary : C.secondary,
        stroke: isP ? C.display : "none",
        "stroke-width": isP ? 1.2 : 0,
        class: "viz-dot",
      });
      c.appendChild(
        el("title", {}, `Layer ${i} · cos=${fmt(v)} · excess=${fmt(v - baseVal)}`)
      );
      svg.appendChild(c);
    });

    // Right margin callout at Probe Layer 16
    svg.appendChild(
      el(
        "text",
        {
          x: W - padR + 6,
          y: py + 3,
          class: "viz-tick",
          fill: isExcessPos ? C.accent : C.success,
        },
        `Δ${fmt(probeVal - baseVal, 3)}`
      )
    );

    // Bottom axis scale labels
    svg.appendChild(el("text", { x: padL, y: H - 8, class: "viz-tick" }, fmtBare(lo)));
    svg.appendChild(
      el("text", { x: x(0), y: H - 8, class: "viz-tick", "text-anchor": "middle" }, "0.000")
    );
    svg.appendChild(
      el("text", { x: W - padR, y: H - 8, class: "viz-tick", "text-anchor": "end" }, fmtBare(hi))
    );
    svg.appendChild(
      el(
        "text",
        { x: padL, y: padT - 8, class: "viz-tick" },
        `LAT COSINE · ${n} LAYERS · PROBE L${probe}`
      )
    );

    this.container.appendChild(svg);
  }
}

/* ------------------------------------------------------------------ */
/* ExcessGate — the decision instrument (with 24-segment block meter)  */
/* ------------------------------------------------------------------ */

export class ExcessGate {
  constructor(container, opts = {}) {
    this.container = container;
    this.render(null, { threshold: 0.002, mode: "monitor", baseline: "panel" });
  }

  /**
   * @param {object|null} rec  record with verdict {harm_cosine, harm_baseline, harm_excess, allowed, reason, advisories}
   * @param {object} state     {threshold, mode:'enforce'|'monitor', baseline:'panel'|'off'}
   */
  render(rec, state = {}) {
    const C = palette();
    const threshold = state.threshold ?? 0.002;
    const mode = state.mode || "monitor";
    const useBaseline = state.baseline !== "off";

    const v = rec && rec.verdict ? rec.verdict : null;
    const excess = v ? v.harm_excess : null;
    const cosine = v ? v.harm_cosine : null;
    const baseline = v ? v.harm_baseline : null;
    const shown = useBaseline ? excess : cosine;
    const aboveThr = shown != null && shown >= threshold;
    const filterEnabled = state.filterEnabled !== false;
    const blocked = aboveThr && filterEnabled;
    const optedOut = aboveThr && !filterEnabled;
    const word =
      shown == null
        ? "—"
        : optedOut
          ? "OPTED OUT"
          : mode === "monitor"
            ? blocked
              ? "HARM FLAGGED"
              : "BENIGN TRACE"
            : blocked
              ? "BLOCKED"
              : "PASSED";
    const stateColor =
      shown == null ? C.disabled : optedOut ? C.warning : blocked ? C.accent : C.success;

    const root = document.createElement("div");
    root.className = "gate";

    const headerRow = document.createElement("div");
    headerRow.className = "gate-header-row";

    const wordEl = document.createElement("div");
    wordEl.className = "gate-word";
    wordEl.style.color = stateColor;
    wordEl.textContent = word;
    headerRow.appendChild(wordEl);

    if (shown != null) {
      const badge = document.createElement("img");
      badge.className = "gate-state-icon";
      badge.src =
        mode === "monitor"
          ? blocked
            ? "./assets/logo/icon-sky-verified.png"
            : "./assets/logo/icon-mint-dormant.png"
          : blocked
            ? "./assets/logo/icon-sky-verified.png"
            : "./assets/logo/icon-acid-recompiled.png";
      badge.alt = mode === "monitor" ? "Read-only trace state" : blocked ? "Circuit tripped" : "Verified safe";
      badge.width = 28;
      badge.height = 31;
      headerRow.appendChild(badge);
    }
    root.appendChild(headerRow);

    const sub = document.createElement("div");
    sub.className = "gate-sub";
    sub.textContent =
      shown == null
        ? "select a tool call to inspect its layer-16 brain trace"
        : optedOut
          ? "READ-ONLY TRACE · ABOVE THRESHOLD, BUT VECTOR FILTER OPTED OUT IN STEP 01"
          : mode === "enforce"
            ? blocked
              ? "ENFORCE · HTTP 403 RETURNED TO AGENT BEFORE EXECUTION"
              : "ENFORCE · VERIFIED SAFE · FORWARDED TO RUNTIME"
            : blocked
              ? "READ-ONLY TRACE · HARM SIGNAL FLAGGED AT LAYER 16 (NOT BLOCKING)"
              : "READ-ONLY TRACE · CALM ACTIVATION BELOW THRESHOLD AT LAYER 16";
    root.appendChild(sub);

    // Continuous + Segmented 24-block hardware meter across [-0.15, +0.20]
    const lo = -0.15,
      hi = 0.2;
    const pct = (val) => Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * 100));
    const zeroPct = pct(0);
    const shownPct = shown != null ? pct(shown) : zeroPct;
    const fillLeft = Math.min(zeroPct, shownPct);
    const fillWidth = Math.max(0.8, Math.abs(shownPct - zeroPct));

    // Build 24 discrete blocks per DESIGN.md
    const numBlocks = 24;
    const blockEls = [];
    for (let b = 0; b < numBlocks; b++) {
      const bVal = lo + ((b + 0.5) / numBlocks) * (hi - lo);
      let cls = "gate-seg-block";
      if (shown != null) {
        if (shown >= 0 && bVal >= 0 && bVal <= shown) {
          cls += blocked ? " is-lit-blocked" : " is-lit-ok";
        } else if (shown < 0 && bVal <= 0 && bVal >= shown) {
          cls += " is-lit-ok";
        }
      }
      if (Math.abs(bVal - threshold) < (hi - lo) / (numBlocks * 1.4)) {
        cls += " is-thresh-block";
      }
      blockEls.push(`<span class="${cls}"></span>`);
    }

    const meter = document.createElement("div");
    meter.className = "gate-meter";
    meter.innerHTML = `
      <div class="gate-seg-row" aria-hidden="true">${blockEls.join("")}</div>
      <div class="gate-track">
        <div class="gate-zero" style="left:${zeroPct}%"></div>
        <div class="gate-thresh" style="left:${pct(threshold)}%"><span>THR ${fmtBare(threshold)}</span></div>
        ${
          shown != null
            ? `<div class="gate-fill ${blocked ? "is-blocked" : "is-ok"}" style="left:${fillLeft}%;width:${fillWidth}%"></div>
               <div class="gate-marker ${blocked ? "is-blocked" : "is-ok"}" style="left:${shownPct}%"></div>`
            : ""
        }
      </div>
      <div class="gate-scale"><span>${lo.toFixed(2)}</span><span>0.00</span><span>+${hi.toFixed(2)}</span></div>`;
    root.appendChild(meter);

    // Telemetry key-value ledger
    const grid = document.createElement("dl");
    grid.className = "gate-kv";
    const rows = [
      ["statistic", useBaseline ? "harm_excess (cos − base)" : "harm_cosine (raw L16)"],
      ["active score", fmt(shown)],
      ["L16 harm cosine", fmt(cosine)],
      ["panel baseline", useBaseline ? fmt(baseline) : "not subtracted"],
      ["gate threshold", fmtBare(threshold)],
      ["harm excess", fmt(excess)],
    ];
    // The token that carried the signal.  For a destructive command this
    // is the part of it that matters — the "/" of "rm -rf /" — which is
    // the whole point of reading the residual stream instead of the
    // string.  Records without one (older replays) simply omit the row.
    if (v && v.attribution_token != null) {
      rows.push([
        "flagged token",
        `"${v.attribution_token}" \u00b7 token ${v.attribution_token_index} \u00b7 cluster ${v.attribution_cluster} \u00b7 cos ${fmt(v.attribution_cosine)}`,
      ]);
    }
    for (const [k, val] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = val;
      if (k === "active score") dd.style.color = stateColor;
      grid.append(dt, dd);
    }
    root.appendChild(grid);

    // Reason + advisories
    const reason = document.createElement("p");
    reason.className = "gate-reason";
    reason.textContent = (v && v.reason) || "no verdict";
    root.appendChild(reason);

    const adv = (v && v.advisories) || [];
    if (adv.length) {
      const ul = document.createElement("ul");
      ul.className = "gate-advisories";
      for (const a of adv) {
        const li = document.createElement("li");
        li.textContent = a;
        ul.appendChild(li);
      }
      root.appendChild(ul);
    }

    this.container.textContent = "";
    this.container.appendChild(root);
  }
}

/* ------------------------------------------------------------------ */
/* PcaTriad — Top-3 LAT PCA Coordinates & Subspace Energy              */
/* ------------------------------------------------------------------ */

export class PcaTriad {
  constructor(container, opts = {}) {
    this.container = container;
    this.height = opts.height || 150;
    this.render(null);
  }

  render(ev) {
    const C = palette();
    const coords = ev && ev.pca_coords ? ev.pca_coords : null;
    const energy = ev && ev.pca_subspace_energy != null ? ev.pca_subspace_energy : null;
    this.container.textContent = "";

    const root = document.createElement("div");
    root.className = "triad";

    if (!coords || coords.length < 3) {
      root.innerHTML = `<div class="viz-empty">PCA coordinates unavailable</div>`;
      this.container.appendChild(root);
      return;
    }

    const maxAbs = Math.max(0.02, ...coords.map((c) => Math.abs(c)));
    const labels = ["PC1 · HARM", "PC2 · TOOL", "PC3 · DRIFT"];
    const colors = [C.accent, C.interactive, C.warning];

    const wrap = document.createElement("div");
    wrap.className = "triad-bars";
    coords.slice(0, 3).forEach((c, i) => {
      const col = document.createElement("div");
      col.className = "triad-col";
      const h = Math.max(3, (Math.abs(c) / maxAbs) * 72);
      col.innerHTML = `
        <div class="triad-val" style="color:${colors[i]}">${fmt(c)}</div>
        <div class="triad-rail">
          <div class="triad-zero"></div>
          <div class="triad-bar ${c >= 0 ? "pos" : "neg"}"
               style="height:${h}px;background:${colors[i]}"></div>
        </div>
        <div class="triad-lab">${labels[i]}</div>`;
      wrap.appendChild(col);
    });
    root.appendChild(wrap);

    const foot = document.createElement("div");
    foot.className = "triad-foot";
    foot.textContent = `LAT 3D subspace energy: ${fmtBare(energy)} of ||h₁₆||²`;
    root.appendChild(foot);

    this.container.appendChild(root);
  }
}

/* ------------------------------------------------------------------ */
/* EventTape — scrolling audit log                                     */
/* ------------------------------------------------------------------ */

export class EventTape {
  constructor(container, opts = {}) {
    this.container = container;
    this.rows = [];
    this.autoScroll = true;
    this.container.classList.add("tape");
    this.container.addEventListener("scroll", () => {
      this.autoScroll = this.container.scrollTop < 8;
    });
  }

  clear() {
    this.rows = [];
    this.container.textContent = "";
  }

  /**
   * @param {object} entry {id, ts_ms, tool_args_preview, tool_name, harm_excess, blocked, threshold}
   */
  push(entry) {
    const row = document.createElement("div");
    row.className = "tape-row " + (entry.blocked ? "is-blocked" : "is-ok");
    const ts = entry.ts_ms
      ? new Date(entry.ts_ms).toISOString().slice(11, 23)
      : entry.id || "--";
    const statusLabel = entry.readonly
      ? entry.blocked
        ? "FLAGGED"
        : "BENIGN"
      : entry.blocked
        ? "BLOCK"
        : "PASS";
    row.innerHTML = `
      <span class="tape-ts">${ts}</span>
      <span class="tape-tool">${entry.tool_name || "?"}</span>
      <span class="tape-cmd">${escapeHtml(entry.tool_args_preview || "")}</span>
      <span class="tape-x">${fmt(entry.harm_excess)}</span>
      <span class="tape-v">${statusLabel}</span>`;
    row.dataset.id = entry.id ?? "";
    this.container.insertBefore(row, this.container.firstChild);
    this.rows.push(row);
    while (this.rows.length > 200) {
      const old = this.rows.shift();
      old.remove();
    }
    if (this.autoScroll) this.container.scrollTop = 0;
  }

  setRows(entries) {
    this.clear();
    for (const e of entries) this.push(e);
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const viz = { LayerSpine, ExcessGate, PcaTriad, EventTape };
export default viz;
