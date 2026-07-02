import type { Page } from 'playwright-core';
import { describe, it, expect, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';

const { mockGetPageForTargetId } = vi.hoisted(() => ({
  mockGetPageForTargetId: vi.fn<(opts: unknown) => Promise<Page>>(),
}));

vi.mock('../connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return { ...actual, getPageForTargetId: mockGetPageForTargetId };
});

const { evaluateInAllFramesViaPlaywright } = await import('./evaluate.js');

describe('evaluateInAllFramesViaPlaywright — per-frame SSRF validation', () => {
  it('skips an SSRF-blocked frame and evaluates only allowed frames', async () => {
    const publicFrame = {
      url: () => 'http://93.184.216.34/',
      name: () => 'main',
      evaluate: vi.fn().mockResolvedValue(1),
    };
    const metadataFrame = {
      url: () => 'http://169.254.169.254/',
      name: () => 'meta',
      evaluate: vi.fn().mockResolvedValue('secret'),
    };
    const page = {
      url: () => 'http://93.184.216.34/',
      frames: () => [publicFrame, metadataFrame],
    } as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(page);

    const results = await evaluateInAllFramesViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      fn: '() => 1',
      ssrfPolicy: {},
    });

    expect(publicFrame.evaluate).toHaveBeenCalledTimes(1);
    expect(metadataFrame.evaluate).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].frameUrl).toBe('http://93.184.216.34/');
  });
});
