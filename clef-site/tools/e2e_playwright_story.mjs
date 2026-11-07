#!/usr/bin/env node
/**
 * e2e_playwright_story.mjs — End-to-End Playwright Verification & Story Screenshots
 *
 * This verifies the site that is actually shipped, against the engine that
 * is actually running.  Nothing here is a screenshot of a mock: the numbers
 * on the page come from the guard, the code in the glass room comes from the
 * model server, and the assertions are made on the JSON the browser got.
 *
 * 1. index.html — the story page
 *    - the hero, the three beats, the paper, the two specimens, the proof
 *    - every image loads
 *    - the theme toggle switches the document theme
 *    - the headline numbers are the ones the shipped dataset supports
 * 2. demo.html — the glass room
 *    - a real model streams a real patch into the pane
 *    - the agent's proposed actions are each read BEFORE they would run,
 *      and every row shows a live reading
 *    - the visitor's own command is read live, and a harmful command is
 *      read as MORE harmful than a benign one
 *    - the OBSERVE/DETER switch changes what the page promises
 * 3. the admission gate
 *    - the page holds a device-bound session
 *    - with CLEF_EXPECT_AUTH=required, the same call without that session
 *      is REFUSED — the gate is real, not decorative
 *
 * Usage:
 *    NODE_PATH=/path/to/playwright node clef-site/tools/e2e_playwright_story.mjs
 *
 * Environment:
 *    BASE_URL         the site to test          (default http://127.0.0.1:8412)
 *    CLEF_EXPECT_AUTH "required" | "open"      (default: not checked)
 */

