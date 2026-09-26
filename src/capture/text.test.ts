import { afterEach, describe, expect, it, vi } from 'vitest';

const { getPage } = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock('../connection.js', () => ({ getPageForTargetId: getPage }));

import { getPageTextViaPlaywright } from './text.js';

describe('visible page text', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const cdpUrl = 'http://localhost:9222';
  function page(contents: Record<string, string>) {
    const innerText = vi.fn((selector: string) => Promise.resolve(contents[selector] ?? ''));
    getPage.mockResolvedValue({
      locator: (selector: string) => ({
        first: () => ({
          count: () => Promise.resolve(Object.hasOwn(contents, selector) ? 1 : 0),
          innerText: () => innerText(selector),
        }),
      }),
    });
    return innerText;
  }
  it('prefers article over main/body and reports truncation', async () => {
    const read = page({ body: 'body', main: 'main', article: 'article text' });
    expect(await getPageTextViaPlaywright({ cdpUrl, maxChars: 7 })).toEqual({ text: 'article', truncated: true });
    expect(read).toHaveBeenCalledWith('article');
  });
  it('uses an explicit selector and leaves short text intact', async () => {
    page({ article: 'ignored', '#chosen': 'chosen text' });
    expect(await getPageTextViaPlaywright({ cdpUrl, selector: '#chosen' })).toEqual({
      text: 'chosen text',
      truncated: false,
    });
  });
  it('falls back to body when no semantic content root exists', async () => {
    page({ body: 'body text' });
    expect(await getPageTextViaPlaywright({ cdpUrl })).toEqual({ text: 'body text', truncated: false });
  });
  it('bounds stalled page acquisition and does not read a late page', async () => {
    vi.useFakeTimers();
    let release!: (page: unknown) => void;
    getPage.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const result = getPageTextViaPlaywright({ cdpUrl });
    const rejected = expect(result).rejects.toThrow('Page text extraction timed out');
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    const locator = vi.fn();
    release({ locator });
    await Promise.resolve();
    expect(locator).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects invalid limits and pre-aborted calls', async () => {
    await expect(getPageTextViaPlaywright({ cdpUrl, maxChars: 0 })).rejects.toThrow('positive integer');
    const reason = new Error('cancelled');
    await expect(getPageTextViaPlaywright({ cdpUrl, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
  });
});
