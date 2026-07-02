import type { Page } from 'playwright-core';
import { describe, it, expect } from 'vitest';

import { assertInteractionNavigationCompletedSafely } from './navigation.js';

const START_URL = 'https://start.example/page';

function makeFakePage(): Page & { setUrl: (u: string) => void } {
  let current = START_URL;
  const page = {
    url: () => current,
    on: () => undefined,
    off: () => undefined,
    mainFrame: () => ({}),
    close: () => Promise.resolve(),
    setUrl: (u: string) => {
      current = u;
    },
  };
  return page as unknown as Page & { setUrl: (u: string) => void };
}

describe('assertInteractionNavigationCompletedSafely — secure by default', () => {
  it('blocks an interaction-triggered navigation to a private/metadata address with no policy', async () => {
    const page = makeFakePage();
    await expect(
      assertInteractionNavigationCompletedSafely({
        action: () => {
          page.setUrl('http://169.254.169.254/latest/meta-data/');
          return Promise.resolve();
        },
        cdpUrl: 'http://localhost:9222',
        page,
        previousUrl: START_URL,
      }),
    ).rejects.toThrow();
  });

  it('allows an interaction-triggered navigation to a public address (non-vacuous control)', async () => {
    const page = makeFakePage();
    await expect(
      assertInteractionNavigationCompletedSafely({
        action: () => {
          page.setUrl('http://93.184.216.34/');
          return Promise.resolve();
        },
        cdpUrl: 'http://localhost:9222',
        page,
        previousUrl: START_URL,
      }),
    ).resolves.toBeUndefined();
  });

  it('does not block an interaction that triggers no navigation (no over-blocking)', async () => {
    const page = makeFakePage();
    const result = await assertInteractionNavigationCompletedSafely({
      action: () => Promise.resolve('clicked'),
      cdpUrl: 'http://localhost:9222',
      page,
      previousUrl: START_URL,
    });
    expect(result).toBe('clicked');
  });
});
