import type { Page } from 'playwright-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NavigationRaceError, SnapshotHydrationError } from '../errors.js';

vi.mock('../actions/navigation.js', () => ({
  assertPageNavigationCompletedSafely: () => Promise.resolve(),
}));

vi.mock('./dom-enrichment.js', () => ({
  enrichSnapshotFromDom: () => Promise.resolve({ refs: {}, additions: [] }),
  mergeSnapshotWithEnrichment: (built: unknown) => built,
  nextRefCounter: () => 1,
}));

const { mockGetPageForTargetId, mockTakeAiSnapshotText, mockStoreRoleRefsForTarget } = vi.hoisted(() => ({
  mockGetPageForTargetId: vi.fn<(opts: unknown) => Promise<Page>>(),
  mockTakeAiSnapshotText: vi.fn<(page: Page, timeoutMs: number) => Promise<string>>(),
  mockStoreRoleRefsForTarget: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  getPageForTargetId: mockGetPageForTargetId,
  ensurePageState: () => ({}),
  storeRoleRefsForTarget: mockStoreRoleRefsForTarget,
  normalizeTimeoutMs: (timeoutMs: number | undefined, fallback: number) => timeoutMs ?? fallback,
  takeAiSnapshotText: mockTakeAiSnapshotText,
}));

const { snapshotAi } = await import('./ai-snapshot.js');

function makeMockPage(urls: string[]): Page {
  let i = 0;
  return {
    url: () => urls[Math.min(i++, urls.length - 1)] ?? '',
  } as unknown as Page;
}

describe('snapshotAi hydration retry', () => {
  beforeEach(() => {
    mockGetPageForTargetId.mockReset();
    mockTakeAiSnapshotText.mockReset();
    mockStoreRoleRefsForTarget.mockReset();
  });

  it('returns immediately when waitForHydration is disabled, even with empty snapshot', async () => {
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://example.test/']));
    mockTakeAiSnapshotText.mockResolvedValue('');

    const result = await snapshotAi({ cdpUrl: 'http://localhost:9222', targetId: 't1' });

    expect(mockTakeAiSnapshotText).toHaveBeenCalledTimes(1);
    expect(result.refs).toEqual({});
  });

  it('retries until interactive refs appear when waitForHydration is enabled', async () => {
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://example.test/']));
    mockTakeAiSnapshotText
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('- button "OK" [ref=e1]');

    const result = await snapshotAi({
      cdpUrl: 'http://localhost:9222',
      targetId: 't1',
      options: { waitForHydration: 2000 },
    });

    expect(mockTakeAiSnapshotText).toHaveBeenCalledTimes(3);
    expect(Object.keys(result.refs).length).toBeGreaterThan(0);
  });

  it('throws SnapshotHydrationError when budget exhausts without interactive refs', async () => {
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://example.test/']));
    mockTakeAiSnapshotText.mockResolvedValue('');

    await expect(
      snapshotAi({
        cdpUrl: 'http://localhost:9222',
        targetId: 't1',
        options: { waitForHydration: 250 },
      }),
    ).rejects.toBeInstanceOf(SnapshotHydrationError);
  });

  it('throws NavigationRaceError when URL changes during hydration retry', async () => {
    // First call captures sourceUrl=A, then page.url() returns B on the next read.
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://a.test/', 'https://a.test/', 'https://b.test/']));
    mockTakeAiSnapshotText.mockResolvedValue('');

    await expect(
      snapshotAi({
        cdpUrl: 'http://localhost:9222',
        targetId: 't1',
        options: { waitForHydration: 2000 },
      }),
    ).rejects.toBeInstanceOf(NavigationRaceError);
  });
});
