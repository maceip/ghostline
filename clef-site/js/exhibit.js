/**
 * exhibit.js — the guided exhibit: set a filter → hit play → watch the brain →
 * the verdict. Real data only: live guard when attached, otherwise the real
 * captured corpus replays through the same instruments.
 */
import { ResidualField } from "./field.js";
import { LayerSpine, ExcessGate, EventTape } from "./clef-viz.js";
import { hydrateIcons } from "./icons.js";

hydrateIcons();

/* ---------- theme ---------- */
const stored = localStorage.getItem("clef-theme");
const initialTheme =
  stored || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
document.documentElement.setAttribute("data-theme", initialTheme);

const logoImg = document.getElementById("ex-logo");
function setLogo(theme) {
  if (logoImg) {
    logoImg.src = theme === "light"
      ? "./assets/logo/lockup-light.png"
      : "./assets/logo/lockup-dark.png";
  }
}

/* ---------- instruments ---------- */
const field = new ResidualField(document.getElementById("field"), { theme: initialTheme });
field.start();
const spine = new LayerSpine(document.getElementById("spine"), { height: 320 });
const gate = new ExcessGate(document.getElementById("gate"));
const tape = new EventTape(document.getElementById("tape"));

/* ---------- state ---------- */
let bundle = null;
let records = [];
let liveBase = "";
let live = false;
const state = { threshold: 0.002, mode: "enforce", baseline: "panel" };

const $ = (id) => document.getElementById(id);

function setStep(n) {
  for (const li of document.querySelectorAll("#ex-rail li")) {
    const s = Number(li.dataset.step);
    li.classList.toggle("is-now", s === n);
    li.classList.toggle("is-done", s < n);
  }
}

function status(text, cls) {
  const el = $("ex-status");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-blocked", cls === "blocked");
  el.classList.toggle("is-ok", cls === "ok");
}

/* ---------- presets from the real capture ---------- */
function renderChips() {
  const row = $("ex-chip-row");
  const list = $("ex-presets");
  if (!row) return;
  row.textContent = "";
  // six specimens: three harmful, three benign — real commands
  const picks = ["00", "01", "12", "13", "20", "21"]
    .map((id) => records.find((r) => r.id === id))
    .filter(Boolean);
  for (const rec of picks) {
    const cmd = rec.verdict?.tool_args_preview || rec.call_render;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ex-specimen" + (rec.label === "harmful" ? " is-harm" : "");
    btn.textContent = cmd;
    btn.addEventListener("click", () => {
      $("ex-input").value = cmd.replace(/^cmd=/, "");
      play(rec);
    });
    row.appendChild(btn);
    if (list) {
      const opt = document.createElement("option");
      opt.value = cmd.replace(/^cmd=/, "");
      list.appendChild(opt);
    }
  }
}

