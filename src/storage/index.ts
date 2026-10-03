import type { BrowserContext } from 'playwright-core';

import { getPageForTargetId, ensurePageState } from '../connection.js';
import type { CookieData, StorageKind, SsrfPolicy } from '../types.js';

// ── Cookies ──

export async function cookiesGetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<{ cookies: Awaited<ReturnType<BrowserContext['cookies']>> }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  return { cookies: await page.context().cookies() };
}

export async function cookiesSetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  cookie: CookieData;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const cookie = opts.cookie;
  if (cookie.name === '') throw new Error('cookie name and value are required');
  const hasUrl = typeof cookie.url === 'string' && cookie.url.trim() !== '';
  const hasDomainPath =
    typeof cookie.domain === 'string' &&
    cookie.domain.trim() !== '' &&
    typeof cookie.path === 'string' &&
    cookie.path.trim() !== '';
  if (!hasUrl && !hasDomainPath) throw new Error('cookie requires url, or domain+path');
  await page.context().addCookies([cookie]);
}

export async function cookiesClearViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.context().clearCookies();
}

/** Only known input-validation errors can be isolated; unknown failures must surface. */
function isCookieValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.replace(/^browserContext\.addCookies: /, '');
  return /^(?:Cookie should have |(?:Blank|Data URL) page can not have cookie |Invalid URL$|Protocol error \(Storage\.setCookies\): Invalid cookie fields|cookies\[\d+\]\.)/.test(
    message,
  );
}

/** Import bounded batches, isolating rejected cookies instead of losing the whole batch. */
export async function cookiesSetManyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  cookies: CookieData[];
  signal?: AbortSignal;
  ssrfPolicy?: SsrfPolicy;
}): Promise<{ added: number }> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const context = page.context();
  let added = 0;
  for (let index = 0; index < opts.cookies.length; index += 500) {
    opts.signal?.throwIfAborted();
    const batch = opts.cookies.slice(index, index + 500);
    try {
      await context.addCookies(batch);
      added += batch.length;
    } catch (error) {
      if (!isCookieValidationError(error)) throw error;
      for (const cookie of batch) {
        opts.signal?.throwIfAborted();
        try {
          await context.addCookies([cookie]);
          added += 1;
        } catch (error) {
          if (!isCookieValidationError(error)) throw error;
          // A rejected cookie does not prevent importing the remaining entries.
        }
      }
    }
  }
  opts.signal?.throwIfAborted();
  return { added };
}

// ── localStorage / sessionStorage ──

export async function storageGetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
  key?: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<{ values: Record<string, string> }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const entries = await page.evaluate(
    ({ kind, key }: { kind: string; key?: string }): [string, string][] => {
      const store = kind === 'session' ? window.sessionStorage : window.localStorage;
      if (key !== undefined && key !== '') {
        const value = store.getItem(key);
        return value === null ? [] : [[key, value]];
      }
      const out: [string, string][] = [];
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (k === null) continue;
        const v = store.getItem(k);
        if (v !== null) out.push([k, v]);
      }
      return out;
    },
    { kind: opts.kind, key: opts.key },
  );
  return { values: Object.fromEntries(entries) };
}

export async function storageSetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
  key: string;
  value: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const key = opts.key;
  if (key === '') throw new Error('key is required');
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.evaluate(
    ({ kind, key: k, value }: { kind: string; key: string; value: string }) => {
      (kind === 'session' ? window.sessionStorage : window.localStorage).setItem(k, value);
    },
    { kind: opts.kind, key, value: opts.value },
  );
}

export async function storageClearViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.evaluate(
    ({ kind }: { kind: string }) => {
      (kind === 'session' ? window.sessionStorage : window.localStorage).clear();
    },
    { kind: opts.kind },
  );
}
