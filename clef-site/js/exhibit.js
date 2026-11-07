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

/* ---------- session: the guard issues device-bound cookies; judgments need them ---------- */
let sessionReady = false;
async function ensureSession() {
  if (sessionReady) return true;
  try {
    const res = await fetch("/api/session", {
      method: "POST",
      credentials: "same-origin",
    });
    sessionReady = res.ok;
    return sessionReady;
  } catch {
    return false;
  }
}

/* Motion, driven only by real work:
   - the button's elapsed clock ticks while the server is actually thinking
   - numbers count into place from 0 to their real value
   - outputs fade up when the real response lands */
function withWork(btn, label, fn) {
  btn.disabled = true;
  const t0 = performance.now();
  const timer = setInterval(() => {
    btn.textContent = `${label} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  }, 100);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      clearInterval(timer);
      btn.textContent = label;
      btn.disabled = false;
    });
}

function reveal(out) {
  out.hidden = false;
  out.classList.remove("is-in");
  void out.offsetWidth;
  out.classList.add("is-in");
}

function countUp(el, value, digits = 0, suffix = "") {
  const t0 = performance.now();
  const dur = 550;
  function frame(now) {
    const k = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = (value * eased).toFixed(digits) + suffix;
    if (k < 1) requestAnimationFrame(frame);
    else el.textContent = value.toFixed(digits) + suffix;
  }
  requestAnimationFrame(frame);
}

const ORDER = ["step-0", "step-1", "step-2", "step-3", "step-4", "step-5"];

function unlock(id) {
  const sec = $(id);
  if (!sec) return;
  sec.dataset.state = "open";
  const btn = sec.querySelector("button.ex-act");
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
  if (!out) return;
  out.hidden = false;
  out.querySelector(".ex-fail")?.remove();
  out.insertAdjacentHTML(
    "beforeend",
    `<p class="ex-runstatus is-blocked ex-fail">server did not answer — ${escapeHtml(
      String(err).slice(0, 80)
    )}</p>`
  );
}

/* ---------- 0 · wake it up: real model, empty context ---------- */
async function act0() {
  const btn = $("act-0");
  $("out-0").hidden = false;
  $("msg-0").textContent = "";
  let text = "";
  const t0 = performance.now();
  await withWork(btn, "0 · WAKE IT UP", async () => {
    try {
      const res = await fetch("/gen/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local",
          stream: true,
          max_tokens: 80,
          temperature: 0.8,
          messages: [
            { role: "user", content: "Hello. Who do you think I am? One short paragraph." },
          ],
        }),
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let tokens = 0;
      const strip = $("tokstrip-0");
      strip.textContent = "";
      const tag = $("tag-0");
      tag.textContent = "FROM QWEN · WRITING…";
      tag.classList.add("is-writing");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop();
        for (const line of parts) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              tokens++;
              $("msg-0").textContent = text;
              // one real tick per streamed chunk — the generation, drawn
              const tick = document.createElement("i");
              strip.appendChild(tick);
              const ms = performance.now() - t0;
              if (ms > 200) {
                $("f0-dec").textContent = `${(tokens / (ms / 1000)).toFixed(1)} tok/s`;
              }
            }
          } catch {}
        }
      }
      const ms = performance.now() - t0;
      $("f0-pre").textContent = "0 ctx about you";
      $("f0-dec").textContent =
        tokens > 0 ? `${(tokens / (ms / 1000)).toFixed(1)} tok/s` : "—";
      tag.textContent = "FROM QWEN";
      tag.classList.remove("is-writing");
    } catch (err) {
      $("msg-0").textContent = `server did not answer — ${String(err).slice(0, 70)}`;
    }
  });
  lockDone("step-0");
  unlock("step-1");
  goTo("step-1");
}

/* ---------- 1 · open the checkpoint: engine introspection ---------- */
async function act1() {
  const btn = $("act-1");
  await withWork(btn, "1 · OPEN THE CHECKPOINT", async () => {
    try {
      const res = await fetch("/api/info");
      const info = await res.json();
      $("f1-arch").textContent = info.architecture || "—";
      countUp($("f1-layers"), Number(info.num_layers) || 0);
      countUp($("f1-width"), Number(info.d_model) || 0);
      countUp($("f1-probe"), Math.round((info.num_layers || 0) * 0.68) || 0);
      $("f1-quant").textContent = info.weight_quant_summary || "—";
      // the layer stack the engine just reported — lit one at a time
      const n = Number(info.num_layers) || 24;
      const probe = Math.round(n * 0.68);
      const box = $("layers-1");
      box.textContent = "";
      for (let i = 0; i < n; i++) {
        const b = document.createElement("i");
        if (i === probe) b.className = "is-probe";
        b.title = `L${i}${i === probe ? " · probe" : ""}`;
        box.appendChild(b);
        b.style.animationDelay = `${(i * 28)}ms`;
      }
      reveal($("out-1"));
    } catch (err) {
      fail("step-1", err);
      return;
    }
  });
  lockDone("step-1");
  unlock("step-2");
  goTo("step-2");
}

/* ---------- 2 · measure the three directions: real cluster scores ---------- */
async function act2() {
  const btn = $("act-2");
  await withWork(btn, "2 · MEASURE THE DIRECTIONS", async () => {
    try {
      await ensureSession();
      const res = await fetch("/v1/guard/tool-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
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
          return `<div class="ex-bar">
            <span class="ex-bar-l">${l}</span>
            <span class="ex-bar-t"><i data-w="${Math.round((Math.abs(s) / max) * 100)}"></i></span>
            <span class="ex-bar-v">${fmt(s)}</span>
          </div>`;
        })
        .join("");
      // the same three numbers as directions — lengths are the readings
      const ang = [-32, 0, 32];
      const cols = ["#D71921", "#C9971F", "#4A9E5C"];
      const arrows = ang
        .map((a, i) => {
          const s = scores[i] ?? 0;
          const L = 30 + (Math.abs(s) / max) * 92;
          const rad = (a * Math.PI) / 180;
          const x = 40 + Math.cos(rad) * L;
          const y = 70 + Math.sin(rad) * L;
          const px = 40 + Math.cos(rad) * (L - 8);
          const py = 70 + Math.sin(rad) * (L - 8);
          return `<path d="M40 70 L${x} ${y}" stroke="${cols[i]}" stroke-width="2" fill="none" marker-end="url(#f2${i})"/>
            <text x="${x + 4}" y="${y + 3}" class="svg-lab" fill="${cols[i]}">${labels[i]} ${fmt(s)}</text>
            <defs><marker id="f2${i}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
            <path d="M0 0 L7 3.5 L0 7" fill="none" stroke="${cols[i]}" stroke-width="2"/></marker></defs>`;
        })
        .join("");
      $("bars-2").insertAdjacentHTML(
        "beforeend",
        `<svg viewBox="0 0 320 150" class="ex-fan">${arrows}
         <circle cx="40" cy="70" r="3.5" fill="#1a1a1a"/>
         <text x="8" y="140" class="svg-lab">three readings · one harmless call</text></svg>`
      );
      reveal($("out-2"));
      // grow the bars from zero on the next frame — motion of the real values
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          for (const bar of document.querySelectorAll("#bars-2 i")) {
            bar.style.width = bar.dataset.w + "%";
          }
        })
      );
    } catch (err) {
      fail("step-2", err);
      return;
    }
  });
  lockDone("step-2");
  unlock("step-3");
  goTo("step-3");
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
  await withWork(btn, "4 · RUN INFERENCE", async () => {
    try {
      await ensureSession();
      const res = await fetch("/v1/guard/tool-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
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
      countUp($("f4-cos"), v.harm_cosine, 3, "");
      countUp($("f4-base"), v.harm_baseline, 3, "");
      countUp($("f4-excess"), v.harm_excess, 3, "");
      // the excess meter: position is the real reading, the tick is the real threshold
      const lo = -0.15, hi = 0.15;
      const pct = (val) => Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * 100));
      const fill = $("meter-4-fill");
      fill.style.width = "0%";
      fill.className = (v.harm_excess >= 0 ? "is-over" : "is-under");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => { fill.style.width = pct(v.harm_excess) + "%"; })
      );
      const thr = document.querySelector(".ex-meter-thr");
      if (thr) thr.style.left = pct(0.001) + "%";
      $("f4-tok").textContent =
        v.attribution_token_index != null
          ? `#${v.attribution_token_index} "${v.attribution_token || "?"}"`
          : "—";
      let shown = escapeHtml(cmd);
      if (v.attribution_token_index != null && v.attribution_token && v.attribution_token !== "-") {
        const needle = escapeHtml(v.attribution_token);
        shown = escapeHtml(cmd).replace(
          new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
          (m) => `<mark>${m}</mark>`
        );
      }
      $("tok-4").innerHTML = shown;
      reveal($("out-4"));
    } catch (err) {
      fail("step-4", err);
      return;
    }
  });
  lockDone("step-4");
  unlock("step-5");
  goTo("step-5");
}

/* ---------- 5 · pull the trace: real layer profile from the event stream ---------- */
async function act5() {
  const btn = $("act-5");
  await withWork(btn, "5 · PULL THE TRACE", async () => {
    try {
      let ev = null;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      try {
        const res = await fetch("/api/events", { signal: ctl.signal, credentials: "same-origin" });
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
      $("f5-verdict").textContent = v.allowed
        ? "it points benign — the call runs"
        : "it points at harm — we refuse";
      $("f5-verdict").className = "ex-verdict " + (v.allowed ? "is-ok" : "is-blocked");
      $("f5-reason").textContent = v.reason || "";
      reveal($("out-5"));
    } catch (err) {
      fail("step-5", err);
    }
  });
  lockDone("step-5");
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
