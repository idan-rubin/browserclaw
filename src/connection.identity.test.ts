import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closePageByTargetIdViaPlaywright, focusPageByTargetIdViaPlaywright } from './actions/navigation.js';
import * as transport from './cdp-transport.js';
import { startConnectionCdpServer } from './connection-cdp.test-support.js';
import {
  BlockedBrowserTargetError,
  BrowserTabNotFoundError,
  connectBrowser,
  disconnectBrowser,
  findPageByTargetId,
  getPageForTargetId,
  markPageRefBlocked,
  markTargetBlocked,
  pageTargetId,
} from './connection.js';

function makePage(targetId: string | null) {
  const close = vi.fn().mockResolvedValue(undefined);
  const bringToFront = vi.fn().mockResolvedValue(undefined);
  const page = {
    url: () => 'https://shared.test/',
    close,
    bringToFront,
    on: vi.fn(),
    context: () => ({
      newCDPSession: () =>
        Promise.resolve({
          send: () => {
            if (targetId === null) return Promise.reject(new Error('metadata unavailable'));
            return Promise.resolve({ targetInfo: { targetId } });
          },
          detach: () => Promise.resolve(),
        }),
    }),
  } as unknown as Page;
  return { page, close, bringToFront };
}

function exposePages(browser: Browser, pages: Page[]) {
  vi.spyOn(browser, 'contexts').mockReturnValue([
    { pages: () => pages, on: vi.fn(), once: vi.fn(), off: vi.fn() } as unknown as BrowserContext,
  ]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await disconnectBrowser();
});

