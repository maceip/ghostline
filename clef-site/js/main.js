/**
 * main.js — landing page (the zoo): story, field, theme, logo.
 * The exhibit lives in demo.html / js/exhibit.js.
 */
import { ResidualField } from "./field.js";
import { hydrateIcons } from "./icons.js";

hydrateIcons();

const stored = localStorage.getItem("clef-theme");
const initialTheme =
  stored || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
document.documentElement.setAttribute("data-theme", initialTheme);

const field = new ResidualField(document.getElementById("field"), {
  theme: initialTheme,
});
// The landing field runs the signature gesture on loop: a harmful call is
// refused at the probe ring. Every number beside it is a real capture.
field.setState({ blocked: true, harm: 0.85 });
field.start();

function setLogo(theme) {
  const dark = theme !== "light";
  for (const [id, h] of [["site-logo", 26], ["foot-logo", 36]]) {
    const img = document.getElementById(id);
    if (!img) continue;
    img.src = dark
      ? "./assets/logo/lockup-dark.png"
      : "./assets/logo/lockup-light.png";
    img.style.height = h + "px";
    img.alt = "AgentVector";
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("clef-theme", theme);
  field.setTheme(theme);
  setLogo(theme);
  for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
    btn.classList.toggle("is-on", btn.dataset.theme === theme);
  }
}

for (const btn of document.querySelectorAll("#seg-theme .seg-btn")) {
  btn.addEventListener("click", () => applyTheme(btn.dataset.theme));
}
applyTheme(initialTheme);
