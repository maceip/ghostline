/**
 * exhibit.js — the run-it page. Five numbered steps, one live path.
 *
 * INTEGRITY RULE: every number on this page comes from the running engine or
 * from the recorded capture in data/replay.json. When neither is available the
 * page says so and shows nothing. A reading is never invented, estimated, or
 * drawn from a template.
 */
import { LayerSpine } from "./clef-viz.js";
import { hydrateIcons } from "./icons.js";

hydrateIcons();

/* ---------- theme ---------- */
// This page is the paper treatment: light · cream · gray bands, always.
// Force the light token layer so instruments read dark ink on those bands.
const initialTheme = "light";
document.documentElement.setAttribute("data-theme", initialTheme);

function setLogo(theme) {
  const img = document.getElementById("ex-logo");
  if (!img) return;
  img.src = theme === "light"
    ? "./assets/logo/lockup-light.png"
    : "./assets/logo/lockup-dark.png";
  img.style.height = "26px";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("clef-theme", theme);
  setLogo(theme);
  for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
    btn.classList.toggle("is-on", btn.dataset.theme === theme);
  }
}
for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
  btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
}
applyTheme(initialTheme);

/* ---------- instruments ---------- */
const spine = new LayerSpine(document.getElementById("spine"), { height: 280 });
const $ = (id) => document.getElementById(id);

function status(text, cls) {
  const el = $("ex-status");
  el.textContent = text;
  el.classList.toggle("is-blocked", cls === "blocked");
  el.classList.toggle("is-ok", cls === "ok");
}

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(3);
}

/* ---------- step 1–2: the engine reports its own facts ---------- */
async function loadFacts() {
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 1500);
    const res = await fetch("/api/info", { signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    const info = await res.json();
    $("fact-arch").textContent = info.architecture || "—";
    $("fact-layers").textContent = info.num_layers ?? "—";
    $("fact-width").textContent = info.d_model ?? "—";
    $("fact-probe").textContent = Math.round((info.num_layers || 0) * 0.68) || "—";
    $("fact-cal").textContent = (info.calibration_mode || "—").replace(/\s*\(.*\)$/, "");
    $("source-chip").textContent = `[ ENGINE ONLINE · ${info.architecture} ]`;
    $("run-note").textContent =
      "The button runs one forward pass on the engine above. Nothing is executed.";
    $("ex-play-btn").disabled = false;
    return true;
  } catch {
    $("fact-arch").textContent = "no engine on :8090";
    $("fact-layers").textContent = "—";
    $("fact-width").textContent = "—";
    $("fact-probe").textContent = "—";
    $("fact-cal").textContent = "—";
    $("source-chip").textContent = "[ ENGINE OFFLINE · START THE GUARD TO RUN STEP 4 ]";
    $("run-note").textContent =
      "No engine is running, so inference is off. This page shows no readings while it is offline.";
    $("ex-play-btn").disabled = true;
    status("engine offline");
    return false;
  }
}

/* Grab the real layer profile for this call from the engine's event stream. */
async function fetchProfile(preview) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch("/api/events", { signal: ctl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const ev = JSON.parse(line.slice(5));
          if (ev.tool_args_preview === preview && ev.layer_profile) {
            clearTimeout(timer);
            reader.cancel();
            return ev;
          }
        } catch {}
      }
    }
    clearTimeout(timer);
  } catch {}
  return null;
}

/* ---------- steps 3–5: the run ---------- */
async function run() {
  const cmd = $("ex-input").value.trim();
  if (!cmd) {
    $("ex-input").focus();
    return;
  }
  const btn = $("ex-play-btn");
  btn.disabled = true;
  status("running inference…");
  $("ex-result").hidden = true;

  try {
    const res = await fetch("/v1/guard/tool-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Direct request from the run-it page.",
        tool_name: "shell",
        tool_args: { cmd },
        questions: [],
      }),
    });
    const v = await res.json();
    if (v.harm_excess === undefined) throw new Error(v.reason || "no reading returned");

    // the real layer profile, if the event stream carries one for this call
    const ev = await fetchProfile(v.tool_args_preview);
    if (ev && ev.layer_profile) {
      spine.render(ev);
    } else {
      $("spine").innerHTML =
        `<p class="knob-hint">no layer profile on the event stream for this run</p>`;
    }

    $("r-cos").textContent = fmt(v.harm_cosine);
    $("r-base").textContent = fmt(v.harm_baseline);
    $("r-excess").textContent = fmt(v.harm_excess);
    $("r-src").textContent = "live engine reading";
    $("ex-verdict").textContent = v.allowed
      ? "it points benign — the call runs"
      : "it points at harm — we refuse";
    $("ex-verdict").className = "ex-verdict " + (v.allowed ? "is-ok" : "is-blocked");
    $("ex-reason").textContent = v.reason || "";
    $("ex-result").hidden = false;
    status(v.allowed ? "passed" : "refused", v.allowed ? "ok" : "blocked");
  } catch (err) {
    status(`error — ${String(err).slice(0, 70)}`, "blocked");
  } finally {
    btn.disabled = false;
  }
}

$("ex-play-btn").addEventListener("click", run);
$("ex-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") run();
});

loadFacts();
