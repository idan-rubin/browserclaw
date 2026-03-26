import { dirname } from 'node:path';

import type { Page, Download } from 'playwright-core';

import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
  toAIFriendlyError,
  normalizeTimeoutMs,
  bumpDownloadArmId,
} from '../connection.js';
import { assertSafeOutputPath, writeViaSiblingTempPath, sanitizeUntrustedFileName } from '../security.js';
import type { DownloadResult, PageState } from '../types.js';

function createPageDownloadWaiter(page: Page, timeoutMs: number) {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handler: ((download: Download) => void) | undefined;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (handler) {
      page.off('download', handler);
      handler = undefined;
    }
  };

  return {
    promise: new Promise<Download>((resolve, reject) => {
      handler = (download: Download) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(download);
      };
      page.on('download', handler);
      timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('Timeout waiting for download'));
      }, timeoutMs);
    }),
    cancel: () => {
      if (done) return;
      done = true;
      cleanup();
    },
  };
}

async function saveDownloadPayload(download: Download, outPath: string): Promise<DownloadResult> {
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
}

async function awaitDownloadPayload(params: {
  waiter: ReturnType<typeof createPageDownloadWaiter>;
  state: PageState;
  armId: number;
  outPath: string;
}): Promise<DownloadResult> {
  try {
    const download = await params.waiter.promise;
    if (params.state.armIdDownload !== params.armId) throw new Error('Download was superseded by another waiter');
    return await saveDownloadPayload(download, params.outPath);
  } catch (err) {
    params.waiter.cancel();
    throw err;
  }
}

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
  const outPath = opts.path.trim();
  if (!outPath) throw new Error('path is required');

  state.armIdDownload = bumpDownloadArmId();
  const armId = state.armIdDownload;
  const waiter = createPageDownloadWaiter(page, timeout);

  try {
    const locator = refLocator(page, opts.ref);
    try {
      await locator.click({ timeout });
    } catch (err) {
      throw toAIFriendlyError(err, opts.ref);
    }
    return await awaitDownloadPayload({ waiter, state, armId, outPath });
  } catch (err) {
    waiter.cancel();
    throw err;
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
  const state = ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);

  state.armIdDownload = bumpDownloadArmId();
  const armId = state.armIdDownload;

  const waiter = createPageDownloadWaiter(page, timeout);
  try {
    const download = await waiter.promise;
    if (state.armIdDownload !== armId) throw new Error('Download was superseded by another waiter');
    const savePath = opts.path ?? sanitizeUntrustedFileName(download.suggestedFilename() || 'download.bin', 'download.bin');
    await assertSafeOutputPath(savePath, opts.allowedOutputRoots);
    return await saveDownloadPayload(download, savePath);
  } catch (err) {
    waiter.cancel();
    throw err;
  }
}
