import type { Page } from 'playwright-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type * as InteractionModule from './actions/interaction.js';
import type * as ScreenshotModule from './capture/screenshot.js';
import type * as ConnectionModule from './connection.js';
import { BrowserTabNotFoundError } from './errors.js';

const {
  mockGetPageForTargetId,
  mockResolveActiveTargetId,
  mockPageTargetId,
  mockClickViaPlaywright,
  mockTakeScreenshotViaPlaywright,
} = vi.hoisted(() => ({
  mockGetPageForTargetId: vi.fn<(opts: { cdpUrl: string; targetId?: string; ssrfPolicy?: unknown }) => Promise<Page>>(),
  mockResolveActiveTargetId:
    vi.fn<
      (
        cdpUrl: string,
        opts?: { preferTargetId?: string; preferUrl?: string; ssrfPolicy?: unknown },
      ) => Promise<string | null>
    >(),
  mockPageTargetId: vi.fn<(page: Page) => Promise<string | null>>(),
  mockClickViaPlaywright: vi.fn<(opts: Record<string, unknown>) => Promise<void>>(),
  mockTakeScreenshotViaPlaywright: vi.fn<(opts: Record<string, unknown>) => Promise<{ buffer: Buffer }>>(),
}));

vi.mock('./connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    getPageForTargetId: mockGetPageForTargetId,
    resolveActiveTargetId: mockResolveActiveTargetId,
    pageTargetId: mockPageTargetId,
    connectBrowser: () => Promise.resolve({ browser: {}, cdpUrl: 'http://localhost:9222' }),
  };
});

vi.mock('./actions/interaction.js', async (importOriginal) => {
  const actual = await importOriginal<typeof InteractionModule>();
  return {
    ...actual,
    clickViaPlaywright: mockClickViaPlaywright,
  };
});

vi.mock('./capture/screenshot.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ScreenshotModule>();
  return {
    ...actual,
    takeScreenshotViaPlaywright: mockTakeScreenshotViaPlaywright,
  };
});

const { CrawlPage } = await import('./browser.js');

describe('CrawlPage.reacquire', () => {
  beforeEach(() => {
    mockGetPageForTargetId.mockReset();
    mockResolveActiveTargetId.mockReset();
    mockPageTargetId.mockReset();
  });

  it('threads ssrfPolicy through to resolveActiveTargetId', async () => {
    const policy = { dangerouslyAllowPrivateNetwork: false };
    const fakePage = { url: () => 'https://app.example.test/' } as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(fakePage);
    mockResolveActiveTargetId.mockResolvedValue('t-new');

    const page = new CrawlPage('http://localhost:9222', 't-old', policy);
    await page.reacquire();

    expect(mockResolveActiveTargetId).toHaveBeenCalledTimes(1);
    const args = mockResolveActiveTargetId.mock.calls[0];
    expect(args[0]).toBe('http://localhost:9222');
    expect(args[1]?.ssrfPolicy).toBe(policy);
  });

  it('captures the page URL and passes it as preferUrl', async () => {
    const fakePage = { url: () => 'https://app.example.test/dashboard' } as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(fakePage);
    mockResolveActiveTargetId.mockResolvedValue('t-new');

    const page = new CrawlPage('http://localhost:9222', 't-old');
    await page.reacquire();

    const args = mockResolveActiveTargetId.mock.calls[0];
    expect(args[1]?.preferTargetId).toBe('t-old');
    expect(args[1]?.preferUrl).toBe('https://app.example.test/dashboard');
  });

  it('still recovers when the original target is gone', async () => {
    mockGetPageForTargetId.mockRejectedValue(new BrowserTabNotFoundError());
    mockResolveActiveTargetId.mockResolvedValue('t-new');

    const page = new CrawlPage('http://localhost:9222', 't-gone');
    const recovered = await page.reacquire();

    expect(recovered).toBe('t-new');
    const args = mockResolveActiveTargetId.mock.calls[0];
    expect(args[1]?.preferTargetId).toBe('t-gone');
    expect(args[1]?.preferUrl).toBeUndefined();
  });

  it('does not pass about:blank as preferUrl', async () => {
    const fakePage = { url: () => 'about:blank' } as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(fakePage);
    mockResolveActiveTargetId.mockResolvedValue('t-new');

    const page = new CrawlPage('http://localhost:9222', 't-old');
    await page.reacquire();

    const args = mockResolveActiveTargetId.mock.calls[0];
    expect(args[1]?.preferUrl).toBeUndefined();
  });

  it('throws BrowserTabNotFoundError when no pages are available', async () => {
    mockGetPageForTargetId.mockRejectedValue(new BrowserTabNotFoundError());
    mockResolveActiveTargetId.mockResolvedValue(null);

    const page = new CrawlPage('http://localhost:9222', 't-old');
    await expect(page.reacquire()).rejects.toBeInstanceOf(BrowserTabNotFoundError);
  });
});

