import { existsSync } from 'node:fs';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';
import { getPageState } from '../page-utils.js';
import { refLocator } from '../ref-resolver.js';

const mocks = vi.hoisted(() => ({ page: vi.fn<() => Promise<Page>>() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: mocks.page,
}));

import { snapshotAi } from './ai-snapshot.js';
import { snapshotRole, snapshotAria } from './aria-snapshot.js';

const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  existsSync,
);

describe.skipIf(executablePath === undefined)('native snapshot capture (real Chromium)', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    mocks.page.mockResolvedValue(page);
  });
  afterAll(async () => {
    await browser.close();
  });
  afterEach(async () => {
    await page.close();
  });

  it('scopes duplicate controls and resolves exact native refs through real DOM markers', async () => {
    await page.setContent(
      '<button>Save</button><section id="scope"><button onclick="this.textContent=\'Clicked\'">Save</button></section>',
    );
    const result = await snapshotRole({ cdpUrl: 'test', selector: '#scope' });
    const entry = Object.entries(result.refs).find(([, info]) => info.name === 'Save');
    expect(entry).toBeDefined();
    expect(Object.values(result.refs).filter((info) => info.name === 'Save')).toHaveLength(1);
    expect(entry?.[1].domMarker).toBe(true);
    await refLocator(page, entry?.[0] ?? '').click();
    expect(await page.locator('#scope button').innerText()).toBe('Clicked');
    expect(await page.locator('body > button').innerText()).toBe('Save');
  });

  it('keeps an iframe snapshot bound to its actual Frame and invalidates a replacement', async () => {
    await page.setContent('<iframe id="frame" srcdoc="<button>Inside</button>"></iframe><button>Outside</button>');
    await page.frameLocator('#frame').getByRole('button').waitFor();
    const result = await snapshotRole({ cdpUrl: 'test', frameSelector: '#frame' });
    const entry = Object.entries(result.refs).find(([, info]) => info.name === 'Inside');
    expect(entry).toBeDefined();
    expect(getPageState(page)?.roleRefsFrame).toBe(page.frames()[1]);
    expect(await refLocator(page, entry?.[0] ?? '').innerText()).toBe('Inside');
    await page.locator('#frame').evaluate((element) => {
      element.outerHTML = '<iframe id="frame" srcdoc="<button>Replacement</button>"></iframe>';
    });
    expect(() => refLocator(page, entry?.[0] ?? '')).toThrow('Unknown ref');
  });

  it('returns a selector no-match promptly and does not capture unrelated controls', async () => {
    await page.setContent('<button>Outside</button>');
    const start = Date.now();
    const result = await snapshotRole({ cdpUrl: 'test', selector: '#missing', timeoutMs: 5000 });
    expect(result.snapshot).toBe('(empty)');
    expect(result.refs).toEqual({});
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('resolves raw ARIA refs and invalidates them on same-URL document replacement', async () => {
    await page.goto('data:text/html,<button>Native</button>');
    const result = await snapshotAria({ cdpUrl: 'test' });
    const node = result.nodes.find((entry) => entry.name === 'Native' && entry.role === 'button');
    expect(node).toBeDefined();
    expect(await refLocator(page, node?.ref ?? '').innerText()).toBe('Native');
    await page.reload();
    expect(() => refLocator(page, node?.ref ?? '')).toThrow('Unknown ref');
  });

  it('preserves enrichment and applies the final budget to both native and AI output', async () => {
    await page.setContent(
      '<button>Primary</button>' +
        Array.from({ length: 12 }, (_, i) => `<input type="color" data-testid="custom-${String(i)}">`).join(''),
    );
    const native = await snapshotRole({ cdpUrl: 'test' });
    expect(native.snapshot).toContain('custom-');
    expect(Object.values(native.refs).some((info) => info.selector !== undefined)).toBe(true);
    const boundedNative = await snapshotRole({ cdpUrl: 'test', maxChars: 90 });
    expect(boundedNative.snapshot.length).toBeLessThanOrEqual(90);
    expect(boundedNative.truncated).toBe(true);
    const boundedAi = await snapshotAi({ cdpUrl: 'test', maxChars: 90 });
    expect(boundedAi.snapshot.length).toBeLessThanOrEqual(90);
    expect(boundedAi.truncated).toBe(true);
    for (const ref of Object.keys(boundedAi.refs)) expect(boundedAi.snapshot).toContain(`[ref=${ref}]`);
  });
});
