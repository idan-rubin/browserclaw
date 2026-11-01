/* eslint-disable @typescript-eslint/unbound-method -- Page methods in this fixture are vi.fn mocks. */
import type * as Dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';

import type { Browser, Page, Request, Route } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as transport from '../cdp-transport.js';
import * as chrome from '../chrome-launcher.js';
import { BlockedBrowserTargetError, disconnectBrowser, getPageForTargetId, isBlockedPageRef } from '../connection.js';
import * as pageUtils from '../page-utils.js';

import { downloadViaPlaywright, waitForDownloadViaPlaywright } from './download.js';
import { evaluateViaPlaywright } from './evaluate.js';
import { pressKeyViaPlaywright } from './keyboard.js';
import { assertInteractionNavigationCompletedSafely, withPageNavigationRequestGuard } from './navigation.js';

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', async (original) => ({ ...(await original<typeof Dns>()), lookup: mocks.lookup }));

type Handler = (route: Route, request: Request) => Promise<void>;
const cdpUrl = 'ws://127.0.0.1:39921/devtools/browser/review';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(url = 'about:blank') {
  let handler: Handler | undefined;
  const native = vi.fn().mockResolvedValue(undefined);
  const frame = {};
  const context = {
    browser: () => browser,
    pages: () => [page],
    newCDPSession: () =>
      Promise.resolve({
        send: () => Promise.resolve({ targetInfo: { targetId: 'T1', type: 'page', url } }),
        detach: () => Promise.resolve(),
      }),
  };
  const page = Object.assign(new EventEmitter(), {
    url: () => url,
    context: () => context,
    isClosed: () => false,
    mainFrame: () => frame,
    route: vi.fn((_pattern: string, next: Handler) => {
      handler = next;
      return Promise.resolve();
    }),
    unroute: vi.fn(() => {
      handler = undefined;
      return Promise.resolve();
    }),
    keyboard: { press: native },
    evaluate: native,
  }) as unknown as Page;
  const browser = Object.assign(new EventEmitter(), {
    contexts: () => [context],
    isConnected: () => true,
    close: vi.fn().mockResolvedValue(undefined),
    newBrowserCDPSession: () =>
      Promise.resolve({
        send: () => Promise.resolve({ commandLine: '/test/chrome' }),
        detach: () => Promise.resolve(),
      }),
  }) as unknown as Browser;
  const dispatch = (requestUrl: string) => {
    const fallback = vi.fn().mockResolvedValue(undefined);
    const fulfill = vi.fn().mockResolvedValue(undefined);
    const route = { fallback, fulfill, abort: vi.fn().mockResolvedValue(undefined) } as unknown as Route;
    const request = { url: () => requestUrl, frame: () => ({}), isNavigationRequest: () => true } as unknown as Request;
    if (!handler) throw new Error('guard not installed');
    return { done: handler(route, request), fallback, fulfill };
  };
  return { page, browser, native, dispatch };
}

beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  vi.spyOn(pageUtils, 'observeBrowser').mockResolvedValue(undefined);
  vi.spyOn(pageUtils, 'guardHeadlessContext').mockResolvedValue(undefined);
  vi.spyOn(chrome, 'getChromeWebSocketEndpoint').mockResolvedValue({ url: cdpUrl });
});
afterEach(async () => {
  await disconnectBrowser();
  vi.restoreAllMocks();
});

describe('review: real selected-page policy cancellation', () => {
  const actions = {
    evaluate: (signal: AbortSignal) => evaluateViaPlaywright({ cdpUrl, targetId: 'T1', fn: '() => 42', signal }),
    key: (signal: AbortSignal) => pressKeyViaPlaywright({ cdpUrl, targetId: 'T1', key: 'Enter', signal }),
    download: (signal: AbortSignal) =>
      downloadViaPlaywright({ cdpUrl, targetId: 'T1', ref: 'e1', path: '/tmp/review-never-written', signal }),
    waiter: (signal: AbortSignal) => waitForDownloadViaPlaywright({ cdpUrl, targetId: 'T1', signal }),
  };
  it.each(Object.keys(actions) as (keyof typeof actions)[])(
    '%s cancels the first DNS check without dispatch',
    async (name) => {
      const f = fixture(`https://selection-${name}.review.example/`);
      vi.spyOn(transport, 'connectOverPinnedCdp').mockResolvedValue(f.browser);
      const dns = deferred<{ address: string; family: number }[]>();
      mocks.lookup.mockReturnValue(dns.promise);
      const controller = new AbortController();
      const reason = new Error('cancel selected-page DNS');
      const pending = actions[name](controller.signal);
      const settled = vi.fn();
      void pending.then(settled, settled);
      try {
        await vi.waitFor(() => {
          expect(mocks.lookup).toHaveBeenCalled();
        });
        controller.abort(reason);
        await vi.waitFor(
          () => {
            expect(settled).toHaveBeenCalledWith(reason);
          },
          { timeout: 150 },
        );
      } finally {
        dns.resolve([{ address: '93.184.216.34', family: 4 }]);
        await pending.catch(() => undefined);
      }
      expect(f.native).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])('retains selected-document validation after abort (private=%s)', async (privateAddress) => {
    const f = fixture(`https://selected-late-${String(privateAddress)}.review.example/`);
    vi.spyOn(transport, 'connectOverPinnedCdp').mockResolvedValue(f.browser);
    const dns = deferred<{ address: string; family: number }[]>();
    mocks.lookup.mockReturnValue(dns.promise);
    const controller = new AbortController();
    const reason = new Error('cancel selected document');
    const pending = getPageForTargetId({ cdpUrl, targetId: 'T1', signal: controller.signal });
    const settled = vi.fn();
    void pending.then(settled, settled);
    try {
      await vi.waitFor(() => {
        expect(mocks.lookup).toHaveBeenCalled();
      });
      controller.abort(reason);
      await vi.waitFor(
        () => {
          expect(settled).toHaveBeenCalledWith(reason);
        },
        { timeout: 150 },
      );
    } finally {
      dns.resolve([{ address: privateAddress ? '10.0.0.5' : '93.184.216.34', family: 4 }]);
      await pending.catch(() => undefined);
    }
    if (privateAddress) {
      await vi.waitFor(() => {
        expect(isBlockedPageRef(cdpUrl, f.page)).toBe(true);
      });
      await expect(getPageForTargetId({ cdpUrl, targetId: 'T1' })).rejects.toBeInstanceOf(BlockedBrowserTargetError);
    } else {
      await expect(getPageForTargetId({ cdpUrl, targetId: 'T1' })).resolves.toBe(f.page);
      expect(isBlockedPageRef(cdpUrl, f.page)).toBe(false);
    }
  });
});

