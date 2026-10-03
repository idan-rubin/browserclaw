import type { Page } from 'playwright-core';
import { afterEach, describe, it, expect, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';
import * as security from '../security.js';

const { mockGetPageForTargetId, mockTryTerminateExecutionForPage } = vi.hoisted(() => ({
  mockGetPageForTargetId: vi.fn<(opts: unknown) => Promise<Page>>(),
  mockTryTerminateExecutionForPage: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('../connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    getPageForTargetId: mockGetPageForTargetId,
    tryTerminateExecutionForPage: mockTryTerminateExecutionForPage,
  };
});

const { evaluateInAllFramesViaPlaywright } = await import('./evaluate.js');

afterEach(() => vi.restoreAllMocks());

describe('evaluateInAllFramesViaPlaywright — per-frame SSRF validation', () => {
  it('applies the total timeout to frame policy validation', async () => {
    const frame = {
      url: () => 'https://93.184.216.34/slow',
      name: () => 'slow',
      evaluate: vi.fn(),
    };
    mockGetPageForTargetId.mockResolvedValue({ url: () => 'about:blank', frames: () => [frame] } as unknown as Page);
    const original = security.assertBrowserNavigationResultAllowed;
    vi.spyOn(security, 'assertBrowserNavigationResultAllowed').mockImplementation((opts) =>
      opts.url.endsWith('/slow') ? new Promise<void>(() => undefined) : original(opts),
    );

    await expect(
      evaluateInAllFramesViaPlaywright({ cdpUrl: 'http://localhost:9222', fn: '() => 1', timeoutMs: 500 }),
    ).rejects.toThrow('All-frame evaluate timed out after 500ms');
    expect(frame.evaluate).not.toHaveBeenCalled();
  });

  it('does not terminate page execution when post-evaluation validation times out', async () => {
    mockTryTerminateExecutionForPage.mockClear();
    let url = 'about:blank';
    const frame = {
      url: () => url,
      name: () => 'main',
      evaluate: vi.fn().mockImplementation(() => {
        url = 'https://93.184.216.34/slow';
        return Promise.resolve(1);
      }),
    };
    mockGetPageForTargetId.mockResolvedValue({ url: () => 'about:blank', frames: () => [frame] } as unknown as Page);
    const original = security.assertBrowserNavigationResultAllowed;
    vi.spyOn(security, 'assertBrowserNavigationResultAllowed').mockImplementation((opts) =>
      opts.url.endsWith('/slow') ? new Promise<void>(() => undefined) : original(opts),
    );

    await expect(
      evaluateInAllFramesViaPlaywright({
        cdpUrl: 'http://localhost:9222',
        targetId: 'T1',
        fn: '() => 1',
        timeoutMs: 500,
      }),
    ).rejects.toThrow('All-frame evaluate timed out after 500ms');
    expect(frame.evaluate).toHaveBeenCalledOnce();
    expect(mockTryTerminateExecutionForPage).not.toHaveBeenCalled();
  });

  it('does not log blocked frame URL credentials or query tokens', async () => {
    const frame = {
      url: () => 'http://user:password@169.254.169.254/?token=secret',
      name: () => 'blocked',
      evaluate: vi.fn(),
    };
    mockGetPageForTargetId.mockResolvedValue({ url: () => 'about:blank', frames: () => [frame] } as unknown as Page);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(evaluateInAllFramesViaPlaywright({ cdpUrl: 'http://localhost:9222', fn: '() => 1' })).resolves.toEqual(
      [],
    );
    expect(warn).toHaveBeenCalledWith('[browserclaw] skipping SSRF-blocked frame');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('password');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });

  it('bounds a frame whose Playwright evaluation never settles', async () => {
    mockTryTerminateExecutionForPage.mockClear();
    const frame = {
      url: () => 'about:blank',
      name: () => 'main',
      evaluate: vi.fn(() => new Promise<never>(() => undefined)),
    };
    mockGetPageForTargetId.mockResolvedValue({ url: () => 'about:blank', frames: () => [frame] } as unknown as Page);

    await expect(
      evaluateInAllFramesViaPlaywright({
        cdpUrl: 'http://localhost:9222',
        targetId: 'T1',
        fn: '() => 1',
        timeoutMs: 500,
      }),
    ).rejects.toThrow('All-frame evaluate timed out after 500ms');
    expect(frame.evaluate).toHaveBeenCalledOnce();
    expect(mockTryTerminateExecutionForPage).toHaveBeenCalledWith(
      expect.objectContaining({ cdpUrl: 'http://localhost:9222', targetId: 'T1' }),
    );
  });

  it('uses the shared evaluator for statement-form code', async () => {
    const frame = {
      url: () => 'about:blank',
      name: () => 'main',
      evaluate: vi.fn(
        (
          evaluator: (args: { fnBody: string; timeoutMs: number }) => unknown,
          args: { fnBody: string; timeoutMs: number },
        ) => Promise.resolve(evaluator(args)),
      ),
    };
    mockGetPageForTargetId.mockResolvedValue({ url: () => 'about:blank', frames: () => [frame] } as unknown as Page);

    await expect(
      evaluateInAllFramesViaPlaywright({ cdpUrl: 'http://localhost:9222', fn: 'const value = 40; value + 2' }),
    ).resolves.toEqual([{ frameUrl: 'about:blank', frameName: 'main', result: 42 }]);
  });

  it.each([undefined, {}])('skips an SSRF-blocked frame with policy %j', async (ssrfPolicy) => {
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
      ssrfPolicy,
    });

    expect(publicFrame.evaluate).toHaveBeenCalledTimes(1);
    expect(metadataFrame.evaluate).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].frameUrl).toBe('http://93.184.216.34/');
  });
});
