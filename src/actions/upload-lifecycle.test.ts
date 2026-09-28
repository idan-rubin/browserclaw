import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';
import type * as Security from '../security.js';

const mocks = vi.hoisted(() => ({ page: vi.fn(), validate: vi.fn(), state: vi.fn() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: mocks.page,
  ensurePageState: mocks.state,
  normalizeTimeoutMs: (value: number | undefined) => value ?? 1000,
}));
vi.mock('../security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Security>()),
  resolveStrictExistingPathsWithinRoot: mocks.validate,
}));
vi.mock('./navigation.js', () => ({
  assertInteractionNavigationCompletedSafely: (opts: { action: () => Promise<void> }) => opts.action(),
}));

import { armFileUploadViaPlaywright } from './interaction.js';
import { armPageUpload } from './upload-lifecycle.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const emitter = new EventEmitter();
  const choosers: ReturnType<typeof deferred<unknown>>[] = [];
  const page = Object.assign(emitter, {
    url: () => 'about:blank',
    isClosed: () => false,
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    waitForEvent: vi.fn((_event: string, opts: { signal: AbortSignal }) => {
      const chooser = deferred<unknown>();
      const onAbort = () => {
        chooser.reject(opts.signal.reason);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      void chooser.promise
        .finally(() => {
          opts.signal.removeEventListener('abort', onAbort);
        })
        .catch(() => undefined);
      choosers.push(chooser);
      return chooser.promise;
    }),
  });
  mocks.page.mockResolvedValue(page);
  mocks.state.mockReturnValue({ armIdUpload: 0, nextArmIdUpload: 0 });
  return { page, choosers };
}

