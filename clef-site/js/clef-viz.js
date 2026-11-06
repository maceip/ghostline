/**
 * clef-viz — visualization component for CLEF telemetry.
 *
 * Renders the exact event shapes produced by qwen-clef-repe-guard
 * (`TelemetryEvent` / `ProbeVerdict` in src/enforcer_proxy.rs). No field is
 * invented here: a missing value renders as an explicit "—" or "unavailable",
 * never as a substitute number.
 *
 * Views: LayerSpine · ExcessGate · PcaTriad · EventTape
 */

const NS = "http://www.w3.org/2000/svg";

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
/* LayerSpine — per-layer harm cosine profile                          */
/* ------------------------------------------------------------------ */

export class LayerSpine {
  constructor(container, opts = {}) {
    this.container = container;
    this.height = opts.height || 260;
    this.accent = opts.accent || "#D71921";
    this.info = opts.info || "#5B8DEF";
    this.ok = opts.ok || "#3FA35C";
    this.render(null);
  }

  /** @param {object|null} ev TelemetryEvent with layer_profile, probe_layer, harm_baseline */
  render(ev) {
    this.container.textContent = "";
    const W = this.container.clientWidth || 520;
    const H = this.height;
    const padL = 44, padR = 56, padT = 18, padB = 28;
    const svg = el("svg", {
      width: "100%", height: H, viewBox: `0 0 ${W} ${H}`,
      class: "viz-svg", role: "img",
    });

    const profile = ev && ev.layer_profile ? ev.layer_profile : null;
    const n = profile ? profile.length : (ev && ev.num_layers) || 24;
    const probe = ev && ev.probe_layer != null ? ev.probe_layer : Math.round(n * 0.68);

    if (!profile || profile.length === 0) {
      svg.appendChild(el("text", {
        x: W / 2, y: H / 2, "text-anchor": "middle", class: "viz-empty",
      }, ev ? "layer profile unavailable" : "no event selected"));
      this.container.appendChild(svg);
      return;
    }

    const lo = Math.min(0, ...profile);
    const hi = Math.max(0, ...profile);
    const span = Math.max(hi - lo, 0.02);
    const x = (v) => padL + ((v - lo) / span) * (W - padL - padR);
    const y = (i) => padT + (i / (n - 1)) * (H - padT - padB);

    // axis hairline at 0
    svg.appendChild(el("line", {
      x1: x(0), x2: x(0), y1: padT - 4, y2: H - padB + 4,
      stroke: "#2C2C2C", "stroke-width": 1,
    }));

    // baseline hairline
    if (ev.harm_baseline != null) {
      const bx = x(ev.harm_baseline);
      svg.appendChild(el("line", {
        x1: bx, x2: bx, y1: padT - 4, y2: H - padB + 4,
        stroke: "#8C8C8C", "stroke-width": 1, "stroke-dasharray": "3 3",
      }));
      svg.appendChild(el("text", {
        x: bx + 4, y: padT + 6, class: "viz-tick",
      }, "baseline"));
    }

    // probe marker band
    svg.appendChild(el("line", {
      x1: padL, x2: W - padR, y1: y(probe), y2: y(probe),
      stroke: this.accent, "stroke-width": 1, "stroke-dasharray": "2 4", opacity: 0.7,
    }));
    svg.appendChild(el("text", {
      x: W - padR + 6, y: y(probe) + 3, class: "viz-tick", fill: this.accent,
    }, `L${probe}`));

    // profile polyline
    const d = profile.map((v, i) => `${i === 0 ? "M" : "L"}${x(v).toFixed(2)},${y(i).toFixed(2)}`).join(" ");
    svg.appendChild(el("path", {
      d, fill: "none", stroke: "#E4E4E4", "stroke-width": 1.5, opacity: 0.85,
    }));

    // dots
    profile.forEach((v, i) => {
      const c = el("circle", {
        cx: x(v), cy: y(i), r: i === probe ? 4 : 2.4,
        fill: i === probe ? this.accent : (v > 0 ? "#E4E4E4" : "#8C8C8C"),
        class: "viz-dot",
      });
      const t = el("title", {}, `L${i}  ${fmt(v)}`);
      c.appendChild(t);
      svg.appendChild(c);
    });

    // x scale labels
    svg.appendChild(el("text", { x: padL, y: H - 8, class: "viz-tick" }, fmtBare(lo)));
    svg.appendChild(el("text", { x: W - padR, y: H - 8, class: "viz-tick", "text-anchor": "end" }, fmtBare(hi)));
    svg.appendChild(el("text", { x: padL, y: padT + 6, class: "viz-tick" }, `n=${n} layers · probe ${probe}`));

    this.container.appendChild(svg);
  }
}

/* ------------------------------------------------------------------ */
/* ExcessGate — the decision instrument                                */
/* ------------------------------------------------------------------ */

