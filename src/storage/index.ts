import { getPageForTargetId, ensurePageState } from '../connection.js';
import type { CookieData, StorageKind } from '../types.js';

// ── Cookies ──

export async function cookiesGetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ cookies: Awaited<ReturnType<import('playwright-core').BrowserContext['cookies']>> }> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  return { cookies: await page.context().cookies() };
}

export async function cookiesSetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  cookie: CookieData;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  const cookie = opts.cookie;
  if (!cookie.name || cookie.value === undefined) throw new Error('cookie name and value are required');
  const hasUrl = typeof cookie.url === 'string' && cookie.url.trim();
  const hasDomain = typeof cookie.domain === 'string' && cookie.domain.trim();
  if (!hasUrl && !hasDomain) throw new Error('cookie requires url or domain');
  await page.context().addCookies([cookie]);
}

export async function cookiesClearViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.context().clearCookies();
}

// ── localStorage / sessionStorage ──

export async function storageGetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
  key?: string;
}): Promise<{ values: Record<string, string> }> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  return {
    values: await page.evaluate(
      ({ kind, key }: { kind: string; key?: string }) => {
        const store = kind === 'session' ? window.sessionStorage : window.localStorage;
        if (key) {
          const value = store.getItem(key);
          return value === null ? {} : { [key]: value };
        }
        const out: Record<string, string> = {};
        for (let i = 0; i < store.length; i++) {
          const k = store.key(i);
          if (!k) continue;
          const v = store.getItem(k);
          if (v !== null) out[k] = v;
        }
        return out;
      },
      { kind: opts.kind, key: opts.key },
    ) ?? {},
  };
}

export async function storageSetViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
  key: string;
  value: string;
}): Promise<void> {
  const key = String(opts.key ?? '');
  if (!key) throw new Error('key is required');
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.evaluate(
    ({ kind, key: k, value }: { kind: string; key: string; value: string }) => {
      (kind === 'session' ? window.sessionStorage : window.localStorage).setItem(k, value);
    },
    { kind: opts.kind, key, value: String(opts.value ?? '') },
  );
}

export async function storageClearViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  kind: StorageKind;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.evaluate(
    ({ kind }: { kind: string }) => {
      (kind === 'session' ? window.sessionStorage : window.localStorage).clear();
    },
    { kind: opts.kind },
  );
}
