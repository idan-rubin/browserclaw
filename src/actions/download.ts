import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Page, Download } from 'playwright-core';

import {
  getPageForTargetId,
  ensurePageState,
  refLocator,
  toAIFriendlyError,
  normalizeTimeoutMs,
  bumpDownloadArmId,
} from '../connection.js';
import {
  DEFAULT_DOWNLOAD_DIR,
  assertBrowserNavigationResultAllowed,
  assertSafeOutputPath,
  withBrowserNavigationPolicy,
  writeViaSiblingTempPath,
  sanitizeUntrustedFileName,
} from '../security.js';
import type { DownloadResult, PageState, SsrfPolicy } from '../types.js';

function createPageDownloadWaiter(page: Page, state: PageState, timeoutMs: number, timeoutMessage?: string) {
  let done = false;
  let depthReleased = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handler: ((download: Download) => void) | undefined;

  state.downloadWaiterDepth += 1;

  const cleanup = () => {
    if (!depthReleased) {
      depthReleased = true;
      state.downloadWaiterDepth = Math.max(0, state.downloadWaiterDepth - 1);
    }
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (handler) {
      page.off('download', handler);
      handler = undefined;
    }
  };

  const promise = new Promise<Download>((resolve, reject) => {
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
      reject(new Error(timeoutMessage ?? 'Timeout waiting for download'));
    }, timeoutMs);
  });
  // Keep a handler attached so a timeout rejection before the caller awaits
  // the promise cannot surface as an unhandledRejection.
  promise.catch(() => undefined);

  return {
    promise,
    cancel: () => {
      if (done) return;
      done = true;
      cleanup();
    },
  };
}

async function assertDownloadUrlAllowed(download: Download, ssrfPolicy?: SsrfPolicy): Promise<void> {
  if (!ssrfPolicy) return;
  await assertBrowserNavigationResultAllowed({ url: download.url(), ...withBrowserNavigationPolicy(ssrfPolicy) });
}

// Unconditional (secure-by-default) — assertBrowserNavigationResultAllowed blocks
// data:/blob: and, with no policy, private/loopback hosts, matching what the
// navigation that triggered the download was already validated against.
async function assertNavigationDownloadUrlAllowed(
  download: Download,
  navigationUrl: string,
  ssrfPolicy?: SsrfPolicy,
): Promise<void> {
  await assertBrowserNavigationResultAllowed({
    url: download.url() || navigationUrl,
    ...withBrowserNavigationPolicy(ssrfPolicy),
  });
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

function buildManagedDownloadPath(fileName: string): string {
  const safeName = sanitizeUntrustedFileName(fileName, 'download.bin');
  return join(DEFAULT_DOWNLOAD_DIR, `${randomUUID()}-${safeName}`);
}

/** A passive download capture armed for the duration of a navigation. */
export interface NavigationDownloadCapture {
  /** False when another download waiter is already active on the page. */
  armed: boolean;
  promise: Promise<DownloadResult>;
  cancel: () => void;
}

/** Passive per-navigation download capture: policy-validates the URL before saving bytes; not armed while an explicit waiter is active. */
export function armNavigationDownloadCapture(
  page: Page,
  state: PageState,
  timeoutMs: number,
  navigationUrl: string,
  ssrfPolicy?: SsrfPolicy,
): NavigationDownloadCapture {
  if (state.downloadWaiterDepth > 0) {
    return {
      armed: false,
      promise: new Promise<DownloadResult>(() => {
        /* never settles — unarmed captures are cancelled by the caller */
      }),
      cancel: () => {
        /* noop */
      },
    };
  }
  const waiter = createPageDownloadWaiter(page, state, timeoutMs, 'Timeout waiting for navigation download');
  const promise = waiter.promise.then(async (download) => {
    await assertNavigationDownloadUrlAllowed(download, navigationUrl, ssrfPolicy);
    await mkdir(DEFAULT_DOWNLOAD_DIR, { recursive: true });
    return await saveDownloadPayload(
      download,
      buildManagedDownloadPath(download.suggestedFilename() || 'download.bin'),
    );
  });
  promise.catch(() => undefined);
  return { armed: true, promise, cancel: waiter.cancel };
}

/** True when a navigation failed because it started a file download instead. */
export function isDownloadStartingNavigationError(err: unknown, expectedUrl?: string): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (message.includes('download is starting')) return true;
  const normalizedUrl = expectedUrl?.trim().toLowerCase();
  return Boolean(normalizedUrl && message.includes('net::err_aborted') && message.includes(normalizedUrl));
}

async function awaitDownloadPayload(params: {
  waiter: ReturnType<typeof createPageDownloadWaiter>;
  state: PageState;
  armId: number;
  outPath: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<DownloadResult> {
  try {
    const download = await params.waiter.promise;
    if (params.state.armIdDownload !== params.armId) throw new Error('Download was superseded by another waiter');
    await assertDownloadUrlAllowed(download, params.ssrfPolicy);
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
  ssrfPolicy?: SsrfPolicy;
}): Promise<DownloadResult> {
  await assertSafeOutputPath(opts.path, opts.allowedOutputRoots);

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: opts.ssrfPolicy });
  const state = ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
  const outPath = opts.path.trim();
  if (!outPath) throw new Error('path is required');

  const armId = bumpDownloadArmId(state);
  state.armIdDownload = armId;
  const waiter = createPageDownloadWaiter(page, state, timeout);

  try {
    const locator = refLocator(page, opts.ref);
    try {
      await locator.click({ timeout });
    } catch (err) {
      throw toAIFriendlyError(err, opts.ref);
    }
    return await awaitDownloadPayload({ waiter, state, armId, outPath, ssrfPolicy: opts.ssrfPolicy });
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
  ssrfPolicy?: SsrfPolicy;
}): Promise<DownloadResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: opts.ssrfPolicy });
  const state = ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);

  state.armIdDownload = bumpDownloadArmId(state);
  const armId = state.armIdDownload;

  const waiter = createPageDownloadWaiter(page, state, timeout);
  try {
    const download = await waiter.promise;
    if (state.armIdDownload !== armId) throw new Error('Download was superseded by another waiter');
    // With no explicit path, save into the managed downloads dir under a UUID —
    // never the process CWD with a page-controlled filename (overwrite risk).
    let savePath: string;
    if (opts.path === undefined) {
      await mkdir(DEFAULT_DOWNLOAD_DIR, { recursive: true });
      savePath = buildManagedDownloadPath(download.suggestedFilename() || 'download.bin');
    } else {
      savePath = opts.path;
    }
    await assertSafeOutputPath(savePath, opts.allowedOutputRoots);
    await assertDownloadUrlAllowed(download, opts.ssrfPolicy);
    return await saveDownloadPayload(download, savePath);
  } catch (err) {
    waiter.cancel();
    throw err;
  }
}
