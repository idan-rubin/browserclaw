import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Page, Download } from 'playwright-core';

import { isCdpUrlProxyRouted } from '../chrome-launcher.js';
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

import { assertInteractionNavigationCompletedSafely, withPageNavigationRequestGuard } from './navigation.js';

function createPageDownloadWaiter(
  page: Page,
  state: PageState,
  timeoutMs: number,
  opts: { timeoutMessage?: string; cancelOnError?: () => boolean; signal?: AbortSignal } = {},
) {
  const operation = new AbortController();
  let activeDownload: Download | undefined;
  let done = false;
  let depthReleased = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handler: ((download: Download) => void) | undefined;

  state.downloadWaiterDepth += 1;

  const releaseListener = () => {
    if (!depthReleased) {
      depthReleased = true;
      state.downloadWaiterDepth = Math.max(0, state.downloadWaiterDepth - 1);
    }
    if (handler) {
      page.off('download', handler);
      handler = undefined;
    }
  };

  const retireDeadline = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    opts.signal?.removeEventListener('abort', onExternalAbort);
  };
  const cleanup = () => {
    done = true;
    releaseListener();
    retireDeadline();
  };
  let rejectOperation: (reason: Error) => void = () => {
    /* initialized synchronously */
  };
  const interrupted = new Promise<never>((_, reject) => {
    rejectOperation = reject;
  });
  // A passive capture may time out before navigation decides whether to settle it.
  interrupted.catch(() => undefined);
  const abort = (reason: Error, cancelDownload = true) => {
    if (done) return;
    operation.abort(reason);
    cleanup();
    if (cancelDownload && activeDownload && typeof activeDownload.cancel === 'function') {
      activeDownload.cancel().catch(() => undefined);
    }
    rejectOperation(reason);
  };
  const onExternalAbort = () => {
    const reason: unknown = opts.signal?.reason;
    abort(
      reason instanceof Error ? reason : new Error('Download aborted', { cause: reason }),
      opts.cancelOnError?.() ?? true,
    );
  };

  const promise = new Promise<Download>((resolve) => {
    handler = (download: Download) => {
      if (done) return;
      activeDownload = download;
      releaseListener();
      resolve(download);
    };
    page.on('download', handler);
    timer = setTimeout(() => {
      abort(new Error(opts.timeoutMessage ?? 'Timeout waiting for download'));
    }, timeoutMs);
  });
  opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
  if (opts.signal?.aborted === true) onExternalAbort();
  return {
    promise,
    signal: operation.signal,
    abort,
    // A completed temp write is the commit point: do not report a timeout
    // after publication has already begun.
    readyToPublish: () => {
      operation.signal.throwIfAborted();
      retireDeadline();
    },
    run: async <T>(action: () => Promise<T>): Promise<T> => {
      try {
        operation.signal.throwIfAborted();
        return await Promise.race([action(), interrupted]);
      } catch (error) {
        abort(
          error instanceof Error ? error : new Error('Download failed', { cause: error }),
          opts.cancelOnError?.() ?? true,
        );
        throw error;
      } finally {
        cleanup();
      }
    },
    cancel: cleanup,
  };
}

async function assertDownloadUrlAllowed(download: Download, cdpUrl: string, ssrfPolicy?: SsrfPolicy): Promise<void> {
  if (!ssrfPolicy) return;
  await assertBrowserNavigationResultAllowed({
    url: download.url(),
    ...withBrowserNavigationPolicy(ssrfPolicy, {
      browserProxyMode: isCdpUrlProxyRouted(cdpUrl) ? 'explicit-browser-proxy' : 'direct',
    }),
  });
}

// Unconditional (secure-by-default) — assertBrowserNavigationResultAllowed blocks
// data:/blob: and, with no policy, private/loopback hosts, matching what the
// navigation that triggered the download was already validated against.
async function assertNavigationDownloadUrlAllowed(
  download: Download,
  navigationUrl: string,
  ssrfPolicy?: SsrfPolicy,
  cdpUrl?: string,
): Promise<void> {
  await assertBrowserNavigationResultAllowed({
    url: download.url() || navigationUrl,
    ...withBrowserNavigationPolicy(ssrfPolicy, {
      browserProxyMode: cdpUrl !== undefined && isCdpUrlProxyRouted(cdpUrl) ? 'explicit-browser-proxy' : 'direct',
    }),
  });
}