describe('exact target identity for lookup and tab mutations', () => {
  it.each([{}, { targetInfo: {} }, { targetInfo: { targetId: '  ' } }])(
    'preserves the null result for missing target identity: %j',
    async (metadata) => {
      const page = makePage('unused').page;
      vi.spyOn(page, 'context').mockReturnValue({
        newCDPSession: () =>
          Promise.resolve({ send: () => Promise.resolve(metadata), detach: () => Promise.resolve() }),
      } as unknown as BrowserContext);
      await expect(pageTargetId(page)).resolves.toBeNull();
    },
  );

  it.each([false, true])('starts cold metadata reads concurrently and rechecks quarantine (%s)', async (blockFirst) => {
    const cdp = await startConnectionCdpServer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const pages = ['first', 'second'].map((targetId) => {
      const fixture = makePage(targetId);
      vi.spyOn(fixture.page, 'context').mockReturnValue({
        newCDPSession: async () => {
          started.push(targetId);
          await gate;
          return {
            send: () => Promise.resolve({ targetInfo: { targetId, title: targetId } }),
            detach: () => Promise.resolve(),
          };
        },
      } as unknown as BrowserContext);
      return fixture.page;
    });
    try {
      const { browser } = await connectBrowser(cdp.httpUrl);
      exposePages(browser, pages);
      const selecting = getPageForTargetId({ cdpUrl: cdp.httpUrl });
      await vi.waitFor(() => {
        expect(started).toEqual(['first', 'second']);
      });
      if (blockFirst) markPageRefBlocked(cdp.httpUrl, pages[0]);
      release();
      await expect(selecting).resolves.toBe(pages[blockFirst ? 1 : 0]);
      await expect(pageTargetId(pages[1])).resolves.toBe('second');
      await expect(getPageForTargetId({ cdpUrl: cdp.httpUrl, targetId: 'second' })).resolves.toBe(pages[1]);
      expect(started).toEqual(['first', 'second']);
    } finally {
      release();
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('bounds cold target metadata at two seconds and detaches a late session', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detach = vi.fn().mockResolvedValue(undefined);
    const send = vi.fn();
    const page = makePage('late').page;
    vi.spyOn(page, 'context').mockReturnValue({
      newCDPSession: async () => {
        await gate;
        return { send, detach };
      },
    } as unknown as BrowserContext);
    try {
      const read = pageTargetId(page);
      const rejected = expect(read).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(2000);
      await rejected;
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(detach).toHaveBeenCalledOnce();
      expect(send).not.toHaveBeenCalled();
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it.each([true, false])('does not guess identity from HTTP list URL/order (matching URL: %s)', async (sameUrl) => {
    const requests = vi.fn();
    const server = createServer((_req, res) => {
      requests();
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify([
          { id: 'wanted', type: 'page', url: sameUrl ? 'https://shared.test/' : 'https://different.test/' },
        ]),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const cdpUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const unidentifiable = makePage(null).page;
    const browser = { contexts: () => [{ pages: () => [unidentifiable] }] } as unknown as Browser;
    try {
      await expect(findPageByTargetId(browser, 'wanted', cdpUrl)).resolves.toBeNull();
      expect(requests).not.toHaveBeenCalled();
      const identified = makePage('wanted').page;
      exposePages(browser, [unidentifiable, identified]);
      await expect(findPageByTargetId(browser, 'wanted', cdpUrl)).resolves.toBe(identified);
      await expect(findPageByTargetId(browser, 'missing')).resolves.toBeNull();
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it.each(['target', 'page'] as const)(
    'prevents close and focus of a quarantined %s, with successful controls',
    async (blocked) => {
      const cdp = await startConnectionCdpServer();
      const fixture = makePage('T1');
      try {
        const { browser } = await connectBrowser(cdp.httpUrl);
        exposePages(browser, [fixture.page]);
        const opts = { cdpUrl: cdp.httpUrl, targetId: 'T1' };
        await focusPageByTargetIdViaPlaywright(opts);
        await closePageByTargetIdViaPlaywright(opts);
        expect(fixture.bringToFront).toHaveBeenCalledOnce();
        expect(fixture.close).toHaveBeenCalledOnce();
        await expect(closePageByTargetIdViaPlaywright({ ...opts, targetId: '' })).resolves.toBeUndefined();
        await expect(focusPageByTargetIdViaPlaywright({ ...opts, targetId: '' })).rejects.toBeInstanceOf(
          BrowserTabNotFoundError,
        );
        expect(fixture.bringToFront).toHaveBeenCalledOnce();
        expect(fixture.close).toHaveBeenCalledOnce();
        if (blocked === 'target') markTargetBlocked(cdp.httpUrl, 'T1');
        else markPageRefBlocked(cdp.httpUrl, fixture.page);
        await expect(focusPageByTargetIdViaPlaywright(opts)).rejects.toBeInstanceOf(BlockedBrowserTargetError);
        await expect(closePageByTargetIdViaPlaywright(opts)).rejects.toBeInstanceOf(BlockedBrowserTargetError);
        await expect(findPageByTargetId(browser, 'T1', cdp.httpUrl)).resolves.toBeNull();
        expect(fixture.bringToFront).toHaveBeenCalledOnce();
        expect(fixture.close).toHaveBeenCalledOnce();
        expect(cdp.connections).toBe(1);
      } finally {
        await disconnectBrowser();
        await cdp.close();
      }
    },
  );

  it.each(['close', 'focus'] as const)('recovers %s onto an exactly identified successor page', async (action) => {
    const cdp = await startConnectionCdpServer();
    const fixture = makePage('T1');
    try {
      const old = await connectBrowser(cdp.httpUrl);
      const originalConnect = transport.connectOverPinnedCdp;
      vi.spyOn(transport, 'connectOverPinnedCdp').mockImplementation(async (...args) => {
        const browser = await originalConnect(...args);
        exposePages(browser, [fixture.page]);
        return browser;
      });
      const opts = { cdpUrl: cdp.httpUrl, targetId: 'T1' };
      if (action === 'close') await closePageByTargetIdViaPlaywright(opts);
      else await focusPageByTargetIdViaPlaywright(opts);
      expect(action === 'close' ? fixture.close : fixture.bringToFront).toHaveBeenCalledOnce();
      expect(cdp.connections).toBe(2);
      expect((await connectBrowser(cdp.httpUrl)).browser).not.toBe(old.browser);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it.each(['close', 'focus'] as const)(
    'reconnects a stale cached adapter once for %s, preserving missing-tab behavior',
    async (action) => {
      const cdp = await startConnectionCdpServer();
      try {
        const old = await connectBrowser(cdp.httpUrl);
        const opts = { cdpUrl: cdp.httpUrl, targetId: 'missing' };
        if (action === 'close') await expect(closePageByTargetIdViaPlaywright(opts)).resolves.toBeUndefined();
        else await expect(focusPageByTargetIdViaPlaywright(opts)).rejects.toBeInstanceOf(BrowserTabNotFoundError);
        expect(cdp.connections).toBe(2);
        const successor = await connectBrowser(cdp.httpUrl);
        expect(successor.browser).not.toBe(old.browser);
        expect(successor.browser.isConnected()).toBe(true);
      } finally {
        await disconnectBrowser();
        await cdp.close();
      }
    },
  );
});
