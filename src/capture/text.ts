import { assertPageNavigationCompletedSafely } from '../actions/navigation.js';
import { getPageForTargetId } from '../connection.js';
import { truncateUtf16Safe } from '../page-utils.js';
import { withSnapshotFrameGuard } from '../snapshot/capture-guard.js';
import type { SsrfPolicy } from '../types.js';

const TEXT_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 40_000;

/** Read visible article/main/body text without evaluating caller-supplied JavaScript. */
export async function getPageTextViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  maxChars?: number;
  signal?: AbortSignal;
  ssrfPolicy?: SsrfPolicy;
}): Promise<{ text: string; truncated: boolean }> {
  const maxChars = Math.min(opts.maxChars ?? MAX_TEXT_CHARS, MAX_TEXT_CHARS);
  if (!Number.isSafeInteger(maxChars) || maxChars <= 0) throw new Error('maxChars must be a positive integer.');
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const deadline = Date.now() + TEXT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    controller.abort(new Error(`Page text extraction timed out after ${String(TEXT_TIMEOUT_MS)}ms`));
  }, TEXT_TIMEOUT_MS);
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const read = async () => {
    const page = await getPageForTargetId(opts);
    signal.throwIfAborted();
    return withSnapshotFrameGuard({
      page,
      frame: page.mainFrame(),
      signal,
      run: async (assertCurrent) => {
        if (opts.ssrfPolicy) await assertPageNavigationCompletedSafely({ ...opts, page, response: null });
        assertCurrent();
        const readText = async (selector: string) => {
          const text = await page
            .locator(selector)
            .first()
            .innerText({ timeout: Math.max(1, deadline - Date.now()), signal });
          assertCurrent();
          return text;
        };
        if (opts.selector === undefined || opts.selector === '') {
          for (const selector of ['article', 'main']) {
            const visible = await page.locator(selector).first().isVisible();
            assertCurrent();
            if (visible) {
              const text = await readText(selector);
              if (text.trim()) return text;
            }
          }
        }
        return readText(opts.selector === '' ? 'body' : (opts.selector ?? 'body'));
      },
    });
  };
  try {
    const text = await Promise.race([read(), aborted]);
    return { text: truncateUtf16Safe(text, maxChars), truncated: text.length > maxChars };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
