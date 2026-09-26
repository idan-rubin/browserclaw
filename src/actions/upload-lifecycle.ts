import type { Page } from 'playwright-core';

interface ActiveUpload {
  controller: AbortController;
  settled: Promise<void>;
}

const activeUploads = new WeakMap<Page, ActiveUpload>();

export interface UploadLifetime {
  signal: AbortSignal;
  remainingMs(): number;
  assertCurrent(): void;
  /** Abort a local wait without treating it as an in-flight browser mutation. */
  wait<T>(promise: Promise<T>): Promise<T>;
  /** Keep native browser work serialized until it actually settles after abort. */
  run<T>(promise: Promise<T>): Promise<T>;
}

/** Supersede the previous upload, then return only after this chooser is armed. */
export async function armPageUpload(
  page: Page,
  opts: { timeoutMs: number; signal?: AbortSignal; awaitStartedCompletion?: boolean },
  action: (lifetime: UploadLifetime, markArmed: () => void) => Promise<void>,
): Promise<{ done: Promise<void> }> {
  opts.signal?.throwIfAborted();
  const previous = activeUploads.get(page);
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Set<Promise<unknown>>();
  const deadline = Date.now() + opts.timeoutMs;
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout ${String(opts.timeoutMs)}ms exceeded while completing file upload`));
  }, opts.timeoutMs);
  timer.unref();

  const onExternalAbort = () => {
    controller.abort(opts.signal?.reason);
  };
  const onClose = () => {
    controller.abort(new Error('Page closed while completing file upload'));
  };
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  page.once('close', onClose);
  if (typeof page.isClosed === 'function' && page.isClosed()) onClose();

  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  void aborted.catch(() => undefined);

  let markArmed: () => void = () => undefined;
  const armed = new Promise<void>((resolve) => {
    markArmed = resolve;
  });
  const lifetime: UploadLifetime = {
    signal,
    remainingMs: () => Math.max(1, deadline - Date.now()),
    assertCurrent: () => {
      signal.throwIfAborted();
    },
    wait: async <T>(promise: Promise<T>): Promise<T> => {
      // Promise.race attaches a rejection handler even if abort already won.
      const result = await Promise.race([promise, aborted]);
      signal.throwIfAborted();
      return result;
    },
    run: async <T>(promise: Promise<T>): Promise<T> => {
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
      if (opts.awaitStartedCompletion === true) {
        const result = await promise;
        signal.throwIfAborted();
        return result;
      }
      return lifetime.wait(promise);
    },
  };

  let started = false;
  const execution = Promise.resolve().then(async () => {
    await lifetime.wait(previous?.settled ?? Promise.resolve());
    lifetime.assertCurrent();
    started = true;
    try {
      await action(lifetime, markArmed);
    } catch (error) {
      if (signal.aborted && error instanceof Error && error.name === 'AbortError' && error.cause === signal.reason) {
        signal.throwIfAborted();
      }
      controller.abort(error);
      throw error;
    }
  });
  const done = lifetime
    .wait(execution)
    .catch(async (error: unknown) => {
      // Atomic callers must observe the guarded mutation's actual outcome. Queued
      // requests and two-phase chooser arms still abort without waiting for it.
      if (opts.awaitStartedCompletion === true && started) await execution;
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
      signal.removeEventListener('abort', onAbort);
      page.off('close', onClose);
    });
  // Keep the serialization lease while native work is still settling, even when
  // `done` has already rejected at its deadline. Native Playwright receives signal.
  const settled = execution
    .catch(() => undefined)
    .then(async () => {
      // A cancelled queued successor must not release its predecessor's lease.
      await previous?.settled;
      await Promise.all(pending);
    });
  const active: ActiveUpload = { controller, settled };
  activeUploads.set(page, active);
  previous?.controller.abort(new Error('File upload was superseded by another waiter'));
  void settled.finally(() => {
    if (activeUploads.get(page) === active) activeUploads.delete(page);
  });
  void done.catch(() => undefined);
  await Promise.race([armed, done]);
  return { done };
}
