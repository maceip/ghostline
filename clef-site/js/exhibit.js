/**
 * exhibit.js — Page 2 (demo.html): Unauthenticated Interactive Timeline,
 * Opt-In Threat Vector Filters, Clickable Attack/Benign Prompts, & Live Traces Workbench.
 *
 * Features:
 * 1. Unauthenticated by default for normal visitors (mints device session via POST /api/session
 *    if required, or connects directly to /api/info).
 * 2. Supports ?lock=1 or clicking #btn-lock-session to display the #auth-gate password modal
 *    verified against GET /api/info with Authorization: Bearer <token> & X-Require-Auth: 1.
 * 3. Step 01 Opt-In Threat Filters (#optin-filters), Step 02 Clickable Prompt Buttons (#ex-chip-row),
 *    Step 03 Live 4-Stage Brain Timeline (#ex-tl-track), and Sortable/Filterable Trace Workbench (#rack).
 */
import { ResidualField } from "./field.js";
import { LayerSpine, ExcessGate, EventTape } from "./clef-viz.js";
import { hydrateIcons } from "./icons.js";

hydrateIcons();

const $ = (id) => document.getElementById(id);

/* ---------- theme & logo assets ---------- */
const storedTheme = localStorage.getItem("clef-theme");
const initialTheme =
  storedTheme || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
document.documentElement.setAttribute("data-theme", initialTheme);

function setLogo(theme) {
  const dark = theme !== "light";
  const map = [
    ["ex-logo", dark ? "./assets/logo/lockup-dark.png" : "./assets/logo/lockup-light.png"],
    ["ex-mark-mobile", dark ? "./assets/logo/mark-dark.png" : "./assets/logo/mark-light.png"],
    ["auth-logo", dark ? "./assets/logo/lockup-dark.png" : "./assets/logo/lockup-light.png"],
  ];
  for (const [id, src] of map) {
    const img = $(id);
    if (img) img.src = src;
  }
}

/* ---------- instruments ---------- */
const field = new ResidualField($("field"), { theme: initialTheme });
const spine = new LayerSpine($("spine"), { height: 280 });
const gate = new ExcessGate($("gate"));
const tape = new EventTape($("tape"));

/* ---------- state ---------- */
let bundle = null;
let records = [];
let filtered = [];
let selectedId = null;
let authToken = sessionStorage.getItem("clef-auth-token") || "";
let live = false;
let liveInfo = null;
let latestLiveEvent = null;
let sseSource = null;

const optedInClusters = new Set(["0", "1", "2", "-1"]);

const state = {
  threshold: 0.002,
  mode: "monitor", // Read-only trace mode by default
  baseline: "panel",
  cluster: "all",
  sort: "capture",
};

const CLUSTER_LABELS = {
  "0": "Cluster 00 · Filesystem Destruction",
  "1": "Cluster 01 · Secret & Credential Theft",
  "2": "Cluster 02 · Network Exfiltration",
  "-1": "Live Probed Command",
};

function setStep(n) {
  for (const li of document.querySelectorAll("#ex-rail li")) {
    const s = Number(li.dataset.step);
    li.classList.toggle("is-now", s === n);
    li.classList.toggle("is-done", s < n);
  }
}

function status(text, cls) {
  const textEl = $("ex-status-text");
  const pillEl = $("ex-status");
  const dotEl = $("ex-status-dot");
  if (textEl) textEl.textContent = text;
  if (pillEl) {
    pillEl.classList.toggle("is-blocked", cls === "blocked");
    pillEl.classList.toggle("is-ok", cls === "ok");
  }
  if (dotEl) {
    dotEl.classList.toggle("is-alert", cls === "blocked");
  }
}

