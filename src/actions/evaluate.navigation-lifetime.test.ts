import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as connection from '../connection.js';

import { evaluateViaPlaywright } from './evaluate.js';
import { createFakeNavigationFence } from './navigation-fence.test-support.js';

afterEach(() => vi.restoreAllMocks());

describe('evaluate navigation guard lifetime', () => {
  it.each([
    { ref: undefined, abort: true },
    { ref: 'e1', abort: true },
    { ref: undefined, abort: false },
    { ref: 'e1', abort: false },
  ])('checks cancellation after guard setup (ref=$ref, abort=$abort)', async ({ ref, abort }) => {
    let entered!: () => void;
    const installing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const installed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const evaluate = vi.fn().mockResolvedValue(42);
    const frame = {};
    const fence = createFakeNavigationFence({ url: () => 'about:blank' });
    fence.newCDPSession.mockImplementation(() => {
      entered();
      return installed.then(() => fence.session);
    });
    const page = Object.assign(new EventEmitter(), {
      url: () => 'about:blank',
      mainFrame: () => frame,
      isClosed: () => false,
      evaluate,
      context: () => ({ newCDPSession: fence.newCDPSession }),
    }) as unknown as Page;
    vi.spyOn(connection, 'getPageForTargetId').mockResolvedValue(page);
    vi.spyOn(connection, 'refLocator').mockReturnValue({ evaluate } as unknown as ReturnType<
      typeof connection.refLocator
    >);
    vi.spyOn(connection, 'tryTerminateExecutionForPage').mockResolvedValue(undefined);
    const controller = new AbortController();
    const reason = new Error('cancel before dispatch');
    const result = evaluateViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      targetId: 'owned',
      fn: '() => 42',
      ref,
      signal: controller.signal,
    });
    const outcome = abort ? expect(result).rejects.toBe(reason) : expect(result).resolves.toBe(42);
    try {
      await installing;
      expect(evaluate).not.toHaveBeenCalled();
      if (abort) {
        controller.abort(reason);
        await outcome;
      }
      release();
      await outcome;
      await vi.waitFor(() => {
        expect(fence.releases()).toBe(1);
      });
      expect(evaluate).toHaveBeenCalledTimes(abort ? 0 : 1);
    } finally {
      release();
    }
  });

  it.each([undefined, 'e1'])('retains native request coverage after failed cancellation (ref=%s)', async (ref) => {
    let enter!: () => void;
    const started = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let settle!: () => void;
    const native = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const evaluate = vi.fn(() => {
      enter();
      return native;
    });
    const frame = {};
    const fence = createFakeNavigationFence({ url: () => 'about:blank' });
    const page = Object.assign(new EventEmitter(), {
      url: () => 'about:blank',
      mainFrame: () => frame,
      isClosed: () => false,
      evaluate,
      context: () => ({ newCDPSession: fence.newCDPSession }),
    }) as unknown as Page;
    vi.spyOn(connection, 'getPageForTargetId').mockResolvedValue(page);
    vi.spyOn(connection, 'refLocator').mockReturnValue({ evaluate } as unknown as ReturnType<
      typeof connection.refLocator
    >);
    const terminate = vi
      .spyOn(connection, 'tryTerminateExecutionForPage')
      .mockRejectedValue(new Error('CDP unavailable'));
    const controller = new AbortController();
    const reason = new Error('cancel evaluation');
    const result = evaluateViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      targetId: 'owned',
      fn: '() => 1',
      ref,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toBe(reason);
    const dispatch = () => fence.pauseDocument('http://127.0.0.1/private');
    try {
      await started;
      controller.abort(reason);
      await rejected;
      expect(terminate).toHaveBeenCalledWith(expect.objectContaining({ page, targetId: 'owned' }));
      // The former inner race removed the guard after its 250ms grace.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(fence.releases()).toBe(0);
      expect(await dispatch()).toEqual({ continued: false, errorReason: 'Aborted' });
      settle();
      await vi.waitFor(() => {
        expect(fence.releases()).toBe(1);
      });
      // Control: once released, the tab's standing policy answers instead of the evaluation.
      expect(await dispatch()).toEqual({ continued: false, errorReason: 'BlockedByClient' });
    } finally {
      settle();
    }
  });
});
