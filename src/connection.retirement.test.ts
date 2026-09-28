import type { Browser, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as transport from './cdp-transport.js';
import { startConnectionCdpServer } from './connection-cdp.test-support.js';
import {
  closePlaywrightBrowserConnection,
  connectBrowser,
  disconnectBrowser,
  forceDisconnectPlaywrightConnection,
  getPageForTargetId,
  hasCachedPlaywrightBrowserConnection,
  isBlockedTarget,
  markTargetBlocked,
} from './connection.js';
import * as pageUtils from './page-utils.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function originatingPage(browser: Browser): Page {
  return { context: () => ({ browser: () => browser }) } as unknown as Page;
}

describe('exact Playwright connection retirement', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectBrowser();
  });

  it.each(['first', 'second', 'both'].flatMap((cancel) => ['dial', 'observation'].map((stage) => ({ cancel, stage }))))(
    'isolates cancellation of shared connection waiters: $cancel during $stage',
    async ({ cancel, stage }) => {
      const cdp = await startConnectionCdpServer();
      const gate = deferred();
      const entered = deferred();
      const originalConnect = transport.connectOverPinnedCdp;
      let browser: Browser | undefined;
      const connect = vi.spyOn(transport, 'connectOverPinnedCdp').mockImplementation(async (...args) => {
        if (stage === 'dial') {
          entered.resolve();
          await gate.promise;
        }
        browser = await originalConnect(...args);
        return browser;
      });
      const originalObserve = pageUtils.observeBrowser;
      vi.spyOn(pageUtils, 'observeBrowser').mockImplementation(async (...args) => {
        if (stage === 'observation') {
          entered.resolve();
          await gate.promise;
        }
        await originalObserve(...args);
      });
      const first = new AbortController();
      const second = new AbortController();
      const joined = vi.spyOn(second.signal, 'addEventListener');
      const reason = new Error('cancel this waiter');
      const results = [vi.fn(), vi.fn()];
      const a = connectBrowser(cdp.httpUrl, undefined, undefined, undefined, first.signal);
      void a.then(results[0], results[0]);
      await entered.promise;
      const b = connectBrowser(cdp.httpUrl, undefined, undefined, undefined, second.signal);
      void b.then(results[1], results[1]);
      try {
        await vi.waitFor(() => {
          expect(joined).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
        });
        if (cancel !== 'second') first.abort(reason);
        if (cancel !== 'first') second.abort(reason);
        await vi.waitFor(
          () => {
            if (cancel !== 'second') expect(results[0]).toHaveBeenCalledWith(reason);
            if (cancel !== 'first') expect(results[1]).toHaveBeenCalledWith(reason);
          },
          { timeout: 100 },
        );
        gate.resolve();
        if (cancel === 'both') {
          await vi.waitFor(() => {
            expect(browser?.isConnected()).toBe(false);
          });
          expect(hasCachedPlaywrightBrowserConnection(cdp.httpUrl)).toBe(false);
        } else {
          const survivor = await (cancel === 'first' ? b : a);
          expect(survivor.browser.isConnected()).toBe(true);
          expect((await connectBrowser(cdp.httpUrl)).browser).toBe(survivor.browser);
        }
        expect(connect).toHaveBeenCalledOnce();
      } finally {
        gate.resolve();
        await Promise.allSettled([a, b]);
        await disconnectBrowser();
        await cdp.close();
      }
    },
  );

  it('bounds a hung close and allows a successor while the old adapter is still closing', async () => {
    const cdp = await startConnectionCdpServer();
    const gate = deferred();
    const old = await connectBrowser(cdp.httpUrl);
    const originalClose = old.browser.close.bind(old.browser);
    const close = vi.spyOn(old.browser, 'close').mockImplementation(async () => {
      await gate.promise;
      await originalClose();
    });
    try {
      const started = Date.now();
      await expect(closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl })).rejects.toThrow('disconnect timed out');
      expect(Date.now() - started).toBeLessThan(3000);
      expect(hasCachedPlaywrightBrowserConnection(cdp.httpUrl)).toBe(false);
      const successor = await connectBrowser(cdp.httpUrl);
      expect(successor.browser).not.toBe(old.browser);
      expect(successor.browser.isConnected()).toBe(true);
      gate.resolve();
      await close.mock.results[0]?.value;
      expect((await connectBrowser(cdp.httpUrl)).browser).toBe(successor.browser);
      expect(successor.browser.isConnected()).toBe(true);
    } finally {
      gate.resolve();
      await originalClose();
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('retains rejected close handles and retries them on the next scoped close', async () => {
    const cdp = await startConnectionCdpServer();
    const connected = await connectBrowser(cdp.httpUrl);
    const originalClose = connected.browser.close.bind(connected.browser);
    const close = vi.spyOn(connected.browser, 'close').mockRejectedValueOnce(new Error('adapter close failed'));
    try {
      await expect(closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl })).rejects.toThrow('adapter close failed');
      expect(connected.browser.isConnected()).toBe(true);
      close.mockImplementation(originalClose);
      await closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl });
      expect(close).toHaveBeenCalledTimes(2);
      expect(connected.browser.isConnected()).toBe(false);
    } finally {
      close.mockRestore();
      await originalClose();
      await cdp.close();
    }
  });

  it('control: scoped close leaves other URLs connected and honors preserveSsrfState', async () => {
    const a = await startConnectionCdpServer();
    const b = await startConnectionCdpServer();
    try {
      const first = await connectBrowser(a.httpUrl);
      const second = await connectBrowser(b.httpUrl);
      markTargetBlocked(a.httpUrl, 'blocked');
      await closePlaywrightBrowserConnection({ cdpUrl: a.httpUrl, preserveSsrfState: true });
      expect(first.browser.isConnected()).toBe(false);
      expect(second.browser.isConnected()).toBe(true);
      expect(isBlockedTarget(a.httpUrl, 'blocked')).toBe(true);
      await closePlaywrightBrowserConnection({ cdpUrl: a.httpUrl });
      expect(isBlockedTarget(a.httpUrl, 'blocked')).toBe(false);
    } finally {
      await disconnectBrowser();
      await a.close();
      await b.close();
    }
  });

  it('does not disconnect a successor for an operation originating on an old page', async () => {
    const cdp = await startConnectionCdpServer();
    try {
      const old = await connectBrowser(cdp.httpUrl);
      await closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl });
      const successor = await connectBrowser(cdp.httpUrl);
      await forceDisconnectPlaywrightConnection({
        cdpUrl: cdp.httpUrl,
        page: originatingPage(old.browser),
        targetId: 'T1',
      });
      expect((await connectBrowser(cdp.httpUrl)).browser).toBe(successor.browser);
      expect(cdp.frames.some((frame) => frame.method === 'Runtime.terminateExecution')).toBe(false);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('rechecks ownership after asynchronous target discovery before terminating execution', async () => {
    const listed = deferred();
    const gate = deferred();
    const cdp = await startConnectionCdpServer({ listGate: gate.promise, onList: listed.resolve });
    try {
      const old = await connectBrowser(cdp.httpUrl);
      const cleanup = forceDisconnectPlaywrightConnection({
        cdpUrl: cdp.httpUrl,
        page: originatingPage(old.browser),
        targetId: 'T1',
      });
      await listed.promise;
      await closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl });
      const successor = await connectBrowser(cdp.httpUrl);
      gate.resolve();
      await cleanup;
      expect(successor.browser.isConnected()).toBe(true);
      expect((await connectBrowser(cdp.httpUrl)).browser).toBe(successor.browser);
      expect(cdp.frames.some((frame) => frame.method === 'Runtime.terminateExecution')).toBe(false);
    } finally {
      gate.resolve();
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('reconnects once for an explicit target on a stale cached page list, without looping', async () => {
    const cdp = await startConnectionCdpServer();
    try {
      await connectBrowser(cdp.httpUrl);
      await expect(getPageForTargetId({ cdpUrl: cdp.httpUrl, targetId: 'missing' })).rejects.toThrow(
        'No pages available',
      );
      expect(cdp.connections).toBe(2);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });
});
