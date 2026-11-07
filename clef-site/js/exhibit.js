/**
 * exhibit.js — press-to-advance run-it page.
 *
 * Nothing runs on load. Each card has one action; pressing it makes the
 * SERVER do real work (live model / live guard), reveals the result, and
 * scrolls to the next card. Integrity rule: every number comes from a real
 * response. If the server does not answer, the card says so and stops.
 */
import { LayerSpine } from "./clef-viz.js";
import { hydrateIcons } from "./icons.js";

hydrateIcons();

/* the paper page always reads the light token layer */
document.documentElement.setAttribute("data-theme", "light");
const logo = document.getElementById("ex-logo");
if (logo) logo.src = "./assets/logo/lockup-light.png";
for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
  btn.classList.toggle("is-on", btn.dataset.theme === "light");
  btn.addEventListener("click", () => {
    document.documentElement.setAttribute("data-theme", btn.dataset.theme);
    localStorage.setItem("clef-theme", btn.dataset.theme);
    if (logo) {
      logo.src = btn.dataset.theme === "light"
        ? "./assets/logo/lockup-light.png"
        : "./assets/logo/lockup-dark.png";
    }
    document.querySelectorAll("#seg-theme .seg-btn").forEach((b) =>
      b.classList.toggle("is-on", b === btn));
  });
}

const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const spine = new LayerSpine($("spine"), { height: 280 });

function fmt(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(3);
}
function escapeHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const ORDER = ["step-0", "step-1", "step-2", "step-3", "step-4", "step-5"];

function unlock(id) {
  const sec = $(id);
  if (!sec) return;
  sec.dataset.state = "open";
  const btn = sec.querySelector("button.ex-act, button.ex-zero");
  if (btn) btn.disabled = false;
  const input = sec.querySelector("input");
  if (input) input.disabled = false;
}
function lockDone(id) {
  const sec = $(id);
  if (sec) sec.dataset.state = "done";
}
function goTo(id) {
  $(id)?.scrollIntoView({ behavior: "smooth", block: "center" });
}
function fail(id, err) {
  const out = $(`out-${id.split("-")[1]}`);
  if (out) {
    out.hidden = false;
    out.innerHTML = `<p class="ex-runstatus is-blocked">server did not answer — ${escapeHtml(String(err).slice(0, 80))}</p>`;
  }
}

/* ---------- 0 · wake it up: real model, empty context ---------- */
async function act0() {
  const btn = $("act-0");
  btn.disabled = true;
  $("msg-0").textContent = "…";
  $("out-0").hidden = false;
  const t0 = performance.now();
  try {
    const res = await fetch("/gen/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local",
        stream: false,
        max_tokens: 80,
        temperature: 0.8,
        messages: [
          { role: "user", content: "Hello. Who do you think I am? One short paragraph." },
        ],
      }),
    });
    const j = await res.json();
    const text = j.choices?.[0]?.message?.content ?? "";
    const ms = performance.now() - t0;
    const pt = j.usage?.prompt_tokens ?? 0;
    const ct = j.usage?.completion_tokens ?? 0;
    $("msg-0").textContent = text || "(empty answer)";
    $("f0-pre").textContent = pt > 0 ? `${pt} ctx tokens` : "—";
    $("f0-dec").textContent = ct > 0 ? `${(ct / (ms / 1000)).toFixed(1)} tok/s` : "—";
    lockDone("step-0");
    unlock("step-1");
    goTo("step-1");
  } catch (err) {
    fail("step-0", err);
  }
  btn.disabled = false;
}

/* ---------- 1 · open the checkpoint: engine introspection ---------- */
async function act1() {
  const btn = $("act-1");
  btn.disabled = true;
  try {
    const res = await fetch("/api/info");
    const info = await res.json();
    $("f1-arch").textContent = info.architecture || "—";
    $("f1-layers").textContent = info.num_layers ?? "—";
    $("f1-width").textContent = info.d_model ?? "—";
    $("f1-probe").textContent = Math.round((info.num_layers || 0) * 0.68) || "—";
    $("f1-quant").textContent = info.weight_quant_summary || "—";
    $("out-1").hidden = false;
    lockDone("step-1");
    unlock("step-2");
    goTo("step-2");
  } catch (err) {
    fail("step-1", err);
  }
  btn.disabled = false;
}

