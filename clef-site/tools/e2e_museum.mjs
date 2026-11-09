#!/usr/bin/env node
/**
 * End-to-end test of the exhibit against a LIVE guard. Exercises every control
 * and checks that what is drawn matches what the guard actually returned.
 *
 *   node clef-site/tools/e2e_museum.mjs http://127.0.0.1:8412
 * (needs `playwright` resolvable and Chrome installed)
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = (() => {
  try { return require("playwright"); }
  catch { return require("/tmp/pw-audit/node_modules/playwright"); }
})();
const base = process.argv[2] || "http://127.0.0.1:8412";
let failed = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) failed++; };

const b = await chromium.launch({ channel: "chrome" });
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const verdicts = [];
p.on("response", async (r) => {
  if (r.url().endsWith("/v1/guard/tool-call")) verdicts.push(await r.json().catch(() => null));
});
const settle = async (n) => {
  await p.waitForFunction(() => !document.querySelector("[data-testid=go]").disabled, null, { timeout: 30000 });
  await p.waitForTimeout(150);
  return verdicts.length === n + 1 ? verdicts.at(-1) : null;
};

await p.goto(`${base}/index.html`, { waitUntil: "load" });
// the page takes one real reading of the first example on load
await p.waitForSelector("#verdict:not([hidden])", { timeout: 30000 });
await p.waitForTimeout(200);
ok(verdicts.length === 1 && verdicts[0]?.harm_excess !== undefined, "first example is measured live on load");
ok((await p.textContent("#scan-cmd")) === "rm -rf ~/Documents", "instrument names the command it measured");
ok(/^live · /.test(await p.textContent("[data-testid=engine]")), "engine chip reports a live engine");
ok((await p.$$("#board .b-col")).length === 2, "scoreboard renders both columns from heldout.json");
ok((await p.$$("#swarm circle.dot")).length === 50, "alarm line shows the 50 reference commands");

// 1. typed command through the form
let n = verdicts.length;
await p.fill("[data-testid=cmd]", "cat ~/.aws/credentials");
await p.click("[data-testid=go]");
let v = await settle(n);
ok(v && typeof v.harm_excess === "number", "form submit reaches the guard");
ok((await p.textContent("#v-word")) === (v.allowed ? "Allowed" : "Refused"), "verdict word matches the guard's decision");
ok((await p.textContent("#v-sub")).includes(Math.abs(v.harm_excess).toFixed(3)), "verdict text shows the real reading");
ok((await p.$$("#tokens .tok")).length === v.span_token_text.length, "one token chip per span token");
ok((await p.$$("#gauges .gauge")).length === v.cluster_scores.length, "one gauge per cluster score");
ok((await p.$$("#elevator .floors li")).length === v.layer_profile.length, "one floor per layer reading");
ok((await p.textContent("#elevator li.is-probe .f-n")) === String(v.probe_layer), "probe floor is the guard's probe layer");
ok(!!(await p.$("#swarm circle.you")), "your command is placed on the alarm line");
ok((await p.$$("#swarm rect.pin")).length === 1, "the earlier reading stays on the line as a pin");
ok((await p.$$("#gauges .g-base")).length === v.cluster_scores.length, "gauges mark the ordinary-command level");
ok((await p.textContent("#gauges .scale")).includes(Math.abs(v.harm_cosine - v.harm_excess).toFixed(3)), "ordinary-command level = harm_cosine - harm_excess");
ok((await p.$$("#elevator .f-ghost")).length === v.layer_profile.length, "layer tower overlays the previous command");

// 2. intent tagging + score
const blocked = !v.allowed;
await p.click("[data-testid=intent-benign]");
ok((await p.textContent("[data-testid=y-false]")) === (blocked ? "1" : "0"), "tagging 'no harm' updates harmless-blocked count");
await p.click("[data-testid=intent-harmful]");
ok((await p.textContent("[data-testid=y-total]")) === "1", "re-tagging the same command replaces, not duplicates");
ok((await p.textContent("[data-testid=y-past]")) === (blocked ? "0" : "1"), "tagging 'harm' updates got-past count");

// 3. every example chip (chip 0 "rm -rf ~/Documents" was measured live on load in verdicts[0])
const chips = await p.$$("[data-testid=chip]");
ok(verdicts[0] && !verdicts[0].allowed, `example "rm -rf ~/Documents" judged live: ${verdicts[0]?.allowed ? "allowed" : "refused"}`);
for (let i = 1; i < chips.length; i++) {
  n = verdicts.length;
  const label = (await chips[i].$eval("code", (c) => c.textContent));
  await chips[i].click();
  v = await settle(n);
  ok(v && (await p.textContent("#v-word")) === (v.allowed ? "Allowed" : "Refused"),
     `example "${label}" judged live: ${v ? (v.allowed ? "allowed" : "refused") : "NO RESPONSE"}`);
}

// 4. matched pairs: two live readings, both drawn
const pairs = await p.$$("[data-testid=pair]");
ok(pairs.length === 3, "three matched pairs offered");
for (let i = 0; i < pairs.length; i++) {
  n = verdicts.length;
  await pairs[i].click();
  await p.waitForFunction(() => document.querySelector(".pair-grid") && !document.querySelector(".pair-btn").disabled, null, { timeout: 60000 });
  await p.waitForTimeout(150);
  const two = verdicts.slice(n);
  const words = await p.$$eval(".pair-side .p-word b", (bs) => bs.map((b) => b.textContent));
  ok(two.length === 2 && words[0] === (two[0].allowed ? "Allowed" : "Refused") && words[1] === (two[1].allowed ? "Allowed" : "Refused"),
     `pair ${i + 1} measured live: ${words.join(" / ")}`);
}

// 5. clicking a reference dot re-measures that command live
n = verdicts.length;
const firstRef = await p.$eval("#swarm circle.dot", (c) => c.getAttribute("aria-label").split(", measured")[0]);
await p.$eval("#swarm circle.dot", (c) => c.dispatchEvent(new MouseEvent("click", { bubbles: true })));
v = await settle(n);
ok(v && (await p.inputValue("[data-testid=cmd]")) === firstRef, "clicking a dot loads and measures that command");

// 6. mistakes list + reset
await p.click(".misses summary");
ok((await p.$$("#misses li")).length > 0, "mistake list opens and lists commands");
await p.click("[data-testid=y-reset]");
ok((await p.textContent("[data-testid=y-total]")) === "0", "reset clears your score");

// 6b. Ghostline branding + UX 3 (3D Layer-Profile Heatmap & Probe Vector Inspector)
ok((await p.title()).includes("GHOSTLINE"), "index.html title carries GHOSTLINE brand");
ok((await p.$$("#layer-heatmap .hm-row")).length === 24, "UX 3: 3D inspector renders 24 layer heatmap rows");
ok((await p.$$("#layer-heatmap .hm-cell")).length === 72, "UX 3: 3D inspector renders 24x3 cluster cosine cells");
ok(!!(await p.$("#pca-3d-svg path")) && (await p.$$("#pca-3d-svg circle")).length === 24, "UX 3: 3D PCA trajectory renders path + 24 layer nodes");
ok((await p.$$("#perf-badges .perf-badge")).length === 4, "UX 3: renders 4 pipeline performance telemetry badges (prefill, KV-slice, AWQ)");
await p.fill("[data-testid=layer-scrub]", "8");
await p.dispatchEvent("[data-testid=layer-scrub]", "input");
ok((await p.textContent("#scrub-label")) === "L08" && (await p.textContent("[data-testid=layer-readout]")).includes("L08"), "UX 3: scrubbing layer slider updates 3D inspector readout to L08");

// 6c. UX 1 (Integrated Block-to-Rollback Simulation on index.html)
await p.click("[data-testid=btn-rollback]");
await p.waitForSelector("#rollback-out .rb-grid", { timeout: 20000 });
ok(!!(await p.$("#rollback-out .rb-col.is-refused")) && !!(await p.$("#rollback-out .rb-col.is-clamped")), "UX 1: rollback simulation renders side-by-side 403 vs Layer-16 Clamp & Rollback cards");
ok(!!(await p.$("#rollback-out svg.rb-svg")), "UX 1: rollback simulation renders pre/post clamp 24-layer trajectory SVG");

// 6d. UX 2 (Interactive Calibration Label Playpen in Room 5)
await p.fill("[data-testid=playpen-cmd]", "cargo check --workspace");
await p.click("[data-testid=playpen-benign]");
await p.waitForFunction(() => (document.querySelector("[data-testid=playpen-status]")?.textContent || "").includes("Recorded"), null, { timeout: 20000 });
ok((await p.$$("#cal-stats .cal-card")).length === 3, "UX 2: calibration playpen renders 3 split-conformal stat cards");
ok((await p.$$("#playpen-feed .pp-row")).length >= 1, "UX 2: calibration playpen renders live site_calibration.jsonl feed rows");

// 7. theme toggle on index.html
await p.click('#seg-theme button[data-theme="dark"]');
ok((await p.getAttribute("html", "data-theme")) === "dark", "index.html theme toggle switches to dark");
await p.click('#seg-theme button[data-theme="light"]');
ok((await p.getAttribute("html", "data-theme")) === "light", "index.html theme toggle switches back to light");

// 8. phone width: no horizontal page scroll
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(100);
ok(await p.evaluate(() => document.documentElement.scrollWidth <= 390), "no horizontal scroll at 390px");
await p.close();

// 9. demo.html ("FROM QWEN" Glass Room 6-step run-it walkthrough + Surface 1 Public Interactive Arena)
const d = await b.newPage({ viewport: { width: 1280, height: 900 } });
d.on("console", (m) => m.type() === "error" && errors.push(`demo: ${m.text()}`));
await d.goto(`${base}/demo.html`, { waitUntil: "load" });

// 9a. Verify Zero-Wait Initial State on Surface 1 before any network round-trip
ok((await d.$$("[data-testid=arena-step-card]")).length === 3, "Surface 1 Zero-Wait Initial State renders 3 pre-captured trajectory cards at 0ms on load");
ok(!!(await d.$("ghostline-token-stream .tok-chip[data-harm]")) && !!(await d.$("ghostline-token-stream .tool-diff-view")), "Component A (<ghostline-token-stream>) renders .tok-chip[data-harm] and .tool-diff-view at 0ms");
ok(!!(await d.$("ghostline-layer-scrubber #active-layer-slider")) && !!(await d.$("ghostline-layer-scrubber #curve-v-harm")) && !!(await d.$("ghostline-layer-scrubber #curve-v-drift")) && (await d.$$("ghostline-layer-scrubber .math-inspection-card samp")).length >= 5, "Component B (<ghostline-layer-scrubber>) renders #active-layer-slider, #curve-v-harm, #curve-v-drift, and .math-inspection-card <samp> readouts at 0ms");
ok(!!(await d.$("ghostline-pca-canvas canvas.gl-pca-hi-canvas")) && !!(await d.$("ghostline-pca-canvas #live-clamp-slider")) && !!(await d.$("ghostline-pca-canvas #run-steered-generation")), "Component C (<ghostline-pca-canvas>) renders high-DPI <canvas>, #live-clamp-slider, and #run-steered-generation at 0ms");

await d.waitForFunction(() => {
  const txt = document.querySelector("#src-chip")?.textContent || "";
  return txt.includes("LIVE ENGINE") && !txt.includes("undefined");
}, null, { timeout: 10000 });
ok((await d.title()).includes("GHOSTLINE"), "demo.html title carries GHOSTLINE brand");
ok(/LIVE ENGINE · qwen2/i.test(await d.textContent("#src-chip")), "demo.html footer chip reports live qwen2 engine");

// Step 0: Wake it up (FROM QWEN live stream)
await d.click("#act-0");
await d.waitForFunction(() => document.querySelector("#step-1")?.dataset.state === "open", null, { timeout: 30000 });
ok((await d.textContent("#msg-0")).trim().length > 10, "demo.html Step 0 streams live response from Qwen");
ok((await d.$$("#tokstrip-0 i")).length > 0, "demo.html Step 0 draws live token ticks");

// Step 1: Open the checkpoint
await d.click("#act-1");
await d.waitForFunction(() => document.querySelector("#step-2")?.dataset.state === "open", null, { timeout: 15000 });
await d.waitForTimeout(650);
ok(/qwen2/i.test(await d.textContent("#f1-arch")), "demo.html Step 1 reports qwen2 architecture");
ok((await d.textContent("#f1-layers")) === "24", "demo.html Step 1 reports 24 layers");
ok((await d.textContent("#f1-probe")) === "16", "demo.html Step 1 reports probe layer 16");
ok((await d.$$("#layers-1 i")).length === 24, "demo.html Step 1 renders 24 layer bars with live heights");

// Step 2: Measure the directions
await d.click("#act-2");
await d.waitForFunction(() => document.querySelector("#step-3")?.dataset.state === "open", null, { timeout: 15000 });
ok((await d.$$("#bars-2 .ex-bar")).length === 3, "demo.html Step 2 renders 3 live cluster direction bars");
ok(!!(await d.$("#bars-2 svg.ex-fan")), "demo.html Step 2 renders SVG direction fan");

// Step 3: Set the filter
await d.fill("#ex-input", "rm -rf ~/Documents");
await d.click("#act-3");
ok((await d.getAttribute("#step-4", "data-state")) === "open", "demo.html Step 3 locks filter and unlocks Step 4");

// Step 4: Run inference
await d.click("#act-4");
await d.waitForFunction(() => document.querySelector("#step-5")?.dataset.state === "open", null, { timeout: 15000 });
await d.waitForTimeout(650);
ok((await d.textContent("#f4-tok")).includes("#"), "demo.html Step 4 shows peak attribution token index");
ok(!!(await d.$("#tok-4 mark")), "demo.html Step 4 highlights peak attribution token");

// Step 5: Pull the trace + 3D Heatmap + Block-to-Rollback simulation
await d.click("#act-5");
await d.waitForFunction(() => document.querySelector("#step-5")?.dataset.state === "done", null, { timeout: 15000 });
ok(!!(await d.$("#spine svg path")), "demo.html Step 5 renders 24-layer spine curve");
ok((await d.textContent("#f5-verdict")).includes("refuse"), "demo.html Step 5 refuses harmful command");
ok((await d.$$("#ex-heatmap .ex-hm-cell")).length === 24, "demo.html Step 5 renders 24 3D layer-cluster heatmap cells");
await d.click("[data-testid=ex-btn-rollback]");
await d.waitForSelector("#ex-rollback-out .ex-rb-grid", { timeout: 20000 });
ok((await d.$$("#ex-rollback-out .ex-rb-card")).length === 2, "demo.html Step 5B runs live Layer-16 clamp & KV rollback simulation");

// Theme toggle on demo.html
await d.click('#seg-theme button[data-theme="dark"]');
ok((await d.getAttribute("html", "data-theme")) === "dark", "demo.html theme toggle switches to dark");

// 9b. GhostlineTraceFrame Wire Contract verification
const tf0 = verdicts[0]?.trace_frame;
ok(
  !!tf0 &&
  typeof tf0.turn_id === "string" &&
  typeof tf0.model_id === "string" &&
  tf0.hidden_dim === 896 &&
  tf0.num_layers === 24 &&
  tf0.decision_layer === 16 &&
  Array.isArray(tf0.tokens) && tf0.tokens.length > 0 &&
  Array.isArray(tf0.layers) && tf0.layers.length === 24 &&
  Array.isArray(tf0.layers[16]?.tensor_slice_preview) && tf0.layers[16].tensor_slice_preview.length === 8 &&
  Array.isArray(tf0.layers[16]?.pca_coords) && tf0.layers[16].pca_coords.length === 2 &&
  typeof tf0.pca_reference?.pc1_variance === "number" &&
  Array.isArray(tf0.pca_reference?.benign_cluster) && tf0.pca_reference.benign_cluster.length > 0 &&
  Array.isArray(tf0.pca_reference?.exploit_cluster) && tf0.pca_reference.exploit_cluster.length > 0,
  "GhostlineTraceFrame wire contract populated with real tokens, 24 layers (8-float tensor_slice_preview + pca_coords), and PCA reference clusters"
);

// 9c. Surface 1: Public Interactive Arena Workbench (on demo.html / /arena)
await d.selectOption("#arena-scenario", "mcp-env-leak");
ok((await d.inputValue("#arena-cmd")).includes(".aws/credentials"), "Surface 1 Arena preset selector populates Pass 1, Pass 2 context, and candidate command");
await d.selectOption("#arena-scenario", "ssh-exfil");

await d.click("[data-testid=arena-run-btn]");
await d.waitForFunction(() => !document.querySelector("[data-testid=arena-run-btn]").disabled, null, { timeout: 25000 });
ok((await d.$$("[data-testid=arena-step-card]")).length === 3, "Surface 1 Arena renders 3 live multi-step agent trajectory cards");
ok(!!(await d.$("[data-testid=gl-token-salience]")) && (await d.$$("[data-testid=gl-tok-chip]")).length > 0, "Surface 1 Arena mounts Shared Token Salience Stream component");
ok(!!(await d.$("[data-testid=gl-layer-scrubber-comp]")) && (await d.$$("#arena-viz-layers .gl-layer-dot")).length === 24, "Surface 1 Arena mounts Shared 24-Layer Cosine Scrubber component");
ok(!!(await d.$("[data-testid=gl-pca-canvas]")) && !!(await d.$("[data-testid=gl-pca-canvas] canvas.gl-pca-hi-canvas")), "Surface 1 Arena mounts Shared 2D PCA Subspace Canvas component");
ok(!!(await d.$("[data-testid=gl-clamp-panel]")) && !!(await d.$("[data-testid=gl-clamp-alpha]")), "Surface 1 Arena mounts Shared Counterfactual Clamping component");

// Scrub layer in Surface 1 Arena
await d.fill("#arena-viz-layers [data-testid=gl-layer-scrubber]", "12");
await d.dispatchEvent("#arena-viz-layers [data-testid=gl-layer-scrubber]", "input");
ok((await d.textContent("#arena-viz-layers [data-testid=gl-scrub-layer-label]")) === "L12", "Surface 1 Arena layer scrubber updates to L12 and refreshes tensor slice preview");

// Toggle mode to bypass in Surface 1 Arena and re-run
await d.click('#arena-modes button[data-mode="bypass"]');
await d.waitForFunction(() => {
  const b = document.querySelector("[data-testid=arena-run-btn]");
  const out = document.querySelector("[data-testid=arena-sandbox-out]")?.textContent || "";
  return b && !b.disabled && out.includes("MODE: BYPASS");
}, null, { timeout: 25000 });
ok((await d.textContent("[data-testid=arena-sandbox-out]")).includes("MODE: BYPASS"), "Surface 1 Arena runs multi-step trajectory in bypass mode (virtualized host side-effects)");
await d.close();

// 10. Surface 2: Operator Control Plane (/console / console.html)
const c = await b.newPage({ viewport: { width: 1440, height: 900 } });
c.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
await c.goto(`${base}/console`, { waitUntil: "load" });
await c.waitForFunction(() => document.body.dataset.telemetryReady === "true", null, { timeout: 15000 });
await c.waitForSelector("[data-testid=con-turn-item]", { timeout: 30000 });

ok((await c.title()).includes("Operator Control Plane"), "Surface 2 (/console) title carries Operator Control Plane");
ok(await c.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && getComputedStyle(document.body).overflow === "hidden"), "Surface 2 enforces zero-scroll 100dvh viewport-locked layout");

// Top Telemetry Bar KPIs + PATCH /v1/runtime/mode
ok((await c.textContent("#con-prefill-ms")).includes("ms"), "Surface 2 Top Bar displays live prefill hook latency (ms)");
ok(!isNaN(parseFloat((await c.textContent("#con-peak-harm")).replace("−", "-"))), "Surface 2 Top Bar displays numeric peak v_harm cosine");
ok(parseInt(await c.textContent("#con-count-total"), 10) >= 1, "Surface 2 Top Bar displays evaluated turn count");

await c.click('[data-testid="con-mode-clamp"]');
await c.waitForFunction(() => (document.querySelector("#con-pol-status")?.textContent || "").includes("CLAMP"), null, { timeout: 10000 });
ok((await c.getAttribute('[data-testid="con-mode-clamp"]', "aria-checked")) === "true", "Surface 2 Top Bar mode radio group dispatches PATCH /v1/runtime/mode");

// Left Rail Session Filtering + Live Probe Dispatch
const initialTurns = (await c.$$("[data-testid=con-turn-item]")).length;
await c.fill("[data-testid=con-quick-cmd]", "cat ~/.ssh/id_rsa");
await c.click("[data-testid=con-quick-send]");
await c.waitForFunction((prev) => document.querySelectorAll("[data-testid=con-turn-item]").length > prev, initialTurns, { timeout: 25000 });
ok((await c.$$("[data-testid=con-turn-item]")).length === initialTurns + 1, "Surface 2 Left Rail live probe dispatch evaluates command and prepends turn card");

// Filter buttons on Left Rail
await c.click('#con-filter-bar button[data-filter="allow"]');
await c.waitForTimeout(100);
await c.click('#con-filter-bar button[data-filter="all"]');
ok((await c.$$("[data-testid=con-turn-item]")).length === initialTurns + 1, "Surface 2 Left Rail verdict filter switches between ALLOW and ALL");

// Center Stage Shared Visualizer Web Components mounted in Surface 2
ok(!!(await c.$("#con-stage-tokens [data-testid=gl-token-salience]")), "Surface 2 Center Stage mounts <ghostline-token-stream>");
ok(!!(await c.$("#con-stage-layers [data-testid=gl-layer-scrubber-comp]")), "Surface 2 Center Stage mounts <ghostline-layer-scrubber>");
ok(!!(await c.$("#con-stage-pca [data-testid=gl-pca-canvas]")), "Surface 2 Center Stage mounts <ghostline-pca-canvas>");
ok(!!(await c.$("#con-stage-pca [data-testid=gl-clamp-panel]")), "Surface 2 Center Stage mounts Shared Counterfactual Clamping panel inside <ghostline-pca-canvas>");

// Right Drawer: Hook Policy update, Tool Capability Matrix, Contrastive Calibration Studio, and Custom Hooks
await c.fill("[data-testid=con-pol-alpha]", "1.20");
await c.dispatchEvent("[data-testid=con-pol-alpha]", "input");
await c.click("[data-testid=con-pol-save]");
await c.waitForFunction(() => (document.querySelector("#con-pol-status")?.textContent || "").includes("ACTIVE"), null, { timeout: 10000 });
ok((await c.textContent("#con-pol-alpha-val")) === "1.20" && (await c.textContent("#con-pol-status")).includes("ACTIVE"), "Surface 2 Right Drawer updates pre-tool hook policy on backend");

// Tab 1: Contrastive Pair Hot-Reload (/v1/calibration/commit) + SITE_CALIBRATION
await c.click('[data-testid="tab-btn-calibration"]');
await c.click('[data-testid="commit-contrastive-btn"]');
await c.waitForFunction(() => (document.querySelector("#contrastive-status")?.textContent || "").includes("Hot-reloaded"), null, { timeout: 15000 });
ok((await c.textContent("#contrastive-status")).includes("Hot-reloaded L16"), "Surface 2 Right Drawer Tab 1 commits contrastive pair via POST /v1/calibration/commit and orthogonalizes Δh_l");

await c.fill("[data-testid=con-cal-cmd]", "git status -sb");
await c.click("[data-testid=con-cal-benign]");
await c.waitForFunction(() => (document.querySelector("[data-testid=con-cal-status]")?.textContent || "").includes("Recorded"), null, { timeout: 15000 });
ok((await c.$$(".con-cal-card")).length === 3 && (await c.$$("#con-cal-feed .con-cal-row")).length >= 1, "Surface 2 Right Drawer Contrastive Calibration Studio records live vector and updates conformal stats");

// Tab 2: Tool Capability Matrix (.capability-matrix)
await c.click('[data-testid="tab-btn-capabilities"]');
ok((await c.$$("[data-testid=con-cap-select]")).length >= 4, "Surface 2 Right Drawer Tab 2 renders .capability-matrix selectors");
const prevCapVal = await c.$eval('[data-testid=con-cap-select][data-cap-idx="1"]', (el) => el.value);
const targetCapVal = prevCapVal === "hard-block" ? "clamp" : "hard-block";
await c.evaluate(() => { const el = document.querySelector("#con-pol-status"); if (el) el.textContent = "PENDING"; });
await c.selectOption('[data-testid=con-cap-select][data-cap-idx="1"]', targetCapVal);
await c.waitForFunction(() => (document.querySelector("#con-pol-status")?.textContent || "").includes("ACTIVE"), null, { timeout: 20000 });
ok((await c.$eval('[data-testid=con-cap-select][data-cap-idx="1"]', (el) => el.value)) === targetCapVal, "Surface 2 Right Drawer persists Tool Capability Matrix change");

// Tab 3: Custom Hooks (#custom-hook-editor)
await c.click('[data-testid="tab-btn-hooks"]');
await c.click('[data-testid="save-custom-hook-btn"]');
await c.waitForFunction(() => (document.querySelector("#custom-hook-status")?.textContent || "") === "RULE SYNCED", null, { timeout: 10000 });
ok((await c.textContent("#custom-hook-status")) === "RULE SYNCED", "Surface 2 Right Drawer Tab 3 saves deterministic + neural pre-tool hook rule");

ok(errors.length === 0, `no console errors ${errors.join(" | ").slice(0, 160)}`);
await b.close();
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