const options = { cdpUrl: 'http://localhost:9222', paths: ['/validated/file.txt'], timeoutMs: 1000 };

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.validate.mockReset().mockResolvedValue({ ok: true, paths: options.paths });
  mocks.page.mockReset();
  mocks.state.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('armed upload lifetime', () => {
  it('is armed before returning and waits for actual setFiles + BC event dispatch', async () => {
    const { page, choosers } = fixture();
    const pending = deferred<undefined>();
    const evaluate = vi.fn().mockResolvedValue(undefined);
    const setFiles = vi.fn().mockReturnValue(pending.promise);
    const { done } = await armFileUploadViaPlaywright(options);
    expect(page.waitForEvent).toHaveBeenCalledTimes(1);
    choosers[0].resolve({ setFiles, element: () => ({ evaluate }) });
    await flush();
    let complete = false;
    void done.then(() => {
      complete = true;
    });
    expect(setFiles).toHaveBeenCalledWith(
      options.paths,
      expect.objectContaining({ signal: expect.any(AbortSignal) as AbortSignal, timeout: 1000 }),
    );
    expect(complete).toBe(false);
    pending.resolve(undefined);
    await done;
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(page.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one deadline for chooser wait and a stalled setFiles', async () => {
    const { choosers } = fixture();
    const pending = deferred<undefined>();
    const setFiles = vi.fn().mockReturnValue(pending.promise);
    const { done } = await armFileUploadViaPlaywright(options);
    const rejected = expect(done).rejects.toThrow('completing file upload');
    await vi.advanceTimersByTimeAsync(700);
    choosers[0].resolve({ setFiles, element: () => null });
    await flush();
    expect(setFiles).toHaveBeenCalledWith(options.paths, expect.objectContaining({ timeout: 300 }));
    const signal = (setFiles.mock.calls[0][1] as { signal: AbortSignal }).signal;
    await vi.advanceTimersByTimeAsync(300);
    await rejected;
    expect(signal.aborted).toBe(true);
    pending.resolve(undefined);
    await flush();
  });

  it('bounds a chooser wait and removes close/abort listeners', async () => {
    const { page } = fixture();
    const { done } = await armFileUploadViaPlaywright(options);
    const rejected = expect(done).rejects.toThrow('completing file upload');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(page.listenerCount('close')).toBe(0);
  });

  it.each(['abort', 'close'] as const)('cancels a pending chooser on %s', async (mode) => {
    const { page } = fixture();
    const controller = new AbortController();
    const { done } = await armFileUploadViaPlaywright({ ...options, signal: controller.signal });
    const rejected = expect(done).rejects.toThrow(mode === 'abort' ? 'caller cancelled' : 'Page closed');
    if (mode === 'abort') controller.abort(new Error('caller cancelled'));
    else page.emit('close');
    await rejected;
    expect(page.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not look up a page for an already-aborted request', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(armFileUploadViaPlaywright({ ...options, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(mocks.page).not.toHaveBeenCalled();
  });

  it('rejects invalid paths and dismisses, while empty paths dismiss successfully', async () => {
    const { page, choosers } = fixture();
    const setFiles = vi.fn();
    mocks.validate.mockResolvedValue({ ok: false, error: 'outside root' });
    const first = await armFileUploadViaPlaywright(options);
    choosers[0].resolve({ setFiles, element: () => null });
    await expect(first.done).rejects.toThrow('path validation failed: outside root');
    expect(page.keyboard.press).toHaveBeenCalledWith('Escape');
    const second = await armFileUploadViaPlaywright({ ...options, paths: [] });
    choosers[1].resolve({ setFiles, element: () => null });
    await second.done;
    expect(page.keyboard.press).toHaveBeenCalledTimes(2);
    expect(setFiles).not.toHaveBeenCalled();
  });

  it('rechecks supersession after path validation before any file or Escape side effect', async () => {
    const { page, choosers } = fixture();
    const validation = deferred<unknown>();
    mocks.validate.mockReturnValueOnce(validation.promise);
    const oldSetFiles = vi.fn();
    const first = await armFileUploadViaPlaywright(options);
    const superseded = expect(first.done).rejects.toThrow('superseded');
    choosers[0].resolve({ setFiles: oldSetFiles, element: () => null });
    await flush();
    const second = await armFileUploadViaPlaywright({ ...options, paths: [] });
    await superseded;
    validation.resolve({ ok: false, error: 'late invalid result' });
    await flush();
    expect(oldSetFiles).not.toHaveBeenCalled();
    expect(page.keyboard.press).not.toHaveBeenCalled();
    choosers[1].resolve({ setFiles: vi.fn(), element: () => null });
    await second.done;
    expect(page.keyboard.press).toHaveBeenCalledTimes(1);
  });

  it('serializes the successor behind native setFiles settlement after cancellation', async () => {
    const { page, choosers } = fixture();
    const pending = deferred<undefined>();
    const setFiles = vi.fn().mockReturnValue(pending.promise);
    const first = await armFileUploadViaPlaywright(options);
    choosers[0].resolve({ setFiles, element: () => null });
    await flush();
    const superseded = expect(first.done).rejects.toThrow('superseded');
    const next = armFileUploadViaPlaywright({ ...options, paths: [] });
    await flush();
    await superseded;
    expect((setFiles.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    expect(page.waitForEvent).toHaveBeenCalledTimes(1);
    pending.resolve(undefined);
    const second = await next;
    expect(page.waitForEvent).toHaveBeenCalledTimes(2);
    choosers[1].resolve({ setFiles: vi.fn(), element: () => null });
    await second.done;
  });

  it('bounds a successor queued behind a native operation that ignores abort', async () => {
    const { page } = fixture();
    const pending = deferred<undefined>();
    const first = await armPageUpload(page as unknown as Page, { timeoutMs: 1000 }, async (lifetime, armed) => {
      armed();
      await lifetime.run(pending.promise);
    });
    const oldRejected = expect(first.done).rejects.toThrow('superseded');
    const next = armPageUpload(page as unknown as Page, { timeoutMs: 100 }, (_lifetime, armed) => {
      armed();
      return Promise.resolve();
    });
    const nextRejected = expect(next).rejects.toThrow('Timeout 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await oldRejected;
    await nextRejected;
    const thirdAction = vi.fn((_lifetime: unknown, armed: () => void) => {
      armed();
      return Promise.resolve();
    });
    const third = armPageUpload(page as unknown as Page, { timeoutMs: 1000 }, thirdAction);
    await flush();
    expect(thirdAction).not.toHaveBeenCalled();
    pending.resolve(undefined);
    const thirdResult = await third;
    await thirdResult.done;
    expect(thirdAction).toHaveBeenCalledTimes(1);
  });

  it('waits for an atomic mutation after abort and preserves its eventual failure', async () => {
    const { page } = fixture();
    const native = deferred<undefined>();
    const controller = new AbortController();
    const { done } = await armPageUpload(
      page as unknown as Page,
      { timeoutMs: 1000, signal: controller.signal, awaitStartedCompletion: true },
      async (lifetime, armed) => {
        armed();
        await lifetime.run(native.promise);
      },
    );
    const settled = vi.fn();
    void done.then(settled, settled);
    const rejected = expect(done).rejects.toThrow('native guard denied');
    controller.abort(new Error('caller cancelled'));
    await flush();
    expect(settled).not.toHaveBeenCalled();
    native.reject(new Error('native guard denied'));
    await rejected;
  });

  it('preserves a completed atomic mutation when cancellation arrives during its final guard', async () => {
    const { page } = fixture();
    const native = deferred<undefined>();
    const controller = new AbortController();
    const { done } = await armPageUpload(
      page as unknown as Page,
      { timeoutMs: 1000, signal: controller.signal, awaitStartedCompletion: true },
      async (lifetime, armed) => {
        armed();
        await lifetime.run(native.promise);
      },
    );
    controller.abort(new Error('late cancellation'));
    native.resolve(undefined);
    await expect(done).resolves.toBeUndefined();
  });

  it('still aborts an atomic request promptly while queued before starting', async () => {
    const { page } = fixture();
    const native = deferred<undefined>();
    const first = await armPageUpload(page as unknown as Page, { timeoutMs: 1000 }, async (lifetime, armed) => {
      armed();
      await lifetime.run(native.promise);
    });
    const firstRejected = expect(first.done).rejects.toThrow('superseded');
    const action = vi.fn().mockResolvedValue(undefined);
    const queued = armPageUpload(page as unknown as Page, { timeoutMs: 100, awaitStartedCompletion: true }, action);
    const queuedRejected = expect(queued).rejects.toThrow('Timeout 100ms');
    await vi.advanceTimersByTimeAsync(100);
    await firstRejected;
    await queuedRejected;
    expect(action).not.toHaveBeenCalled();
    native.resolve(undefined);
    await flush();
    expect(action).not.toHaveBeenCalled();
  });

  it.each(['unrelated', 'matching'] as const)('normalizes only %s atomic native cancellation causes', async (kind) => {
    const { page } = fixture();
    const native = deferred<undefined>();
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    const error = new Error('native cancellation', { cause: kind === 'matching' ? reason : new Error('other cause') });
    error.name = 'AbortError';
    const { done } = await armPageUpload(
      page as unknown as Page,
      { timeoutMs: 1000, signal: controller.signal, awaitStartedCompletion: true },
      async (lifetime, armed) => {
        armed();
        await lifetime.run(native.promise);
      },
    );
    const rejected = expect(done).rejects.toBe(kind === 'matching' ? reason : error);
    controller.abort(reason);
    native.reject(error);
    await rejected;
  });
});
