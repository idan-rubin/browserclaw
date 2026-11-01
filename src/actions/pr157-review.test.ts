import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as connection from '../connection.js';
import * as Security from '../security.js';

import { downloadViaPlaywright, waitForDownloadViaPlaywright } from './download.js';
import { evaluateViaPlaywright } from './evaluate.js';
import { clickViaPlaywright } from './interaction.js';
import { withPageNavigationRequestGuard } from './navigation.js';

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let url = 'about:blank';
  const frame = {};
  const evaluate = vi.fn().mockResolvedValue(42);
  const click = vi.fn().mockResolvedValue(undefined);
  const page = Object.assign(new EventEmitter(), {
    url: () => url,
    mainFrame: () => frame,
    isClosed: () => false,
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
    evaluate,
  });
  vi.spyOn(connection, 'getPageForTargetId').mockResolvedValue(page as unknown as Page);
  vi.spyOn(connection, 'getRestoredPageForTarget').mockResolvedValue(page as unknown as Page);
  vi.spyOn(connection, 'refLocator').mockReturnValue({ click, evaluate } as unknown as ReturnType<
    typeof connection.refLocator
  >);
  return {
    page,
    evaluate,
    click,
    setUrl: (value: string) => {
      url = value;
    },
  };
}

describe('PR157 evaluator cancellation ownership', () => {
  it.each([
    { targetId: undefined, ssrfPolicy: undefined },
    { targetId: 'owned', ssrfPolicy: undefined },
    { targetId: undefined, ssrfPolicy: {} },
    { targetId: 'owned', ssrfPolicy: {} },
  ])(
    'a pre-aborted evaluator performs no lookup or cancellation control ($targetId, policy=$ssrfPolicy)',
    async (opts) => {
      const f = fixture();
      const terminate = vi.spyOn(connection, 'tryTerminateExecutionForPage').mockResolvedValue(undefined);
      const disconnect = vi.spyOn(connection, 'forceDisconnectPlaywrightConnection').mockResolvedValue(undefined);
      const controller = new AbortController();
      const reason = { source: 'pre-aborted evaluator' };
      controller.abort(reason);
      await expect(
        evaluateViaPlaywright({ ...opts, cdpUrl: 'http://localhost:9222', fn: '() => 42', signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(connection.getPageForTargetId).not.toHaveBeenCalled();
      expect(f.evaluate).not.toHaveBeenCalled();
      expect(terminate).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'owned'])(
    'does not terminate a settled evaluation during guard grace (targetId=%s)',
    async (targetId) => {
      const f = fixture();
      const entered = deferred<undefined>();
      const native = deferred<unknown>();
      f.evaluate.mockImplementation(() => {
        entered.resolve(undefined);
        return native.promise;
      });
      const terminate = vi.spyOn(connection, 'tryTerminateExecutionForPage').mockResolvedValue(undefined);
      const disconnect = vi.spyOn(connection, 'forceDisconnectPlaywrightConnection').mockResolvedValue(undefined);
      const controller = new AbortController();
      const reason = new Error('cancel during guard grace');
      const pending = evaluateViaPlaywright({
        cdpUrl: 'http://localhost:9222',
        targetId,
        fn: '() => 42',
        signal: controller.signal,
      });
      const rejected = expect(pending).rejects.toBe(reason);
      await entered.promise;
      native.resolve(42);
      await native.promise;
      await Promise.resolve();
      // Native completion precedes the guard's 250ms delayed-navigation window.
      expect(f.page.unroute).not.toHaveBeenCalled();
      controller.abort(reason);
      await rejected;
      expect(terminate).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(f.page.unroute).toHaveBeenCalledOnce();
      });
    },
  );

  it.each([undefined, 'owned'])('does not terminate execution before dispatch (targetId=%s)', async (targetId) => {
    const f = fixture();
    const entered = deferred<undefined>();
    const installed = deferred<undefined>();
    f.page.route.mockImplementation(() => {
      entered.resolve(undefined);
      return installed.promise;
    });
    const terminate = vi.spyOn(connection, 'tryTerminateExecutionForPage').mockResolvedValue(undefined);
    const disconnect = vi.spyOn(connection, 'forceDisconnectPlaywrightConnection').mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = new AbortController();
    const reason = new Error('cancel before script dispatch');
    const pending = evaluateViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      targetId,
      fn: '() => 42',
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      await entered.promise;
      controller.abort(reason);
      installed.resolve(undefined);
      await rejected;
      expect(f.evaluate).not.toHaveBeenCalled();
      expect(terminate).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      installed.resolve(undefined);
      await pending.catch(() => undefined);
    }
  });

  it('control: terminates the owned evaluation after native dispatch', async () => {
    const f = fixture();
    const entered = deferred<undefined>();
    const native = deferred<undefined>();
    f.evaluate.mockImplementation(() => {
      entered.resolve(undefined);
      return native.promise;
    });
    const terminate = vi.spyOn(connection, 'tryTerminateExecutionForPage').mockResolvedValue(undefined);
    const controller = new AbortController();
    const reason = new Error('cancel dispatched script');
    const pending = evaluateViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      targetId: 'owned',
      fn: '() => 42',
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      await entered.promise;
      controller.abort(reason);
      await rejected;
      expect(terminate).toHaveBeenCalledOnce();
    } finally {
      native.resolve(undefined);
      await pending.catch(() => undefined);
    }
  });
});

