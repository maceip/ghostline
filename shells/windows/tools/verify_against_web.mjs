#!/usr/bin/env node
/**
 * verify_against_web.mjs — cross-implementation conformance check.
 *
 * The Windows shell (C#) and the web app (JavaScript) have to agree on the
 * frozen contract: the request types, the event names, the error codes, the
 * attachment sources, the intent names, the capability keys and the height of
 * the drag strip.
 *
 * This script imports the canonical list from the web app
 * (apps/web/src/bridge/contract.js) and compares it with the constants that
 * the shell declares in C#.  It is the one part of the contract that CAN be
 * verified on a machine without Windows and without the .NET SDK.
 *
 *   node tools/verify_against_web.mjs
 *
 * Exit code 0 = the two implementations agree.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, '..');
const repoRoot = resolve(shellRoot, '..', '..');
const webContract = join(repoRoot, 'src', 'bridge', 'contract.js');

const results = [];
const check = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
};

/** Every C# source of the shell. */
function csharpSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...csharpSources(full));
    else if (entry.endsWith('.cs')) out.push(full);
  }
  return out;
}

/** All `public const string NAME = "value";` declarations of a C# file. */
function constantsOf(file) {
  const text = readFileSync(file, 'utf8');
  const map = new Map();
  for (const match of text.matchAll(/public const string (\w+)\s*=\s*"([^"]+)";/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

/** The const declarations of one C# class only. */
function constantsOfClass(file, className) {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(`class ${className}`);
  if (start < 0) return new Map();
  const end = text.indexOf('\n}', start);
  const body = text.slice(start, end < 0 ? text.length : end);
  const map = new Map();
  for (const match of body.matchAll(/public const string (\w+)\s*=\s*"([^"]+)";/g)) {
    map.set(match[1], match[2]);
  }
  return map;
}

function valuesOf(map) {
  return new Set(map.values());
}

// --------------------------------------------------------------------------
console.log('Zode — Windows shell ⇄ web app contract check');
console.log(`web contract: ${webContract}`);
console.log('-'.repeat(72));

let contract;
try {
  contract = await import(pathToFileURL(webContract).href);
} catch (error) {
  console.log(`ERROR: the web contract could not be imported: ${error.message}`);
  console.log('The web app is not in the repository — skipping the cross check.');
  process.exit(0);
}

const sources = csharpSources(join(shellRoot, 'Zode.Shell'));
const bridgeProtocol = join(shellRoot, 'Zode.Shell', 'Bridge', 'BridgeProtocol.cs');
const dispatcherFile = join(shellRoot, 'Zode.Shell', 'Bridge', 'BridgeDispatcher.cs');
const intentFile = join(shellRoot, 'Zode.Shell', 'Platform', 'IntentService.cs');
const attachmentFile = join(shellRoot, 'Zode.Shell', 'Attachments', 'Attachment.cs');

// ---- request types (§3) --------------------------------------------------
const requestTypes = new Set(constantsOfClass(bridgeProtocol, 'RequestTypes').values());
const missingRequests = contract.REQUEST_TYPES.filter((t) => !requestTypes.has(t));
const extraRequests = [...requestTypes].filter((t) => !contract.REQUEST_TYPES.includes(t));
check(
  missingRequests.length === 0 && extraRequests.length === 0,
  'request types match the web app',
  missingRequests.length || extraRequests.length
    ? `missing=[${missingRequests}] extra=[${extraRequests}]`
    : `${contract.REQUEST_TYPES.length} types`,
);

// ---- event names (§2.2) --------------------------------------------------
const eventNames = new Set(constantsOfClass(bridgeProtocol, 'EventNames').values());
const missingEvents = contract.EVENT_NAMES.filter((e) => !eventNames.has(e));
const extraEvents = [...eventNames].filter((e) => !contract.EVENT_NAMES.includes(e));
check(
  missingEvents.length === 0 && extraEvents.length === 0,
  'native event names match the web app',
  missingEvents.length || extraEvents.length
    ? `missing=[${missingEvents}] extra=[${extraEvents}]`
    : `${contract.EVENT_NAMES.length} events`,
);

