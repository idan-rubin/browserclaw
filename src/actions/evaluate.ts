import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
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
  const fnText = String(opts.fn ?? '').trim();
  if (!fnText) throw new Error('function is required');

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  const frames = page.frames();
  const results: FrameEvalResult[] = [];

  for (const frame of frames) {
    try {
      // Runs in the frame's browser context (sandboxed), not in Node.js
      const result = await frame.evaluate(
        // eslint-disable-next-line no-eval
        (fnBody: string) => {
          'use strict';
          try {
            const candidate = (0, eval)('(' + fnBody + ')');
            return typeof candidate === 'function' ? candidate() : candidate;
          } catch (err: unknown) {
            throw new Error('Invalid evaluate function: ' + (err instanceof Error ? err.message : String(err)));
          }
        },
        fnText,
      );
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
  const fnText = String(opts.fn ?? '').trim();
  if (!fnText) throw new Error('function is required');

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const timeout = opts.timeoutMs != null ? opts.timeoutMs : undefined;

  if (opts.ref) {
    const locator = refLocator(page, opts.ref);
    // Runs in the browser page context (sandboxed), not in Node.js
    return await locator.evaluate(
      // eslint-disable-next-line no-eval
      (el: Element, fnBody: string) => {
        'use strict';
        try {
          const candidate = (0, eval)('(' + fnBody + ')');
          return typeof candidate === 'function' ? candidate(el) : candidate;
        } catch (err: unknown) {
          throw new Error('Invalid evaluate function: ' + (err instanceof Error ? err.message : String(err)));
        }
      },
      fnText,
      { timeout },
    );
  }

  // Runs in the browser page context (sandboxed), not in Node.js
  const evalPromise = page.evaluate(
    // eslint-disable-next-line no-eval
    (fnBody: string) => {
      'use strict';
      try {
        const candidate = (0, eval)('(' + fnBody + ')');
        return typeof candidate === 'function' ? candidate() : candidate;
      } catch (err: unknown) {
        throw new Error('Invalid evaluate function: ' + (err instanceof Error ? err.message : String(err)));
      }
    },
    fnText,
  );

  if (!opts.signal) return evalPromise;
  return Promise.race([
    evalPromise,
    new Promise<never>((_, reject) => {
      opts.signal!.addEventListener('abort', () => reject(new Error('Evaluate aborted')), { once: true });
    }),
  ]);
}
