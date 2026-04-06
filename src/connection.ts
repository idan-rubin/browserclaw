import http from 'node:http';
import https from 'node:https';

import { chromium } from 'playwright-core';
import type { Browser, Page, CDPSession } from 'playwright-core';

import {
  getChromeWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  normalizeCdpWsUrl,
  isLoopbackHost,
  hasProxyEnvConfigured,
} from './chrome-launcher.js';
import { ensurePageState, observeBrowser, setDialogHandlerOnPage } from './page-utils.js';
import { clearRoleRefsForCdpUrl, normalizeCdpUrl } from './ref-resolver.js';
import type { DialogHandler } from './types.js';

// Re-export everything from sub-modules so existing `import … from './connection.js'`
// paths keep working. When adding a public function to page-utils or ref-resolver,
// add a corresponding re-export here — otherwise downstream imports break silently.
export {
  ensurePageState,
  ensureContextState,
  observeContext,
  findNetworkRequestById,
  bumpUploadArmId,
  bumpDialogArmId,
  bumpDownloadArmId,
  toAIFriendlyError,
  normalizeTimeoutMs,
} from './page-utils.js';

export {
  rememberRoleRefsForTarget,
  storeRoleRefsForTarget,
  restoreRoleRefsForTarget,
  clearRoleRefsForCdpUrl,
  parseRoleRef,
  requireRef,
  requireRefOrSelector,
  resolveInteractionTimeoutMs,
  resolveBoundedDelayMs,
  refLocator,
} from './ref-resolver.js';

// ── Errors ──

export class BrowserTabNotFoundError extends Error {
  constructor(message = 'Tab not found') {
    super(message);
    this.name = 'BrowserTabNotFoundError';
  }
}

/** Page extended with Playwright's private `_snapshotForAI` method. */
export type PageWithAI = Page & {
  _snapshotForAI?: (opts: { timeout: number; track: string }) => Promise<{ full?: string }>;
};

async function fetchJsonForCdp(url: string, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
      console.warn(`[browserclaw] fetchJsonForCdp ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function appendCdpPath(cdpUrl: string, cdpPath: string): string {
  try {
    const url = new URL(cdpUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}${cdpPath.startsWith('/') ? cdpPath : `/${cdpPath}`}`;
    return url.toString();
  } catch {
    return `${cdpUrl.replace(/\/$/, '')}${cdpPath}`;
  }
}

// ── CDP Session Helpers ──

/**
 * Run a function with a scoped Playwright CDP session, detaching when done.
 */
export async function withPlaywrightPageCdpSession<T>(page: Page, fn: (session: CDPSession) => Promise<T>): Promise<T> {
  const CDP_SESSION_TIMEOUT_MS = 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const session = await Promise.race([
    page.context().newCDPSession(page),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('newCDPSession timed out after 10s'));
      }, CDP_SESSION_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  try {
    return await fn(session);
  } finally {
    await session.detach().catch(() => {
      /* noop */
    });
  }
}

/**
 * Run a function with a page-scoped CDP client.
 */
export async function withPageScopedCdpClient<T>(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  fn: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>;
}): Promise<T> {
  return await withPlaywrightPageCdpSession(opts.page, async (session) => {
    return await opts.fn((method, params) => session.send(method as Parameters<CDPSession['send']>[0], params));
  });
}

// ── NO_PROXY Lease Manager (for loopback CDP URLs) ──

const LOOPBACK_ENTRIES = 'localhost,127.0.0.1,[::1]';

function noProxyAlreadyCoversLocalhost(): boolean {
  const current = process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  return current.includes('localhost') && current.includes('127.0.0.1') && current.includes('[::1]');
}

function isLoopbackCdpUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Mutex promise chain that serializes concurrent env mutations.
 *
 * Playwright reads proxy config from `process.env` at connect time — there is
 * no API to pass proxy bypass settings per-connection. When the CDP target is
 * loopback we must temporarily add localhost entries to `NO_PROXY` / `no_proxy`
 * so Playwright's underlying HTTP stack skips the proxy.
 *
 * Because multiple connections may be established concurrently, we serialize
 * the save → mutate → fn() → restore cycle through a promise chain so that
 * one caller's restore doesn't clobber another caller's mutation.
 */
