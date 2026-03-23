import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
  normalizeTimeoutMs,
  forceDisconnectPlaywrightForTarget,
} from '../connection.js';

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
}): Promise<FrameEvalResult[]> {
  const fnText = opts.fn.trim();
  if (!fnText) throw new Error('function is required');

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  const frames = page.frames();
  const results: FrameEvalResult[] = [];

  for (const frame of frames) {
    try {
      // Runs in the frame's browser context (sandboxed), not in Node.js
      const result: unknown = await frame.evaluate((fnBody: string) => {
        'use strict';
        try {
          const candidate: unknown = (0, eval)('(' + fnBody + ')');
          return typeof candidate === 'function' ? (candidate as () => unknown)() : candidate;
        } catch (err: unknown) {
          throw new Error('Invalid evaluate function: ' + (err instanceof Error ? err.message : String(err)));
        }
      }, fnText);
      results.push({
        frameUrl: frame.url(),
        frameName: frame.name(),
        result,
      });
    } catch {
      // Frame may have been detached or navigation in progress — skip
    }
  }

  return results;
}

/**
 * Race an eval promise against an abort promise.
 */
async function awaitEvalWithAbort(evalPromise: Promise<unknown>, abortPromise?: Promise<never>): Promise<unknown> {
  if (!abortPromise) return await evalPromise;
  try {
    return await Promise.race([evalPromise, abortPromise]);
  } catch (err) {
    // Suppress unhandled rejection from the eval promise if abort won the race
    evalPromise.catch(() => {
      /* suppress unhandled rejection */
    });
    throw err;
  }
}

// Browser-side evaluator that wraps async results with a timeout via Promise.race.
// This runs inside the browser sandbox (not Node.js) — `new Function` is the standard
// pattern for browser-context evaluation with timeout, matching OpenClaw's implementation.

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const BROWSER_EVALUATOR = new Function(
  'args',
  `
  "use strict";
  var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
  try {
    var candidate = eval("(" + fnBody + ")");
    var result = typeof candidate === "function" ? candidate() : candidate;
    if (result && typeof result.then === "function") {
      return Promise.race([
        result,
        new Promise(function(_, reject) {
          setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
        })
      ]);
    }
    return result;
  } catch (err) {
    throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
  }
`,
);

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const ELEMENT_EVALUATOR = new Function(
  'el',
  'args',
  `
  "use strict";
  var fnBody = args.fnBody, timeoutMs = args.timeoutMs;
  try {
    var candidate = eval("(" + fnBody + ")");
    var result = typeof candidate === "function" ? candidate(el) : candidate;
    if (result && typeof result.then === "function") {
      return Promise.race([
        result,
        new Promise(function(_, reject) {
          setTimeout(function() { reject(new Error("evaluate timed out after " + timeoutMs + "ms")); }, timeoutMs);
        })
      ]);
    }
    return result;
  } catch (err) {
    throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
  }
`,
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
}): Promise<unknown> {
  const fnText = opts.fn.trim();
  if (!fnText) throw new Error('function is required');

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const outerTimeout = normalizeTimeoutMs(opts.timeoutMs, 20000);
  let evaluateTimeout = Math.max(1000, Math.min(120000, outerTimeout - 500));
  evaluateTimeout = Math.min(evaluateTimeout, outerTimeout);

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
      forceDisconnectPlaywrightForTarget({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        reason: 'evaluate aborted',
      }).catch(() => {
        /* intentional no-op */
      });
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

  try {
    if (opts.ref !== undefined && opts.ref !== '') {
      const locator = refLocator(page, opts.ref);
      return await awaitEvalWithAbort(
        locator.evaluate(ELEMENT_EVALUATOR as (...args: unknown[]) => unknown, {
          fnBody: fnText,
          timeoutMs: evaluateTimeout,
        }),
        abortPromise,
      );
    }

    return await awaitEvalWithAbort(
      page.evaluate(BROWSER_EVALUATOR as (...args: unknown[]) => unknown, {
        fnBody: fnText,
        timeoutMs: evaluateTimeout,
      }),
      abortPromise,
    );
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
  }
}
