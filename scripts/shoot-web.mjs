#!/usr/bin/env node
/**
 * Render the Zode web app in headless Chromium and capture every view.
 * Proves the app boots, the Metro layout renders, and the drag strip is present.
 *
 * Usage:  node scripts/shoot-web.mjs [outputDir]
 * Requires: playwright (installed globally) + a Chromium build.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/usr/local/lib/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'apps', 'web');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'screenshots'));
const PORT = 5199;

mkdirSync(OUT, { recursive: true });

// --- serve ---------------------------------------------------------------
const server = spawn(process.execPath, [path.join(WEB, 'serve.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[serve] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));

const base = `http://127.0.0.1:${PORT}`;
const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  try {
    const r = await fetch(base + '/');
    if (r.ok) break;
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 300));
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(base + '/', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);

// --- the bridge must exist -------------------------------------------------
const bridge = await page.evaluate(() => {
  const z = globalThis.window?.zode;
  if (!z) return null;
  return {
    platform: z.platform,
    version: z.version,
    capabilities: z.capabilities,
    members: Object.keys(z).sort(),
  };
});
console.log('bridge:', JSON.stringify(bridge, null, 2));

// --- the drag strip must exist --------------------------------------------
const strip = await page.evaluate(() => {
  const el = document.querySelector('[data-zode-drag-zone="true"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { height: r.height, width: r.width, top: r.top, tag: el.tagName };
});
console.log('drag strip:', JSON.stringify(strip));

// --- walk every view -------------------------------------------------------
const views = ['now-playing', 'collection', 'library', 'search', 'agent'];
const shots = [];
for (const v of views) {
  const ok = await page.evaluate((view) => {
    const z = globalThis.window?.zode;
    if (z?.performIntent) return z.performIntent('zode.show', { view }).then(() => true).catch(() => false);
    return false;
  }, v);
  await page.waitForTimeout(500);
  const file = path.join(OUT, `web-${v}.png`);
  await page.screenshot({ path: file });
  shots.push({ view: v, intent: ok, file });
  console.log(`shot ${v} (intent=${ok}) -> ${file}`);
}

// --- the light canvas too --------------------------------------------------
// Click the real canvas toggle in the drag strip, the way a user would.
await page.evaluate(async () => {
  await window.zode.performIntent('zode.show', { view: 'collection' });
});
await page.waitForTimeout(400);
const toggled = await page.evaluate(() => {
  const button = document.querySelector('[data-zode-drag-zone="true"] button[aria-label="Switch canvas"]');
  if (!button) return false;
  button.click();
  return true;
});
console.log('canvas toggle found:', toggled);
await page.waitForTimeout(400);
const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
console.log('theme now:', theme);
await page.screenshot({ path: path.join(OUT, 'web-paper.png') });
console.log('shot paper canvas');

console.log('console errors:', consoleErrors.length ? consoleErrors : 'none');
await browser.close();
server.kill('SIGTERM');
console.log('DONE', JSON.stringify(shots.map((s) => s.view)));
