import type { Page } from 'playwright-core';
import { describe, it, expect, vi } from 'vitest';

import { appendSnapshotUrls, collectSnapshotUrls } from './snapshot-urls.js';

describe('appendSnapshotUrls', () => {
  it('returns the snapshot unchanged when there are no urls', () => {
    expect(appendSnapshotUrls('- link "Home"', [])).toBe('- link "Home"');
  });

  it('appends a numbered Links block', () => {
    const out = appendSnapshotUrls('SNAP', [
      { text: 'Home', url: 'https://x/' },
      { text: 'Pricing', url: 'https://x/p' },
    ]);
    expect(out).toBe('SNAP\n\nLinks:\n1. Home -> https://x/\n2. Pricing -> https://x/p');
  });
});

describe('collectSnapshotUrls', () => {
  it('strips control chars from page-controlled text and urls', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue([{ text: 'a\nb', url: 'https://x/\n' }]) } as unknown as Page;
    expect(await collectSnapshotUrls(page)).toEqual([{ text: 'a b', url: 'https://x/' }]);
  });

  it('returns [] when the page evaluation fails', async () => {
    const page = { evaluate: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as Page;
    expect(await collectSnapshotUrls(page)).toEqual([]);
  });
});
