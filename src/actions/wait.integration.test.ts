import { existsSync } from 'node:fs';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';

const mocks = vi.hoisted(() => ({ page: vi.fn<() => Promise<Page>>() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: mocks.page,
}));
import { waitForViaPlaywright } from './wait.js';

const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  existsSync,
);
describe.skipIf(executablePath === undefined)('document-bound waits (real Chromium)', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    mocks.page.mockResolvedValue(page);
  });
  afterEach(async () => {
    await page.close();
  });
  afterAll(async () => {
    await browser.close();
  });

  it('supports function arguments, string functions, and reevaluated expressions', async () => {
    await page.setContent('<div>Visible content</div>');
    await waitForViaPlaywright({ cdpUrl: 'test', fn: (arg) => arg === 'expected', arg: 'expected' });
    const methods = {
      ready(arg?: unknown) {
        return arg === 'method';
      },
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- exercise method-source serialization, not its receiver
    await waitForViaPlaywright({ cdpUrl: 'test', fn: methods.ready, arg: 'method' });
    await waitForViaPlaywright({ cdpUrl: 'test', fn: '(arg) => arg.ok', arg: { ok: true } });
    await waitForViaPlaywright({ cdpUrl: 'test', fn: 'return arg === "statement";', arg: 'statement' });
    await waitForViaPlaywright({ cdpUrl: 'test', fn: 'await Promise.resolve(); return arg.ok;', arg: { ok: true } });
    await expect(waitForViaPlaywright({ cdpUrl: 'test', fn: 'return );' })).rejects.toThrow(/Unexpected token/);
    const pending = waitForViaPlaywright({ cdpUrl: 'test', fn: 'document.body.dataset.ready === "yes"' });
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      document.body.dataset.ready = 'yes';
    });
    await pending;
    await waitForViaPlaywright({ cdpUrl: 'test', text: 'Visible content', textGone: 'missing' });
  });

  it('serializes async predicate polls and surfaces rejection', async () => {
    await page.setContent('<body></body>');
    await waitForViaPlaywright({
      cdpUrl: 'test',
      fn: `async () => {
        const body = document.body;
        body.dataset.active = String(Number(body.dataset.active || 0) + 1);
        body.dataset.max = String(Math.max(Number(body.dataset.max || 0), Number(body.dataset.active)));
        await new Promise(resolve => setTimeout(resolve, 75));
        body.dataset.active = String(Number(body.dataset.active) - 1);
        body.dataset.calls = String(Number(body.dataset.calls || 0) + 1);
        return Number(body.dataset.calls) >= 2;
      }`,
    });
    expect(await page.locator('body').getAttribute('data-max')).toBe('1');
    expect(await page.locator('body').getAttribute('data-calls')).toBe('2');
    await expect(
      waitForViaPlaywright({ cdpUrl: 'test', fn: 'async () => { throw new Error("predicate failed"); }' }),
    ).rejects.toThrow('predicate failed');
  });

  it('retains a closure-producing predicate across polls', async () => {
    await waitForViaPlaywright({
      cdpUrl: 'test',
      fn: `(() => {
        let calls = 0;
        return (expected) => {
          document.body.dataset.calls = String(++calls);
          return calls === expected;
        };
      })()`,
      arg: 2,
      timeoutMs: 1500,
    });
    expect(await page.locator('body').getAttribute('data-calls')).toBe('2');
  });

  it('does not bind internal wait state as the predicate receiver', async () => {
    await waitForViaPlaywright({
      cdpUrl: 'test',
      fn: 'function () { "use strict"; return this === undefined; }',
      timeoutMs: 1500,
    });
  });

  it('rejects after same-URL document replacement and allows a fresh wait', async () => {
    await page.goto('about:blank');
    const pending = waitForViaPlaywright({
      cdpUrl: 'test',
      fn: '() => { document.body.dataset.started = "yes"; return false; }',
      timeoutMs: 5000,
    });
    const rejected = expect(pending).rejects.toThrow(/document|context/i);
    await page.waitForFunction(() => document.body.dataset.started === 'yes');
    await page.reload();
    await rejected;
    await waitForViaPlaywright({ cdpUrl: 'test', fn: () => true });
  });

  it('aborts the native predicate and dispatches no subsequent step', async () => {
    const controller = new AbortController();
    const reason = new Error('stop wait');
    const pending = waitForViaPlaywright({
      cdpUrl: 'test',
      text: 'absent',
      fn: '() => { document.body.dataset.ran = "yes"; return true; }',
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    await page.waitForTimeout(50);
    controller.abort(reason);
    await rejected;
    expect(await page.locator('body').getAttribute('data-ran')).toBeNull();
    await waitForViaPlaywright({ cdpUrl: 'test', fn: () => true });
  });

  it('aborts a fixed delay promptly and skips its selector', async () => {
    const controller = new AbortController();
    const reason = new Error('stop delay');
    const pending = waitForViaPlaywright({
      cdpUrl: 'test',
      timeMs: 30_000,
      selector: '#missing',
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    await waitForViaPlaywright({ cdpUrl: 'test', timeMs: 1, selector: 'body' });
  });
});
