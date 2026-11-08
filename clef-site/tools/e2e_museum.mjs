#!/usr/bin/env node
/**
 * End-to-end test of the exhibit against a LIVE guard. Exercises every control
 * and checks that what is drawn matches what the guard actually returned.
 *
 *   node clef-site/tools/e2e_museum.mjs http://127.0.0.1:8417
 * (needs `playwright` resolvable and Chrome installed)
 */
import { chromium } from "playwright";
const base = process.argv[2] || "http://127.0.0.1:8417";
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

// 3. every example chip
const chips = await p.$$("[data-testid=chip]");
for (let i = 0; i < chips.length; i++) {
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

// 7. phone width: no horizontal page scroll
const phone = await b.newPage({ viewport: { width: 390, height: 844 } });
await phone.goto(`${base}/index.html`, { waitUntil: "load" });
await phone.waitForSelector("#verdict:not([hidden])", { timeout: 30000 });
ok(await phone.evaluate(() => document.documentElement.scrollWidth <= 390), "no horizontal scroll at 390px");

// 8. legacy link
const d = await b.newPage();
await d.goto(`${base}/demo.html`);
await d.waitForURL(/index\.html/, { timeout: 5000 }).catch(() => {});
ok(d.url().includes("index.html"), "demo.html forwards to the exhibit");

ok(errors.length === 0, `no console errors ${errors.join(" | ").slice(0, 160)}`);
await b.close();
console.log(failed ? `${failed} FAILED` : "ALL PASS");
process.exit(failed ? 1 : 0);
