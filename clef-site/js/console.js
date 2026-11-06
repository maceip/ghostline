/**
 * console.js — THE CONSOLE state machine.
 *
 * Data contract: every reading comes from the bundled real capture
 * (data/replay.json) or from a live guard's HTTP API. Nothing here fabricates
 * a measurement. The threshold knob re-evaluates the real decision rule
 * (`harm_excess >= threshold`) over recorded readings; it never invents cosines.
 */
import { LayerSpine, ExcessGate, PcaTriad, EventTape } from "./clef-viz.js";

// Same-origin by default: tools/serve.py proxies the guard on this origin
// (the guard itself sends no CORS headers). Override with ?base=http://host:port
// when the site is served next to a remote engine.
const DEFAULT_BASE = "";

export class Console {
  constructor(roots) {
    this.roots = roots;
    this.bundle = null;
    this.records = [];
    this.filtered = [];
    this.selectedId = null;
    this.liveBase = DEFAULT_BASE;
    this.liveInfo = null;
    this.live = false;
    /** The device-bound session, when the guard issues one. */
    this.session = null;

    // knob state
    this.state = {
      threshold: 0.002,
      mode: "enforce",
      baseline: "panel",
      cluster: "all",
    };

    this.spine = new LayerSpine(roots.spine, { height: 260 });
    this.gate = new ExcessGate(roots.gate);
    this.triad = new PcaTriad(roots.triad, { height: 150 });
    this.tape = new EventTape(roots.tape);

    this.onSelect = roots.onSelect || (() => {});
    this._bindKnobs();
    this._bindJudge();
  }

  async load() {
    const res = await fetch("./data/replay.json");
    this.bundle = await res.json();
    this.records = this.bundle.records || [];
    // sort: harmful first inside each cluster? Keep capture order — it pairs
    // harmful/benign adjacently, which reads well on the rack.
    this._applyFilter();
    this._renderRack();
    this._rejudgeAll();
    const first = this.filtered.find((r) => r.label === "harmful") || this.filtered[0];
    if (first) this.select(first.id);
    this._renderSourceChip();
    this.probeLive();
  }

  /* ---------------- knobs ---------------- */

  _bindKnobs() {
    const $ = (id) => this.roots[id];

    const thr = $("threshold");
    if (thr) {
      thr.addEventListener("input", () => {
        this.state.threshold = Number(thr.value);
        $("thresholdVal").textContent = this.state.threshold.toFixed(3);
        this._rejudgeAll();
        this._renderSelected();
        this._flashChip("[ RE-JUDGING CORPUS ]");
      });
      thr.addEventListener("change", () => this._renderSourceChip());
    }

    for (const btn of this.roots.modeButtons || []) {
      btn.addEventListener("click", () => {
        this.state.mode = btn.dataset.mode;
        this.roots.modeButtons.forEach((b) =>
          b.classList.toggle("is-on", b === btn)
        );
        this._renderSelected();
        this._renderSourceChip();
      });
    }

    for (const btn of this.roots.baselineButtons || []) {
      btn.addEventListener("click", () => {
        this.state.baseline = btn.dataset.baseline;
        this.roots.baselineButtons.forEach((b) =>
          b.classList.toggle("is-on", b === btn)
        );
        this._renderSelected();
      });
    }

    for (const btn of this.roots.clusterButtons || []) {
      btn.addEventListener("click", () => {
        this.state.cluster = btn.dataset.cluster;
        this.roots.clusterButtons.forEach((b) =>
          b.classList.toggle("is-on", b === btn)
        );
        this._applyFilter();
        this._renderRack();
        this._rejudgeAll();
      });
    }
  }

  _applyFilter() {
    const c = this.state.cluster;
    this.filtered =
      c === "all"
        ? this.records.slice()
        : this.records.filter((r) => r.cluster_id === Number(c));
  }

  /* ---------------- judging ---------------- */

  /** Real decision rule over a real reading: harm_excess >= threshold. */
  _blocked(rec) {
    const v = rec.verdict || {};
    const shown = this.state.baseline === "off" ? v.harm_cosine : v.harm_excess;
    return shown != null && shown >= this.state.threshold;
  }

  _rejudgeAll() {
    let blocked = 0;
    let harmful = 0;
    let benignWrong = 0;
    let benign = 0;
    const rows = [];
    for (const rec of this.filtered) {
      const b = this._blocked(rec);
      // Benchmark tallies use only the labeled corpus; ad-hoc live judgments
      // appear in the tape and rack but are not part of the capture's rates.
      if (rec.label === "harmful") {
        harmful++;
        if (b) blocked++;
      } else if (rec.label === "benign") {
        benign++;
        if (b) benignWrong++;
      }
      rows.push({
        id: rec.id,
        ts_ms: rec.event && rec.event.ts_ms,
        tool_name: rec.tool_name,
        tool_args_preview:
          (rec.verdict && rec.verdict.tool_args_preview) ||
          rec.call_render,
        harm_excess:
          this.state.baseline === "off"
            ? rec.verdict.harm_cosine
            : rec.verdict.harm_excess,
        blocked: b,
      });
    }
    // tape newest-first: reverse capture order
    this.tape.setRows(rows.slice().reverse());
    if (this.roots.counts) {
      this.roots.counts.innerHTML = `
        <span class="count-num">${blocked}/${harmful}</span>
        <span class="count-lab">harmful blocked</span>
        <span class="count-sep">·</span>
        <span class="count-num ${benignWrong ? "is-alarm" : ""}">${benignWrong}/${benign}</span>
        <span class="count-lab">false positives</span>`;
    }
    this._renderRack();
  }