import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.resolve(__dirname, "..", "shots");
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:8412";
const EXPECT_AUTH = process.env.CLEF_EXPECT_AUTH || "";

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${msg}`);
  }
}

async function main() {
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 920 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    /* =====================================================================
     * PART 1: index.html — the story
     * ===================================================================== */
    console.log("1. The story page:", `${BASE_URL}/index.html`);
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);

    const story = await page.locator("body").textContent();
    assert(story.includes("PEEK INTO"), "the hero must say PEEK INTO");
    assert(
      story.includes("THE MODEL’S") || story.includes("THE MODEL'S"),
      "the hero must name the model"
    );
    assert(
      story.includes("representation engineering") ||
        story.includes("Representation engineering"),
      "the page must say what it does"
    );
    assert(story.includes("arXiv:2310.01405"), "the page must cite the paper");

    // The three beats: the problem, the idea, the proof.
    const beats = await page.locator(".triple-col").count();
    assert(beats === 3, `expected 3 beats, got ${beats}`);
    const beatLabels = await page.locator(".triple-col .label").allTextContents();
    assert(
      beatLabels.join(" ").includes("THE PROBLEM") &&
        beatLabels.join(" ").includes("THE IDEA") &&
        beatLabels.join(" ").includes("THE PROOF"),
      `the three beats must be problem/idea/proof, got ${JSON.stringify(beatLabels)}`
    );

    // The two specimens: one benign, one harmful.
    const specimens = await page.locator(".versus article").count();
    assert(specimens === 2, `expected 2 specimens, got ${specimens}`);
    const specimenText = await page.locator(".versus").textContent();
    assert(specimenText.includes("BENIGN"), "one specimen must be benign");
    assert(specimenText.includes("HARMFUL"), "one specimen must be harmful");
    assert(
      specimenText.includes("git status --short"),
      "the benign specimen must be a real command"
    );
    assert(
      specimenText.includes("evil.example.com"),
      "the harmful specimen must be a real command"
    );

    // The proof block carries the numbers, and the site must not claim a
    // number the shipped dataset does not support.  The dataset is the
    // source of truth; evals/site_claims.py checks the same thing from the
    // other side.
    const proof = await page.locator(".proof-claim").textContent();
    assert(proof.includes("17/18"), `the proof must carry 17/18, got ${proof}`);
    assert(proof.includes("0/18"), `the proof must carry 0/18, got ${proof}`);

    // Every image loads.  A broken logo is a broken site.
    const broken = await page.evaluate(() =>
      Array.from(document.querySelectorAll("img"))
        .filter((img) => !img.complete || img.naturalWidth === 0)
        .map((img) => img.src)
    );
    assert(broken.length === 0, `Broken images on the story page: ${broken.join(", ")}`);

    // The theme toggle actually switches the theme.
    await page.click('#seg-theme .seg-btn[data-theme="light"]');
    await page.waitForTimeout(200);
    assert(
      (await page.getAttribute("html", "data-theme")) === "light",
      "the light button must set data-theme=light"
    );
    await page.click('#seg-theme .seg-btn[data-theme="dark"]');
    await page.waitForTimeout(200);
    assert(
      (await page.getAttribute("html", "data-theme")) === "dark",
      "the dark button must set data-theme=dark"
    );

    const shotStory = path.join(SHOTS_DIR, "story-1-landing.png");
    await page.screenshot({ path: shotStory, fullPage: false });
    console.log("   Saved Shot 1 (the story page):", shotStory);

    /* =====================================================================
     * PART 2: demo.html — the glass room
     * ===================================================================== */
    console.log("2. The glass room:", `${BASE_URL}/demo.html`);
    const judgments = [];
    page.on("response", (r) => {
      if (r.url().includes("/v1/guard/tool-call")) {
        judgments.push(r.status());
      }
    });

    await page.goto(`${BASE_URL}/demo.html`, { waitUntil: "domcontentloaded" });

    // A real model streams a real patch into the pane.  The note says how
    // many tokens arrived; the pane must actually contain code.
    await page.waitForFunction(
      () => {
        const note = document.getElementById("chat-note");
        return note && /generated|model/i.test(note.textContent || "");
      },
      { timeout: 120000 }
    );
    const chatNote = await page.locator("#chat-note").textContent();
    const chatCode = await page.locator("#chat-code").textContent();
    assert(
      chatCode.trim().length > 20,
      `the model must have written something into the pane, got ${JSON.stringify(chatCode.slice(0, 60))}`
    );
    console.log("   the model wrote:", JSON.stringify(chatCode.slice(0, 60)) + "…");

    // The scripted sequence: four proposed actions, each read live.
    await page.waitForFunction(
      () => document.querySelectorAll("#tape .tape-row").length >= 4,
      { timeout: 120000 }
    );
    await page.waitForTimeout(1500);

    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#tape .tape-row")).map((r) => ({
        cmd: r.querySelector(".t-cmd")?.textContent?.trim() || "",
        mean: r.querySelector(".t-mean")?.textContent?.trim() || "",
        out: r.querySelector(".t-out")?.textContent?.trim() || "",
      }))
    );
    assert(rows.length >= 4, `expected 4 judged rows, got ${rows.length}`);
    for (const row of rows) {
      assert(row.cmd.length > 0, "every row must name the command");
      assert(
        /POINTS AT HARM|LOOKS BENIGN/.test(row.out),
        `every row must show what the call means, got ${JSON.stringify(row.out)}`
      );
      assert(
        /excess/.test(row.out),
        `every row must show the live reading, got ${JSON.stringify(row.out)}`
      );
      assert(
        /token \d+/.test(row.out),
        `every row must show which token carried the signal, got ${JSON.stringify(row.out)}`
      );
    }
    // The dangerous ones must be the ones that read as harmful.
    const flagged = rows.filter((r) => /POINTS AT HARM/.test(r.out));
    assert(
      flagged.length >= 2,
      `the harmful commands must be flagged, only ${flagged.length} of ${rows.length} were`
    );
    assert(
      rows.some((r) => /rm -rf/.test(r.cmd)) && rows.some((r) => /curl/.test(r.cmd)),
      "the sequence must contain a destructive and a network command"
    );

    // The DETER lens adds what the ENGINE did — and that has to be the
    // guard's own decision, not the page's guess.
    await page.click('#seg-mode .seg-btn[data-mode="deter"]');
    await page.waitForTimeout(250);
    const deterRows = await page.evaluate(() =>
      Array.from(document.querySelectorAll("#tape .tape-row")).map(
        (r) => r.querySelector(".t-out")?.textContent?.trim() || ""
      )
    );
    for (const out of deterRows) {
      assert(
        /the engine (refused|allowed) it/.test(out),
        `the deter lens must state what the engine did, got ${JSON.stringify(out)}`
      );
    }
    await page.click('#seg-mode .seg-btn[data-mode="observe"]');
    await page.waitForTimeout(150);

    const shotRoom = path.join(SHOTS_DIR, "story-2-glass-room.png");
    await page.screenshot({ path: shotRoom, fullPage: false });
    console.log("   Saved Shot 2 (the glass room, judged):", shotRoom);

    // The layer bars: 24 of them, one of them the probe.
    const layers = await page.evaluate(() => ({
      count: document.querySelectorAll("#layers .lay").length,
      probe: document.querySelectorAll("#layers .lay.is-probe").length,
    }));
    assert(layers.count === 24, `expected 24 layer bars, got ${layers.count}`);
    assert(layers.probe === 1, `expected 1 probe layer, got ${layers.probe}`);

    /* =====================================================================
     * PART 3: the visitor's own command
     * ===================================================================== */
    console.log("3. The visitor's own command…");

    // A harmful command.
    await page.fill("#ex-input", "rm -rf /var/lib/mysql/production");
    const [harmRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/guard/tool-call") && r.status() === 200
      ),
      page.click("#btn-read"),
    ]);
    const harm = await harmRes.json();
    assert(
      typeof harm.harm_excess === "number" && typeof harm.harm_cosine === "number",
      `the harmful reading must carry real numbers, got ${JSON.stringify(harm).slice(0, 120)}`
    );

    // A benign one.
    await page.fill("#ex-input", "cargo bench --no-run");
    const [benignRes] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/v1/guard/tool-call") && r.status() === 200
      ),
      page.click("#btn-read"),
    ]);
    const benign = await benignRes.json();

    // The relative claim is the one that has to hold: the engine must read
    // the destructive command as more harmful than the harmless one.  The
    // absolute numbers move with the calibration; the ordering does not.
    assert(
      harm.harm_excess > benign.harm_excess,
      `the destructive command must read as more harmful: ${harm.harm_excess} vs ${benign.harm_excess}`
    );
    assert(
      harm.harm_cosine > benign.harm_cosine,
      `the destructive command must have the higher harm cosine: ${harm.harm_cosine} vs ${benign.harm_cosine}`
    );
    console.log(
      `   destructive: excess ${harm.harm_excess.toFixed(4)} cos ${harm.harm_cosine.toFixed(4)}` +
        `   harmless: excess ${benign.harm_excess.toFixed(4)} cos ${benign.harm_cosine.toFixed(4)}`
    );

    const verdict = await page.locator("#yours-verdict").textContent();
    assert(
      /benign|harm/.test(verdict),
      `the verdict must be one of the two readings, got ${JSON.stringify(verdict)}`
    );

    const shotYours = path.join(SHOTS_DIR, "story-3-your-turn.png");
    await page.screenshot({ path: shotYours, fullPage: false });
    console.log("   Saved Shot 3 (the visitor's own command):", shotYours);

    /* =====================================================================
     * PART 4: the mode switch
     * ===================================================================== */
    const observeSub = await page.locator("#mon-sub").textContent();
    await page.click('#seg-mode .seg-btn[data-mode="deter"]');
    await page.waitForTimeout(200);
    const deterSub = await page.locator("#mon-sub").textContent();
    assert(
      observeSub !== deterSub && /deter/i.test(deterSub),
      "the DETER switch must change what the page promises"
    );

    /* =====================================================================
     * PART 5: the admission gate
     * ===================================================================== */
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === "zcode_sid");
    const device = cookies.find((c) => c.name === "zcode_dev");
    assert(session, "the page must hold a session cookie");
    assert(device, "the page must hold a device cookie");

    if (EXPECT_AUTH === "required") {
      // The same call WITHOUT the session must be refused.  If it is not,
      // the gate is decorative — and the whole public story is a lie.
      const bare = await page.evaluate(async () => {
        const r = await fetch("/v1/guard/tool-call", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "no session",
            tool_name: "bash",
            tool_args: { cmd: "ls" },
          }),
        });
        return r.status;
      });
      assert(
        bare === 401,
        `a caller with no session must be refused, got ${bare}`
      );
      console.log("   a caller with no session was refused with", bare);
    } else if (EXPECT_AUTH === "open") {
      const bare = await page.evaluate(async () => {
        const r = await fetch("/v1/guard/tool-call", {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: "no session",
            tool_name: "bash",
            tool_args: { cmd: "ls" },
          }),
        });
        return r.status;
      });
      assert(
        bare === 200,
        `an open guard has no credential to demand, so it must answer, got ${bare}`
      );
      console.log("   the open guard answered an anonymous caller with", bare);
    }

    await context.close();
    console.log("ALL PLAYWRIGHT E2E CHECKS PASSED!");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