let envMutexPromise: Promise<void> = Promise.resolve();
let envMutexDepth = 0;

/**
 * Scoped NO_PROXY bypass for loopback CDP URLs.
 * Serializes env mutations so concurrent connects don't interleave save/restore.
 * Only restores if the value hasn't been changed by someone else.
 * Reentrant: nested calls skip the env mutation if already inside the mutex.
 */
export async function withNoProxyForCdpUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
  if (!isLoopbackCdpUrl(url) || !hasProxyEnvConfigured()) return fn();

  // Reentrancy guard: if already inside this mutex, just run fn() directly
  if (envMutexDepth > 0) return fn();

  const prev = envMutexPromise;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  let release: () => void = () => {};
  envMutexPromise = new Promise<void>((r) => {
    release = r;
  });
  await prev;

  if (noProxyAlreadyCoversLocalhost()) {
    try {
      return await fn();
    } finally {
      release();
    }
  }

  const savedNoProxy = process.env.NO_PROXY;
  const savedNoProxyLower = process.env.no_proxy;
  const current = savedNoProxy ?? savedNoProxyLower ?? '';
  const applied = current ? `${current},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
  process.env.NO_PROXY = applied;
  process.env.no_proxy = applied;
  envMutexDepth += 1;
  try {
    return await fn();
  } finally {
    envMutexDepth -= 1;
    if (process.env.NO_PROXY === applied) {
      if (savedNoProxy !== undefined) process.env.NO_PROXY = savedNoProxy;
      else delete process.env.NO_PROXY;
    }
    if (process.env.no_proxy === applied) {
      if (savedNoProxyLower !== undefined) process.env.no_proxy = savedNoProxyLower;
      else delete process.env.no_proxy;
    }
    release();
  }
}

/** HTTP agent that never uses a proxy — for localhost CDP connections. */
const directHttpAgent = new http.Agent();
const directHttpsAgent = new https.Agent();

/**
 * Returns a plain (non-proxy) agent for WebSocket or HTTP connections
 * when the target is a loopback address. Returns `undefined` otherwise.
 */
export function getDirectAgentForCdp(url: string): http.Agent | https.Agent | undefined {
  try {
    const parsed = new URL(url);
    if (isLoopbackHost(parsed.hostname)) {
      return parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? directHttpsAgent : directHttpAgent;
    }
  } catch {
    // url is not a valid URL string — return undefined (no direct agent)
  }
  return undefined;
}

// ── Auth Headers ──

/**
 * Resolve auth headers for a CDP endpoint URL.
 * Supports URL credentials (user:pass@host).
 */
export function getHeadersWithAuth(endpoint: string, baseHeaders: Record<string, string> = {}): Record<string, string> {
  const headers = { ...baseHeaders };
  try {
    const parsed = new URL(endpoint);
    if (Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) return headers;
    if (parsed.username || parsed.password) {
      const credentials = Buffer.from(
        `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`,
      ).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
    }
  } catch {
    // endpoint is not a valid URL (e.g. a raw WebSocket path) — skip auth header injection
  }
  return headers;
}

// ── Persistent Connection Cache ──

interface CachedConnection {
  browser: Browser;
  cdpUrl: string;
  onDisconnected?: () => void;
}

const cachedByCdpUrl = new Map<string, CachedConnection>();
const connectingByCdpUrl = new Map<string, Promise<CachedConnection>>();

// ── Connection Mutex ──
// Serializes connect/disconnect operations to prevent races where a disconnect
// clears a connection that a concurrent connect just established.

let connectionMutex: Promise<void> = Promise.resolve();

async function withConnectionLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = connectionMutex;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  let release: () => void = () => {};
  connectionMutex = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ── Blocked Target Tracking ──

export class BlockedBrowserTargetError extends Error {
  constructor() {
    super('Browser target is unavailable after SSRF policy blocked its navigation.');
    this.name = 'BlockedBrowserTargetError';
  }
}

const MAX_BLOCKED_TARGETS = 200;
const blockedTargetsByCdpUrl = new Set<string>();
const blockedPageRefsByCdpUrl = new Map<string, WeakSet<Page>>();

function blockedTargetKey(cdpUrl: string, targetId: string): string {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

export function isBlockedTarget(cdpUrl: string, targetId?: string): boolean {
  const normalized = targetId?.trim() ?? '';
  if (normalized === '') return false;
  return blockedTargetsByCdpUrl.has(blockedTargetKey(cdpUrl, normalized));
}

export function markTargetBlocked(cdpUrl: string, targetId?: string): void {
  const normalized = targetId?.trim() ?? '';
  if (normalized === '') return;
  blockedTargetsByCdpUrl.add(blockedTargetKey(cdpUrl, normalized));
  // Evict oldest entries if the set grows too large
  if (blockedTargetsByCdpUrl.size > MAX_BLOCKED_TARGETS) {
    const first = blockedTargetsByCdpUrl.values().next();
    if (first.done !== true) blockedTargetsByCdpUrl.delete(first.value);
  }
}

export function clearBlockedTarget(cdpUrl: string, targetId?: string): void {
  const normalized = targetId?.trim() ?? '';
  if (normalized === '') return;
  blockedTargetsByCdpUrl.delete(blockedTargetKey(cdpUrl, normalized));
}

function hasBlockedTargetsForCdpUrl(cdpUrl: string): boolean {
  const prefix = `${normalizeCdpUrl(cdpUrl)}::`;
  for (const key of blockedTargetsByCdpUrl) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

function clearBlockedTargetsForCdpUrl(cdpUrl?: string): void {
  if (cdpUrl === undefined) {
    blockedTargetsByCdpUrl.clear();
    return;
  }
  const prefix = `${normalizeCdpUrl(cdpUrl)}::`;
  for (const key of blockedTargetsByCdpUrl) {
    if (key.startsWith(prefix)) blockedTargetsByCdpUrl.delete(key);
  }
}

function blockedPageRefsForCdpUrl(cdpUrl: string): WeakSet<Page> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const existing = blockedPageRefsByCdpUrl.get(normalized);
  if (existing) return existing;
  const created = new WeakSet<Page>();
  blockedPageRefsByCdpUrl.set(normalized, created);
  return created;
}

export function isBlockedPageRef(cdpUrl: string, page: Page): boolean {
  return blockedPageRefsByCdpUrl.get(normalizeCdpUrl(cdpUrl))?.has(page) ?? false;
}

export function markPageRefBlocked(cdpUrl: string, page: Page): void {
  blockedPageRefsForCdpUrl(cdpUrl).add(page);
}

function clearBlockedPageRefsForCdpUrl(cdpUrl?: string): void {
  if (cdpUrl === undefined) {
    blockedPageRefsByCdpUrl.clear();
    return;
  }
  blockedPageRefsByCdpUrl.delete(normalizeCdpUrl(cdpUrl));
}

export function clearBlockedPageRef(cdpUrl: string, page: Page): void {
  blockedPageRefsByCdpUrl.get(normalizeCdpUrl(cdpUrl))?.delete(page);
}

// ── Dialog Handler ──

/**
 * Set or clear a persistent dialog handler for a page.
 * When set, this handler is called for every dialog that is not covered by armDialog().
 * Pass `undefined` to clear the handler and restore default auto-dismiss.
 */
export async function setDialogHandler(opts: {
  cdpUrl: string;
  targetId?: string;
  handler?: DialogHandler;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  setDialogHandlerOnPage(page, opts.handler);
}

// ── Connect to Browser ──

export async function connectBrowser(cdpUrl: string, authToken?: string): Promise<CachedConnection> {
  const normalized = normalizeCdpUrl(cdpUrl);
  // Lock-free fast path: return cached connection
  const existing_cached = cachedByCdpUrl.get(normalized);
  if (existing_cached) return existing_cached;

  const existing = connectingByCdpUrl.get(normalized);
  if (existing) return await existing;

  // Slow path: acquire connection lock before creating a new connection
  return withConnectionLock(async () => {
    // Re-check after acquiring lock
    const rechecked = cachedByCdpUrl.get(normalized);
    if (rechecked) return rechecked;
    const recheckPending = connectingByCdpUrl.get(normalized);
    if (recheckPending) return await recheckPending;

    const connectWithRetry = async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const timeout = 5000 + attempt * 2000;
          const endpoint =
            (await getChromeWebSocketUrl(normalized, timeout, authToken).catch(() => null)) ?? normalized;
          const headers: Record<string, string> = getHeadersWithAuth(endpoint);
          if (authToken !== undefined && authToken !== '' && !headers.Authorization)
            headers.Authorization = `Bearer ${authToken}`;
          const browser = await withNoProxyForCdpUrl(endpoint, () =>
            chromium.connectOverCDP(endpoint, { timeout, headers }),
          );
          const onDisconnected = () => {
            if (cachedByCdpUrl.get(normalized)?.browser === browser) {
              cachedByCdpUrl.delete(normalized);
              clearRoleRefsForCdpUrl(normalized);
            }
          };
          const connected: CachedConnection = { browser, cdpUrl: normalized, onDisconnected };
          cachedByCdpUrl.set(normalized, connected);
          await observeBrowser(browser);
          browser.on('disconnected', onDisconnected);
          return connected;
        } catch (err) {
          lastErr = err;
          if ((err instanceof Error ? err.message : String(err)).includes('rate limit')) {
            // Rate-limit: wait longer before retrying instead of breaking immediately
            await new Promise((r) => setTimeout(r, 1000 + attempt * 1000));
            continue;
          }
          await new Promise((r) => setTimeout(r, 250 + attempt * 250));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('CDP connect failed');
    };

    const promise = connectWithRetry().finally(() => {
      connectingByCdpUrl.delete(normalized);
    });
    connectingByCdpUrl.set(normalized, promise);
    return await promise;
  });
}

export async function disconnectBrowser(): Promise<void> {
  return withConnectionLock(async () => {
    if (connectingByCdpUrl.size) {
      for (const p of connectingByCdpUrl.values()) {
        try {
          await p;
        } catch (err) {
          console.warn(
            `[browserclaw] disconnectBrowser: pending connect failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    for (const cur of cachedByCdpUrl.values()) {
      clearRoleRefsForCdpUrl(cur.cdpUrl);
      if (cur.onDisconnected && typeof cur.browser.off === 'function')
        cur.browser.off('disconnected', cur.onDisconnected);
      await cur.browser.close().catch(() => {
        /* noop */
      });
    }
    cachedByCdpUrl.clear();
    clearBlockedTargetsForCdpUrl();
    clearBlockedPageRefsForCdpUrl();
  });
}

