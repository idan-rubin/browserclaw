import type { Page } from 'playwright-core';

import type { SsrfPolicy } from '../types.js';

import { assertInteractionNavigationCompletedSafely } from './navigation.js';

interface GuardedInputOptions {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}

export async function runGuardedInput(
  page: Page,
  opts: GuardedInputOptions,
  action: () => Promise<void>,
): Promise<void> {
  opts.signal?.throwIfAborted();
  let onAbort = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason: unknown = opts.signal?.reason;
      reject(reason instanceof Error ? reason : new Error('Input action aborted', { cause: reason }));
    };
  });
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // Mouse/keyboard dispatch cannot be undone; retain the request guard until native work settles.
    await assertInteractionNavigationCompletedSafely({
      ...opts,
      page,
      abortPromise: aborted,
      previousUrl: page.url(),
      action: async () => {
        opts.signal?.throwIfAborted();
        await action();
        opts.signal?.throwIfAborted();
      },
    });
    opts.signal?.throwIfAborted();
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
