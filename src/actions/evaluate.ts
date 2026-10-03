import { isCdpUrlProxyRouted } from '../chrome-launcher.js';
import {
  getPageForTargetId,
  ensurePageState,
  refLocator,
  normalizeTimeoutMs,
  forceDisconnectPlaywrightConnection,
  tryTerminateExecutionForPage,
} from '../connection.js';
import { assertBrowserNavigationResultAllowed, withBrowserNavigationPolicy } from '../security.js';
import type { SsrfPolicy } from '../types.js';

import { assertInteractionNavigationCompletedSafely, assertPageNavigationCompletedSafely } from './navigation.js';

export interface FrameEvalResult {
  frameUrl: string;
  frameName: string;
  result: unknown;
}

/**
 * Evaluate JavaScript in ALL frames (including cross-origin iframes).
 * Playwright can access cross-origin frames via CDP, bypassing same-origin policy.
 * Returns results from each frame where evaluation succeeded.
 */
export async function evaluateInAllFramesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fn: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<FrameEvalResult[]> {
  const fnText = opts.fn.trim();
  if (!fnText) throw new Error('function is required');

  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  await assertPageNavigationCompletedSafely({
    cdpUrl: opts.cdpUrl,
    page,
    response: null,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
  });
  const frames = page.frames();
  const results: FrameEvalResult[] = [];
  const timeoutMs = normalizeTimeoutMs(opts.timeoutMs, 20000);
  const deadline = Date.now() + timeoutMs;
  const framePolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, {
    browserProxyMode: isCdpUrlProxyRouted(opts.cdpUrl) ? 'explicit-browser-proxy' : undefined,
  });

  for (const frame of frames) {
    try {
      await assertBrowserNavigationResultAllowed({ url: frame.url(), ...framePolicy });
    } catch {
      console.warn(`[browserclaw] skipping SSRF-blocked frame: ${frame.url()}`);
      continue;
    }
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new FrameEvaluationTimeoutError(timeoutMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new FrameEvaluationTimeoutError(timeoutMs));
        }, remaining);
      });
      let result: unknown;
      try {
        // Uses the same browser-side expression/statement and promise rules as evaluate().
        result = await Promise.race([
          frame.evaluate(BROWSER_EVALUATOR as (...args: unknown[]) => unknown, {
            fnBody: fnText,
            timeoutMs: remaining,
          }),
          timedOut,
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      await assertBrowserNavigationResultAllowed({ url: frame.url(), ...framePolicy });
      results.push({
        frameUrl: frame.url(),
        frameName: frame.name(),
        result,
      });
    } catch (err) {
      if (
        err instanceof FrameEvaluationTimeoutError ||
        (err instanceof Error && /evaluate timed out after \d+ms/.test(err.message))
      ) {
        if (opts.targetId !== undefined && opts.targetId !== '') {
          void tryTerminateExecutionForPage({
            cdpUrl: opts.cdpUrl,
            targetId: opts.targetId,
            page,
            ssrfPolicy: opts.ssrfPolicy,
          }).catch(() => undefined);
        }
        throw err instanceof FrameEvaluationTimeoutError ? err : new FrameEvaluationTimeoutError(timeoutMs);
      }
      console.warn('[browserclaw] frame evaluate failed:', err instanceof Error ? err.message : String(err));
    }
  }

  return results;
}

class FrameEvaluationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`All-frame evaluate timed out after ${String(timeoutMs)}ms`);
    this.name = 'FrameEvaluationTimeoutError';
  }
}