/* ---------- the guided run ---------- */
async function play(known) {
  const input = $("ex-input").value.trim();
  if (!input && !known) return;

  const btn = $("ex-play-btn");
  btn.disabled = true;

  // step 2 → 3: the brain lights up
  setStep(2);
  $("ex-brain").hidden = false;
  $("ex-verdict").hidden = true;
  status("RUNNING THE BACKBONE…");
  field.setState({ blocked: false, harm: 0 });

  let rec = known;
  let verdict;

  if (!rec && live) {
    // live judgment — a real forward pass on the running engine
    setStep(3);
    status("READING LAYER 16…");
    try {
      const res = await fetch(`${liveBase}/v1/guard/tool-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "The exhibit: one tool call, judged live.",
          tool_name: "shell",
          tool_args: { cmd: input },
          questions: [],
        }),
      });
      verdict = await res.json();
      rec = {
        id: "live-" + Date.now(),
        label: "live",
        cluster: "ad-hoc",
        prompt: "The exhibit: one tool call, judged live.",
        tool_name: "shell",
        tool_args: { cmd: input },
        call_render: `bash({"cmd": ${JSON.stringify(input)}})`,
        verdict,
        event: null,
      };
    } catch (err) {
      status(`[ ERROR: ${String(err).slice(0, 60)} ]`);
      btn.disabled = false;
      return;
    }
  } else {
    // replay a real captured reading — never a synthetic one
    rec = rec || matchCapture(input);
    if (!rec) {
      status("NO CAPTURED READING FOR THAT COMMAND — TRY A SPECIMEN");
      btn.disabled = false;
      return;
    }
    verdict = rec.verdict;
    // staged reveal so the story reads
    setStep(3);
    status("READING LAYER 16…");
    await wait(650);
    spine.render(rec.event);
    await wait(500);
  }

  if (rec.event) spine.render(rec.event);

  const harm = Math.max(0, Math.min(1, Math.abs(verdict.harm_excess) / 0.12));
  field.setState({ blocked: !verdict.allowed, harm });
  await wait(450);

  // step 4: the verdict
  setStep(4);
  $("ex-verdict").hidden = false;
  gate.render(rec, state);
  renderDetail(rec);
  status(
    verdict.allowed ? "PASSED" : "REFUSED BEFORE EXECUTION",
    verdict.allowed ? "ok" : "blocked"
  );
  tape.push({
    id: rec.id,
    ts_ms: rec.event && rec.event.ts_ms,
    tool_name: rec.tool_name,
    tool_args_preview: verdict.tool_args_preview || rec.call_render,
    harm_excess: verdict.harm_excess,
    blocked: !verdict.allowed,
  });
  btn.disabled = false;
  setStep(4);
}

function matchCapture(input) {
  const needle = input.toLowerCase();
  return (
    records.find((r) => {
      const c = (r.verdict?.tool_args_preview || r.call_render || "").toLowerCase();
      return c.includes(needle) || needle.includes(c.replace(/^cmd=/, ""));
    }) || null
  );
}

function renderDetail(rec) {
  const v = rec.verdict || {};
  const ev = rec.event || {};
  $("detail").innerHTML = `
    <div class="detail-head">
      <span class="detail-tag ${rec.label}">${String(rec.label).toUpperCase()}</span>
      <span class="detail-cluster">${rec.cluster || ""}</span>
    </div>
    <pre class="detail-call">${escapeHtml(rec.call_render || "")}</pre>
    <dl class="detail-kv">
      <dt>harm cosine</dt><dd>${fmt(v.harm_cosine)}</dd>
      <dt>baseline</dt><dd>${fmt(v.harm_baseline)}</dd>
      <dt>excess</dt><dd>${fmt(v.harm_excess)}</dd>
      <dt>probe</dt><dd>${ev.probe_layer != null ? ev.probe_layer + " / " + ev.num_layers : "—"}</dd>
      <dt>reason</dt><dd style="text-align:left">${escapeHtml(v.reason || "—")}</dd>
    </dl>`;
}

/* ---------- knobs (advanced drawer) ---------- */
function bindKnobs() {
  const thr = $("thr");
  if (thr) {
    thr.addEventListener("input", () => {
      state.threshold = Number(thr.value);
      $("thr-val").textContent = state.threshold.toFixed(3);
    });
  }
  for (const btn of document.querySelectorAll("#seg-mode .seg-btn")) {
    btn.addEventListener("click", () => {
      state.mode = btn.dataset.mode;
      document.querySelectorAll("#seg-mode .seg-btn").forEach((b) =>
        b.classList.toggle("is-on", b === btn));
      const gm = $("gate-mode");
      if (gm) gm.textContent = state.mode.toUpperCase();
    });
  }
  for (const btn of document.querySelectorAll("#seg-baseline .seg-btn")) {
    btn.addEventListener("click", () => {
      state.baseline = btn.dataset.baseline;
      document.querySelectorAll("#seg-baseline .seg-btn").forEach((b) =>
        b.classList.toggle("is-on", b === btn));
    });
  }
}

/* ---------- live probe ---------- */
async function probeLive() {
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 1200);
    const res = await fetch("/api/info", { signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const info = await res.json();
    live = true;
    liveBase = "";
    const chip = $("source-chip");
    chip.textContent = `[ LIVE · ${info.architecture} ]`;
    chip.className = "chip chip-live";
    status("LIVE ENGINE READY");
  } catch {
    const chip = $("source-chip");
    chip.textContent = "[ REPLAY · REAL CAPTURE · 2026-11-06 ]";
    chip.className = "chip chip-replay";
    status("REPLAY MODE — SPECIMENS ARE REAL CAPTURES");
  }
}

/* ---------- theme toggle ---------- */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("clef-theme", theme);
  field.setTheme(theme);
  setLogo(theme);
  document.querySelectorAll("#seg-theme .seg-btn").forEach((b) =>
    b.classList.toggle("is-on", b.dataset.theme === theme));
}

/* ---------- boot ---------- */
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(3);
}
function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

(async function boot() {
  setLogo(initialTheme);
  bindKnobs();
  for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
    btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
  }
  $("ex-play-btn").addEventListener("click", () => play());
  $("ex-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") play();
  });

  const res = await fetch("./data/replay.json");
  bundle = await res.json();
  records = bundle.records || [];
  renderChips();
  probeLive();
  setStep(1);
})();
