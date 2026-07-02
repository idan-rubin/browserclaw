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
