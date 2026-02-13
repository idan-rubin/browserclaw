import { getPageForTargetId, ensurePageState, normalizeTimeoutMs } from '../connection.js';

export async function waitForViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeMs?: number;
  text?: string;
  textGone?: string;
  selector?: string;
  url?: string;
  loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  fn?: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20000);

  if (typeof opts.timeMs === 'number' && Number.isFinite(opts.timeMs)) {
    await page.waitForTimeout(Math.max(0, opts.timeMs));
  }
  if (opts.text) {
    await page.getByText(opts.text).first().waitFor({ state: 'visible', timeout });
  }
  if (opts.textGone) {
    await page.getByText(opts.textGone).first().waitFor({ state: 'hidden', timeout });
  }
  if (opts.selector) {
    const selector = String(opts.selector).trim();
    if (selector) await page.locator(selector).first().waitFor({ state: 'visible', timeout });
  }
  if (opts.url) {
    const url = String(opts.url).trim();
    if (url) await page.waitForURL(url, { timeout });
  }
  if (opts.loadState) {
    await page.waitForLoadState(opts.loadState, { timeout });
  }
  if (opts.fn) {
    const fn = String(opts.fn).trim();
    if (fn) await page.waitForFunction(fn, undefined, { timeout });
  }
}