describe('PR157 download admission', () => {
  it.each(['wait', 'click'] as const)('a canceled %s preflight does not supersede an admitted waiter', async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'bc-review-download-'));
    const f = fixture();
    const firstPath = join(directory, 'first.bin');
    const first = waitForDownloadViaPlaywright({ cdpUrl: 'http://localhost:9222', path: firstPath, timeoutMs: 3000 });
    const firstOutcome = first.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    const checked = deferred<undefined>();
    const policy = deferred<undefined>();
    let second: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => {
        expect(f.page.listenerCount('download')).toBe(1);
      });
      const state = connection.ensurePageState(f.page as unknown as Page);
      const admittedArm = state.armIdDownload;
      f.setUrl('https://stalled-download-review.example/');
      vi.spyOn(Security, 'assertBrowserNavigationResultAllowed').mockImplementation((opts) => {
        if (!opts.url.includes('stalled-download-review')) return Promise.resolve();
        checked.resolve(undefined);
        return new Promise<void>((resolve, reject) => {
          void policy.promise.then(resolve);
          opts.signal?.addEventListener(
            'abort',
            () => {
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              reject(opts.signal?.reason);
            },
            { once: true },
          );
        });
      });
      const controller = new AbortController();
      const reason = new Error('cancel unadmitted download');
      second =
        kind === 'wait'
          ? waitForDownloadViaPlaywright({
              cdpUrl: 'http://localhost:9222',
              path: join(directory, 'second.bin'),
              signal: controller.signal,
              timeoutMs: 3000,
            })
          : downloadViaPlaywright({
              cdpUrl: 'http://localhost:9222',
              ref: 'e1',
              path: join(directory, 'second.bin'),
              signal: controller.signal,
              timeoutMs: 3000,
            });
      const secondOutcome = second.catch((error: unknown) => error);
      await checked.promise;
      controller.abort(reason);
      await expect(secondOutcome).resolves.toBe(reason);
      policy.resolve(undefined);
      f.page.emit('download', {
        url: () => 'https://93.184.216.34/file',
        suggestedFilename: () => 'first.bin',
        saveAs: (path: string) => writeFile(path, 'first payload'),
      });
      const outcome = await firstOutcome;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ path: firstPath });
      expect(state.armIdDownload).toBe(admittedArm);
      expect(f.click).not.toHaveBeenCalled();
    } finally {
      policy.resolve(undefined);
      f.page.emit('download', {
        url: () => 'https://93.184.216.34/file',
        suggestedFilename: () => 'first.bin',
        saveAs: (path: string) => writeFile(path, 'first payload'),
      });
      await firstOutcome;
      await second?.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('PR157 cancellation reason identity', () => {
  it.each([
    { kind: 'wait', reason: 'caller download cancel' },
    { kind: 'click', reason: 'caller download cancel' },
    { kind: 'wait', reason: new Error('Timeout 100ms exceeded') },
    { kind: 'click', reason: new Error('Timeout 100ms exceeded') },
  ])('preserves the $kind download preflight reason ($reason)', async ({ kind, reason }) => {
    const directory = await mkdtemp(join(tmpdir(), 'bc-review-download-reason-'));
    const f = fixture();
    const entered = deferred<undefined>();
    const policy = deferred<undefined>();
    vi.spyOn(Security, 'assertBrowserNavigationResultAllowed').mockImplementation(() => {
      entered.resolve(undefined);
      return policy.promise;
    });
    const controller = new AbortController();
    const common = {
      cdpUrl: 'http://localhost:9222',
      path: join(directory, 'payload.bin'),
      signal: controller.signal,
      timeoutMs: 3000,
    };
    const pending =
      kind === 'wait' ? waitForDownloadViaPlaywright(common) : downloadViaPlaywright({ ...common, ref: 'e1' });
    const outcome = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort(reason);
      await expect(outcome).resolves.toBe(reason);
      expect(f.click).not.toHaveBeenCalled();
      expect(f.page.listenerCount('download')).toBe(0);
    } finally {
      policy.resolve(undefined);
      await outcome;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves a Timeout-shaped caller reason through the click error adapter', async () => {
    const f = fixture();
    const entered = deferred<undefined>();
    const policy = deferred<undefined>();
    vi.spyOn(Security, 'assertBrowserNavigationResultAllowed').mockImplementation((opts) => {
      entered.resolve(undefined);
      return new Promise<void>((resolve, reject) => {
        void policy.promise.then(resolve);
        opts.signal?.addEventListener(
          'abort',
          () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(opts.signal?.reason);
          },
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const reason = new Error('Timeout 100ms exceeded');
    const pending = clickViaPlaywright({ cdpUrl: 'http://localhost:9222', ref: 'e1', signal: controller.signal });
    const outcome = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort(reason);
      await expect(outcome).resolves.toBe(reason);
      expect(f.click).not.toHaveBeenCalled();
    } finally {
      policy.resolve(undefined);
      await outcome;
    }
  });

  it.each(['user-cancel', { source: 'caller' }])('preserves a non-Error reason through preflight', async (reason) => {
    const f = fixture();
    const entered = deferred<undefined>();
    const policy = deferred<undefined>();
    vi.spyOn(Security, 'assertBrowserNavigationResultAllowed').mockImplementation((opts) => {
      entered.resolve(undefined);
      return new Promise<void>((resolve, reject) => {
        void policy.promise.then(resolve);
        opts.signal?.addEventListener(
          'abort',
          () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(opts.signal?.reason);
          },
          { once: true },
        );
      });
    });
    const controller = new AbortController();
    const action = vi.fn().mockResolvedValue(undefined);
    const pending = withPageNavigationRequestGuard({
      cdpUrl: 'http://localhost:9222',
      page: f.page as unknown as Page,
      signal: controller.signal,
      action,
    });
    const outcome = pending.catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort(reason);
      await expect(outcome).resolves.toBe(reason);
      expect(action).not.toHaveBeenCalled();
    } finally {
      policy.resolve(undefined);
      await outcome;
    }
  });
});
