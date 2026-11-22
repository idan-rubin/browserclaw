import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';
import { InvalidBrowserNavigationUrlError } from '../security.js';

const mocks = vi.hoisted(() => ({ page: vi.fn(), state: vi.fn(), locator: vi.fn() }));
vi.mock('../connection.js', async (original) => ({
  ...(await original<typeof Connection>()),
  getPageForTargetId: mocks.page,
  ensurePageState: mocks.state,
  refLocator: mocks.locator,
}));

import { downloadViaPlaywright } from './download.js';
import { createFakeNavigationFence } from './navigation-fence.test-support.js';
import { navigateViaPlaywright } from './navigation.js';

let directory: string;
const published: string[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bc-download-lifetime-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  for (const file of published.splice(0)) await rm(file, { force: true });
});

function fixture() {
  const frame = {};
  const fence = createFakeNavigationFence({ url: () => 'about:blank' });
  const page = Object.assign(new EventEmitter(), {
    url: () => 'about:blank',
    mainFrame: () => frame,
    isClosed: () => false,
    close: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn(),
    context: () => ({ newCDPSession: fence.newCDPSession }),
  });
  const dispatch = () => fence.pauseDocument('http://169.254.169.254/latest/meta-data/');
  mocks.page.mockResolvedValue(page as unknown as Page);
  mocks.state.mockReturnValue({ nextArmIdDownload: 0, armIdDownload: 0, downloadWaiterDepth: 0 });
  return { page, fence, dispatch };
}

describe('download navigation ownership', () => {
  it('waits for an aborted native click and preserves a later policy denial', async () => {
    const f = fixture();
    let finish: () => void = () => undefined;
    const native = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const click = vi.fn(() => native);
    mocks.locator.mockReturnValue({ click });
    const controller = new AbortController();
    let settled = false;
    const pending = downloadViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      targetId: 'T1',
      ref: 'e1',
      path: join(directory, 'payload.bin'),
      signal: controller.signal,
      timeoutMs: 5000,
    }).finally(() => {
      settled = true;
    });
    const rejection = expect(pending).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    await vi.waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    controller.abort(new Error('cancel download'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(f.fence.releases()).toBe(0);
    expect(await f.dispatch()).toEqual({ continued: false, errorReason: 'Aborted' });
    finish();
    await rejection;
    expect(f.fence.releases()).toBe(1);
    // Control: once released, the tab's standing policy answers instead of the download.
    expect(await f.dispatch()).toEqual({ continued: false, errorReason: 'BlockedByClient' });
  });

  it.each([
    ['https://93.184.216.34/start', 'https://93.184.216.34/final.zip'],
    ['https://93.184.216.34/my file.zip', 'https://93.184.216.34/my%20file.zip'],
    ['https://93.184.216.34:443/file.zip', 'https://93.184.216.34/file.zip'],
  ])('confirms an aborted download by its event, not the input URL: %s', async (url, finalUrl) => {
    const f = fixture();
    f.page.goto.mockImplementation(() => {
      setTimeout(
        () =>
          f.page.emit('download', {
            url: () => finalUrl,
            suggestedFilename: () => 'payload.txt',
            saveAs: (file: string) => writeFile(file, 'download payload'),
          }),
        20,
      );
      return Promise.reject(new Error(`page.goto: net::ERR_ABORTED at ${finalUrl}`));
    });
    const result = await navigateViaPlaywright({ cdpUrl: 'http://localhost:9222', url, timeoutMs: 3000 });
    expect(result.download).toBeDefined();
    if (!result.download) throw new Error('Expected confirmed download');
    published.push(result.download.path);
    expect(await readFile(result.download.path, 'utf8')).toBe('download payload');
    expect(f.page.listenerCount('download')).toBe(0);
  });

  it('rethrows the original abort after the bounded grace when no download event arrives', async () => {
    const f = fixture();
    const error = new Error('page.goto: net::ERR_ABORTED at https://93.184.216.34/final');
    f.page.goto.mockRejectedValue(error);
    const started = Date.now();
    await expect(
      navigateViaPlaywright({
        cdpUrl: 'http://localhost:9222',
        url: 'https://93.184.216.34/start',
        timeoutMs: 10_000,
      }),
    ).rejects.toBe(error);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(4000);
    expect(f.page.listenerCount('download')).toBe(0);
  });
});
