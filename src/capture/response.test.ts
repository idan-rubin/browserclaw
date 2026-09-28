import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getPage } = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock('../connection.js', () => ({
  getPageForTargetId: getPage,
  ensurePageState: vi.fn(),
  normalizeTimeoutMs: (value: number | undefined, fallback: number) => value ?? fallback,
  truncateUtf16Safe: (value: string, max: number) => value.slice(0, max),
}));

import { responseBodyViaPlaywright } from './response.js';

describe('response body completion budget', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fixture(body: () => Promise<Buffer>) {
    const response = {
      body: vi.fn(body),
      url: () => 'https://example.com/data',
      status: () => 200,
      headers: () => ({}),
    };
    const page = Object.assign(new EventEmitter(), {
      waitForResponse: vi.fn(() => Promise.resolve(response)),
    });
    getPage.mockResolvedValue(page);
    return { page, response };
  }

  it('times out after headers when a body never completes', async () => {
    const { page, response } = fixture(
      () =>
        new Promise(() => {
          /* deliberately stalled */
        }),
    );
    const result = responseBodyViaPlaywright({ cdpUrl: 'http://localhost:9222', url: '/data', timeoutMs: 50 });
    const rejected = expect(result).rejects.toThrow('Response body timed out after 50ms');
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(response.body).toHaveBeenCalledOnce();
    expect(page.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a body which completes inside the same budget (control)', async () => {
    const { page } = fixture(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve(Buffer.from('ready'));
          }, 40),
        ),
    );
    const result = responseBodyViaPlaywright({ cdpUrl: 'http://localhost:9222', url: '/data', timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(40);
    await expect(result).resolves.toMatchObject({ body: 'ready', truncated: false, status: 200 });
    expect(page.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects page closure while consuming the body', async () => {
    const { page } = fixture(
      () =>
        new Promise(() => {
          /* deliberately stalled */
        }),
    );
    const result = responseBodyViaPlaywright({ cdpUrl: 'http://localhost:9222', url: '/data', timeoutMs: 50 });
    const rejected = expect(result).rejects.toThrow('Page closed before response body');
    await vi.advanceTimersByTimeAsync(1);
    page.emit('close');
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects cancellation while consuming the body and removes its listener', async () => {
    fixture(
      () =>
        new Promise(() => {
          /* deliberately stalled */
        }),
    );
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = responseBodyViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      url: '/data',
      timeoutMs: 50,
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('cancelled'));
    await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