/* ---------- 2 · measure the three directions: real cluster scores ---------- */
async function act2() {
  const btn = $("act-2");
  btn.disabled = true;
  try {
    const res = await fetch("/v1/guard/tool-call", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "A harmless reference call for calibrating the axes.",
        tool_name: "shell",
        tool_args: { cmd: "cargo test" },
        questions: [],
      }),
    });
    const v = await res.json();
    const scores = v.cluster_scores || [];
    const labels = ["destruction", "theft", "exfiltration"];
    const max = Math.max(0.05, ...scores.map(Math.abs));
    $("bars-2").innerHTML = labels
      .map((l, i) => {
        const s = scores[i] ?? 0;
        const w = Math.round((Math.abs(s) / max) * 100);
        return `<div class="ex-bar">
          <span class="ex-bar-l">${l}</span>
          <span class="ex-bar-t"><i style="width:${w}%"></i></span>
          <span class="ex-bar-v">${fmt(s)}</span>
        </div>`;
      })
      .join("");
    $("out-2").hidden = false;
    lockDone("step-2");
    unlock("step-3");
    goTo("step-3");
  } catch (err) {
    fail("step-2", err);
  }
  btn.disabled = false;
}

/* ---------- 3 · set the filter ---------- */
function act3() {
  const cmd = $("ex-input").value.trim();
  if (!cmd) {
    $("ex-input").focus();
    return;
  }
  lockDone("step-3");
  $("out-3").hidden = false;
  unlock("step-4");
  goTo("step-4");
}

/* ---------- 4 · run inference: real judgment + attribution ---------- */
let lastVerdict = null;
async function act4() {
  const cmd = $("ex-input").value.trim();
  if (!cmd) return;
  const btn = $("act-4");
  btn.disabled = true;
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
    if (v.harm_excess === undefined) throw new Error(v.reason || "no reading");
    lastVerdict = v;
    $("f4-cos").textContent = fmt(v.harm_cosine);
    $("f4-base").textContent = fmt(v.harm_baseline);
    $("f4-excess").textContent = fmt(v.harm_excess);
    $("f4-tok").textContent =
      v.attribution_token_index != null
        ? `#${v.attribution_token_index} "${v.attribution_token || "?"}"`
        : "—";
    // the command with the attributed token marked
    const idx = v.attribution_token_index;
    const words = cmd.split(/(\s+)/);
    let shown = escapeHtml(cmd);
    if (idx != null && v.attribution_token && v.attribution_token !== "-") {
      const needle = escapeHtml(v.attribution_token);
      shown = escapeHtml(cmd).replace(
        new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        (m) => `<mark>${m}</mark>`
      );
    }
    $("tok-4").innerHTML = shown;
    $("out-4").hidden = false;
    lockDone("step-4");
    unlock("step-5");
    goTo("step-5");
  } catch (err) {
    fail("step-4", err);
  }
  btn.disabled = false;
}

/* ---------- 5 · pull the trace: real layer profile from the event stream ---------- */
async function act5() {
  const btn = $("act-5");
  btn.disabled = true;
  try {
    let ev = null;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    try {
      const res = await fetch("/api/events", { signal: ctl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const preview = lastVerdict?.tool_args_preview;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const j = JSON.parse(line.slice(5));
            if (j.tool_args_preview === preview && j.layer_profile) {
              ev = j;
              clearTimeout(timer);
              reader.cancel();
              break;
            }
          } catch {}
        }
        if (ev) break;
      }
      clearTimeout(timer);
    } catch {}

    if (ev && ev.layer_profile) {
      spine.render(ev);
    } else {
      $("spine").innerHTML =
        `<p class="knob-hint">no layer profile on the event stream for this run</p>`;
    }
    const v = lastVerdict || {};
    const harm = v.harm_excess != null && v.harm_excess >= 0.001;
    $("f5-verdict").textContent = v.allowed
      ? "it points benign — the call runs"
      : "it points at harm — we refuse";
    $("f5-verdict").className = "ex-verdict " + (v.allowed ? "is-ok" : "is-blocked");
    $("f5-reason").textContent = v.reason || "";
    $("out-5").hidden = false;
    lockDone("step-5");
  } catch (err) {
    fail("step-5", err);
  }
  btn.disabled = false;
}

/* ---------- wiring ---------- */
$("act-0").addEventListener("click", act0);
$("act-1").addEventListener("click", act1);
$("act-2").addEventListener("click", act2);
$("act-3").addEventListener("click", act3);
$("act-4").addEventListener("click", act4);
$("act-5").addEventListener("click", act5);
$("ex-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") act3();
});
$("ex-input").addEventListener("input", () => {
  const sec = $("step-3");
  if (sec?.dataset.state === "open") {
    $("act-3").disabled = !$("ex-input").value.trim();
  }
});

/* source chip — who is answering */
(async () => {
  try {
    const r = await fetch("/api/info");
    const info = await r.json();
    $("src-chip").textContent = `[ LIVE ENGINE · ${info.architecture} ]`;
  } catch {
    $("src-chip").textContent = "[ ENGINE OFFLINE · PRESS 0 TO SEE WHO ANSWERS ]";
  }
})();

/* nothing else runs on load. the first act is yours. */
unlock("step-0");
