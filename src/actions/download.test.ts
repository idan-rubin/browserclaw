import type { Page } from 'playwright-core';
import { describe, it, expect, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';

const { mockGetPageForTargetId, mockEnsurePageState, mockRefLocator, mockNormalizeTimeoutMs, mockBumpDownloadArmId } =
  vi.hoisted(() => ({
    mockGetPageForTargetId: vi.fn<(opts: unknown) => Promise<Page>>(),
    mockEnsurePageState: vi.fn<(page: unknown) => Record<string, number>>(),
    mockRefLocator: vi.fn(),
    mockNormalizeTimeoutMs: vi.fn<() => number>(),
    mockBumpDownloadArmId: vi.fn<() => number>(),
  }));

vi.mock('../connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    getPageForTargetId: mockGetPageForTargetId,
    ensurePageState: mockEnsurePageState,
    refLocator: mockRefLocator,
    normalizeTimeoutMs: mockNormalizeTimeoutMs,
    bumpDownloadArmId: mockBumpDownloadArmId,
    toAIFriendlyError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  };
});

const { downloadViaPlaywright } = await import('./download.js');

describe('downloadViaPlaywright — waiter rejection safety', () => {
  it('does not emit an unhandledRejection when the click fails after the waiter timeout', async () => {
    const fakePage = { on: () => undefined, off: () => undefined } as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(fakePage);
    mockEnsurePageState.mockReturnValue({});
    mockBumpDownloadArmId.mockReturnValue(1);
    mockNormalizeTimeoutMs.mockReturnValue(50);
    // Click hangs past the 50ms waiter timeout, then rejects. The waiter's
    // timeout fires first, on a promise the caller has not yet awaited.
    mockRefLocator.mockReturnValue({
      click: () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => {
            reject(new Error('click timeout'));
          }, 120),
        ),
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        downloadViaPlaywright({
          cdpUrl: 'http://localhost:9222',
          ref: 'e1',
          path: '/tmp/browserclaw-download-test.bin',
        }),
      ).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

const { waitForDownloadViaPlaywright, isDownloadStartingNavigationError } = await import('./download.js');

describe('isDownloadStartingNavigationError', () => {
  it('matches the Playwright download-start message', () => {
    expect(isDownloadStartingNavigationError(new Error('page.goto: Download is starting'))).toBe(true);
  });

  it('matches net::ERR_ABORTED only when the message includes the expected URL', () => {
    const err = new Error('page.goto: net::ERR_ABORTED at https://example.com/file.zip');
    expect(isDownloadStartingNavigationError(err, 'https://example.com/file.zip')).toBe(true);
    expect(isDownloadStartingNavigationError(err, 'https://other.com/file.zip')).toBe(false);
    expect(isDownloadStartingNavigationError(err)).toBe(false);
  });

  it('rejects unrelated errors', () => {
    expect(isDownloadStartingNavigationError(new Error('boom'), 'https://example.com')).toBe(false);
  });
});

describe('download URL validation before saving bytes', () => {
  function pageWithDownloadEmitter(): { page: Page; emit: (download: unknown) => void } {
    let downloadHandler: ((download: unknown) => void) | undefined;
    const page = {
      on: (event: string, handler: (download: unknown) => void) => {
        if (event === 'download') downloadHandler = handler;
      },
      off: () => undefined,
    } as unknown as Page;
    return {
      page,
      emit: (download: unknown) => {
        downloadHandler?.(download);
      },
    };
  }

  it('rejects a policy-blocked download URL without calling saveAs', async () => {
    const { page, emit } = pageWithDownloadEmitter();
    mockGetPageForTargetId.mockResolvedValue(page);
    mockEnsurePageState.mockReturnValue({ armIdDownload: 0, downloadWaiterDepth: 0 });
    mockBumpDownloadArmId.mockReturnValue(1);
    mockNormalizeTimeoutMs.mockReturnValue(1000);
    const saveAs = vi.fn(() => Promise.resolve());
    const fakeDownload = {
      url: () => 'data:text/plain,exfiltrated',
      suggestedFilename: () => 'file.bin',
      saveAs,
    };

    const pending = waitForDownloadViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      path: '/tmp/browserclaw-download-validate.bin',
      ssrfPolicy: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit(fakeDownload);
    await expect(pending).rejects.toThrow('Navigation result blocked');
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('saves the same download when no policy is provided (control)', async () => {
    const { mkdtempSync, writeFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'bc-dl-test-'));
    const outPath = join(dir, 'file.bin');

    const { page, emit } = pageWithDownloadEmitter();
    mockGetPageForTargetId.mockResolvedValue(page);
    mockEnsurePageState.mockReturnValue({ armIdDownload: 0, downloadWaiterDepth: 0 });
    mockBumpDownloadArmId.mockReturnValue(1);
    mockNormalizeTimeoutMs.mockReturnValue(1000);
    const saveAs = vi.fn((tempPath: string) => {
      writeFileSync(tempPath, 'payload');
      return Promise.resolve();
    });
    const fakeDownload = {
      url: () => 'data:text/plain,exfiltrated',
      suggestedFilename: () => 'file.bin',
      saveAs,
    };

    const pending = waitForDownloadViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      path: outPath,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    emit(fakeDownload);
    const result = await pending;
    expect(saveAs).toHaveBeenCalledTimes(1);
    expect(result.path).toBe(outPath);
    expect(existsSync(outPath)).toBe(true);
  });
});

const { armNavigationDownloadCapture } = await import('./download.js');

describe('armNavigationDownloadCapture — secure-by-default URL validation', () => {
  function pageWithDownloadEmitter(): { page: Page; emit: (download: unknown) => void } {
    let downloadHandler: ((download: unknown) => void) | undefined;
    const page = {
      on: (event: string, handler: (download: unknown) => void) => {
        if (event === 'download') downloadHandler = handler;
      },
      off: () => undefined,
    } as unknown as Page;
    return { page, emit: (d: unknown) => downloadHandler?.(d) };
  }

  function makeState() {
    return {
      armIdDownload: 0,
      downloadWaiterDepth: 0,
    } as unknown as import('../types.js').PageState;
  }

  it('blocks a data: download URL even when no ssrfPolicy is set', async () => {
    const { page, emit } = pageWithDownloadEmitter();
    const capture = armNavigationDownloadCapture(page, makeState(), 1000, 'https://example.com/page');
    expect(capture.armed).toBe(true);
    emit({ url: () => 'data:text/plain,exfil', suggestedFilename: () => 'x.bin', saveAs: vi.fn() });
    await expect(capture.promise).rejects.toThrow(/data:|not allowed/i);
  });

  it('blocks a private-host download URL with no policy (secure-by-default)', async () => {
    const { page, emit } = pageWithDownloadEmitter();
    const saveAs = vi.fn(() => Promise.resolve());
    const capture = armNavigationDownloadCapture(page, makeState(), 1000, 'https://example.com/page');
    emit({ url: () => 'http://169.254.169.254/latest/meta-data', suggestedFilename: () => 'x.bin', saveAs });
    await expect(capture.promise).rejects.toThrow();
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('falls back to the navigation URL when the download URL is empty', async () => {
    const { page, emit } = pageWithDownloadEmitter();
    const saveAs = vi.fn(() => Promise.resolve());
    const capture = armNavigationDownloadCapture(page, makeState(), 1000, 'http://169.254.169.254/');
    emit({ url: () => '', suggestedFilename: () => 'x.bin', saveAs });
    await expect(capture.promise).rejects.toThrow();
    expect(saveAs).not.toHaveBeenCalled();
  });

  it('is not armed when an explicit download waiter is already active', () => {
    const { page } = pageWithDownloadEmitter();
    const state = makeState();
    (state as { downloadWaiterDepth: number }).downloadWaiterDepth = 1;
    const capture = armNavigationDownloadCapture(page, state, 1000, 'https://example.com/');
    expect(capture.armed).toBe(false);
  });
});