/* ---------- authentication gate ---------- */
async function verifyTokenAndUnlock(token, isAutoBoot = false) {
  const errEl = $("auth-error");
  const btn = $("auth-submit-btn");
  if (errEl) errEl.hidden = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "VERIFYING TOKEN…";
  }

  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch("/api/info", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Require-Auth": "1",
      },
      signal: ctl.signal,
    });
    clearTimeout(timer);

    if (res.status === 401) {
      throw new Error("HTTP 401 Unauthorized — Invalid operator password or bearer token.");
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from guard /api/info`);
    }

    const info = await res.json();
    authToken = token;
    sessionStorage.setItem("clef-auth-token", token);
    live = true;
    liveInfo = info;

    unlockDashboard(info);
    return true;
  } catch (err) {
    if (!isAutoBoot && errEl) {
      errEl.textContent = String(err.message || err);
      errEl.hidden = false;
    }
    return false;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "UNLOCK LIVE TRACES →";
    }
  }
}

function unlockDashboard(info) {
  document.body.classList.remove("is-locked");
  const gateModal = $("auth-gate");
  if (gateModal) gateModal.hidden = true;

  if (info && info.architecture) {
    const chipText = $("source-chip-text");
    if (chipText) {
      chipText.textContent = `LIVE · ${info.architecture} · ${info.num_layers}L · READ-ONLY TRACES`;
    }
    const metaEl = $("live-engine-meta");
    if (metaEl) {
      metaEl.textContent = `${info.architecture.toUpperCase()} · ${info.num_layers} LAYERS · d_model = ${info.d_model} · ${info.calibration_mode || "PROBE L16"}`;
    }
    status(`LIVE STREAM CONNECTED · ${info.architecture} (READ-ONLY)`, "ok");
  }

  connectLiveSse();

  requestAnimationFrame(() => {
    field.resize();
    field.start();
    applyFilterAndSort();
    rejudgeAll();
    const first = filtered.find((r) => r.id === "12") || filtered.find((r) => r.label === "harmful") || filtered[0];
    if (first) selectRecord(first.id, { instant: true });
    setStep(4);
  });
}

function lockDashboard() {
  sessionStorage.removeItem("clef-auth-token");
  authToken = "";
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  const gateModal = $("auth-gate");
  if (gateModal) gateModal.hidden = false;
  document.body.classList.add("is-locked");
  const input = $("auth-password-input");
  if (input) {
    input.value = "";
    input.focus();
  }
}

/* ---------- live SSE stream (/api/events) ---------- */
function connectLiveSse() {
  if (sseSource || typeof EventSource === "undefined" || !window.ENABLE_CLEF_SSE) return;
  mintSession()
    .catch(() => false)
    .then(() => {
      try {
        sseSource = new EventSource("/api/events");
        sseSource.onmessage = (msg) => {
          try {
            const ev = JSON.parse(msg.data);
            latestLiveEvent = ev;
          } catch {
            // Ignore malformed SSE heartbeats
          }
        };
        sseSource.onerror = () => {
          mintSession().catch(() => false);
        };
      } catch {
        // Ignore SSE error if offline
      }
    });
}

async function mintSession() {
  const res = await fetch("/api/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) throw new Error(`session ${res.status}`);
  return res.json();
}

/* ---------- Step 01: Opt-In Threat Filters ---------- */
function bindOptInFilters() {
  for (const card of document.querySelectorAll("#optin-filters .ex-optin-card")) {
    card.addEventListener("click", () => {
      const cid = String(card.dataset.optinCluster);
      if (optedInClusters.has(cid)) {
        optedInClusters.delete(cid);
      } else {
        optedInClusters.add(cid);
      }
      const on = optedInClusters.has(cid);
      card.classList.toggle("is-on", on);
      card.setAttribute("aria-pressed", String(on));
      const badge = card.querySelector(".ex-optin-badge");
      if (badge) badge.textContent = on ? "OPTED IN ✓" : "OPTED OUT";
      rejudgeAll();
      if (selectedId) renderSelected({ instant: true });
    });
  }
}

/* ---------- Step 02: Clickable Malicious & Benign Prompt Buttons ---------- */
function renderChips() {
  const row = $("ex-chip-row");
  const list = $("ex-presets");
  if (!row) return;
  row.textContent = "";
  if (list) list.textContent = "";

  const picks = ["12", "00", "20", "24", "13", "21"]
    .map((id) => records.find((r) => r.id === id))
    .filter(Boolean);

  for (const rec of picks) {
    const rawCmd = (rec.tool_args && rec.tool_args.cmd) ||
      (rec.verdict?.tool_args_preview || rec.call_render || "").replace(/^cmd=/, "");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.recId = rec.id;
    const isHarm = rec.label === "harmful";
    btn.className = "ex-specimen" + (isHarm ? " is-harm" : "");
    const tag = rec.id === "24"
      ? "⚠ MALICIOUS (THE 1 MISS)"
      : isHarm
        ? "▶ RUN MALICIOUS PROMPT"
        : "▶ RUN BENIGN PROMPT";
    btn.innerHTML = `
      <span class="ex-spec-top">
        <span>${tag}</span>
        <span>Δ ${fmt(rec.verdict?.harm_excess)}</span>
      </span>
      <span class="ex-spec-cmd">${escapeHtml(rawCmd)}</span>
      <span class="ex-spec-prompt">Prompt: “${escapeHtml(rec.prompt || "")}”</span>`;
    btn.addEventListener("click", () => {
      $("ex-input").value = rawCmd;
      selectRecord(rec.id, { instant: false });
    });
    row.appendChild(btn);

    if (list) {
      const opt = document.createElement("option");
      opt.value = rawCmd;
      list.appendChild(opt);
    }
  }
}

function highlightActiveChip(id) {
  for (const b of document.querySelectorAll("#ex-chip-row .ex-specimen")) {
    b.classList.toggle("is-active", b.dataset.recId === id);
  }
}

/* ---------- filtering, sorting & judging ---------- */
function getScore(rec) {
  const v = rec.verdict || {};
  return state.baseline === "off" ? v.harm_cosine : v.harm_excess;
}

function isFlagged(rec) {
  const s = getScore(rec);
  const cid = String(rec.cluster_id ?? "0");
  const clusterEnabled = cid === "-1" || optedInClusters.has(cid);
  return s != null && s >= state.threshold && clusterEnabled;
}

function applyFilterAndSort() {
  const c = state.cluster;
  const subset =
    c === "all"
      ? records.slice()
      : records.filter((r) => String(r.cluster_id) === String(c));

  const sortMode = state.sort;
  if (sortMode === "excess-desc") {
    subset.sort((a, b) => (b.verdict?.harm_excess ?? -99) - (a.verdict?.harm_excess ?? -99));
  } else if (sortMode === "excess-asc") {
    subset.sort((a, b) => (a.verdict?.harm_excess ?? 99) - (b.verdict?.harm_excess ?? 99));
  } else if (sortMode === "cosine-desc") {
    subset.sort((a, b) => (b.verdict?.harm_cosine ?? -99) - (a.verdict?.harm_cosine ?? -99));
  }

  filtered = subset;

  const sortLabels = {
    capture: "SORT: CAPTURE ORDER",
    "excess-desc": "SORT: HARM EXCESS (HIGH → LOW)",
    "excess-asc": "SORT: HARM EXCESS (LOW → HIGH)",
    "cosine-desc": "SORT: RAW COSINE (HIGH → LOW)",
  };
  const lbl = $("rack-sort-label");
  if (lbl) lbl.textContent = sortLabels[sortMode] || "SORT: CAPTURE ORDER";
}

function rejudgeAll() {
  let flaggedHarm = 0;
  let totalHarm = 0;
  let falsePos = 0;
  let totalBenign = 0;
  let liveCount = 0;
  const tapeRows = [];

  for (const rec of filtered) {
    const b = isFlagged(rec);
    if (rec.label === "harmful") {
      totalHarm++;
      if (b) flaggedHarm++;
    } else if (rec.label === "benign") {
      totalBenign++;
      if (b) falsePos++;
    } else if (rec.label === "live") {
      liveCount++;
    }

    tapeRows.push({
      id: rec.id,
      ts_ms: rec.event && rec.event.ts_ms,
      tool_name: rec.tool_name,
      tool_args_preview: (rec.verdict && rec.verdict.tool_args_preview) || rec.call_render,
      harm_excess: getScore(rec),
      blocked: b,
      readonly: state.mode === "monitor",
    });
  }

  tape.setRows(tapeRows.slice().reverse());

  const countsEl = $("counts");
  if (countsEl) {
    countsEl.innerHTML = `
      <span class="count-num">${flaggedHarm}/${totalHarm}</span>
      <span class="count-lab">harmful flagged</span>
      <span class="count-sep">·</span>
      <span class="count-num ${falsePos ? "is-alarm" : ""}">${falsePos}/${totalBenign}</span>
      <span class="count-lab">false alarms</span>
      <span class="count-sep">·</span>
      <span class="count-num">${filtered.length}</span>
      <span class="count-lab">traces shown${liveCount ? ` (${liveCount} live)` : ""}</span>`;
  }

  renderRack();
}

function renderRack() {
  const rack = $("rack");
  if (!rack) return;
  rack.textContent = "";

  if (state.sort !== "capture") {
    const lane = document.createElement("div");
    lane.className = "rack-lane";
    lane.innerHTML = `<div class="rack-lane-h">ALL MATCHING TRACES (${filtered.length}) · ${state.sort.toUpperCase()}</div>`;
    for (const rec of filtered) {
      lane.appendChild(buildRackRow(rec));
    }
    rack.appendChild(lane);
    return;
  }

  const lanes = [
    ["-1", "LIVE PROBED TRACES (REAL-TIME ENGINE)"],
    ["0", "CLUSTER 00 · FILESYSTEM DESTRUCTION"],
    ["1", "CLUSTER 01 · SECRET & CREDENTIAL THEFT"],
    ["2", "CLUSTER 02 · NETWORK EXFILTRATION"],
  ];

  for (const [cid, label] of lanes) {
    const recs = filtered.filter((r) => String(r.cluster_id) === cid);
    if (!recs.length) continue;
    const lane = document.createElement("div");
    lane.className = "rack-lane";
    lane.innerHTML = `<div class="rack-lane-h">${label}</div>`;
    for (const rec of recs) {
      lane.appendChild(buildRackRow(rec));
    }
    rack.appendChild(lane);
  }
}

function buildRackRow(rec) {
  const b = isFlagged(rec);
  const row = document.createElement("button");
  row.type = "button";
  row.className =
    "rack-row " +
    (rec.id === selectedId ? "is-sel " : "") +
    (rec.label === "harmful" ? "is-harmful " : "") +
    (b ? "is-blocked" : "is-passed");
  row.dataset.id = rec.id;
  row.dataset.excess = String(rec.verdict?.harm_excess ?? 0);
  const cmd = (rec.verdict && rec.verdict.tool_args_preview) || rec.call_render;
  const tagChar = rec.label === "live" ? "LIVE" : rec.label === "harmful" ? "HARM" : "SAFE";
  row.innerHTML = `
    <span class="rack-tag">${tagChar}</span>
    <span class="rack-cmd">${escapeHtml(cmd)}</span>
    <span class="rack-x">${fmt(getScore(rec))}</span>
    <span class="rack-v">${b ? "FLAG" : "CLEAN"}</span>`;
  row.addEventListener("click", () => selectRecord(rec.id, { instant: false }));
  return row;
}

async function selectRecord(id, opts = {}) {
  selectedId = id;
  highlightActiveChip(id);
  renderRack();
  await renderSelected(opts);
}

async function renderSelected(opts = {}) {
  const rec = records.find((r) => r.id === selectedId);
  if (!rec) return;
  const ev = rec.event || null;
  const v = rec.verdict || {};

  // Animate 4-Stage Brain Timeline
  const nodes = Array.from(document.querySelectorAll("#ex-tl-track .ex-tl-node"));
  if (!opts.instant && nodes.length === 4) {
    setStep(2);
    nodes.forEach((n, i) => {
      n.classList.toggle("is-active", i === 1);
      n.classList.toggle("is-done", i < 1);
      n.classList.remove("is-flagged");
    });
    await wait(120);
    setStep(3);
    nodes.forEach((n, i) => {
      n.classList.toggle("is-active", i === 2);
      n.classList.toggle("is-done", i < 2);
    });
    await wait(140);
  }

  setStep(4);
  spine.render(ev);
  gate.render(rec, state);
  renderDetail(rec);
  renderTimelineBar(rec);

  const flagged = isFlagged(rec);
  const harm = v.harm_excess != null ? Math.max(0, Math.min(1, Math.abs(v.harm_excess) / 0.12)) : 0;
  field.setState({ blocked: flagged, harm });

  status(
    flagged
      ? `TRACE #${rec.id} · FLAGGED AT LAYER 16 (${fmt(getScore(rec))}) · READ-ONLY`
      : `TRACE #${rec.id} · CLEAN BELOW THRESHOLD (${fmt(getScore(rec))}) · READ-ONLY`,
    flagged ? "blocked" : "ok"
  );
}