  /* ---------------- rendering ---------------- */

  _renderRack() {
    const rack = this.roots.rack;
    if (!rack) return;
    rack.textContent = "";
    const lanes = [
      ["0", "DESTROY"],
      ["1", "STEAL"],
      ["2", "EXFIL"],
      ["-1", "AD-HOC"],
    ];
    for (const [cid, label] of lanes) {
      const recs = this.filtered.filter((r) => String(r.cluster_id) === cid);
      if (!recs.length) continue;
      const lane = document.createElement("div");
      lane.className = "rack-lane";
      lane.innerHTML = `<div class="rack-lane-h">${label}</div>`;
      for (const rec of recs) {
        const b = this._blocked(rec);
        const row = document.createElement("button");
        row.type = "button";
        row.className =
          "rack-row " +
          (rec.id === this.selectedId ? "is-sel " : "") +
          (rec.label === "harmful" ? "is-harmful " : "") +
          (b ? "is-blocked" : "is-passed");
        row.dataset.id = rec.id;
        const cmd = (rec.verdict && rec.verdict.tool_args_preview) || rec.call_render;
        row.innerHTML = `
          <span class="rack-tag">${rec.label === "harmful" ? "H" : "B"}</span>
          <span class="rack-cmd">${escapeHtml(cmd)}</span>
          <span class="rack-x">${fmt(
            this.state.baseline === "off"
              ? rec.verdict.harm_cosine
              : rec.verdict.harm_excess
          )}</span>
          <span class="rack-v">${b ? "BLK" : "PASS"}</span>`;
        row.addEventListener("click", () => this.select(rec.id));
        lane.appendChild(row);
      }
      rack.appendChild(lane);
    }
  }

  _renderSelected() {
    const rec = this.records.find((r) => r.id === this.selectedId);
    const ev = rec && rec.event ? rec.event : null;

    // For the spine/PCA we show the REAL event; for the gate we re-judge with knobs.
    this.spine.render(ev);
    this.triad.render(ev);
    this.gate.render(rec, this.state);

    const v = (rec && rec.verdict) || {};
    if (this.roots.detail) {
      this.roots.detail.innerHTML = rec
        ? `
        <div class="detail-head">
          <span class="detail-tag ${rec.label}">${rec.label.toUpperCase()}</span>
          <span class="detail-cluster">${rec.cluster}</span>
        </div>
        <p class="detail-prompt">“${escapeHtml(rec.prompt)}”</p>
        <pre class="detail-call">${escapeHtml(rec.call_render)}</pre>
        <dl class="detail-kv">
          <dt>harm cosine</dt><dd>${fmt(v.harm_cosine)}</dd>
          <dt>baseline</dt><dd>${fmt(v.harm_baseline)} <em>${escapeHtml(
            v.baseline_mode || ""
          )}</em></dd>
          <dt>excess</dt><dd>${fmt(v.harm_excess)}</dd>
          <dt>drift</dt><dd>${fmt(v.drift_cosine)}</dd>
          <dt>pca energy</dt><dd>${fmtBare(v.pca_subspace_energy)}</dd>
          <dt>probe</dt><dd>${ev ? ev.probe_layer + " / " + ev.num_layers : "—"}</dd>
          <dt>architecture</dt><dd>${escapeHtml(
            (ev && ev.architecture) || (this.bundle && this.bundle.info && this.bundle.info.architecture) || "—"
          )}</dd>
          <dt>calibration</dt><dd>${escapeHtml(
            (ev && ev.calibration_mode) ||
              (this.bundle && this.bundle.info && this.bundle.info.calibration_mode) ||
              "—"
          )}</dd>
        </dl>`
        : `<div class="viz-empty">select a tool call</div>`;
    }

    // drive the hero field
    const shown =
      this.state.baseline === "off"
        ? v.harm_cosine
        : v.harm_excess;
    const blocked = shown != null && shown >= this.state.threshold;
    this.onSelect({
      blocked,
      harm: v.harm_excess != null ? Math.max(0, Math.min(1, Math.abs(v.harm_excess) / 0.12)) : 0,
      rec,
    });
  }

  select(id) {
    this.selectedId = id;
    this._renderRack();
    this._renderSelected();
  }

  /* ---------------- source chip / live ---------------- */

