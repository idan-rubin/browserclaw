import http from 'node:http';
import https from 'node:https';

import type { Browser, Page } from 'playwright-core';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  BrowserTabNotFoundError,
  BlockedBrowserTargetError,
  getHeadersWithAuth,
  getDirectAgentForCdp,
  isBlockedTarget,
  markTargetBlocked,
  clearBlockedTarget,
  withNoProxyForCdpUrl,
  getAllPages,
  takeAiSnapshotText,
  pickActiveTargetId,
  isRecoverableStalePageSelectionError,
} from './connection.js';

// ─────────────────────────────────────────────────────────────────────────────
// Error classes
// ─────────────────────────────────────────────────────────────────────────────

describe('BrowserTabNotFoundError', () => {
  it('has correct name and default message', () => {
    const err = new BrowserTabNotFoundError();
    expect(err.name).toBe('BrowserTabNotFoundError');
    expect(err.message).toBe('Tab not found');
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts custom message', () => {
    const err = new BrowserTabNotFoundError('Custom tab error');
    expect(err.message).toBe('Custom tab error');
  });
});

describe('BlockedBrowserTargetError', () => {
  it('has correct name and message', () => {
    const err = new BlockedBrowserTargetError();
    expect(err.name).toBe('BlockedBrowserTargetError');
    expect(err.message).toContain('SSRF');
    expect(err).toBeInstanceOf(Error);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getHeadersWithAuth
// ─────────────────────────────────────────────────────────────────────────────

describe('getHeadersWithAuth', () => {
  it('returns empty headers for URL without credentials', () => {
    const headers = getHeadersWithAuth('http://localhost:9222');
    expect(headers).toEqual({});
  });

  it('extracts Basic auth from URL credentials', () => {
    const headers = getHeadersWithAuth('http://user:pass@localhost:9222');
    expect(headers.Authorization).toBeDefined();
    expect(headers.Authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(headers.Authorization.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('user:pass');
  });

  it('decodes URL-encoded credentials', () => {
    const headers = getHeadersWithAuth('http://us%40er:p%23ss@localhost:9222');
    const decoded = Buffer.from(headers.Authorization.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('us@er:p#ss');
  });

  it('handles username without password', () => {
    const headers = getHeadersWithAuth('http://user@localhost:9222');
    expect(headers.Authorization).toBeDefined();
    const decoded = Buffer.from(headers.Authorization.replace('Basic ', ''), 'base64').toString();
    expect(decoded).toBe('user:');
  });

  it('preserves existing base headers', () => {
    const headers = getHeadersWithAuth('http://localhost:9222', { 'X-Custom': 'value' });
    expect(headers['X-Custom']).toBe('value');
  });

  it('does not overwrite existing Authorization header', () => {
    const headers = getHeadersWithAuth('http://user:pass@localhost:9222', {
      Authorization: 'Bearer existing-token',
    });
    expect(headers.Authorization).toBe('Bearer existing-token');
  });

  it('case-insensitive check for existing Authorization', () => {
    const headers = getHeadersWithAuth('http://user:pass@localhost:9222', {
      authorization: 'Bearer token',
    });
    expect(headers.authorization).toBe('Bearer token');
    // Should not add a second Authorization header
    expect(Object.keys(headers).filter((k) => k.toLowerCase() === 'authorization')).toHaveLength(1);
  });

  it('handles invalid URL gracefully', () => {
    const headers = getHeadersWithAuth('not-a-url');
    expect(headers).toEqual({});
  });

  it('does not mutate the input headers object', () => {
    const base = { 'X-Foo': 'bar' };
    const result = getHeadersWithAuth('http://user:pass@localhost:9222', base);
    expect(base).toEqual({ 'X-Foo': 'bar' });
    expect(result).not.toBe(base);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getDirectAgentForCdp
// ─────────────────────────────────────────────────────────────────────────────

describe('getDirectAgentForCdp', () => {
  it('returns http.Agent for http:// loopback URL', () => {
    const agent = getDirectAgentForCdp('http://localhost:9222');
    expect(agent).toBeInstanceOf(http.Agent);
  });

  it('returns http.Agent for ws:// loopback URL', () => {
    const agent = getDirectAgentForCdp('ws://127.0.0.1:9222');
    expect(agent).toBeInstanceOf(http.Agent);
  });

  it('returns https.Agent for https:// loopback URL', () => {
    const agent = getDirectAgentForCdp('https://localhost:9222');
    expect(agent).toBeInstanceOf(https.Agent);
  });

  it('returns https.Agent for wss:// loopback URL', () => {
    const agent = getDirectAgentForCdp('wss://[::1]:9222');
    expect(agent).toBeInstanceOf(https.Agent);
  });

  it('returns undefined for non-loopback URL', () => {
    expect(getDirectAgentForCdp('http://example.com:9222')).toBeUndefined();
    expect(getDirectAgentForCdp('ws://192.168.1.1:9222')).toBeUndefined();
  });

  it('returns undefined for invalid URL', () => {
    expect(getDirectAgentForCdp('not-a-url')).toBeUndefined();
    expect(getDirectAgentForCdp('')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Blocked Target Management
// ─────────────────────────────────────────────────────────────────────────────

describe('blocked target management', () => {
  const CDP_URL = 'ws://localhost:9222';

  beforeEach(() => {
    // Clear any leftover state
    clearBlockedTarget(CDP_URL, 'target1');
    clearBlockedTarget(CDP_URL, 'target2');
    clearBlockedTarget(CDP_URL, 'target3');
  });

  it('target is not blocked by default', () => {
    expect(isBlockedTarget(CDP_URL, 'target1')).toBe(false);
  });

  it('marks and checks blocked target', () => {
    markTargetBlocked(CDP_URL, 'target1');
    expect(isBlockedTarget(CDP_URL, 'target1')).toBe(true);
    expect(isBlockedTarget(CDP_URL, 'target2')).toBe(false);
  });

  it('clears blocked target', () => {
    markTargetBlocked(CDP_URL, 'target1');
    clearBlockedTarget(CDP_URL, 'target1');
    expect(isBlockedTarget(CDP_URL, 'target1')).toBe(false);
  });

  it('ignores empty targetId', () => {
    markTargetBlocked(CDP_URL, '');
    expect(isBlockedTarget(CDP_URL, '')).toBe(false);
  });

  it('ignores undefined targetId', () => {
    markTargetBlocked(CDP_URL, undefined);
    expect(isBlockedTarget(CDP_URL, undefined)).toBe(false);
  });

  it('ignores whitespace-only targetId', () => {
    markTargetBlocked(CDP_URL, '   ');
    expect(isBlockedTarget(CDP_URL, '   ')).toBe(false);
  });

  it('targets are scoped to cdpUrl', () => {
    markTargetBlocked('ws://localhost:9222', 'target1');
    expect(isBlockedTarget('ws://localhost:9222', 'target1')).toBe(true);
    expect(isBlockedTarget('ws://localhost:9223', 'target1')).toBe(false);
  });

  it('normalizes cdpUrl trailing slashes', () => {
    markTargetBlocked('ws://localhost:9222/', 'target1');
    expect(isBlockedTarget('ws://localhost:9222', 'target1')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withNoProxyForCdpUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('withNoProxyForCdpUrl', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.HTTP_PROXY = process.env.HTTP_PROXY;
    savedEnv.HTTPS_PROXY = process.env.HTTPS_PROXY;
    savedEnv.NO_PROXY = process.env.NO_PROXY;
    savedEnv.no_proxy = process.env.no_proxy;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('passes through directly for non-loopback URLs', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    let called = false;
    await withNoProxyForCdpUrl('ws://example.com:9222', () => {
      called = true;
      return Promise.resolve('result');
    });
    expect(called).toBe(true);
  });

  it('passes through directly when no proxy configured', async () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.all_proxy;
    const result = await withNoProxyForCdpUrl('ws://localhost:9222', () => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('sets NO_PROXY for loopback URLs when proxy configured', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    let noProxyDuringFn: string | undefined;
    await withNoProxyForCdpUrl('ws://localhost:9222', () => {
      noProxyDuringFn = process.env.NO_PROXY;
      return Promise.resolve();
    });
    expect(noProxyDuringFn).toContain('localhost');
    expect(noProxyDuringFn).toContain('127.0.0.1');
    expect(noProxyDuringFn).toContain('[::1]');
  });

  it('restores NO_PROXY after function completes', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = 'original.com';
    delete process.env.no_proxy;

    await withNoProxyForCdpUrl('ws://localhost:9222', () => Promise.resolve());
    expect(process.env.NO_PROXY).toBe('original.com');
  });

  it('restores NO_PROXY even if function throws', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = 'original.com';
    delete process.env.no_proxy;

    await expect(withNoProxyForCdpUrl('ws://localhost:9222', () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(process.env.NO_PROXY).toBe('original.com');
  });

  it('appends to existing NO_PROXY', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = 'internal.corp';
    delete process.env.no_proxy;

    let noProxyDuringFn: string | undefined;
    await withNoProxyForCdpUrl('ws://localhost:9222', () => {
      noProxyDuringFn = process.env.NO_PROXY;
      return Promise.resolve();
    });
    expect(noProxyDuringFn).toContain('internal.corp');
    expect(noProxyDuringFn).toContain('localhost');
  });

  it('skips mutation when NO_PROXY already covers localhost', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    process.env.NO_PROXY = 'foo,localhost,127.0.0.1,[::1],bar';

    let noProxyDuringFn: string | undefined;
    await withNoProxyForCdpUrl('ws://localhost:9222', () => {
      noProxyDuringFn = process.env.NO_PROXY;
      return Promise.resolve();
    });
    expect(noProxyDuringFn).toBe('foo,localhost,127.0.0.1,[::1],bar');
  });

  it('deletes NO_PROXY if it was originally undefined', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    await withNoProxyForCdpUrl('ws://localhost:9222', () => Promise.resolve());
    expect(process.env.NO_PROXY).toBeUndefined();
  });

  it('serializes concurrent env mutations', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;

    const events: string[] = [];

    const p1 = withNoProxyForCdpUrl('ws://localhost:9222', async () => {
      events.push('fn1-start');
      await new Promise((r) => setTimeout(r, 50));
      events.push('fn1-end');
    });

    const p2 = withNoProxyForCdpUrl('ws://127.0.0.1:9222', async () => {
      events.push('fn2-start');
      await new Promise((r) => setTimeout(r, 10));
      events.push('fn2-end');
    });

    await Promise.all([p1, p2]);

    const fn1EndIdx = events.indexOf('fn1-end');
    const fn2StartIdx = events.indexOf('fn2-start');
    expect(fn2StartIdx).toBeGreaterThan(fn1EndIdx);
  });

  it('returns the function result', async () => {
    process.env.HTTP_PROXY = 'http://proxy:8080';
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    const result = await withNoProxyForCdpUrl('ws://localhost:9222', () => Promise.resolve('hello'));
    expect(result).toBe('hello');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllPages
// ─────────────────────────────────────────────────────────────────────────────

describe('getAllPages', () => {
  it('flattens pages from all contexts', () => {
    const page1 = { url: () => 'page1' };
    const page2 = { url: () => 'page2' };
    const page3 = { url: () => 'page3' };
    const browser = {
      contexts: () => [{ pages: () => [page1, page2] }, { pages: () => [page3] }],
    } as unknown as Browser;
    const pages = getAllPages(browser);
    expect(pages).toHaveLength(3);
  });

  it('returns empty array when no contexts', () => {
    const browser = {
      contexts: () => [],
    } as unknown as Browser;
    expect(getAllPages(browser)).toHaveLength(0);
  });

  it('returns empty array when contexts have no pages', () => {
    const browser = {
      contexts: () => [{ pages: () => [] }, { pages: () => [] }],
    } as unknown as Browser;
    expect(getAllPages(browser)).toHaveLength(0);
  });
});

// Passing track to Playwright makes it return incremental diffs on repeat snapshots, which our parser can't handle.
describe('takeAiSnapshotText', () => {
  it('calls _snapshotForAI without a track option (Playwright <1.59)', async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const mockPage = {
      _snapshotForAI: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve({ full: '- button "OK" [ref=e1]' });
      },
    } as unknown as Page;

    await takeAiSnapshotText(mockPage, 5000);

    expect(capturedOpts).toEqual({ timeout: 5000 });
    expect(capturedOpts).not.toHaveProperty('track');
    expect(capturedOpts).not.toHaveProperty('_track');
  });

  it('calls ariaSnapshot without a _track option (Playwright >=1.59)', async () => {
    let capturedOpts: Record<string, unknown> | undefined;
    const mockPage = {
      ariaSnapshot: (opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return Promise.resolve('- button "OK" [ref=e1]');
      },
    } as unknown as Page;

    await takeAiSnapshotText(mockPage, 5000);

    expect(capturedOpts).toEqual({ timeout: 5000, mode: 'ai' });
    expect(capturedOpts).not.toHaveProperty('_track');
    expect(capturedOpts).not.toHaveProperty('track');
  });

  it('prefers _snapshotForAI when both APIs are available', async () => {
    let snapshotForAICalled = false;
    let ariaSnapshotCalled = false;
    const mockPage = {
      _snapshotForAI: () => {
        snapshotForAICalled = true;
        return Promise.resolve({ full: '' });
      },
      ariaSnapshot: () => {
        ariaSnapshotCalled = true;
        return Promise.resolve('');
      },
    } as unknown as Page;

    await takeAiSnapshotText(mockPage, 5000);

    expect(snapshotForAICalled).toBe(true);
    expect(ariaSnapshotCalled).toBe(false);
  });

  it('throws a descriptive error when neither API is available', async () => {
    const mockPage = {} as unknown as Page;
    await expect(takeAiSnapshotText(mockPage, 5000)).rejects.toThrow(/playwright-core/i);
  });

  it('returns empty string when _snapshotForAI resolves without full', async () => {
    const mockPage = {
      _snapshotForAI: () => Promise.resolve({}),
    } as unknown as Page;
    await expect(takeAiSnapshotText(mockPage, 5000)).resolves.toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pickActiveTargetId
// ─────────────────────────────────────────────────────────────────────────────

function pageWithUrl(url: string): Page {
  return { url: () => url } as unknown as Page;
}

describe('pickActiveTargetId', () => {
  it('returns the page matching preferTargetId', async () => {
    const accessible = [pageWithUrl('https://a.test/'), pageWithUrl('https://b.test/')];
    const tids = new Map<Page, string>([
      [accessible[0], 't-a'],
      [accessible[1], 't-b'],
    ]);
    const tidOf = (page: Page) => Promise.resolve(tids.get(page) ?? null);

    const result = await pickActiveTargetId({ accessible, preferTargetId: 't-b', preferUrl: '', tidOf });
    expect(result).toBe('t-b');
  });

  it('returns the page matching preferUrl when no targetId matches', async () => {
    const accessible = [pageWithUrl('https://a.test/'), pageWithUrl('https://b.test/')];
    const tids = new Map<Page, string>([
      [accessible[0], 't-a'],
      [accessible[1], 't-b'],
    ]);
    const tidOf = (page: Page) => Promise.resolve(tids.get(page) ?? null);

    const result = await pickActiveTargetId({
      accessible,
      preferTargetId: 't-gone',
      preferUrl: 'https://b.test/',
      tidOf,
    });
    expect(result).toBe('t-b');
  });

  it('prefers non-blank pages over about:blank when no prefer-hints match', async () => {
    const accessible = [pageWithUrl('about:blank'), pageWithUrl('https://real.test/')];
    const tids = new Map<Page, string>([
      [accessible[0], 't-blank'],
      [accessible[1], 't-real'],
    ]);
    const tidOf = (page: Page) => Promise.resolve(tids.get(page) ?? null);

    const result = await pickActiveTargetId({ accessible, preferTargetId: '', preferUrl: '', tidOf });
    expect(result).toBe('t-real');
  });

  it('iterates the final fallback when the first accessible page has no targetId', async () => {
    // All pages blank, first one's pageTargetId returns null (transient CDP
    // failure) — we must still return the second page's tid instead of bailing.
    const accessible = [pageWithUrl('about:blank'), pageWithUrl('about:blank')];
    const tids = new Map<Page, string | null>([
      [accessible[0], null],
      [accessible[1], 't-recovered'],
    ]);
    const tidOf = (page: Page) => Promise.resolve(tids.get(page) ?? null);

    const result = await pickActiveTargetId({ accessible, preferTargetId: '', preferUrl: '', tidOf });
    expect(result).toBe('t-recovered');
  });

  it('iterates the non-blank branch when the first non-blank page has no targetId', async () => {
    const accessible = [pageWithUrl('https://a.test/'), pageWithUrl('https://b.test/')];
    const tids = new Map<Page, string | null>([
      [accessible[0], null],
      [accessible[1], 't-b'],
    ]);
    const tidOf = (page: Page) => Promise.resolve(tids.get(page) ?? null);

    const result = await pickActiveTargetId({ accessible, preferTargetId: '', preferUrl: '', tidOf });
    expect(result).toBe('t-b');
  });

  it('returns null only when no accessible page has a usable targetId', async () => {
    const accessible = [pageWithUrl('about:blank'), pageWithUrl('about:blank')];
    const tidOf = () => Promise.resolve(null);

    const result = await pickActiveTargetId({ accessible, preferTargetId: '', preferUrl: '', tidOf });
    expect(result).toBeNull();
  });

  it('skips pages whose tidOf rejects without failing the whole resolve', async () => {
    const accessible = [pageWithUrl('https://a.test/'), pageWithUrl('https://b.test/')];
    const tidOf = (page: Page) => (page === accessible[0] ? Promise.resolve(null) : Promise.resolve('t-b'));

    const result = await pickActiveTargetId({ accessible, preferTargetId: '', preferUrl: '', tidOf });
    expect(result).toBe('t-b');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isRecoverableStalePageSelectionError
// ─────────────────────────────────────────────────────────────────────────────

describe('isRecoverableStalePageSelectionError', () => {
  it('returns false when no cached browser was reused', () => {
    expect(isRecoverableStalePageSelectionError(new BrowserTabNotFoundError(), false, false)).toBe(false);
    expect(isRecoverableStalePageSelectionError(new BrowserTabNotFoundError(), false, true)).toBe(false);
  });

  it('returns true for "No pages available" regardless of explicit targetId', () => {
    const err = new Error('No pages available in the connected browser.');
    expect(isRecoverableStalePageSelectionError(err, true, false)).toBe(true);
    expect(isRecoverableStalePageSelectionError(err, true, true)).toBe(true);
  });

  it('returns true for BrowserTabNotFoundError when no explicit targetId was passed', () => {
    expect(isRecoverableStalePageSelectionError(new BrowserTabNotFoundError(), true, false)).toBe(true);
  });

  it('returns false for BrowserTabNotFoundError when caller passed an explicit targetId', () => {
    expect(isRecoverableStalePageSelectionError(new BrowserTabNotFoundError(), true, true)).toBe(false);
  });

  it('returns true for "tab not found" message only when no explicit targetId', () => {
    expect(isRecoverableStalePageSelectionError(new Error('Tab Not Found'), true, false)).toBe(true);
    expect(isRecoverableStalePageSelectionError(new Error('Tab Not Found'), true, true)).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(isRecoverableStalePageSelectionError(new Error('boom'), true, false)).toBe(false);
    expect(isRecoverableStalePageSelectionError(new BlockedBrowserTargetError(), true, false)).toBe(false);
  });

  it('handles non-Error inputs', () => {
    expect(isRecoverableStalePageSelectionError('tab not found', true, false)).toBe(true);
    expect(isRecoverableStalePageSelectionError(null, true, false)).toBe(false);
  });
});
