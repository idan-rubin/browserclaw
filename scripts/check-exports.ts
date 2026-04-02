#!/usr/bin/env node

/**
 * Verifies that the built dist/index.d.ts contains all expected public APIs.
 * Run after `npm run build` to catch accidental removals before publishing.
 *
 * To add a new required export:  add it to REQUIRED_EXPORTS below.
 * To add a new required method:  add it to REQUIRED_METHODS below.
 */

import { readFileSync } from 'fs';

const DTS_PATH = 'dist/index.d.ts';

// Top-level exports that must appear in the export {} line
const REQUIRED_EXPORTS = [
  'BrowserClaw',
  'CrawlPage',
  'pressAndHoldViaCdp',
  'RequestResult',
  'batchViaPlaywright',
  'executeSingleAction',
  'detectChallengeViaPlaywright',
  'waitForChallengeViaPlaywright',
  'STEALTH_SCRIPT',
];

// Methods that must exist on CrawlPage (checked via declaration in the .d.ts)
const REQUIRED_METHODS = ['pressAndHold', 'waitForRequest', 'waitForTab'];

let dts: string;
try {
  dts = readFileSync(DTS_PATH, 'utf8');
} catch {
  console.error(`ERROR: ${DTS_PATH} not found. Run "npm run build" first.`);
  process.exit(1);
}

const failures: string[] = [];

for (const name of REQUIRED_EXPORTS) {
  if (!dts.includes(name)) {
    failures.push(`Missing export: ${name}`);
  }
}

for (const method of REQUIRED_METHODS) {
  // Match method declarations like: methodName(  or methodName<
  const pattern = new RegExp(`\\b${method}\\s*[(<]`);
  if (!pattern.test(dts)) {
    failures.push(`Missing method: ${method}`);
  }
}

if (failures.length > 0) {
  console.error('Export check FAILED — the following public APIs are missing from the build:\n');
  for (const f of failures) {
    console.error(`  ✗ ${f}`);
  }
  console.error('\nThis likely means a sync or refactor accidentally removed browserclaw-only code.');
  console.error('Fix the source, rebuild, and re-run this check.');
  process.exit(1);
}

console.log(
  `Export check passed — ${REQUIRED_EXPORTS.length} exports and ${REQUIRED_METHODS.length} methods verified.`,
);
