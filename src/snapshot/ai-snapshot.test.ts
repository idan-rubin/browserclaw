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

  it('throws NavigationRaceError when URL changes between retries during hydration', async () => {
    // page.url() is called at: entry (initial), post-snapshot (snapshotUrl),
    // post-enrichment (postEnrichUrl), post-sleep (waitUrl). We keep the
    // first three aligned so the check fires on the post-sleep waitUrl,
    // exercising the between-retries race path.
    mockGetPageForTargetId.mockResolvedValue(
      makeMockPage(['https://a.test/', 'https://a.test/', 'https://a.test/', 'https://b.test/']),
    );
    mockTakeAiSnapshotText.mockResolvedValue('');

    await expect(
      snapshotAi({
        cdpUrl: 'http://localhost:9222',
        targetId: 't1',
        options: { waitForHydration: 2000 },
      }),
    ).rejects.toBeInstanceOf(NavigationRaceError);
  });

  it('throws NavigationRaceError before returning when URL drifted during the snapshot itself', async () => {
    // initialUrl=A, then snapshotUrl=B — the page navigated while takeAiSnapshotText ran.
    // Even though the snapshot has interactive refs, we must not return stale sourceUrl.
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://a.test/', 'https://b.test/']));
    mockTakeAiSnapshotText.mockResolvedValue('- button "OK" [ref=e1]');

    await expect(
      snapshotAi({
        cdpUrl: 'http://localhost:9222',
        targetId: 't1',
        options: { waitForHydration: 2000 },
      }),
    ).rejects.toBeInstanceOf(NavigationRaceError);
  });

  it('throws NavigationRaceError when URL drifts during DOM enrichment', async () => {
    // initialUrl=A, snapshotUrl=A (no drift during takeAiSnapshotText), then
    // postEnrichUrl=B — the page navigated while enrichSnapshotFromDom ran.
    // Without this check, we'd merge AI-snapshot refs (from A) with
    // DOM-enrichment data (from B) and return/store the inconsistent result.
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://a.test/', 'https://a.test/', 'https://b.test/']));
    mockTakeAiSnapshotText.mockResolvedValue('- button "OK" [ref=e1]');

    await expect(
      snapshotAi({
        cdpUrl: 'http://localhost:9222',
        targetId: 't1',
        options: { waitForHydration: 2000 },
      }),
    ).rejects.toBeInstanceOf(NavigationRaceError);

    // And the ref cache must not have been stamped.
    expect(mockStoreRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it('threads ssrfPolicy into getPageForTargetId', async () => {
    const policy = { dangerouslyAllowPrivateNetwork: false };
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://example.test/']));
    mockTakeAiSnapshotText.mockResolvedValue('');

    await snapshotAi({ cdpUrl: 'http://localhost:9222', targetId: 't1', ssrfPolicy: policy });

    expect(mockGetPageForTargetId).toHaveBeenCalledWith({
      cdpUrl: 'http://localhost:9222',
      targetId: 't1',
      ssrfPolicy: policy,
    });
  });

  it('records the snapshot-time URL in contentMeta, not the initial URL', async () => {
    // Without hydration, a mid-snapshot redirect is not a race — but the metadata
    // should still reflect the document the refs were actually built against.
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://a.test/', 'https://b.test/']));
    mockTakeAiSnapshotText.mockResolvedValue('- button "OK" [ref=e1]');

    const result = await snapshotAi({ cdpUrl: 'http://localhost:9222', targetId: 't1' });

    expect(result.contentMeta?.sourceUrl).toBe('https://b.test/');
  });

  it('does not poison the per-target ref cache when NavigationRaceError is thrown', async () => {
    // If we threw a race error but still called storeRoleRefsForTarget, a caller
    // that caught and retried without re-snapshotting could target refs bound
    // to a discarded document. The store must only happen on success.
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://a.test/', 'https://b.test/']));
    mockTakeAiSnapshotText.mockResolvedValue('- button "OK" [ref=e1]');

    await expect(
      snapshotAi({
        cdpUrl: 'http://localhost:9222',
        targetId: 't1',
        options: { waitForHydration: 2000 },
      }),
    ).rejects.toBeInstanceOf(NavigationRaceError);

    expect(mockStoreRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it('does not store refs on retry iterations, only on the returned snapshot', async () => {
    // Two empty iterations then a ready one. Previously we'd call store 3 times
    // (once per iteration); now we only call it on the final success.
    mockGetPageForTargetId.mockResolvedValue(makeMockPage(['https://a.test/']));
    mockTakeAiSnapshotText
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('- button "OK" [ref=e1]');

    await snapshotAi({
      cdpUrl: 'http://localhost:9222',
      targetId: 't1',
      options: { waitForHydration: 2000 },
    });

    expect(mockStoreRoleRefsForTarget).toHaveBeenCalledTimes(1);
  });
});
