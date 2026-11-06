/**
 * main.js — glue between the hero field and the console.
 */
import { ResidualField } from "./field.js";
import { Console } from "./console.js";
import { hydrateIcons } from "./icons.js";

hydrateIcons();

/* ---- theme: dark and light are both first-class ---- */
const stored = localStorage.getItem("clef-theme");
const initialTheme =
  stored || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
document.documentElement.setAttribute("data-theme", initialTheme);

const canvas = document.getElementById("field");
const fieldState = document.getElementById("field-state");
const field = new ResidualField(canvas, { theme: initialTheme });
field.start();

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("clef-theme", theme);
  field.setTheme(theme);
  for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
    btn.classList.toggle("is-on", btn.dataset.theme === theme);
  }
  // re-render the SVG instruments against the new tokens
  if (consoleApp && consoleApp.selectedId) consoleApp.select(consoleApp.selectedId);
}

const consoleApp = new Console({
  spine: document.getElementById("spine"),
  gate: document.getElementById("gate"),
  triad: document.getElementById("triad"),
  tape: document.getElementById("tape"),
  rack: document.getElementById("rack"),
  detail: document.getElementById("detail"),
  counts: document.getElementById("counts"),
  threshold: document.getElementById("thr"),
  thresholdVal: document.getElementById("thr-val"),
  modeButtons: [...document.querySelectorAll("#seg-mode .seg-btn")],
  baselineButtons: [...document.querySelectorAll("#seg-baseline .seg-btn")],
  clusterButtons: [...document.querySelectorAll("#seg-cluster .seg-btn")],
  judgeInput: document.getElementById("judge-input"),
  judgeBtn: document.getElementById("judge-btn"),
  judgeNote: document.getElementById("judge-note"),
  sourceChip: document.getElementById("source-chip"),
  onSelect: ({ blocked, harm }) => {
    field.setState({ blocked, harm });
    if (fieldState) {
      fieldState.textContent = blocked
        ? "REFUSED BEFORE EXECUTION"
        : harm > 0.15
          ? "SEVERITY CRITICAL"
          : "PASSED";
      fieldState.classList.toggle("is-blocked", blocked);
      fieldState.classList.toggle("is-ok", !blocked && harm <= 0.15);
    }
    const gm = document.getElementById("gate-mode");
    if (gm) gm.textContent = consoleApp.state.mode.toUpperCase();
  },
});

for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
  btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
}
applyTheme(initialTheme);

consoleApp.load().then(() => {
  const strip = document.getElementById("strip-source");
  if (strip) {
    strip.textContent = consoleApp.live
      ? `LIVE ${consoleApp.liveBase || location.host}`
      : "REPLAY · 36 AUDIT EVENTS";
  }
});

// clicking the hero field advances to the next scenario
canvas.addEventListener("click", () => {
  const recs = consoleApp.filtered || [];
  if (!recs.length) return;
  const idx = recs.findIndex((r) => r.id === consoleApp.selectedId);
  const next = recs[(idx + 1) % recs.length];
  consoleApp.select(next.id);
});
