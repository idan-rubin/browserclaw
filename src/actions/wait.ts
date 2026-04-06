import { getPageForTargetId, ensurePageState, normalizeTimeoutMs, resolveBoundedDelayMs } from '../connection.js';

const MAX_WAIT_TIME_MS = 30000;

export async function waitForViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  fn?: string | ((arg?: unknown) => unknown);
  arg?: unknown;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  const totalTimeout = normalizeTimeoutMs(opts.timeoutMs, 20000);
  const deadline = Date.now() + totalTimeout;

  const remaining = () => Math.max(500, deadline - Date.now());

  if (typeof opts.timeMs === 'number' && Number.isFinite(opts.timeMs)) {
    // timeMs is a fixed delay capped at MAX_WAIT_TIME_MS, independent of timeoutMs
    // (timeoutMs governs condition-based waits below, not this fixed sleep)
    await page.waitForTimeout(resolveBoundedDelayMs(opts.timeMs, 'wait timeMs', MAX_WAIT_TIME_MS));
  }
  if (opts.text !== undefined && opts.text !== '') {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- document.body is null before DOM ready
    await page.waitForFunction((text) => (document.body?.innerText ?? '').includes(text), opts.text, {
      timeout: remaining(),
    });
  }
  if (opts.textGone !== undefined && opts.textGone !== '') {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- document.body is null before DOM ready
    await page.waitForFunction((text) => !(document.body?.innerText ?? '').includes(text), opts.textGone, {
      timeout: remaining(),
    });
  }
  if (opts.selector !== undefined && opts.selector !== '') {
    const selector = opts.selector.trim();
    if (selector !== '') await page.locator(selector).first().waitFor({ state: 'visible', timeout: remaining() });
  }
  if (opts.url !== undefined && opts.url !== '') {
    const url = opts.url.trim();
    if (url !== '') await page.waitForURL(url, { timeout: remaining() });
  }
  if (opts.loadState !== undefined) {
    await page.waitForLoadState(opts.loadState, { timeout: remaining() });
  }
  if (opts.fn !== undefined) {
    if (typeof opts.fn === 'function') {
      await page.waitForFunction(opts.fn, opts.arg, { timeout: remaining() });
    } else {
      const fn = opts.fn.trim();
      if (fn !== '') await page.waitForFunction(fn, opts.arg, { timeout: remaining() });
    }
  }
}