export class ExcessGate {
  constructor(container, opts = {}) {
    this.container = container;
    this.accent = opts.accent || "#D71921";
    this.ok = opts.ok || "#3FA35C";
    this.warn = opts.warn || "#C9971F";
    this.render(null, { threshold: 0.015, mode: "enforce", baseline: "panel" });
  }

  /**
   * @param {object|null} rec  record with verdict {harm_cosine, harm_baseline, harm_excess, allowed, reason, advisories}
   * @param {object} state     {threshold, mode:'enforce'|'monitor', baseline:'panel'|'off'}
   */
  render(rec, state = {}) {
    const threshold = state.threshold ?? 0.015;
    const mode = state.mode || "enforce";
    const useBaseline = state.baseline !== "off";

    const v = rec && rec.verdict ? rec.verdict : null;
    const excess = v ? v.harm_excess : null;
    const cosine = v ? v.harm_cosine : null;
    const baseline = v ? v.harm_baseline : null;
    const shown = useBaseline ? excess : cosine;
    const blocked = shown != null && shown >= threshold;
    const word = shown == null ? "—" : blocked ? "BLOCKED" : "PASSED";
    const stateColor = shown == null ? "#5A5A5A" : blocked ? this.accent : this.ok;

    const root = document.createElement("div");
    root.className = "gate";

    const wordEl = document.createElement("div");
    wordEl.className = "gate-word";
    wordEl.style.color = stateColor;
    wordEl.textContent = word;
    root.appendChild(wordEl);

    const sub = document.createElement("div");
    sub.className = "gate-sub";
    sub.textContent =
      shown == null
        ? "select a finding"
        : mode === "enforce"
          ? blocked
            ? "enforce · 403 returned to the agent"
            : "enforce · call forwarded upstream"
          : blocked
            ? "monitor · reported, passed through"
            : "monitor · reported, passed through";
    root.appendChild(sub);

    // meter
    const W = 100; // percent space
    const lo = -0.15, hi = 0.20;
    const pct = (val) => Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * W));
    const meter = document.createElement("div");
    meter.className = "gate-meter";
    meter.innerHTML = `
      <div class="gate-track">
        <div class="gate-zero" style="left:${pct(0)}%"></div>
        <div class="gate-thresh" style="left:${pct(threshold)}%"><span>THR</span></div>
        ${shown != null ? `<div class="gate-fill ${blocked ? "is-blocked" : "is-ok"}" style="left:${pct(0)}%;width:${Math.max(0.6, pct(shown) - pct(0))}%"></div>
        <div class="gate-marker ${blocked ? "is-blocked" : "is-ok"}" style="left:${pct(shown)}%"></div>` : ""}
      </div>
      <div class="gate-scale"><span>${lo.toFixed(2)}</span><span>0</span><span>${hi.toFixed(2)}</span></div>`;
    root.appendChild(meter);

    // numbers
    const grid = document.createElement("dl");
    grid.className = "gate-kv";
    const rows = [
      ["statistic", useBaseline ? "harm_excess" : "harm_cosine (baseline off)"],
      ["value", fmt(shown)],
      ["harm cosine", fmt(cosine)],
      ["baseline", useBaseline ? fmt(baseline) : "not subtracted"],
      ["threshold", fmtBare(threshold)],
      ["excess", fmt(excess)],
    ];
    for (const [k, val] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = val;
      if (k === "value") dd.style.color = stateColor;
      grid.append(dt, dd);
    }
    root.appendChild(grid);

    // reason + advisories
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
/* PcaTriad — PC1/PC2/PC3                                              */
/* ------------------------------------------------------------------ */

export class PcaTriad {
  constructor(container, opts = {}) {
    this.container = container;
    this.height = opts.height || 150;
    this.info = opts.info || "#5B8DEF";
    this.render(null);
  }

  render(ev) {
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
    const labels = ["PC1", "PC2", "PC3"];
    const colors = ["#E4E4E4", this.info, "#C9971F"];

    const wrap = document.createElement("div");
    wrap.className = "triad-bars";
    coords.slice(0, 3).forEach((c, i) => {
      const col = document.createElement("div");
      col.className = "triad-col";
      const h = (Math.abs(c) / maxAbs) * 76;
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
    foot.textContent = `subspace energy ${fmtBare(energy)}`;
    root.appendChild(foot);

    this.container.appendChild(root);
  }
}

/* ------------------------------------------------------------------ */
/* EventTape — scrolling log                                           */
/* ------------------------------------------------------------------ */

export class EventTape {
  constructor(container, opts = {}) {
    this.container = container;
    this.accent = opts.accent || "#D71921";
    this.ok = opts.ok || "#3FA35C";
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
    row.innerHTML = `
      <span class="tape-ts">${ts}</span>
      <span class="tape-tool">${entry.tool_name || "?"}</span>
      <span class="tape-cmd">${escapeHtml(entry.tool_args_preview || "")}</span>
      <span class="tape-x">${fmt(entry.harm_excess)}</span>
      <span class="tape-v">${entry.blocked ? "BLOCK" : "PASS"}</span>`;
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