describe('review: background preflight security ownership', () => {
  it.each([false, true])('retains a late current-document denial after abort (private=%s)', async (privateAddress) => {
    const f = fixture(`https://late-baseline-${String(privateAddress)}.review.example/`);
    const dns = deferred<{ address: string; family: number }[]>();
    mocks.lookup.mockReturnValue(dns.promise);
    const controller = new AbortController();
    const reason = new Error('cancel pending baseline');
    const pending = assertInteractionNavigationCompletedSafely({
      cdpUrl,
      page: f.page,
      previousUrl: f.page.url(),
      signal: controller.signal,
      action: f.native,
    });
    const settled = vi.fn();
    void pending.then(settled, settled);
    try {
      await vi.waitFor(() => {
        expect(mocks.lookup).toHaveBeenCalled();
      });
      controller.abort(reason);
      await vi.waitFor(
        () => {
          expect(settled).toHaveBeenCalledWith(reason);
        },
        { timeout: 150 },
      );
    } finally {
      dns.resolve([{ address: privateAddress ? '10.0.0.5' : '93.184.216.34', family: 4 }]);
      await pending.catch(() => undefined);
    }
    await vi.waitFor(() => {
      expect(isBlockedPageRef(cdpUrl, f.page)).toBe(privateAddress);
    });
    expect(f.native).not.toHaveBeenCalled();
  });

  it.each([false, true])('releases a pre-input abort without awaiting unrelated route DNS (deny=%s)', async (deny) => {
    const f = fixture();
    const dns = deferred<{ address: string; family: number }[]>();
    mocks.lookup.mockReturnValue(dns.promise);
    const controller = new AbortController();
    const reason = new Error('cancel before input');
    let route: ReturnType<typeof f.dispatch> | undefined;
    vi.mocked(f.page.route).mockImplementation((_pattern, callback) => {
      const fallback = vi.fn().mockResolvedValue(undefined);
      const fulfill = vi.fn().mockResolvedValue(undefined);
      const request = {
        url: () => `https://route-${String(deny)}.review.example/`,
        frame: () => ({}),
        isNavigationRequest: () => true,
      } as unknown as Request;
      route = {
        done: (callback as Handler)(
          { fallback, fulfill, abort: vi.fn().mockResolvedValue(undefined) } as unknown as Route,
          request,
        ),
        fallback,
        fulfill,
      };
      controller.abort(reason);
      return Promise.resolve({ dispose: () => Promise.resolve(), [Symbol.asyncDispose]: () => Promise.resolve() });
    });
    const pending = withPageNavigationRequestGuard({
      cdpUrl,
      page: f.page,
      signal: controller.signal,
      action: f.native,
    });
    const settled = vi.fn();
    void pending.then(settled, settled);
    try {
      await vi.waitFor(() => {
        expect(mocks.lookup).toHaveBeenCalled();
      });
      await vi.waitFor(
        () => {
          expect(settled).toHaveBeenCalledWith(reason);
        },
        { timeout: 150 },
      );
      expect(f.native).not.toHaveBeenCalled();
    } finally {
      dns.resolve([{ address: deny ? '10.0.0.5' : '93.184.216.34', family: 4 }]);
      await pending.catch(() => undefined);
      await route?.done;
    }
    expect(route?.fallback).toHaveBeenCalledTimes(deny ? 0 : 1);
    expect(route?.fulfill).toHaveBeenCalledTimes(deny ? 1 : 0);
  });
});
