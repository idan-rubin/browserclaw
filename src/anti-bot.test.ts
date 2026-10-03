import type { Page } from 'playwright-core';
import { describe, it, expect, vi } from 'vitest';

import type * as ConnectionModule from './connection.js';

const { mockGetPageForTargetId, mockEnsurePageState, mockNormalizeTimeoutMs, mockAssertSelectedPageAllowed } =
  vi.hoisted(() => ({
    mockGetPageForTargetId: vi.fn<(opts: unknown) => Promise<Page>>(),
    mockEnsurePageState: vi.fn<(page: unknown) => Record<string, unknown>>(),
    mockNormalizeTimeoutMs: vi.fn<() => number>(),
    mockAssertSelectedPageAllowed: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  }));

vi.mock('./connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    getPageForTargetId: mockGetPageForTargetId,
    ensurePageState: mockEnsurePageState,
    normalizeTimeoutMs: mockNormalizeTimeoutMs,
    assertSelectedPageAllowed: mockAssertSelectedPageAllowed,
  };
});

const { detectChallengeViaPlaywright, waitForChallengeViaPlaywright } = await import('./anti-bot.js');

describe('waitForChallengeViaPlaywright — evaluate error handling', () => {
  it('forwards the caller policy before challenge detection reads the page', async () => {
    const policy = { dangerouslyAllowPrivateNetwork: false };
    const page = { evaluate: vi.fn().mockResolvedValue(null) } as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(page);
    mockEnsurePageState.mockReturnValue({});

    await detectChallengeViaPlaywright({ cdpUrl: 'http://localhost:9222', targetId: 'T1', ssrfPolicy: policy });
    expect(mockGetPageForTargetId).toHaveBeenCalledWith({
      cdpUrl: 'http://localhost:9222',
      targetId: 'T1',
      ssrfPolicy: policy,
    });
  });

  it('propagates a non-navigation evaluate error instead of reporting the challenge cleared', async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error('Target page, context or browser has been closed'));
    const page = { evaluate, waitForLoadState: vi.fn().mockResolvedValue(undefined) } as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(page);
    mockEnsurePageState.mockReturnValue({});
    mockNormalizeTimeoutMs.mockReturnValue(15000);

    await expect(waitForChallengeViaPlaywright({ cdpUrl: 'http://localhost:9222' })).rejects.toThrow(/closed/i);
  });

  it('treats a navigation-race context-destroyed error as the challenge clearing', async () => {
    mockAssertSelectedPageAllowed.mockClear();
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation.'))
      .mockResolvedValueOnce(null);
    const page = { evaluate, waitForLoadState: vi.fn().mockResolvedValue(undefined) } as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(page);
    mockEnsurePageState.mockReturnValue({});
    mockNormalizeTimeoutMs.mockReturnValue(15000);

    const result = await waitForChallengeViaPlaywright({ cdpUrl: 'http://localhost:9222' });
    expect(result).toEqual({ resolved: true, challenge: null });
    expect(mockAssertSelectedPageAllowed).toHaveBeenCalledTimes(2);
  });
});
