import { existsSync } from 'node:fs';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { takeScreenshotViaPlaywright } from '../capture/screenshot.js';
import type * as Connection from '../connection.js';

import { setDeviceViaPlaywright } from './emulation.js';
import { clickViaPlaywright } from './interaction.js';

const mocks = vi.hoisted(() => ({ page: vi.fn<() => Promise<Page>>() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: mocks.page,
  getRestoredPageForTarget: mocks.page,
}));

const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  existsSync,
);
describe.skipIf(executablePath === undefined)('native action state (real Chromium)', () => {
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

  it('cancels a waiting click without disconnecting another tab', async () => {
    const other = await browser.newPage();
    try {
      await other.setContent('<button onclick="this.textContent=\'clicked\'">Ready</button>');
      const controller = new AbortController();
      const reason = new Error('cancel only this click');
      const result = clickViaPlaywright({ cdpUrl: 'test', selector: '#not-present', signal: controller.signal });
      const rejected = expect(result).rejects.toBe(reason);
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort(reason);
      await rejected;
      expect(browser.isConnected()).toBe(true);
      await other.getByRole('button').click();
      expect(await other.getByRole('button').innerText()).toBe('clicked');
      await page.setContent('<button>Control</button>');
      await clickViaPlaywright({ cdpUrl: 'test', selector: 'button' });
    } finally {
      await other.close();
    }
  });

  it('keeps mobile metrics and touch settings across a screenshot', async () => {
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><button>Mobile</button>');
    await setDeviceViaPlaywright({ cdpUrl: 'test', name: 'iPhone 13' });
    const before = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      touch: navigator.maxTouchPoints,
    }));
    const result = await takeScreenshotViaPlaywright({ cdpUrl: 'test' });
    expect(result.buffer.readUInt32BE(16)).toBe(1170);
    expect(
      await page.evaluate(() => ({ width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints })),
    ).toEqual(before);
    expect(before.touch).toBe(5);
  });
});