function renderTimelineBar(rec) {
  const v = rec.verdict || {};
  const score = getScore(rec);
  const aboveThr = score != null && score >= state.threshold;
  const cid = String(rec.cluster_id ?? "0");
  const filterOn = cid === "-1" || optedInClusters.has(cid);
  const flagged = aboveThr && filterOn;

  const pEl = $("tl-node-prompt");
  const cEl = $("tl-node-cmd");
  const clEl = $("tl-node-cluster");
  const mEl = $("tl-node-math");
  const vBox = $("tl-node-verdict-box");
  const vDot = $("tl-node-dot");
  const vWord = $("tl-node-verdict");
  const vExp = $("tl-node-explain");

  if (pEl) pEl.textContent = `“${rec.prompt || "—"}”`;
  if (cEl) cEl.textContent = rec.call_render || "";
  if (clEl) clEl.textContent = CLUSTER_LABELS[cid] || `Cluster ${rec.cluster || "ad-hoc"}`;
  if (mEl) {
    mEl.textContent = `cos ${fmt(v.harm_cosine)} − base ${fmt(v.harm_baseline)} = Δ ${fmt(v.harm_excess)}`;
  }

  for (const n of document.querySelectorAll("#ex-tl-track .ex-tl-node")) {
    const idx = Number(n.dataset.node);
    n.classList.remove("is-active");
    if (idx < 4) n.classList.add("is-done");
  }
  if (vBox) {
    vBox.classList.toggle("is-flagged", flagged);
    vBox.classList.toggle("is-done", !flagged);
  }
  if (vDot) vDot.classList.toggle("is-alert", flagged);
  if (vWord) {
    vWord.textContent = flagged
      ? `FLAGGED (${fmt(score)})`
      : aboveThr && !filterOn
        ? `OPTED OUT (${fmt(score)})`
        : `CLEAN TRACE (${fmt(score)})`;
  }
  if (vExp) {
    vExp.textContent = flagged
      ? "Read-only trace · Opt-in filter matched ✓"
      : aboveThr && !filterOn
        ? "Above threshold, but cluster filter unchecked"
        : "Read-only trace · Below threshold";
  }
}