  _renderSourceChip() {
    const chip = this.roots.sourceChip;
    if (!chip) return;
    if (this.live) {
      const where = this.liveBase
        ? this.liveBase.replace(/^https?:\/\//, "")
        : (typeof location !== "undefined" ? location.host : "local");
      chip.textContent = `[ LIVE · ${where} ]`;
      chip.className = "chip chip-live";
    } else {
      chip.textContent = "[ REPLAY · 36 CAPTURED CALLS · 2026-11-06 ]";
      chip.className = "chip chip-replay";
    }
  }

  _flashChip(text) {
    const chip = this.roots.sourceChip;
    if (!chip) return;
    chip.textContent = text;
    chip.className = "chip chip-rule";
    clearTimeout(this._chipT);
    this._chipT = setTimeout(() => this._renderSourceChip(), 1600);
  }

  async probeLive(base = DEFAULT_BASE) {
    if (base === "" && typeof location !== "undefined") {
      const q = new URLSearchParams(location.search).get("base");
      if (q) base = q;
    }
    this.liveBase = base;
    try {
      // The session comes FIRST. In a protected deployment /api/info needs
      // one, and a local guard that has no session route simply answers
      // 404 — which is not an error here, it just means sessions are off.
      await this._ensureSession();
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 1500);
      const res = await fetch(`${base}/api/info`, {
        signal: ctl.signal,
        credentials: "same-origin",
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(String(res.status));
      this.liveInfo = await res.json();
      this.live = true;
      if (this.roots.judgeInput) this.roots.judgeInput.disabled = false;
      if (this.roots.judgeBtn) this.roots.judgeBtn.disabled = false;
      if (this.roots.judgeNote)
        this.roots.judgeNote.textContent = `[ LIVE GUARD · ${this.liveInfo.architecture} · ${this.liveInfo.num_layers} LAYERS ]`;
    } catch {
      this.live = false;
      if (this.roots.judgeInput) this.roots.judgeInput.disabled = true;
      if (this.roots.judgeBtn) this.roots.judgeBtn.disabled = true;
      if (this.roots.judgeNote)
        this.roots.judgeNote.textContent = "[ REQUIRES LOCAL GUARD · START ONE ON :8090 TO JUDGE NEW COMMANDS ]";
    }
    this._renderSourceChip();
  }

  /**
   * Mint a device-bound session.
   *
   * There is no sign-in and nothing about the visitor is recorded: the
   * guard issues a cookie that is bound to this browser and expires on its
   * own. A local guard that does not run sessions answers 404, and that is
   * fine — it only means the session was not needed.
   */
  async _ensureSession() {
    try {
      const res = await fetch(`${this.liveBase}/api/session`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        this.session = await res.json();
        return true;
      }
    } catch {
      /* no session route, or the guard is not up yet */
    }
    this.session = null;
    return false;
  }

  _bindJudge() {
    const input = this.roots.judgeInput;
    const btn = this.roots.judgeBtn;
    if (!input || !btn) return;
    const go = async () => {
      const cmd = input.value.trim();
      if (!cmd) {
        // Say what is missing instead of doing nothing: a button that
        // swallows the click looks like a dead page.
        if (this.roots.judgeNote)
          this.roots.judgeNote.textContent =
            "[ TYPE A COMMAND TO JUDGE — THE FIELD IS EMPTY ]";
        input.focus();
        return;
      }
      if (!this.live) {
        if (this.roots.judgeNote)
          this.roots.judgeNote.textContent =
            "[ REQUIRES LOCAL GUARD · START ONE ON :8090 TO JUDGE NEW COMMANDS ]";
        return;
      }
      btn.disabled = true;
      btn.textContent = "JUDGING…";
      const probe = () =>
        fetch(`${this.liveBase}/v1/guard/tool-call`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "Ad-hoc command judged from the Clef console.",
            tool_name: "shell",
            tool_args: { cmd },
            questions: [],
          }),
        });
      try {
        let res = await probe();
        if (res.status === 401) {
          // The session expired, or the browser dropped the cookies. Mint
          // a new one and try once more before giving up.
          await this._ensureSession();
          res = await probe();
        }
        const verdict = await res.json();
        if (!res.ok) {
          throw new Error(
            verdict.hint || verdict.reason || `HTTP ${res.status}`
          );
        }
        const rec = {
          id: "live-" + Date.now(),
          label: "live",
          cluster: "ad-hoc",
          cluster_id: -1,
          prompt: "Ad-hoc command judged from the Clef console.",
          tool_name: "shell",
          tool_args: { cmd },
          call_render: `bash({"cmd": ${JSON.stringify(cmd)}})`,
          verdict,
          event: null,
        };
        this.records.unshift(rec);
        this._applyFilter();
        this._rejudgeAll();
        this.select(rec.id);
        input.value = "";
      } catch (err) {
        if (this.roots.judgeNote)
          this.roots.judgeNote.textContent = `[ ERROR: ${String(err).slice(0, 80)} ]`;
      } finally {
        btn.disabled = false;
        btn.textContent = "JUDGE";
      }
    };
    btn.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    });
  }
}

function fmt(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(digits);
}
function fmtBare(v, digits = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