/**
 * Close the Playwright connection for a specific CDP URL without affecting other connections.
 */
export async function closePlaywrightBrowserConnection(opts?: { cdpUrl?: string }): Promise<void> {
  if (opts?.cdpUrl !== undefined && opts.cdpUrl !== '') {
    return withConnectionLock(async () => {
      const cdpUrl = opts.cdpUrl
      if (cdpUrl === undefined || cdpUrl === '') return;
      const normalized = normalizeCdpUrl(cdpUrl);
      clearBlockedTargetsForCdpUrl(normalized);
      clearBlockedPageRefsForCdpUrl(normalized);
      const cur = cachedByCdpUrl.get(normalized);
      cachedByCdpUrl.delete(normalized);
      connectingByCdpUrl.delete(normalized);
      if (!cur) return;
      if (cur.onDisconnected && typeof cur.browser.off === 'function')
        cur.browser.off('disconnected', cur.onDisconnected);
      await cur.browser.close().catch(() => {
        /* noop */
      });
    });
  } else {
    await disconnectBrowser();
  }
}

function cdpSocketNeedsAttach(wsUrl: string): boolean {
  try {
    const pathname = new URL(wsUrl).pathname;
    return (
      pathname === '/cdp' || pathname.endsWith('/cdp') || pathname.includes('/devtools/browser/') || pathname === '/'
    );
  } catch {
    return false;
  }
}

