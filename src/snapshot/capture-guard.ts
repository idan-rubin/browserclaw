import type { Frame, Page } from 'playwright-core';

import { NavigationRaceError } from '../errors.js';

/** Keep every stage of a capture bound to the same document, including same-URL reloads. */
export async function withSnapshotFrameGuard<T>(opts: {
  page: Page;
  frame?: Frame;
  timeoutMs?: number;
  sourceUrl?: string;
  signal?: AbortSignal;
  run: (assertCurrent: () => void) => Promise<T>;
}): Promise<T> {
  const sourceUrl = opts.sourceUrl ?? opts.page.url();
  const deadline = opts.timeoutMs === undefined ? undefined : Date.now() + opts.timeoutMs;
  let current = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => undefined;
  const onFrameChanged = (frame: Frame) => {
    if (!opts.frame || frame === opts.frame || frame === opts.page.mainFrame()) current = false;
  };
  const assertCurrent = () => {
    opts.signal?.throwIfAborted();
    if (!current || opts.frame?.isDetached() === true) {
      throw new NavigationRaceError({ fromUrl: sourceUrl, toUrl: opts.page.url() });
    }
    if (deadline !== undefined && Date.now() >= deadline) throw new Error('Browser snapshot capture timed out.');
  };
  opts.page.on('framenavigated', onFrameChanged);
  opts.page.on('framedetached', onFrameChanged);
  try {
    assertCurrent();
    const pending: Promise<T>[] = [];
    if (opts.signal) {
      pending.push(
        new Promise<never>((_, reject) => {
          onAbort = () => {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(opts.signal?.reason);
          };
          opts.signal?.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    pending.push(
      Promise.resolve().then(() => {
        assertCurrent();
        return opts.run(assertCurrent);
      }),
    );
    if (opts.timeoutMs !== undefined) {
      pending.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            current = false;
            reject(new Error('Browser snapshot capture timed out.'));
          }, opts.timeoutMs);
        }),
      );
    }
    return await Promise.race(pending);
  } finally {
    current = false;
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    opts.page.off('framenavigated', onFrameChanged);
    opts.page.off('framedetached', onFrameChanged);
  }
}