// Browser-side evaluators: intentionally use eval() to execute user-provided
// browser-side code. This is the core purpose — running arbitrary JS in the
// page sandbox. The fallback path handles statement-form code (template
// literals, multi-statement blocks) that fail expression-mode eval.

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const BROWSER_EVALUATOR = new Function(
  'args',
  [
    '"use strict";',
    'var fnBody = args.fnBody, timeoutMs = args.timeoutMs;',
    'try {',
    '  var candidate;',
    '  try { candidate = eval("(" + fnBody + ")"); }',
    '  catch (_) { candidate = (0, eval)(fnBody); }',
    '  var result = typeof candidate === "function" ? candidate() : candidate;',
    '  if (result && typeof result.then === "function") {',
    '    var tid;',
    '    return Promise.race([',
    '      result.then(function(v) { clearTimeout(tid); return v; }, function(e) { clearTimeout(tid); throw e; }),',
    '      new Promise(function(_, reject) {',
    '        tid = setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);',
    '      })',
    '    ]);',
    '  }',
    '  return result;',
    '} catch (err) {',
    '  throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));',
    '}',
  ].join('\n'),
);

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const ELEMENT_EVALUATOR = new Function(
  'el',
  'args',
  [
    '"use strict";',
    'var fnBody = args.fnBody, timeoutMs = args.timeoutMs;',
    'try {',
    '  var candidate;',
    '  try { candidate = eval("(" + fnBody + ")"); }',
    '  catch (_) { candidate = (0, eval)(fnBody); }',
    '  var result = typeof candidate === "function" ? candidate(el) : candidate;',
    '  if (result && typeof result.then === "function") {',
    '    var tid;',
    '    return Promise.race([',
    '      result.then(function(v) { clearTimeout(tid); return v; }, function(e) { clearTimeout(tid); throw e; }),',
    '      new Promise(function(_, reject) {',
    '        tid = setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);',
    '      })',
    '    ]);',
    '  }',
    '  return result;',
    '} catch (err) {',
    '  throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));',
    '}',
  ].join('\n'),
);

/**
 * Evaluate JavaScript in the browser page context.
 * This is intentionally using eval() to execute user-provided browser-side code,
 * which is the core purpose of this function — running arbitrary JS in the page.
 * The code runs in the browser sandbox, not in Node.js.
 */
export async function evaluateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fn: string;
  ref?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  ssrfPolicy?: SsrfPolicy;
}): Promise<unknown> {
  const fnText = opts.fn.trim();
  if (!fnText) throw new Error('function is required');

  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);

  if (opts.ssrfPolicy) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }

  const outerTimeout = normalizeTimeoutMs(opts.timeoutMs, 20000);
  // Reserve time for Playwright to surface the error without exceeding a small caller budget.
  const evaluateTimeout = Math.min(outerTimeout, Math.max(1000, Math.min(120000, outerTimeout - 1000)));

  const signal = opts.signal;
  let abortListener: (() => void) | undefined;
  let abortReject: ((reason: unknown) => void) | undefined;
  let abortPromise: Promise<never> | undefined;

  if (signal !== undefined) {
    abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {
      /* suppress unhandled rejection */
    });
  }

  if (signal !== undefined) {
    const disconnect = () => {
      const targetId = opts.targetId?.trim() ?? '';
      if (targetId !== '') {
        // Targeted: only terminate execution on this target, preserving the shared connection
        tryTerminateExecutionForPage({
          cdpUrl: opts.cdpUrl,
          targetId,
          page,
          ssrfPolicy: opts.ssrfPolicy,
        }).catch(() => {
          /* intentional no-op */
        });
      } else {
        // No target ID — forced to tear down the shared connection as last resort
        console.warn('[browserclaw] evaluate abort: no targetId, forcing full disconnect');
        forceDisconnectPlaywrightConnection({
          cdpUrl: opts.cdpUrl,
          page,
          reason: 'evaluate aborted (no targetId)',
          ssrfPolicy: opts.ssrfPolicy,
        }).catch(() => {
          /* intentional no-op */
        });
      }
    };
    if (signal.aborted) {
      disconnect();
      throw signal.reason ?? new Error('aborted');
    }
    abortListener = () => {
      disconnect();
      abortReject?.(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
    // Re-check after adding listener to handle race where signal was aborted between checks
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (signal.aborted) {
      abortListener();
      throw signal.reason ?? new Error('aborted');
    }
  }

  const previousUrl = page.url();
  try {
    if (opts.ref !== undefined && opts.ref !== '') {
      const locator = refLocator(page, opts.ref);
      return await assertInteractionNavigationCompletedSafely({
        action: () => {
          signal?.throwIfAborted();
          return locator.evaluate(ELEMENT_EVALUATOR as (...args: unknown[]) => unknown, {
            fnBody: fnText,
            timeoutMs: evaluateTimeout,
          });
        },
        abortPromise,
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
      });
    }

    return await assertInteractionNavigationCompletedSafely({
      action: () => {
        signal?.throwIfAborted();
        return page.evaluate(BROWSER_EVALUATOR as (...args: unknown[]) => unknown, {
          fnBody: fnText,
          timeoutMs: evaluateTimeout,
        });
      },
      abortPromise,
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    // Release closure references to prevent memory leaks in long-lived signals
    abortReject = undefined;
    abortListener = undefined;
  }
}
