import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
  toAIFriendlyError,
  normalizeTimeoutMs,
  bumpDownloadArmId,
} from '../connection.js';
import { dirname } from 'node:path';
import { assertSafeOutputPath, writeViaSiblingTempPath } from '../security.js';
import type { DownloadResult } from '../types.js';

export async function downloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  path: string;
  timeoutMs?: number;
  allowedOutputRoots?: string[];
}): Promise<DownloadResult> {
  await assertSafeOutputPath(opts.path, opts.allowedOutputRoots);

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  const state = ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
  const locator = refLocator(page, opts.ref);

  state.armIdDownload = bumpDownloadArmId();

  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout }),
      locator.click({ timeout }),
    ]);

    // Atomic write via sibling temp path
    const outPath = opts.path;
    await writeViaSiblingTempPath({
      rootDir: dirname(outPath),
      targetPath: outPath,
      writeTemp: async (tempPath) => {
        await download.saveAs(tempPath);
      },
    });

    return {
      url: download.url(),
      suggestedFilename: download.suggestedFilename(),
      path: outPath,
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
  allowedOutputRoots?: string[];
}): Promise<DownloadResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);

  const download = await page.waitForEvent('download', { timeout });
  const savePath = opts.path ?? download.suggestedFilename();
  await assertSafeOutputPath(savePath, opts.allowedOutputRoots);

  await writeViaSiblingTempPath({
    rootDir: dirname(savePath),
    targetPath: savePath,
    writeTemp: async (tempPath) => {
      await download.saveAs(tempPath);
    },
  });

  return {
    url: download.url(),
    suggestedFilename: download.suggestedFilename(),
    path: savePath,
  };
}
