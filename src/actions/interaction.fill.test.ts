import type { Page, Locator } from 'playwright-core';
import { describe, it, expect, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';
import { NavigationRaceError } from '../errors.js';

const { mockGetRestoredPageForTarget, mockRefLocator, mockResolveTimeout } = vi.hoisted(() => ({
  mockGetRestoredPageForTarget: vi.fn<(opts: unknown) => Promise<Page>>(),
  mockRefLocator: vi.fn(),
  mockResolveTimeout: vi.fn<() => number>(() => 5000),
}));

vi.mock('../connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    getRestoredPageForTarget: mockGetRestoredPageForTarget,
    refLocator: mockRefLocator,
    resolveInteractionTimeoutMs: mockResolveTimeout,
  };
});

const { fillFormViaPlaywright } = await import('./interaction.js');

describe('fillFormViaPlaywright — mid-fill navigation', () => {
  it('throws NavigationRaceError instead of silently returning after a benign mid-fill navigation', async () => {
    let url = 'http://93.184.216.34/form';
    const page = {
      url: () => url,
      on: () => undefined,
      off: () => undefined,
      mainFrame: () => ({}),
    } as unknown as Page;
    mockGetRestoredPageForTarget.mockResolvedValue(page);

    let fillCalls = 0;
    const locator = {
      fill: vi.fn(() => {
        fillCalls += 1;
        if (fillCalls === 1) url = 'http://93.184.216.34/done';
        return Promise.resolve();
      }),
      setChecked: vi.fn(() => Promise.resolve()),
    } as unknown as Locator;
    mockRefLocator.mockReturnValue(locator);

    await expect(
      fillFormViaPlaywright({
        cdpUrl: 'http://localhost:9222',
        fields: [
          { ref: 'e1', value: 'a' },
          { ref: 'e2', value: 'b' },
        ],
      }),
    ).rejects.toBeInstanceOf(NavigationRaceError);
  });
});
