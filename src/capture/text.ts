import { getPageForTargetId } from '../connection.js';
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
    let locator = page.locator(opts.selector ?? 'body').first();
    if (opts.selector === undefined || opts.selector === '') {
      for (const selector of ['article', 'main']) {
        const candidate = page.locator(selector).first();
        const count = await candidate.count();
        signal.throwIfAborted();
        if (count > 0) {
          locator = candidate;
          break;
        }
      }
    }
    return locator.innerText({ timeout: Math.max(1, deadline - Date.now()), signal });
  };
  try {
    const text = await Promise.race([read(), aborted]);
    return { text: text.slice(0, maxChars), truncated: text.length > maxChars };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
