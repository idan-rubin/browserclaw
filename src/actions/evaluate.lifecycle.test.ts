import type { Browser, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startConnectionCdpServer } from '../connection-cdp.test-support.js';
import * as connection from '../connection.js';

import { evaluateViaPlaywright } from './evaluate.js';

vi.mock('./navigation.js', () => ({
  assertInteractionNavigationCompletedSafely: async (opts: {
    action: () => Promise<unknown>;
    abortPromise?: Promise<never>;
  }) => await Promise.race([opts.action(), ...(opts.abortPromise ? [opts.abortPromise] : [])]),
  assertPageNavigationCompletedSafely: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function evaluationPage(browser: Browser) {
  const started = deferred<undefined>();
  const completed = deferred<unknown>();
  const evaluate = vi.fn<(_fn: unknown, args: unknown) => Promise<unknown>>(() => {
    started.resolve(undefined);
    return completed.promise;
  });
  const page = {
    context: () => ({ browser: () => browser }),
    url: () => 'https://example.com/',
    on: vi.fn(),
    evaluate,
  } as unknown as Page;
  vi.spyOn(connection, 'getPageForTargetId').mockResolvedValue(page);
  return { page, started, completed, evaluate };
}

describe('evaluate abort connection ownership', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await connection.disconnectBrowser();
  });

  it.each([true, false])('does not affect a successor after an old evaluate abort (targeted=%s)', async (targeted) => {
    const cdp = await startConnectionCdpServer();
    const old = await connection.connectBrowser(cdp.httpUrl);
    const evaluation = evaluationPage(old.browser);
    const terminate = vi.spyOn(connection, 'tryTerminateExecutionForPage');
    const disconnect = vi.spyOn(connection, 'forceDisconnectPlaywrightConnection');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = new AbortController();
    const result = evaluateViaPlaywright({
      cdpUrl: cdp.httpUrl,
      targetId: targeted ? 'T1' : undefined,
      fn: '() => new Promise(() => {})',
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow('cancel evaluation');
    try {
      await evaluation.started.promise;
      await connection.closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl });
      const successor = await connection.connectBrowser(cdp.httpUrl);
      controller.abort(new Error('cancel evaluation'));
      await rejected;
      if (targeted) await terminate.mock.results[0]?.value;
      else await disconnect.mock.results[0]?.value;
      expect((await connection.connectBrowser(cdp.httpUrl)).browser).toBe(successor.browser);
      expect(successor.browser.isConnected()).toBe(true);
      expect(cdp.frames.some((frame) => frame.method === 'Runtime.terminateExecution')).toBe(false);
      expect(cdp.connections).toBe(2);
    } finally {
      controller.abort(new Error('cancel evaluation'));
      evaluation.completed.resolve(undefined);
      await connection.disconnectBrowser();
      await cdp.close();
    }
  });

  it.each([true, false])('control: abort cleans up the current evaluation (targeted=%s)', async (targeted) => {
    const cdp = await startConnectionCdpServer({ targetSocket: 'browser' });
    const current = await connection.connectBrowser(cdp.httpUrl);
    const evaluation = evaluationPage(current.browser);
    const terminate = vi.spyOn(connection, 'tryTerminateExecutionForPage');
    const disconnect = vi.spyOn(connection, 'forceDisconnectPlaywrightConnection');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const controller = new AbortController();
    const result = evaluateViaPlaywright({
      cdpUrl: cdp.httpUrl,
      targetId: targeted ? 'T1' : undefined,
      fn: '() => new Promise(() => {})',
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow('cancel evaluation');
    try {
      await evaluation.started.promise;
      controller.abort(new Error('cancel evaluation'));
      await rejected;
      if (targeted) {
        await terminate.mock.results[0]?.value;
        expect(cdp.frames.filter((frame) => frame.method === 'Runtime.terminateExecution')).toHaveLength(1);
        expect(cdp.frames.some((frame) => frame.method === 'Target.detachFromTarget')).toBe(true);
        expect((await connection.connectBrowser(cdp.httpUrl)).browser).toBe(current.browser);
        expect(current.browser.isConnected()).toBe(true);
      } else {
        await disconnect.mock.results[0]?.value;
        await vi.waitFor(() => {
          expect(current.browser.isConnected()).toBe(false);
        });
        expect(connection.hasCachedPlaywrightBrowserConnection(cdp.httpUrl)).toBe(false);
      }
    } finally {
      controller.abort(new Error('cancel evaluation'));
      evaluation.completed.resolve(undefined);
      await connection.disconnectBrowser();
      await cdp.close();
    }
  });

  it.each(['discovery', 'attach'] as const)('rechecks the exact owner after asynchronous %s', async (stage) => {
    const reached = deferred<undefined>();
    const gate = deferred<undefined>();
    const onReached = () => {
      reached.resolve(undefined);
    };
    const cdp = await startConnectionCdpServer(
      stage === 'discovery'
        ? { listGate: gate.promise, onList: onReached }
        : { targetSocket: 'browser', attachGate: gate.promise, onAttach: onReached },
    );
    const old = await connection.connectBrowser(cdp.httpUrl);
    const evaluation = evaluationPage(old.browser);
    const terminate = vi.spyOn(connection, 'tryTerminateExecutionForPage');
    const controller = new AbortController();
    const result = evaluateViaPlaywright({
      cdpUrl: cdp.httpUrl,
      targetId: 'T1',
      fn: '() => new Promise(() => {})',
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow('cancel evaluation');
    try {
      await evaluation.started.promise;
      controller.abort(new Error('cancel evaluation'));
      await rejected;
      await reached.promise;
      await connection.closePlaywrightBrowserConnection({ cdpUrl: cdp.httpUrl });
      const successor = await connection.connectBrowser(cdp.httpUrl);
      gate.resolve(undefined);
      await terminate.mock.results[0]?.value;
      expect((await connection.connectBrowser(cdp.httpUrl)).browser).toBe(successor.browser);
      expect(successor.browser.isConnected()).toBe(true);
      expect(cdp.frames.some((frame) => frame.method === 'Runtime.terminateExecution')).toBe(false);
      if (stage === 'attach') expect(cdp.frames.some((frame) => frame.method === 'Target.detachFromTarget')).toBe(true);
    } finally {
      controller.abort(new Error('cancel evaluation'));
      gate.resolve(undefined);
      evaluation.completed.resolve(undefined);
      await terminate.mock.results[0]?.value;
      await connection.disconnectBrowser();
      await cdp.close();
    }
  });

  it.each([
    [500, 500],
    [undefined, 19000],
  ])('caps the browser-side payload at the caller budget (%s)', async (timeoutMs, expected) => {
    const cdp = await startConnectionCdpServer();
    const current = await connection.connectBrowser(cdp.httpUrl);
    const evaluation = evaluationPage(current.browser);
    try {
      const result = evaluateViaPlaywright({ cdpUrl: cdp.httpUrl, fn: '() => 1', timeoutMs });
      await evaluation.started.promise;
      expect(evaluation.evaluate.mock.calls[0]?.[1]).toMatchObject({ timeoutMs: expected });
      evaluation.completed.resolve(1);
      await expect(result).resolves.toBe(1);
    } finally {
      evaluation.completed.resolve(undefined);
      await connection.disconnectBrowser();
      await cdp.close();
    }
  });
});
