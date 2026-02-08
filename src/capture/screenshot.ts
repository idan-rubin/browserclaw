import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
} from '../connection.js';

export async function takeScreenshotViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fullPage?: boolean;
  ref?: string;
  element?: string;
  type?: 'png' | 'jpeg';
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const type = opts.type ?? 'png';

  if (opts.ref) {
    if (opts.fullPage) throw new Error('fullPage is not supported for element screenshots');
    return { buffer: await refLocator(page, opts.ref).screenshot({ type }) };
  }
  if (opts.element) {
    if (opts.fullPage) throw new Error('fullPage is not supported for element screenshots');
    return { buffer: await page.locator(opts.element).first().screenshot({ type }) };
  }
  return { buffer: await page.screenshot({ type, fullPage: Boolean(opts.fullPage) }) };
}
