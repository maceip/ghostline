#!/usr/bin/env node
/**
 * Dump the canonical Zode library from packages/shared/library.json.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const canonical = join(root, 'packages', 'shared', 'library.json');
const data = JSON.parse(readFileSync(canonical, 'utf8'));
process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