/**
 * Best-effort termination of stuck page operations via raw CDP websocket.
 * Bypasses Playwright entirely — important because Playwright may be stuck.
 * If the wsUrl is a browser-level endpoint, attaches to the target first.
 */
async function tryTerminateExecutionViaCdp(cdpUrl: string, targetId: string): Promise<void> {
  const httpBase = normalizeCdpHttpBaseForJsonEndpoints(cdpUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => {
    ctrl.abort();
  }, 2000);
  let targets: unknown;
  try {
    const res = await fetch(`${httpBase}/json/list`, { signal: ctrl.signal });
    if (!res.ok) return;
    targets = await res.json();
  } catch {
    return;
  } finally {
    clearTimeout(t);
  }

  if (!Array.isArray(targets)) return;
  const target = targets.find((entry: unknown) => {
    const e = entry as { id?: string; webSocketDebuggerUrl?: string };
    return (e.id ?? '').trim() === targetId;
  }) as { id?: string; webSocketDebuggerUrl?: string } | undefined;
  const wsUrlRaw = (target?.webSocketDebuggerUrl ?? '').trim();
  if (wsUrlRaw === '') return;

  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, httpBase);
  const needsAttach = cdpSocketNeedsAttach(wsUrl);

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    let ws: WebSocket;
    let nextId = 1;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      finish();
      return;
    }
    ws.onopen = () => {
      if (needsAttach) {
        ws.send(JSON.stringify({ id: nextId++, method: 'Target.attachToTarget', params: { targetId, flatten: true } }));
      } else {
        ws.send(JSON.stringify({ id: nextId++, method: 'Runtime.terminateExecution' }));
        setTimeout(finish, 300);
      }
    };
    ws.onmessage = (event) => {
      if (!needsAttach) return;
      try {
        const msg = JSON.parse(String(event.data)) as Record<string, unknown>;
        const result = msg.result as Record<string, unknown> | undefined;
        if (msg.id !== undefined && result?.sessionId !== undefined) {
          const sessionId = result.sessionId as string;
          ws.send(JSON.stringify({ id: nextId++, sessionId, method: 'Runtime.terminateExecution' }));
          try {
            ws.send(
              JSON.stringify({
                id: nextId++,
                method: 'Target.detachFromTarget',
                params: { sessionId },
              }),
            );
          } catch {
            /* noop */
          }
          setTimeout(finish, 300);
        }
      } catch {
        /* noop */
      }
    };
    ws.onerror = () => {
      finish();
    };
    ws.onclose = () => {
      finish();
    };
  });
}