function renderDetail(rec) {
  const v = rec.verdict || {};
  const ev = rec.event || {};
  const detailEl = $("detail");
  if (!detailEl) return;

  detailEl.innerHTML = `
    <div class="detail-head">
      <span class="detail-tag ${rec.label}">${String(rec.label).toUpperCase()} TRACE</span>
      <span class="detail-cluster">CLUSTER: ${escapeHtml(rec.cluster || "ad-hoc")}</span>
    </div>
    <p class="detail-prompt">Prompt: “${escapeHtml(rec.prompt || "—")}”</p>
    <pre class="detail-call">${escapeHtml(rec.call_render || "")}</pre>
    <dl class="detail-kv">
      <dt>L16 harm cosine</dt><dd>${fmt(v.harm_cosine)}</dd>
      <dt>prompt baseline</dt><dd>${fmt(v.harm_baseline)} <em>(${escapeHtml(v.baseline_mode || "live-panel")})</em></dd>
      <dt>harm excess (Δ)</dt><dd>${fmt(v.harm_excess)}</dd>
      <dt>task drift cosine</dt><dd>${fmt(v.drift_cosine)}</dd>
      <dt>LAT PCA energy</dt><dd>${fmtBare(v.pca_subspace_energy)}</dd>
      <dt>probe depth</dt><dd>Layer ${ev.probe_layer ?? 16} / ${ev.num_layers ?? 24} (68%)</dd>
      <dt>backbone</dt><dd>${escapeHtml(ev.architecture || liveInfo?.architecture || "Qwen2ForCausalLM")}</dd>
      <dt>trace reason</dt><dd style="text-align:right">${escapeHtml(v.reason || "read-only trace recorded")}</dd>
    </dl>`;
}

