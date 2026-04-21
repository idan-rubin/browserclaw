/**
 * Integration test for DOM enrichment — exercises the real page.evaluate path
 * against a headless Chromium and verifies:
 *
 *   1. Icon-only buttons (no accessible name, only an `id`) are discovered
 *   2. Elements in open shadow roots are discovered
 *   3. `data-bc-ref` stamps are cleared on re-snapshot so re-used ref numbers
 *      cannot match two elements at once
 *   4. Enriched refs resolve to real locators that can click through to
 *      handler invocation (proving end-to-end that the selector is correct)
 *
 * Skipped automatically if `playwright-core`'s Chromium binary is not installed.
 */

import { existsSync } from 'node:fs';

import type { Browser, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enrichSnapshotFromDom, nextRefCounter } from './dom-enrichment.js';

const ICON_BUTTON_PAGE = [
  '<!doctype html><html><body>',
  '<button id="settings-btn" onclick="window.__clicks = (window.__clicks || 0) + 1">x</button>',
  '<button aria-label="Save">Save</button>',
  '<button></button>',
  '<button id="hidden-btn" style="display:none">h</button>',
  '</body></html>',
].join('');

const SHADOW_DOM_PAGE = [
  '<!doctype html><html><body>',
  '<div id="host"></div>',
  '<script>',
  "const host = document.getElementById('host');",
  "const root = host.attachShadow({ mode: 'open' });",
  "const btn = document.createElement('button');",
  "btn.id = 'shadow-btn';",
  "btn.textContent = 'S';",
  "btn.addEventListener('click', () => { window.__shadowClicks = (window.__shadowClicks || 0) + 1; });",
  'root.appendChild(btn);',
  '</script>',
  '</body></html>',
].join('');

function dataUrl(html: string): string {
  return `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
}

const chromiumAvailable = ((): boolean => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const d = chromiumAvailable ? describe : describe.skip;

d('enrichSnapshotFromDom (integration)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser.close();
  });

  it('discovers icon-only buttons identified by id only', async () => {
    await page.goto(dataUrl(ICON_BUTTON_PAGE));
    const { lines, refs } = await enrichSnapshotFromDom(page, 1);

    const ids = Object.values(refs).map((r) => r.selector);
    expect(ids).toContain('[data-bc-ref="e1"]');

    const settingsLine = lines.find((l) => l.includes('settings-btn'));
    expect(settingsLine).toBeDefined();

    expect(lines.find((l) => l.includes('hidden-btn'))).toBeUndefined();
    expect(lines.filter((l) => l.startsWith('- button')).length).toBe(1);
  });

  it('traverses open shadow roots', async () => {
    await page.goto(dataUrl(SHADOW_DOM_PAGE));
    const { lines } = await enrichSnapshotFromDom(page, 1);
    const shadowLine = lines.find((l) => l.includes('shadow-btn'));
    expect(shadowLine).toBeDefined();
  });

  it('clears stale data-bc-ref stamps between snapshots', async () => {
    await page.goto(dataUrl(ICON_BUTTON_PAGE));

    await enrichSnapshotFromDom(page, 1);
    const firstStamp = await page.evaluate(() => document.querySelectorAll('[data-bc-ref]').length);
    expect(firstStamp).toBe(1);

    await enrichSnapshotFromDom(page, 1);
    const secondStamp = await page.evaluate(() => document.querySelectorAll('[data-bc-ref]').length);
    expect(secondStamp).toBe(1);

    const match = await page.evaluate(() => document.querySelectorAll('[data-bc-ref="e1"]').length);
    expect(match).toBe(1);
  });

  it('enriched selector resolves to an element that actually clicks', async () => {
    await page.goto(dataUrl(ICON_BUTTON_PAGE));
    const { refs } = await enrichSnapshotFromDom(page, 1);

    const ref = Object.values(refs).find((r) => r.selector?.startsWith('[data-bc-ref=') === true);
    expect(ref).toBeDefined();
    const selector = ref?.selector ?? '';
    expect(selector).not.toBe('');

    await page.locator(selector).click();
    const clicks = await page.evaluate(() => (window as unknown as { __clicks?: number }).__clicks ?? 0);
    expect(clicks).toBe(1);
  });

  it('nextRefCounter round-trips with a scoped scan', async () => {
    await page.goto(dataUrl(ICON_BUTTON_PAGE));
    const first = await enrichSnapshotFromDom(page, 5);
    expect(Object.keys(first.refs)).toContain('e5');
    expect(nextRefCounter(first.refs)).toBe(6);
  });
});