/**
 * Force-disconnect the ENTIRE Playwright browser connection, not just one target.
 * Clears the connection cache, optionally sends Runtime.terminateExecution to
 * a specific target via raw CDP websocket to kill stuck evals (bypassing
 * Playwright), then closes the browser — which disconnects ALL tabs.
 * The targetId parameter is only used to send Runtime.terminateExecution before closing.
 */
export async function forceDisconnectPlaywrightConnection(opts: {
  cdpUrl: string;
  targetId?: string;
  reason?: string;
}): Promise<void> {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  const cur = cachedByCdpUrl.get(normalized);
  if (!cur) return;

  cachedByCdpUrl.delete(normalized);
  connectingByCdpUrl.delete(normalized);

  if (cur.onDisconnected && typeof cur.browser.off === 'function') {
    cur.browser.off('disconnected', cur.onDisconnected);
  }

  const targetId = opts.targetId?.trim() ?? '';
  if (targetId !== '') {
    await tryTerminateExecutionViaCdp(normalized, targetId).catch(() => {
      /* noop */
    });
  }

  await cur.browser.close().catch(() => {
    /* noop */
  });
}

/**
 * Terminate JavaScript execution on a specific CDP target without tearing down
 * the shared Playwright connection. Use this to abort a stuck evaluate on one
 * tab without affecting other tabs.
 */
export { tryTerminateExecutionViaCdp };

/** @deprecated Use `forceDisconnectPlaywrightConnection` instead. */
export const forceDisconnectPlaywrightForTarget = forceDisconnectPlaywrightConnection;

// ── Page Lookup ──

/** CDP target entry from /json/list endpoint. */
interface CdpTarget {
  id: string;
  url: string;
  title?: string;
  type?: string;
  webSocketDebuggerUrl?: string;
}

export function getAllPages(browser: Browser) {
  return browser.contexts().flatMap((c) => c.pages());
}

/** Cache of CDP target IDs — stable for a page's lifetime. */
const pageTargetIdCache = new WeakMap<Page, string>();

export async function pageTargetId(page: Page): Promise<string | null> {
  const cached = pageTargetIdCache.get(page);
  if (cached !== undefined) return cached;
  return withPlaywrightPageCdpSession(page, async (session) => {
    const info = await session.send('Target.getTargetInfo');
    const targetInfo = (info as { targetInfo?: { targetId?: string } }).targetInfo;
    const id = (targetInfo?.targetId ?? '').trim() || null;
    if (id !== null) pageTargetIdCache.set(page, id);
    return id;
  });
}