/* ---------- live tool-call probe (POST /v1/guard/tool-call) ---------- */
async function runLiveProbe() {
  const inputEl = $("ex-input");
  const cmd = inputEl ? inputEl.value.trim() : "";
  if (!cmd) return;

  const btn = $("ex-play-btn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "TRACING LAYER 16…";
  }
  setStep(2);
  status("RUNNING FORWARD PASS ON QWEN2.5-0.5B…");

  try {
    setStep(3);
    const headers = { "Content-Type": "application/json" };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
      headers["X-Require-Auth"] = "1";
    }
    const res = await fetch("/v1/guard/tool-call", {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify({
        prompt: "Interactive live trace from the RepE + Clef console.",
        tool_name: "shell",
        tool_args: { cmd },
        questions: [],
      }),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const verdict = await res.json();
    await wait(120);

    const ev =
      latestLiveEvent &&
      latestLiveEvent.harm_cosine != null &&
      Math.abs(latestLiveEvent.harm_cosine - verdict.harm_cosine) < 1e-4
        ? latestLiveEvent
        : {
            ts_ms: Date.now(),
            architecture: liveInfo?.architecture || "Qwen2ForCausalLM",
            num_layers: liveInfo?.num_layers || 24,
            probe_layer: 16,
            harm_cosine: verdict.harm_cosine,
            harm_baseline: verdict.harm_baseline,
            harm_excess: verdict.harm_excess,
            pca_subspace_energy: verdict.pca_subspace_energy,
            layer_profile: latestLiveEvent?.layer_profile || records[0]?.event?.layer_profile || null,
          };

    const rec = {
      id: "live-" + String(Date.now()).slice(-4),
      label: "live",
      cluster: "live-probe",
      cluster_id: -1,
      prompt: "Interactive live trace from the RepE + Clef console.",
      tool_name: "shell",
      tool_args: { cmd },
      call_render: `bash({"cmd": ${JSON.stringify(cmd)}})`,
      verdict,
      event: ev,
    };

    records.unshift(rec);
    state.cluster = "all";
    document.querySelectorAll("#seg-cluster .seg-btn").forEach((b) =>
      b.classList.toggle("is-on", b.dataset.cluster === "all")
    );
    applyFilterAndSort();
    rejudgeAll();
    await selectRecord(rec.id, { instant: true });
    setStep(4);
  } catch (err) {
    // Fallback to matching real captured record if live guard returned an error
    const matched = records.find((r) => {
      const c = (r.verdict?.tool_args_preview || r.call_render || "").toLowerCase();
      return c.includes(cmd.toLowerCase());
    });
    if (matched) {
      await selectRecord(matched.id, { instant: false });
    } else {
      status(`LIVE PROBE ERROR: ${String(err.message || err).slice(0, 60)}`, "blocked");
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<span class="live-dot live-dot-btn" aria-hidden="true"></span> TRACE LIVE`;
    }
  }
}

/* ---------- bind interactive controls ---------- */
function bindControls() {
  bindOptInFilters();

  const authForm = $("auth-form");
  if (authForm) {
    authForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const val = $("auth-password-input")?.value.trim() || "";
      if (!val) return;
      await verifyTokenAndUnlock(val, false);
    });
  }

  const lockBtn = $("btn-lock-session");
  if (lockBtn) {
    lockBtn.addEventListener("click", () => lockDashboard());
  }

  const thr = $("thr");
  if (thr) {
    thr.addEventListener("input", () => {
      state.threshold = Number(thr.value);
      $("thr-val").textContent = state.threshold.toFixed(3);
      rejudgeAll();
      renderSelected({ instant: true });
    });
  }

  for (const btn of document.querySelectorAll("#seg-cluster .seg-btn")) {
    btn.addEventListener("click", () => {
      state.cluster = btn.dataset.cluster;
      document.querySelectorAll("#seg-cluster .seg-btn").forEach((b) =>
        b.classList.toggle("is-on", b === btn)
      );
      applyFilterAndSort();
      rejudgeAll();
      if (filtered.length && !filtered.some((r) => r.id === selectedId)) {
        selectRecord(filtered[0].id, { instant: true });
      }
    });
  }

  for (const btn of document.querySelectorAll("#seg-sort .seg-btn")) {
    btn.addEventListener("click", () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll("#seg-sort .seg-btn").forEach((b) =>
        b.classList.toggle("is-on", b === btn)
      );
      applyFilterAndSort();
      rejudgeAll();
      if (filtered.length) {
        selectRecord(filtered[0].id, { instant: true });
      }
    });
  }

  for (const btn of document.querySelectorAll("#seg-baseline .seg-btn")) {
    btn.addEventListener("click", () => {
      state.baseline = btn.dataset.baseline;
      document.querySelectorAll("#seg-baseline .seg-btn").forEach((b) =>
        b.classList.toggle("is-on", b === btn)
      );
      rejudgeAll();
      renderSelected({ instant: true });
    });
  }

  for (const btn of document.querySelectorAll("#seg-mode .seg-btn")) {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll("#seg-mode .seg-btn").forEach((b) =>
        b.classList.toggle("is-on", b === btn)
      );
      const gm = $("gate-mode");
      if (gm) gm.textContent = state.mode === "monitor" ? "READ-ONLY TRACE" : "SIMULATED BLOCK";
      renderSelected({ instant: true });
    });
  }

  const playBtn = $("ex-play-btn");
  if (playBtn) playBtn.addEventListener("click", () => runLiveProbe());
  const playInput = $("ex-input");
  if (playInput) {
    playInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runLiveProbe();
    });
  }

  for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
    btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("clef-theme", theme);
  field.setTheme(theme);
  setLogo(theme);
  document.querySelectorAll("#seg-theme .seg-btn").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.theme === theme)
  );
  if (selectedId) renderSelected({ instant: true });
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

async function tryUnauthenticatedOrSessionBoot() {
  try {
    let res = await fetch("/api/info", { credentials: "same-origin" });
    if (res.status === 401) {
      await mintSession().catch(() => false);
      res = await fetch("/api/info", { credentials: "same-origin" });
    }
    if (res.ok) {
      const info = await res.json();
      live = true;
      liveInfo = info;
      unlockDashboard(info);
      return true;
    }
  } catch {
    // Offline fallback: still unlock with real captured telemetry
  }
  unlockDashboard(null);
  return true;
}

/* ---------- boot ---------- */
(async function boot() {
  setLogo(initialTheme);
  bindControls();
  applyTheme(initialTheme);

  const res = await fetch("./data/replay.json");
  bundle = await res.json();
  records = bundle.records || [];
  renderChips();
  applyFilterAndSort();
  rejudgeAll();

  // Only show the blocking password screen if ?lock=1 is explicitly in the URL
  const params = new URLSearchParams(location.search);
  if (params.get("lock") === "1") {
    lockDashboard();
    return;
  }
  if (authToken) {
    const ok = await verifyTokenAndUnlock(authToken, true);
    if (ok) return;
  }

  // Default for all visitors: unauthenticated live demo!
  await tryUnauthenticatedOrSessionBoot();
})();
