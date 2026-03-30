import { getPageForTargetId, ensurePageState, normalizeTimeoutMs } from '../connection.js';

const MAX_WAIT_TIME_MS = 30000;

function resolveBoundedDelayMs(value: number | undefined, label: string, maxMs: number): number {
  const normalized = Math.floor(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error(`${label} must be >= 0`);
  if (normalized > maxMs) throw new Error(`${label} exceeds maximum of ${String(maxMs)}ms`);
  return normalized;
}

export async function waitForViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  fn?: string | (() => unknown);
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20000);

  if (typeof opts.timeMs === 'number' && Number.isFinite(opts.timeMs)) {
    await page.waitForTimeout(resolveBoundedDelayMs(opts.timeMs, 'wait timeMs', MAX_WAIT_TIME_MS));
  }
  if (opts.text !== undefined && opts.text !== '') {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- document.body is null before DOM ready
    await page.waitForFunction((text) => (document.body?.innerText ?? '').includes(text), opts.text, { timeout });
  }
  if (opts.textGone !== undefined && opts.textGone !== '') {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- document.body is null before DOM ready
    await page.waitForFunction((text) => !(document.body?.innerText ?? '').includes(text), opts.textGone, { timeout });
  }
  if (opts.selector !== undefined && opts.selector !== '') {
    const selector = opts.selector.trim();
    if (selector !== '') await page.locator(selector).first().waitFor({ state: 'visible', timeout });
  }
  if (opts.url !== undefined && opts.url !== '') {
    const url = opts.url.trim();
    if (url !== '') await page.waitForURL(url, { timeout });
  }
  if (opts.loadState !== undefined) {
    await page.waitForLoadState(opts.loadState, { timeout });
  }
  if (opts.fn !== undefined) {
    if (typeof opts.fn === 'function') {
      await page.waitForFunction(opts.fn, { timeout });
    } else {
      const fn = opts.fn.trim();
      if (fn !== '') await page.waitForFunction(fn, undefined, { timeout });
    }
  }
}
