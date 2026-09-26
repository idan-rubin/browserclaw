import { setTimeout as delay } from 'node:timers/promises';

import type { Frame } from 'playwright-core';

import { getPageForTargetId, ensurePageState, normalizeTimeoutMs, resolveBoundedDelayMs } from '../connection.js';
import type { SsrfPolicy, WaitOptions } from '../types.js';

import { assertInteractionNavigationCompletedSafely } from './navigation.js';

const MAX_WAIT_TIME_MS = 30000;

function waitPredicateSource(fn: WaitOptions['fn']): string {
  const source = typeof fn === 'function' ? fn.toString() : (fn?.trim() ?? '');
  if (!source) return '';
  try {
    // Like Playwright, accept method shorthand as well as function/arrow source.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(`return (${source});`);
    if (typeof fn === 'function' || /^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(source)) {
      return source;
    }
    return `(arg) => {
      const value = (${source});
      return typeof value === 'function' ? value(arg) : value;
    }`;
  } catch {
    if (typeof fn === 'string') return `async (arg) => {\n${source}\n}`;
    return source.startsWith('async ') ? `async function ${source.slice(6)}` : `function ${source}`;
  }
}

function createWaitPredicate(source: string): (state: { document: Document; arg: unknown }) => boolean {
  // The generated function is serialized by Playwright, never run in Node.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(
    'state',
    `
    if (state.document !== globalThis.document) throw new Error('Wait predicate document changed');
    state.predicate ??= (${source});
    if (state.settled) {
      const settled = state.settled;
      delete state.settled;
      if (settled.kind === 'error') throw settled.error;
      if (settled.value) return true;
    }
    if (state.pending) return false;
    const predicate = state.predicate;
    const value = predicate(state.arg);
    if (!value || typeof value.then !== 'function') return !!value;
    state.pending = true;
    Promise.resolve(value).then(
      value => { state.settled = { kind: 'value', value }; delete state.pending; },
      error => { state.settled = { kind: 'error', error }; delete state.pending; }
    );
    return false;
  `,
  ) as (state: { document: Document; arg: unknown }) => boolean;
}

export async function waitForViaPlaywright(
  opts: WaitOptions & {
    cdpUrl: string;
    targetId?: string;
    ssrfPolicy?: SsrfPolicy;
  },
): Promise<void> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  opts.signal?.throwIfAborted();
  ensurePageState(page);
  const totalTimeout = normalizeTimeoutMs(opts.timeoutMs, 20000);
  const deadline = Date.now() + totalTimeout;

  const remaining = () => Math.max(500, deadline - Date.now());
  const step = async (action: () => Promise<unknown>) => {
    opts.signal?.throwIfAborted();
    try {
      await action();
    } catch (error) {
      opts.signal?.throwIfAborted();
      throw error;
    }
    opts.signal?.throwIfAborted();
  };
  const waitOptions = () => ({ timeout: remaining(), signal: opts.signal });
  const source = waitPredicateSource(opts.fn);

  const runWaitSequence = async () => {
    if (typeof opts.timeMs === 'number' && Number.isFinite(opts.timeMs)) {
      await step(() =>
        delay(resolveBoundedDelayMs(opts.timeMs, 'wait timeMs', MAX_WAIT_TIME_MS), undefined, {
          signal: opts.signal,
        }),
      );
    }
    if (opts.text !== undefined && opts.text !== '') {
      const text = opts.text;
      await step(() =>
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- document.body is null before DOM ready
        page.waitForFunction((text) => (document.body?.innerText ?? '').includes(text), text, waitOptions()),
      );
    }
    if (opts.textGone !== undefined && opts.textGone !== '') {
      const textGone = opts.textGone;
      await step(() =>
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- document.body is null before DOM ready
        page.waitForFunction((text) => !(document.body?.innerText ?? '').includes(text), textGone, waitOptions()),
      );
    }
    if (opts.selector !== undefined && opts.selector !== '') {
      const selector = opts.selector.trim();
      if (selector !== '')
        await step(() =>
          page
            .locator(selector)
            .first()
            .waitFor({ state: 'visible', ...waitOptions() }),
        );
    }
    if (opts.url !== undefined && opts.url !== '') {
      const url = opts.url.trim();
      if (url !== '') await step(() => page.waitForURL(url, waitOptions()));
    }
    if (opts.loadState !== undefined) {
      await step(() => page.waitForLoadState(opts.loadState, waitOptions()));
    }
    if (source !== '') {
      opts.signal?.throwIfAborted();
      const documentController = new AbortController();
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, documentController.signal])
        : documentController.signal;
      const onNavigated = (frame: Frame) => {
        if (frame === page.mainFrame()) documentController.abort(new Error('Wait predicate document changed'));
      };
      page.on('framenavigated', onNavigated);
      try {
        const documentHandle = await page.evaluateHandle(() => globalThis.document);
        try {
          signal.throwIfAborted();
          await step(() =>
            page.waitForFunction(
              createWaitPredicate(source),
              {
                document: documentHandle,
                arg: opts.arg,
              },
              { ...waitOptions(), signal },
            ),
          );
          signal.throwIfAborted();
        } finally {
          await documentHandle.dispose();
        }
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      } finally {
        page.off('framenavigated', onNavigated);
      }
    }
  };
  if (source !== '') {
    await assertInteractionNavigationCompletedSafely({
      ...opts,
      page,
      previousUrl: page.url(),
      action: runWaitSequence,
    });
  } else {
    await runWaitSequence();
  }
}