async function saveDownloadPayload(
  download: Download,
  outPath: string,
  waiter: ReturnType<typeof createPageDownloadWaiter>,
): Promise<DownloadResult> {
  waiter.signal.throwIfAborted();
  await writeViaSiblingTempPath({
    rootDir: dirname(outPath),
    targetPath: outPath,
    writeTemp: async (tempPath) => {
      await download.saveAs(tempPath);
      waiter.readyToPublish();
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

export const NAVIGATION_DOWNLOAD_TIMEOUT_MESSAGE = 'Timeout waiting for navigation download';

/** A navigation that aborted because it became a download emits `download` within IPC latency; anything slower is a plain abort. */
export const NAVIGATION_DOWNLOAD_GRACE_MS = 1500;

/** A passive download capture armed for the duration of a navigation. */
export interface NavigationDownloadCapture {
  /** False when another download waiter is already active on the page. */
  armed: boolean;
  /** Waits up to `graceMs` for the navigation's download, then policy-validates and saves it. */
  settle: (graceMs: number) => Promise<DownloadResult>;
  cancel: () => void;
}

function rejectAfter(ms: number, message: string): { promise: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  promise.catch(() => undefined);
  return {
    promise,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
  };
}

/** Passive per-navigation download capture: nothing is saved until the caller confirms the navigation became a download. */
export function armNavigationDownloadCapture(
  page: Page,
  state: PageState,
  timeoutMs: number,
  navigationUrl: string,
  ssrfPolicy?: SsrfPolicy,
  cdpUrl?: string,
): NavigationDownloadCapture {
  if (state.downloadWaiterDepth > 0) {
    return {
      armed: false,
      settle: () => Promise.reject(new Error(NAVIGATION_DOWNLOAD_TIMEOUT_MESSAGE)),
      cancel: () => {
        /* noop */
      },
    };
  }
  const waiter = createPageDownloadWaiter(page, state, timeoutMs, {
    timeoutMessage: NAVIGATION_DOWNLOAD_TIMEOUT_MESSAGE,
  });
  const settle = async (graceMs: number): Promise<DownloadResult> =>
    waiter.run(async () => {
      const grace = rejectAfter(Math.max(1, Math.min(graceMs, timeoutMs)), NAVIGATION_DOWNLOAD_TIMEOUT_MESSAGE);
      let download: Download;
      try {
        download = await Promise.race([waiter.promise, grace.promise]);
      } finally {
        grace.clear();
      }
      await assertNavigationDownloadUrlAllowed(download, navigationUrl, ssrfPolicy, cdpUrl);
      await mkdir(DEFAULT_DOWNLOAD_DIR, { recursive: true });
      return await saveDownloadPayload(
        download,
        buildManagedDownloadPath(download.suggestedFilename() || 'download.bin'),
        waiter,
      );
    });
  return { armed: true, settle, cancel: waiter.cancel };
}

/** A possible download abort; the caller must confirm it with an observed download event. */
export function isDownloadStartingNavigationError(err: unknown, expectedUrl?: string): boolean {
  // Retain the signature; redirects and URL normalization can change the error's URL.
  void expectedUrl;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('download is starting') || message.includes('net::err_aborted');
}

async function awaitDownloadPayload(params: {
  waiter: ReturnType<typeof createPageDownloadWaiter>;
  state: PageState;
  armId: number;
  outPath: string;
  cdpUrl: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<DownloadResult> {
  const download = await params.waiter.promise;
  if (params.state.armIdDownload !== params.armId) throw new Error('Download was superseded by another waiter');
  await assertDownloadUrlAllowed(download, params.cdpUrl, params.ssrfPolicy);
  if (params.state.armIdDownload !== params.armId) throw new Error('Download was superseded by another waiter');
  return await saveDownloadPayload(download, params.outPath, params.waiter);
}

export async function downloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  path: string;
  timeoutMs?: number;
  allowedOutputRoots?: string[];
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<DownloadResult> {
  opts.signal?.throwIfAborted();
  await assertSafeOutputPath(opts.path, opts.allowedOutputRoots);

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: opts.ssrfPolicy });
  const state = ensurePageState(page);
  opts.signal?.throwIfAborted();

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
  const outPath = opts.path.trim();
  if (!outPath) throw new Error('path is required');

  const armId = bumpDownloadArmId(state);
  state.armIdDownload = armId;
  const waiter = createPageDownloadWaiter(page, state, timeout, {
    signal: opts.signal,
    cancelOnError: () => state.armIdDownload === armId,
  });

  try {
    const locator = refLocator(page, opts.ref);
    await assertInteractionNavigationCompletedSafely({
      ...opts,
      page,
      previousUrl: page.url(),
      action: () => locator.click({ timeout, signal: waiter.signal }),
    });
  } catch (err) {
    const error = toAIFriendlyError(err, opts.ref);
    waiter.abort(error, state.armIdDownload === armId);
    throw error;
  }
  return await waiter.run(() =>
    awaitDownloadPayload({
      waiter,
      state,
      armId,
      outPath,
      cdpUrl: opts.cdpUrl,
      ssrfPolicy: opts.ssrfPolicy,
    }),
  );
}

export async function waitForDownloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path?: string;
  timeoutMs?: number;
  allowedOutputRoots?: string[];
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<DownloadResult> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: opts.ssrfPolicy });
  const state = ensurePageState(page);
  opts.signal?.throwIfAborted();

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);

  state.armIdDownload = bumpDownloadArmId(state);
  const armId = state.armIdDownload;

  let activeWaiter: ReturnType<typeof createPageDownloadWaiter> | undefined;
  return await withPageNavigationRequestGuard({
    ...opts,
    page,
    onPolicyDenied: (event) => {
      if (event.state === 'detected') {
        activeWaiter?.abort(
          event.error instanceof Error
            ? event.error
            : new Error('Browser navigation blocked by policy', { cause: event.error }),
        );
      }
    },
    action: async () => {
      const waiter = createPageDownloadWaiter(page, state, timeout, {
        signal: opts.signal,
        cancelOnError: () => state.armIdDownload === armId,
      });
      activeWaiter = waiter;
      return await waiter.run(async () => {
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
        await assertDownloadUrlAllowed(download, opts.cdpUrl, opts.ssrfPolicy);
        if (state.armIdDownload !== armId) throw new Error('Download was superseded by another waiter');
        return await saveDownloadPayload(download, savePath, waiter);
      });
    },
  });
}