function matchPageByTargetList(pages: Page[], targets: CdpTarget[], targetId: string): Page | null {
  const target = targets.find((entry) => entry.id === targetId);
  if (!target) return null;
  const urlMatch = pages.filter((page) => page.url() === target.url);
  if (urlMatch.length === 1) return urlMatch[0] ?? null;
  if (urlMatch.length > 1) {
    const sameUrlTargets = targets.filter((entry) => entry.url === target.url);
    if (sameUrlTargets.length === urlMatch.length) {
      const idx = sameUrlTargets.findIndex((entry) => entry.id === targetId);
      if (idx >= 0 && idx < urlMatch.length) return urlMatch[idx] ?? null;
    }
  }
  return null;
}

async function findPageByTargetIdViaTargetList(pages: Page[], targetId: string, cdpUrl: string): Promise<Page | null> {
  const targets = await fetchJsonForCdp(
    appendCdpPath(normalizeCdpHttpBaseForJsonEndpoints(cdpUrl), '/json/list'),
    2000,
  );
  if (!Array.isArray(targets)) return null;
  return matchPageByTargetList(pages, targets as CdpTarget[], targetId);
}

export async function findPageByTargetId(browser: Browser, targetId: string, cdpUrl?: string) {
  const pages = getAllPages(browser);

  const results = await Promise.all(
    pages.map(async (page) => {
      try {
        const tid = await pageTargetId(page);
        return { page, tid };
      } catch {
        return { page, tid: null as string | null };
      }
    }),
  );

  const matched = results.find(({ tid }) => tid !== null && tid !== '' && tid === targetId);
  if (matched) return matched.page;

  if (cdpUrl !== undefined && cdpUrl !== '') {
    try {
      return await findPageByTargetIdViaTargetList(pages, targetId, cdpUrl);
    } catch {}
  }

  return null;
}

async function partitionAccessiblePages(opts: {
  cdpUrl: string;
  pages: Page[];
}): Promise<{ accessible: Page[]; blockedCount: number }> {
  const accessible: Page[] = [];
  let blockedCount = 0;
  for (const page of opts.pages) {
    if (isBlockedPageRef(opts.cdpUrl, page)) {
      blockedCount += 1;
      continue;
    }
    const targetId = await pageTargetId(page).catch(() => null);
    if (targetId === null || targetId === '') {
      if (hasBlockedTargetsForCdpUrl(opts.cdpUrl)) {
        blockedCount += 1;
        continue;
      }
      accessible.push(page);
      continue;
    }
    if (isBlockedTarget(opts.cdpUrl, targetId)) {
      blockedCount += 1;
      continue;
    }
    accessible.push(page);
  }
  return { accessible, blockedCount };
}

export async function getPageForTargetId(opts: { cdpUrl: string; targetId?: string }) {
  if (opts.targetId !== undefined && opts.targetId !== '' && isBlockedTarget(opts.cdpUrl, opts.targetId))
    throw new BlockedBrowserTargetError();
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = getAllPages(browser);
  if (!pages.length) throw new Error('No pages available in the connected browser.');
  const { accessible, blockedCount } = await partitionAccessiblePages({ cdpUrl: opts.cdpUrl, pages });
  if (!accessible.length) {
    if (blockedCount > 0) throw new BlockedBrowserTargetError();
    throw new Error('No pages available in the connected browser.');
  }
  const first = accessible[0];
  if (opts.targetId === undefined || opts.targetId === '') return first;
  const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!found) {
    throw new BrowserTabNotFoundError(
      `Tab not found (targetId: ${opts.targetId}). Call browser.tabs() to list open tabs.`,
    );
  }
  if (isBlockedPageRef(opts.cdpUrl, found)) throw new BlockedBrowserTargetError();
  return found;
}

/**
 * Resolve a page by targetId or throw BrowserTabNotFoundError.
 */
export async function resolvePageByTargetIdOrThrow(opts: { cdpUrl: string; targetId: string }): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) throw new BrowserTabNotFoundError();
  return page;
}

/**
 * Get a page for a target, ensuring page state is initialized.
 */
export async function getRestoredPageForTarget(opts: { cdpUrl: string; targetId?: string }): Promise<Page> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  return page;
}