describe('CrawlPage.refreshTargetId', () => {
  beforeEach(() => {
    mockGetPageForTargetId.mockReset();
    mockResolveActiveTargetId.mockReset();
    mockPageTargetId.mockReset();
  });

  it('threads ssrfPolicy through to getPageForTargetId on the happy path', async () => {
    const policy = { dangerouslyAllowPrivateNetwork: false };
    const fakePage = {} as unknown as Page;
    mockGetPageForTargetId.mockResolvedValue(fakePage);
    mockPageTargetId.mockResolvedValue('t-old');

    const page = new CrawlPage('http://localhost:9222', 't-old', policy);
    await page.refreshTargetId();

    expect(mockGetPageForTargetId).toHaveBeenCalledWith({
      cdpUrl: 'http://localhost:9222',
      targetId: 't-old',
      ssrfPolicy: policy,
    });
  });

  it('threads ssrfPolicy through to resolveActiveTargetId on the active fallback', async () => {
    const policy = { dangerouslyAllowPrivateNetwork: false };
    mockGetPageForTargetId.mockRejectedValue(new BrowserTabNotFoundError());
    mockResolveActiveTargetId.mockResolvedValue('t-new');

    const page = new CrawlPage('http://localhost:9222', 't-old', policy);
    await page.refreshTargetId({ fallback: 'active' });

    expect(mockResolveActiveTargetId).toHaveBeenCalledWith('http://localhost:9222', { ssrfPolicy: policy });
  });

  it('rethrows when no fallback is requested', async () => {
    mockGetPageForTargetId.mockRejectedValue(new BrowserTabNotFoundError('gone'));

    const page = new CrawlPage('http://localhost:9222', 't-old');
    await expect(page.refreshTargetId()).rejects.toBeInstanceOf(BrowserTabNotFoundError);
  });
});

describe('CrawlPage click — AbortSignal forwarding', () => {
  beforeEach(() => {
    mockClickViaPlaywright.mockReset();
    mockClickViaPlaywright.mockResolvedValue(undefined);
  });

  it('forwards the signal from click(ref, { signal }) to clickViaPlaywright', async () => {
    const controller = new AbortController();
    const page = new CrawlPage('http://localhost:9222', 't-1');

    await page.click('e4', { signal: controller.signal });

    expect(mockClickViaPlaywright).toHaveBeenCalledTimes(1);
    expect(mockClickViaPlaywright.mock.calls[0]?.[0]).toMatchObject({
      ref: 'e4',
      signal: controller.signal,
    });
  });

  it('forwards the signal from clickBySelector(selector, { signal }) to clickViaPlaywright', async () => {
    const controller = new AbortController();
    const page = new CrawlPage('http://localhost:9222', 't-1');

    await page.clickBySelector('button.submit', { signal: controller.signal });

    expect(mockClickViaPlaywright).toHaveBeenCalledTimes(1);
    expect(mockClickViaPlaywright.mock.calls[0]?.[0]).toMatchObject({
      selector: 'button.submit',
      signal: controller.signal,
    });
  });

  it('passes signal: undefined when omitted', async () => {
    const page = new CrawlPage('http://localhost:9222', 't-1');

    await page.click('e4');

    expect(mockClickViaPlaywright).toHaveBeenCalledTimes(1);
    expect(mockClickViaPlaywright.mock.calls[0]?.[0]).toMatchObject({ signal: undefined });
  });
});

describe('CrawlPage.screenshot — timeoutMs forwarding', () => {
  beforeEach(() => {
    mockTakeScreenshotViaPlaywright.mockReset();
    mockTakeScreenshotViaPlaywright.mockResolvedValue({ buffer: Buffer.from('') });
  });

  it('forwards timeoutMs to takeScreenshotViaPlaywright', async () => {
    const page = new CrawlPage('http://localhost:9222', 't-1');
    await page.screenshot({ timeoutMs: 5000 });
    expect(mockTakeScreenshotViaPlaywright).toHaveBeenCalledTimes(1);
    expect(mockTakeScreenshotViaPlaywright.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: 5000 });
  });

  it('passes timeoutMs: undefined when omitted', async () => {
    const page = new CrawlPage('http://localhost:9222', 't-1');
    await page.screenshot();
    expect(mockTakeScreenshotViaPlaywright).toHaveBeenCalledTimes(1);
    expect(mockTakeScreenshotViaPlaywright.mock.calls[0]?.[0]).toMatchObject({ timeoutMs: undefined });
  });
});