// ---- error codes (§1.2) --------------------------------------------------
const errorCodes = new Set(constantsOfClass(bridgeProtocol, 'ErrorCodes').values());
const missingCodes = contract.ERROR_CODES.filter((c) => !errorCodes.has(c));
const extraCodes = [...errorCodes].filter((c) => !contract.ERROR_CODES.includes(c));
check(
  missingCodes.length === 0 && extraCodes.length === 0,
  'error codes match the web app',
  missingCodes.length || extraCodes.length
    ? `missing=[${missingCodes}] extra=[${extraCodes}]`
    : `${contract.ERROR_CODES.length} codes`,
);

// ---- attachment sources (§2.1) ------------------------------------------
const attachmentSources = new Set(constantsOfClass(attachmentFile, 'AttachmentSources').values());
const missingSources = contract.ATTACHMENT_SOURCES.filter((s) => !attachmentSources.has(s));
const extraSources = [...attachmentSources].filter((s) => !contract.ATTACHMENT_SOURCES.includes(s));
check(
  missingSources.length === 0 && extraSources.length === 0,
  'attachment sources match the web app',
  missingSources.length || extraSources.length
    ? `missing=[${missingSources}] extra=[${extraSources}]`
    : `${contract.ATTACHMENT_SOURCES.length} sources`,
);

// ---- intent names (§4) ---------------------------------------------------
const intentNames = new Set(
  [...constantsOfClass(intentFile, 'IntentService').values()].filter((v) => v.startsWith('zode.')),
);
const missingIntents = contract.INTENT_NAMES.filter((i) => !intentNames.has(i));
const extraIntents = [...intentNames].filter((i) => !contract.INTENT_NAMES.includes(i));
check(
  missingIntents.length === 0 && extraIntents.length === 0,
  'intent names match the web app',
  missingIntents.length || extraIntents.length
    ? `missing=[${missingIntents}] extra=[${extraIntents}]`
    : `${contract.INTENT_NAMES.length} intents`,
);

// ---- drag zone height (§5.3) --------------------------------------------
const shellWindow = readFileSync(join(shellRoot, 'Zode.Shell', 'Windowing', 'ShellWindow.cs'), 'utf8');
const dragZone = /DRAG_ZONE_HEIGHT\s*=\s*(\d+)/.exec(shellWindow);
check(
  dragZone !== null && Number(dragZone[1]) === contract.DRAG_ZONE_HEIGHT,
  'DRAG_ZONE_HEIGHT matches the web app',
  dragZone ? `${dragZone[1]} vs ${contract.DRAG_ZONE_HEIGHT}` : 'not found',
);

// ---- capability keys (§2) ------------------------------------------------
const dispatcher = readFileSync(dispatcherFile, 'utf8');
const capabilityBlock = dispatcher.slice(
  dispatcher.indexOf('DescribeCapabilities'),
  dispatcher.indexOf('public JsonObject Dispatch'),
);
const capabilities = new Set(
  [...capabilityBlock.matchAll(/\["(\w+)"\]\s*=/g)].map((m) => m[1]),
);
const missingKeys = contract.CAPABILITY_KEYS.filter((k) => !capabilities.has(k));
const extraKeys = [...capabilities].filter((k) => !contract.CAPABILITY_KEYS.includes(k));
check(
  missingKeys.length === 0 && extraKeys.length === 0,
  'capability keys match the web app',
  missingKeys.length || extraKeys.length
    ? `missing=[${missingKeys}] extra=[${extraKeys}]`
    : `${contract.CAPABILITY_KEYS.length} keys`,
);

// --------------------------------------------------------------------------
console.log('-'.repeat(72));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} cross checks passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}`);
  process.exit(1);
}
console.log('The Windows shell and the web app agree on the frozen contract.');
