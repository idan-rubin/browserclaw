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

import { enrichSnapshotFromDom, mergeSnapshotWithEnrichment, nextRefCounter } from './dom-enrichment.js';

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

const MIRRORED_VALUE_PAGE = [
  '<!doctype html><html><body>',
  '<input id="pw" type="password" data-typed="">',
  '<input id="otp" autocomplete="one-time-code" data-typed="">',
  '<input id="city" data-typed="">',
  '<script>',
  "for (const el of document.querySelectorAll('input')) el.addEventListener('input', () => { el.dataset.typed = el.value; });",
  '</script>',
  '</body></html>',
].join('');

const STALE_SHADOW_STAMP_PAGE = [
  '<!doctype html><html><body>',
  '<div id="host"></div>',
  '<input id="otp" autocomplete="one-time-code" data-typed="">',
  '<input id="city" data-typed="">',
  '<script>',
  "for (const el of document.querySelectorAll('input')) el.addEventListener('input', () => { el.dataset.typed = el.value; });",
  "document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button id=\"inner\">S</button>';",
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

  it('masks a typed secret the page mirrors into a data attribute', async () => {
    await page.goto(dataUrl(MIRRORED_VALUE_PAGE));
    await page.fill('#pw', 'hunter2-typed');
    await page.fill('#otp', '246810');
    await page.fill('#city', 'Lisbon');
    const { lines } = await enrichSnapshotFromDom(page, 1);
    const text = lines.join('\n');
    expect(text).not.toContain('hunter2-typed');
    expect(text).not.toContain('246810');
    expect(text).toContain('[id="pw"] [type="password"] [data-typed="redacted"]');
    expect(text).toContain('[id="otp"] [data-typed="redacted"]');
    expect(text).toContain('[id="city"] [data-typed="Lisbon"]');
  });

  it('masks a mirrored secret when the page overrides its own attribute reads', async () => {
    await page.goto(dataUrl(MIRRORED_VALUE_PAGE));
    await page.fill('#pw', 'hunter2-typed');
    await page.fill('#otp', '246810');
    await page.fill('#city', 'Lisbon');
    await page.evaluate(() => {
      Element.prototype.getAttribute = () => null;
      Object.defineProperty(Element.prototype, 'tagName', { get: () => 'DIV' });
    });
    const { lines } = await enrichSnapshotFromDom(page, 1);
    const text = lines.join('\n');
    expect(text).not.toContain('hunter2-typed');
    expect(text).not.toContain('246810');
    expect(text).toContain('[id="pw"] [data-typed="redacted"]');
    expect(text).toContain('[id="otp"] [data-typed="redacted"]');
    expect(text).toContain('[id="city"] [data-typed="Lisbon"]');
  });

  it('masks a mirrored secret when a stamp left inside a shadow root balances the totals', async () => {
    await page.goto(dataUrl(STALE_SHADOW_STAMP_PAGE));
    await page.fill('#otp', '246810');
    await page.fill('#city', 'Lisbon');
    expect((await enrichSnapshotFromDom(page, 1)).lines.join('\n')).toContain('[id="inner"]');
    await page.evaluate(() => {
      const inner = document.getElementById('host')?.shadowRoot?.querySelector('button');
      if (inner) inner.style.display = 'none';
      Element.prototype.getAttribute = () => null;
      Object.defineProperty(Element.prototype, 'tagName', { get: () => 'DIV' });
    });
    for (const startRef of [1, 2]) {
      const text = (await enrichSnapshotFromDom(page, startRef)).lines.join('\n');
      expect(text).not.toContain('246810');
      expect(text).toContain('[id="otp"] [data-typed="redacted"]');
      expect(text).toContain('[id="city"] [data-typed="Lisbon"]');
    }
  });

  it('drops an element whose ref the page rewrote on the way back from the scan', async () => {
    await page.goto(dataUrl(MIRRORED_VALUE_PAGE));
    await page.fill('#otp', '246810');
    await page.fill('#city', 'Lisbon');
    await page.evaluate(() => {
      Element.prototype.getAttribute = () => null;
      Object.defineProperty(Element.prototype, 'tagName', { get: () => 'DIV' });
      const push = Array.prototype.push;
      Array.prototype.push = function (...items: unknown[]): number {
        for (const item of items) {
          const scanned = item as { id?: string; ref?: string } | null;
          if (scanned?.id === 'otp') scanned.ref = 'x"], body, [x="';
        }
        return push.apply(this, items);
      };
    });
    const { lines, refs } = await enrichSnapshotFromDom(page, 1);
    const text = lines.join('\n');
    expect(text).not.toContain('246810');
    expect(text).not.toContain('body');
    expect(Object.keys(refs).every((ref) => /^e\d+$/.test(ref))).toBe(true);
    expect(text).toContain('[id="city"] [data-typed="Lisbon"]');
  });

  it('keeps a snapshot ref the page tried to claim for another element', async () => {
    await page.goto(dataUrl('<button id="save">Save</button><button id="delete">Delete</button>'));
    await page.evaluate(() => {
      const push = Array.prototype.push;
      Array.prototype.push = function (...items: unknown[]): number {
        for (const item of items) {
          const scanned = item as { id?: string; ref?: string } | null;
          if (scanned?.id === 'delete') scanned.ref = 'e1';
        }
        return push.apply(this, items);
      };
    });
    const built = { snapshot: '- link "Home" [ref=e1]', refs: { e1: { role: 'link', name: 'Home' } } };
    const merged = mergeSnapshotWithEnrichment(built, await enrichSnapshotFromDom(page, nextRefCounter(built.refs)));
    expect(merged.refs.e1).toEqual(built.refs.e1);
    expect(merged.snapshot.match(/\[ref=e1\]/g)).toHaveLength(1);
    expect(merged.snapshot).toContain('[ref=e2] [id="save"]');
  });

  it('keeps the values of an ordinary control whose attribute names need escaping', async () => {
    await page.goto(dataUrl('<button id="b" data-testid="save" data-analytics.id="cta" data-a:b="c">B</button>'));
    const text = (await enrichSnapshotFromDom(page, 1)).lines.join('\n');
    expect(text).toContain('[data-testid="save"]');
    expect(text).toContain('[data-analyticsid="cta"]');
    expect(text).toContain('[data-ab="c"]');
  });

  it('masks only the value that changed after the scan read it', async () => {
    await page.goto(
      dataUrl(
        '<button id="b" data-testid="save" data-tick="0">B</button>' +
          "<script>new MutationObserver(() => { document.getElementById('b').dataset.tick = '1'; })" +
          ".observe(document.getElementById('b'), { attributes: true, attributeFilter: ['data-bc-ref'] });</script>",
      ),
    );
    const text = (await enrichSnapshotFromDom(page, 1)).lines.join('\n');
    expect(text).toContain('[data-testid="save"]');
    expect(text).toContain('[data-tick="redacted"]');
  });

  it('keeps the data values of an ordinary element inside a shadow root and masks a sensitive one', async () => {
    await page.goto(
      dataUrl(
        '<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = ' +
          '\'<button data-kind="primary">S</button><input autocomplete="one-time-code" data-typed="246810">\';</script>',
      ),
    );
    const text = (await enrichSnapshotFromDom(page, 1)).lines.join('\n');
    expect(text).toContain('[data-kind="primary"]');
    expect(text).not.toContain('246810');
  });

  it('checks data values without walking the whole document for each element', async () => {
    const fields = (attrs: (i: number) => string): string =>
      Array.from({ length: 200 }, (_, i) => `<input ${attrs(i)}>`).join('');
    const table = `<table>${Array.from({ length: 20_000 }, (_, i) => `<tr><td>row ${String(i)}</td><td>cell</td></tr>`).join('')}</table>`;
    const timed = async (html: string): Promise<{ text: string; ms: number }> => {
      await page.goto('about:blank');
      await page.setContent(html);
      await enrichSnapshotFromDom(page, 1);
      const start = performance.now();
      const { lines } = await enrichSnapshotFromDom(page, 1);
      return { text: lines.join('\n'), ms: performance.now() - start };
    };
    const unchecked = await timed(fields((i) => `id="f${String(i)}"`) + table);
    const checked = await timed(fields((i) => `data-testid="f${String(i)}" data-track="t${String(i)}"`) + table);
    expect(checked.text).toContain('[data-testid="f150"] [data-track="t150"]');
    expect(checked.ms).toBeLessThan(unchecked.ms * 5 + 250);
  });

  it('keeps ordinary data values that need escaping or are cut to the printed length', async () => {
    const long = 'x'.repeat(300);
    await page.setContent(
      `<button id="b" data-label='say "hi" [now]\\ ok' data-url="https://example.test/a?b=1&amp;c=é" data-long="${long}">B</button>`,
    );
    const text = (await enrichSnapshotFromDom(page, 1)).lines.join('\n');
    expect(text).toContain('[data-label="say hi now \\ ok"]');
    expect(text).toContain('[data-url="https://example.test/a?b=1&c=é"]');
    expect(text).toContain(`[data-long="${'x'.repeat(120)}…"]`);
  });

  it('nextRefCounter round-trips with a scoped scan', async () => {
    await page.goto(dataUrl(ICON_BUTTON_PAGE));
    const first = await enrichSnapshotFromDom(page, 5);
    expect(Object.keys(first.refs)).toContain('e5');
    expect(nextRefCounter(first.refs)).toBe(6);
  });
});
