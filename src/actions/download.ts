import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
  toAIFriendlyError,
  normalizeTimeoutMs,
} from '../connection.js';
import type { DownloadResult } from '../types.js';

export async function downloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  path: string;
  timeoutMs?: number;
}): Promise<DownloadResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 30000, 120000);
  const locator = refLocator(page, opts.ref);

  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      locator.click({ timeout }),
    ]);

    await download.saveAs(opts.path);

    return {
      url: download.url(),
      suggestedFilename: download.suggestedFilename(),
      path: opts.path,
    };
  } catch (err) {
    throw toAIFriendlyError(err, opts.ref);
  }
}

export async function waitForDownloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path?: string;
  timeoutMs?: number;
}): Promise<DownloadResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 30000, 120000);

  const download = await page.waitForEvent('download', { timeout });
  const savePath = opts.path ?? download.suggestedFilename();
  await download.saveAs(savePath);

  return {
    url: download.url(),
    suggestedFilename: download.suggestedFilename(),
    path: savePath,
  };
}
