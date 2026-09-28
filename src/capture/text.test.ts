import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';

const { getPage } = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: getPage,
}));

import { getPageTextViaPlaywright } from './text.js';

describe('visible page text', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const cdpUrl = 'http://localhost:9222';
  function page(contents: Record<string, string>, hidden: string[] = [], url = 'about:blank') {
    const innerText = vi.fn((selector: string) => Promise.resolve(contents[selector] ?? ''));
    getPage.mockResolvedValue({
      url: () => url,
      locator: (selector: string) => ({
        first: () => ({
          count: () => Promise.resolve(Object.hasOwn(contents, selector) ? 1 : 0),
          isVisible: () => Promise.resolve(Object.hasOwn(contents, selector) && !hidden.includes(selector)),
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
  it('blocks private page text before reading, but permits an explicit private-network opt-in', async () => {
    const read = page({ body: 'private data' }, [], 'http://169.254.169.254/latest/meta-data/');
    await expect(
      getPageTextViaPlaywright({ cdpUrl, ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } }),
    ).rejects.toThrow('blocked');
    expect(read).not.toHaveBeenCalled();
    await expect(
      getPageTextViaPlaywright({ cdpUrl, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } }),
    ).resolves.toEqual({ text: 'private data', truncated: false });
  });
  it.each([1, 2, 3, 4])('does not split an emoji at limit %s', async (maxChars) => {
    page({ body: 'A😀B' });
    const result = await getPageTextViaPlaywright({ cdpUrl, maxChars });
    expect(result.text).toBe(['A', 'A', 'A😀', 'A😀B'][maxChars - 1]);
    expect(result.truncated).toBe(maxChars < 4);
  });
  it.each([['article'], ['article', 'main']])('skips hidden semantic roots: %j', async (...hidden) => {
    const read = page({ article: 'hidden article', main: 'main', body: 'body' }, hidden);
    const result = await getPageTextViaPlaywright({ cdpUrl });
    expect(result.text).toBe(hidden.includes('main') ? 'body' : 'main');
    expect(read).not.toHaveBeenCalledWith('article');
  });
  it('skips an empty article and treats an empty selector as automatic selection', async () => {
    page({ article: '  ', main: 'main', body: 'body' });
    expect(await getPageTextViaPlaywright({ cdpUrl, selector: '' })).toEqual({ text: 'main', truncated: false });
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
