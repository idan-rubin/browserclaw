import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startConnectionCdpServer } from '../connection-cdp.test-support.js';
import { closePlaywrightBrowserConnection, connectBrowser, disconnectBrowser } from '../connection.js';
import * as connection from '../connection.js';
import * as pageTarget from '../page-target.js';

import { listPagesViaPlaywright } from './navigation.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const targetInfo = { targetId: 'T1', title: 'Test', url: 'https://example.com/', type: 'page' };

function exposePage(browser: Browser, url: () => string): void {
  const page = { url } as unknown as Page;
  vi.spyOn(browser, 'contexts').mockReturnValue([{ pages: () => [page] } as unknown as BrowserContext]);
}

function exposeMetadataPage(browser: Browser, closed = false): void {
  const context = {
    newCDPSession: () => browser.newBrowserCDPSession(),
  };
  const page = {
    context: () => context,
    url: () => 'https://example.com/',
    isClosed: () => closed,
  } as unknown as Page;
  vi.spyOn(browser, 'contexts').mockReturnValue([{ pages: () => [page] } as unknown as BrowserContext]);
}

describe('page enumeration exact-connection recovery', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectBrowser();
  });

  it.each(['Target.attachToBrowserTarget', 'Target.getTargetInfo'])(
    'retries a recoverable metadata failure from %s and returns successor metadata',
    async (method) => {
      const cdp = await startConnectionCdpServer({
        commandFailures: [{ method, message: 'Browser disconnected', sessionOnly: method === 'Target.getTargetInfo' }],
      });
      try {
        const old = await connectBrowser(cdp.httpUrl);
        const originalConnect = connection.connectBrowser;
        vi.spyOn(connection, 'connectBrowser').mockImplementation(async (...args) => {
          const connected = await originalConnect(...args);
          exposeMetadataPage(connected.browser);
          return connected;
        });
        await expect(listPagesViaPlaywright({ cdpUrl: cdp.httpUrl })).resolves.toEqual([targetInfo]);
        const successor = await connectBrowser(cdp.httpUrl);
        expect(successor.browser).not.toBe(old.browser);
        expect(successor.browser.isConnected()).toBe(true);
        expect(cdp.connections).toBe(2);
        expect(cdp.frames.some((frame) => frame.method === method)).toBe(true);
      } finally {
        await disconnectBrowser();
        await cdp.close();
      }
    },
  );

  it('control: skips a closed page metadata failure without retiring its connected browser', async () => {
    const cdp = await startConnectionCdpServer({
      commandFailures: [{ method: 'Target.getTargetInfo', message: 'Browser disconnected', sessionOnly: true }],
    });
    try {
      const current = await connectBrowser(cdp.httpUrl);
      exposeMetadataPage(current.browser, true);
      await expect(listPagesViaPlaywright({ cdpUrl: cdp.httpUrl })).resolves.toEqual([]);
      expect((await connectBrowser(cdp.httpUrl)).browser).toBe(current.browser);
      expect(current.browser.isConnected()).toBe(true);
      expect(cdp.connections).toBe(1);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('does not retire a successor when the old read fails after replacement', async () => {
    const cdp = await startConnectionCdpServer();
    const metadata = deferred<typeof targetInfo>();
    const read = vi.spyOn(pageTarget, 'pageTargetInfo').mockReturnValue(metadata.promise);
    try {
      const old = await connectBrowser(cdp.httpUrl);
      exposePage(
        old.browser,
        vi
          .fn()
          .mockReturnValueOnce('https://example.com/')
          .mockImplementation(() => {
            throw new Error('Browser disconnected');
          }),
      );
      const listing = listPagesViaPlaywright({ cdpUrl: cdp.httpUrl });
      await vi.waitFor(() => {
        expect(read).toHaveBeenCalledOnce();
      });
      await closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl });
      const successor = await connectBrowser(cdp.httpUrl);
      metadata.resolve(targetInfo);
      await expect(listing).resolves.toEqual([]);
      expect(successor.browser.isConnected()).toBe(true);
      expect((await connectBrowser(cdp.httpUrl)).browser).toBe(successor.browser);
      expect(cdp.connections).toBe(2);
    } finally {
      metadata.resolve(targetInfo);
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('does not retire a successor on timeout or when the old read later completes', async () => {
    const cdp = await startConnectionCdpServer();
    const metadata = deferred<typeof targetInfo>();
    const read = vi.spyOn(pageTarget, 'pageTargetInfo').mockReturnValue(metadata.promise);
    try {
      const old = await connectBrowser(cdp.httpUrl);
      exposePage(old.browser, () => 'https://example.com/');
      const listing = listPagesViaPlaywright({ cdpUrl: cdp.httpUrl, timeoutMs: 300 });
      const rejected = expect(listing).rejects.toThrow('enumeration timed out');
      await vi.waitFor(() => {
        expect(read).toHaveBeenCalledOnce();
      });
      await closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl });
      const successor = await connectBrowser(cdp.httpUrl);
      await rejected;
      metadata.resolve(targetInfo);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(successor.browser.isConnected()).toBe(true);
      expect((await connectBrowser(cdp.httpUrl)).browser).toBe(successor.browser);
      expect(cdp.connections).toBe(2);
    } finally {
      metadata.resolve(targetInfo);
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('control: retires the timed-out adapter when it is still current', async () => {
    const cdp = await startConnectionCdpServer();
    const metadata = deferred<typeof targetInfo>();
    vi.spyOn(pageTarget, 'pageTargetInfo').mockReturnValue(metadata.promise);
    try {
      const connected = await connectBrowser(cdp.httpUrl);
      exposePage(connected.browser, () => 'https://example.com/');
      await expect(listPagesViaPlaywright({ cdpUrl: cdp.httpUrl, timeoutMs: 30 })).rejects.toThrow(
        'enumeration timed out',
      );
      await vi.waitFor(() => {
        expect(connected.browser.isConnected()).toBe(false);
      });
    } finally {
      metadata.resolve(targetInfo);
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('control: reconnects a stale current adapter once, preserving the existing recovery behavior', async () => {
    const cdp = await startConnectionCdpServer();
    try {
      const connected = await connectBrowser(cdp.httpUrl);
      exposePage(connected.browser, () => {
        throw new Error('Browser disconnected');
      });
      await expect(listPagesViaPlaywright({ cdpUrl: cdp.httpUrl })).resolves.toEqual([]);
      expect(cdp.connections).toBe(2);
      expect((await connectBrowser(cdp.httpUrl)).browser).not.toBe(connected.browser);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('control: does not reconnect for an unrelated read failure', async () => {
    const cdp = await startConnectionCdpServer();
    try {
      const connected = await connectBrowser(cdp.httpUrl);
      exposePage(connected.browser, () => {
        throw new Error('unrelated read error');
      });
      await expect(listPagesViaPlaywright({ cdpUrl: cdp.httpUrl })).rejects.toThrow('unrelated read error');
      expect((await connectBrowser(cdp.httpUrl)).browser).toBe(connected.browser);
      expect(cdp.connections).toBe(1);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });
});
