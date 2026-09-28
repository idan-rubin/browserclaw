import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CookieData } from '../types.js';

import { cookiesSetManyViaPlaywright, storageGetViaPlaywright } from './index.js';

const { getPage } = vi.hoisted(() => ({ getPage: vi.fn() }));
vi.mock('../connection.js', () => ({ getPageForTargetId: getPage, ensurePageState: vi.fn() }));

describe('storage key preservation', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves __proto__, empty keys, and ordinary keys through the page transport', async () => {
    const entries = new Map([
      ['__proto__', 'own value'],
      ['', 'empty key'],
      ['normal', 'control'],
    ]);
    const store = {
      length: entries.size,
      key: (index: number) => [...entries.keys()][index],
      getItem: (key: string) => entries.get(key) ?? null,
    };
    vi.stubGlobal('window', { localStorage: store, sessionStorage: store });
    getPage.mockResolvedValue({
      evaluate: (fn: (args: unknown) => unknown, args: unknown) =>
        Promise.resolve(JSON.parse(JSON.stringify(fn(args))) as unknown),
    });
    for (const kind of ['local', 'session'] as const) {
      const result = await storageGetViaPlaywright({ cdpUrl: 'http://localhost:9222', kind });
      expect(Object.hasOwn(result.values, '__proto__')).toBe(true);
      expect(result.values.__proto__).toBe('own value');
      expect(result.values['']).toBe('empty key');
      expect(result.values.normal).toBe('control');
      expect(Object.getPrototypeOf(result.values)).toBe(Object.prototype);
    }
  });
});

describe('bulk cookie import', () => {
  const cookie = (name: string): CookieData => ({ name, value: 'value', url: 'https://example.test/' });
  it('splits imports into bounded batches', async () => {
    const addCookies = vi.fn().mockResolvedValue(undefined);
    getPage.mockResolvedValue({ context: () => ({ addCookies }) });
    const cookies = Array.from({ length: 501 }, (_, index) => cookie(String(index)));
    expect(await cookiesSetManyViaPlaywright({ cdpUrl: 'local', cookies })).toEqual({ added: 501 });
    expect(addCookies.mock.calls.map(([batch]) => (batch as CookieData[]).length)).toEqual([500, 1]);
  });
  it('isolates a rejected cookie and counts the accepted ones', async () => {
    const addCookies = vi.fn((cookies: CookieData[]) =>
      cookies.some((entry) => entry.name === 'bad')
        ? Promise.reject(
            new Error('browserContext.addCookies: Protocol error (Storage.setCookies): Invalid cookie fields'),
          )
        : Promise.resolve(),
    );
    getPage.mockResolvedValue({ context: () => ({ addCookies }) });
    expect(
      await cookiesSetManyViaPlaywright({ cdpUrl: 'local', cookies: [cookie('first'), cookie('bad'), cookie('last')] }),
    ).toEqual({ added: 2 });
    expect(addCookies).toHaveBeenCalledTimes(4);
  });
  it.each([false, true])('propagates operational failures during import (fallback=%s)', async (fallback) => {
    const failure = new Error('browserContext.addCookies: Target page, context or browser has been closed');
    const addCookies = vi.fn().mockRejectedValue(failure);
    if (fallback) addCookies.mockRejectedValueOnce(new Error('Cookie should have a url or a domain/path pair'));
    getPage.mockResolvedValue({ context: () => ({ addCookies }) });
    await expect(cookiesSetManyViaPlaywright({ cdpUrl: 'local', cookies: [cookie('a'), cookie('b')] })).rejects.toBe(
      failure,
    );
    expect(addCookies).toHaveBeenCalledTimes(fallback ? 2 : 1);
  });
  it('does not dispatch another batch after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('stop import');
    const addCookies = vi.fn(() => {
      controller.abort(reason);
      return Promise.resolve();
    });
    getPage.mockResolvedValue({ context: () => ({ addCookies }) });
    await expect(
      cookiesSetManyViaPlaywright({
        cdpUrl: 'local',
        cookies: Array.from({ length: 501 }, () => cookie('cookie')),
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    expect(addCookies).toHaveBeenCalledOnce();
  });
});
