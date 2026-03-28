import http from 'node:http';
import https from 'node:https';

import { chromium } from 'playwright-core';
import type { Browser, Page, BrowserContext, CDPSession } from 'playwright-core';

import {
  getChromeWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  normalizeCdpWsUrl,
  isLoopbackHost,
  hasProxyEnvConfigured,
} from './chrome-launcher.js';
import { STEALTH_SCRIPT } from './stealth.js';
import type { PageState, ContextState, RoleRefs, NetworkRequest, DialogHandler } from './types.js';

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
  } catch {
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
  const session = await page.context().newCDPSession(page);
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

class NoProxyLeaseManager {
  private leaseCount = 0;
  private snapshot: { noProxy?: string; noProxyLower?: string; applied: string } | null = null;

  acquire(url: string): (() => void) | null {
    if (!isLoopbackCdpUrl(url) || !hasProxyEnvConfigured()) return null;
    if (this.leaseCount === 0 && !noProxyAlreadyCoversLocalhost()) {
      const noProxy = process.env.NO_PROXY;
      const noProxyLower = process.env.no_proxy;
      const current = noProxy ?? noProxyLower ?? '';
      const applied = current ? `${current},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
      process.env.NO_PROXY = applied;
      process.env.no_proxy = applied;
      this.snapshot = { noProxy, noProxyLower, applied };
    }
    this.leaseCount += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  release(): void {
    if (this.leaseCount <= 0) return;
    this.leaseCount -= 1;
    if (this.leaseCount > 0 || !this.snapshot) return;
    const { noProxy, noProxyLower, applied } = this.snapshot;
    const currentNoProxy = process.env.NO_PROXY;
    const currentNoProxyLower = process.env.no_proxy;
    if (currentNoProxy === applied && (currentNoProxyLower === applied || currentNoProxyLower === undefined)) {
      if (noProxy !== undefined) process.env.NO_PROXY = noProxy;
      else delete process.env.NO_PROXY;
      if (noProxyLower !== undefined) process.env.no_proxy = noProxyLower;
      else delete process.env.no_proxy;
    }
    this.snapshot = null;
  }
}

const noProxyLeaseManager = new NoProxyLeaseManager();

/**
 * Scoped NO_PROXY bypass for loopback CDP URLs.
 * This wrapper only mutates env vars for loopback destinations.
 */
export async function withNoProxyForCdpUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const release = noProxyLeaseManager.acquire(url);
  try {
    return await fn();
  } finally {
    release?.();
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
  } catch {}
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
  } catch {}
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

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

// ── Arm ID Counters ──

let nextUploadArmId = 0;
let nextDialogArmId = 0;
let nextDownloadArmId = 0;

export function bumpUploadArmId(): number {
  nextUploadArmId += 1;
  return nextUploadArmId;
}
export function bumpDialogArmId(): number {
  nextDialogArmId += 1;
  return nextDialogArmId;
}
export function bumpDownloadArmId(): number {
  nextDownloadArmId += 1;
  return nextDownloadArmId;
}

// ── Context State Management ──

export function ensureContextState(context: BrowserContext): ContextState {
  const existing = contextStates.get(context);
  if (existing) return existing;
  const state: ContextState = { traceActive: false };
  contextStates.set(context, state);
  return state;
}

// Ref cache: keyed by "cdpUrl::targetId"
const roleRefsByTarget = new Map<
  string,
  {
    refs: RoleRefs;
    frameSelector?: string;
    mode?: 'role' | 'aria';
  }
>();
const MAX_ROLE_REFS_CACHE = 50;

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

function normalizeCdpUrl(raw: string): string {
  return raw.replace(/\/$/, '');
}

function roleRefsKey(cdpUrl: string, targetId: string): string {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

// ── Page State Management ──

/** Find a network request by ID in the page state. */
export function findNetworkRequestById(state: PageState, id: string): NetworkRequest | undefined {
  for (let i = state.requests.length - 1; i >= 0; i--) {
    const candidate = state.requests[i];
    if (candidate.id === id) return candidate;
  }
  return undefined;
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) return existing;

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    armIdUpload: 0,
    armIdDialog: 0,
    armIdDownload: 0,
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);

    page.on('console', (msg) => {
      state.console.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      });
      if (state.console.length > MAX_CONSOLE_MESSAGES) state.console.shift();
    });

    page.on('pageerror', (err) => {
      state.errors.push({
        message: err.message !== '' ? err.message : String(err),
        name: err.name !== '' ? err.name : undefined,
        stack: err.stack !== undefined && err.stack !== '' ? err.stack : undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS) state.errors.shift();
    });

    page.on('request', (req) => {
      state.nextRequestId += 1;
      const id = `r${String(state.nextRequestId)}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK_REQUESTS) state.requests.shift();
    });

    page.on('response', (resp) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (id === undefined) return;
      const rec = findNetworkRequestById(state, id);
      if (rec) {
        rec.status = resp.status();
        rec.ok = resp.ok();
      }
    });

    page.on('requestfailed', (req) => {
      const id = state.requestIds.get(req);
      if (id === undefined) return;
      const rec = findNetworkRequestById(state, id);
      if (rec) {
        rec.failureText = req.failure()?.errorText;
        rec.ok = false;
      }
    });

    page.on('dialog', (dialog) => {
      // If a one-shot armDialog is active, let it handle the dialog.
      if (state.armIdDialog > 0) return;

      // If a persistent onDialog handler is registered, invoke it.
      if (state.dialogHandler) {
        let handled = false;
        const event = {
          type: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
          accept: (promptText?: string) => { handled = true; return dialog.accept(promptText); },
          dismiss: () => { handled = true; return dialog.dismiss(); },
        };
        Promise.resolve(state.dialogHandler(event))
          .then(() => {
            if (!handled) {
              dialog.dismiss().catch((err: unknown) => {
                console.warn(`[browserclaw] Failed to auto-dismiss dialog: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          })
          .catch((err: unknown) => {
            console.warn(`[browserclaw] onDialog handler error: ${err instanceof Error ? err.message : String(err)}`);
            if (!handled) {
              dialog.dismiss().catch((dismissErr: unknown) => {
                console.warn(`[browserclaw] Failed to dismiss dialog after handler error: ${dismissErr instanceof Error ? dismissErr.message : String(dismissErr)}`);
              });
            }
          });
        return;
      }

      // Default: auto-dismiss unexpected dialogs.
      dialog.dismiss().catch((err: unknown) => {
        console.warn(`[browserclaw] Failed to dismiss dialog: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    page.on('close', () => {
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
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
  const state = ensurePageState(page);
  state.dialogHandler = opts.handler;
}

// ── Stealth ──

function applyStealthToPage(page: Page): void {
  page.evaluate(STEALTH_SCRIPT).catch((e: unknown) => {
    if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
      console.warn('[browserclaw] stealth evaluate failed:', e instanceof Error ? e.message : String(e));
  });
}

export function observeContext(context: BrowserContext): void {
  if (observedContexts.has(context)) return;
  observedContexts.add(context);
  ensureContextState(context);

  context.addInitScript(STEALTH_SCRIPT).catch((e: unknown) => {
    if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
      console.warn('[browserclaw] stealth initScript failed:', e instanceof Error ? e.message : String(e));
  });

  for (const page of context.pages()) {
    ensurePageState(page);
    applyStealthToPage(page);
  }
  context.on('page', (page) => {
    ensurePageState(page);
    applyStealthToPage(page);
  });
}

function observeBrowser(browser: Browser): void {
  for (const context of browser.contexts()) observeContext(context);
}

// ── Role Refs Storage ──

/**
 * Remember role refs in the target cache (without storing on page state).
 * Used to persist refs across page reconnections.
 */
export function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: 'role' | 'aria';
}): void {
  const targetId = opts.targetId.trim();
  if (targetId === '') return;
  roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    refs: opts.refs,
    ...(opts.frameSelector !== undefined && opts.frameSelector !== '' ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done === true) break;
    roleRefsByTarget.delete(first.value);
  }
}

export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode: 'role' | 'aria';
}): void {
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsMode = opts.mode;

  if (opts.targetId === undefined || opts.targetId.trim() === '') return;
  rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
  });
}

export function restoreRoleRefsForTarget(opts: { cdpUrl: string; targetId?: string; page: Page }): void {
  const targetId = opts.targetId?.trim() ?? '';
  if (targetId === '') return;
  const entry = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
  if (!entry) return;
  const state = ensurePageState(opts.page);
  if (state.roleRefs) return;
  state.roleRefs = entry.refs;
  state.roleRefsFrameSelector = entry.frameSelector;
  state.roleRefsMode = entry.mode;
}

// ── Connect to Browser ──

export async function connectBrowser(cdpUrl: string, authToken?: string): Promise<CachedConnection> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const existing_cached = cachedByCdpUrl.get(normalized);
  if (existing_cached) return existing_cached;

  const existing = connectingByCdpUrl.get(normalized);
  if (existing) return await existing;

  const connectWithRetry = async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const timeout = 5000 + attempt * 2000;
        const endpoint = (await getChromeWebSocketUrl(normalized, timeout, authToken).catch(() => null)) ?? normalized;
        const headers: Record<string, string> = getHeadersWithAuth(endpoint);
        if (authToken !== undefined && authToken !== '' && !headers.Authorization)
          headers.Authorization = `Bearer ${authToken}`;
        const browser = await withNoProxyForCdpUrl(endpoint, () =>
          chromium.connectOverCDP(endpoint, { timeout, headers }),
        );
        const onDisconnected = () => {
          if (cachedByCdpUrl.get(normalized)?.browser === browser) {
            cachedByCdpUrl.delete(normalized);
            for (const key of roleRefsByTarget.keys()) {
              if (key.startsWith(normalized + '::')) roleRefsByTarget.delete(key);
            }
          }
        };
        const connected: CachedConnection = { browser, cdpUrl: normalized, onDisconnected };
        cachedByCdpUrl.set(normalized, connected);
        observeBrowser(browser);
        browser.on('disconnected', onDisconnected);
        return connected;
      } catch (err) {
        lastErr = err;
        if ((err instanceof Error ? err.message : String(err)).includes('rate limit')) break;
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
}

export async function disconnectBrowser(): Promise<void> {
  if (connectingByCdpUrl.size) {
    for (const p of connectingByCdpUrl.values()) {
      try {
        await p;
      } catch {}
    }
  }
  for (const cur of cachedByCdpUrl.values()) {
    if (cur.onDisconnected && typeof cur.browser.off === 'function')
      cur.browser.off('disconnected', cur.onDisconnected);
    await cur.browser.close().catch(() => {
      /* noop */
    });
  }
  cachedByCdpUrl.clear();
}

/**
 * Close the Playwright connection for a specific CDP URL without affecting other connections.
 */
export async function closePlaywrightBrowserConnection(opts?: { cdpUrl?: string }): Promise<void> {
  if (opts?.cdpUrl !== undefined && opts.cdpUrl !== '') {
    const normalized = normalizeCdpUrl(opts.cdpUrl);
    const cur = cachedByCdpUrl.get(normalized);
    cachedByCdpUrl.delete(normalized);
    connectingByCdpUrl.delete(normalized);
    if (!cur) return;
    if (cur.onDisconnected && typeof cur.browser.off === 'function')
      cur.browser.off('disconnected', cur.onDisconnected);
    await cur.browser.close().catch(() => {
      /* noop */
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
 * Force-disconnect a Playwright browser connection for a given CDP target.
 * Clears the connection cache, sends Runtime.terminateExecution via raw CDP
 * websocket to kill stuck evals (bypassing Playwright), and closes the browser.
 */
export async function forceDisconnectPlaywrightForTarget(opts: {
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

  cur.browser.close().catch(() => {
    /* noop */
  });
}

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

export async function pageTargetId(page: Page): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = await session.send('Target.getTargetInfo');
    const targetInfo = (info as { targetInfo?: { targetId?: string } }).targetInfo;
    return (targetInfo?.targetId ?? '').trim() || null;
  } finally {
    await session.detach().catch(() => {
      /* noop */
    });
  }
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

  let resolvedViaCdp = false;
  for (const page of pages) {
    let tid: string | null = null;
    try {
      tid = await pageTargetId(page);
      resolvedViaCdp = true;
    } catch {
      tid = null;
    }
    if (tid !== null && tid !== '' && tid === targetId) return page;
  }

  if (cdpUrl !== undefined && cdpUrl !== '') {
    try {
      return await findPageByTargetIdViaTargetList(pages, targetId, cdpUrl);
    } catch {}
  }

  // Last resort: if CDP sessions failed for all pages and there's only one, return it
  if (!resolvedViaCdp && pages.length === 1) return pages[0] ?? null;
  return null;
}

export async function getPageForTargetId(opts: { cdpUrl: string; targetId?: string }) {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = getAllPages(browser);
  if (!pages.length) throw new Error('No pages available in the connected browser.');
  const first = pages[0];
  if (opts.targetId === undefined || opts.targetId === '') return first;
  const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!found) {
    if (pages.length === 1) return first;
    throw new BrowserTabNotFoundError(
      `Tab not found (targetId: ${opts.targetId}). Call browser.tabs() to list open tabs.`,
    );
  }
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

// ── Ref Helpers ──

/**
 * Parse a role ref string (e.g. "e1", "@e1", "ref=e1") to a normalized ref ID.
 * Returns null if the string is not a valid role ref.
 */
export function parseRoleRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('@')
    ? trimmed.slice(1)
    : trimmed.startsWith('ref=')
      ? trimmed.slice(4)
      : trimmed;
  return /^e\d+$/.test(normalized) ? normalized : null;
}

/**
 * Require a ref string, normalizing and validating it.
 * Throws if the ref is empty.
 */
export function requireRef(value: string | undefined): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const ref = (raw ? parseRoleRef(raw) : null) ?? (raw.startsWith('@') ? raw.slice(1) : raw);
  if (!ref) throw new Error('ref is required');
  return ref;
}

/**
 * Require either a ref or selector, returning whichever is provided.
 * Throws if neither is provided.
 */
export function requireRefOrSelector(ref?: string, selector?: string): { ref?: string; selector?: string } {
  const trimmedRef = typeof ref === 'string' ? ref.trim() : '';
  const trimmedSelector = typeof selector === 'string' ? selector.trim() : '';
  if (!trimmedRef && !trimmedSelector) throw new Error('ref or selector is required');
  return { ref: trimmedRef || undefined, selector: trimmedSelector || undefined };
}

/** Clamp interaction timeout to [500, 60000]ms range, defaulting to 8000ms. */
export function resolveInteractionTimeoutMs(timeoutMs?: number): number {
  return Math.max(500, Math.min(60000, Math.floor(timeoutMs ?? 8000)));
}

/** Bounded delay validator for animation/interaction delays. */
export function resolveBoundedDelayMs(value: number | undefined, label: string, maxMs: number): number {
  const normalized = Math.floor(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error(`${label} must be >= 0`);
  if (normalized > maxMs) throw new Error(`${label} exceeds maximum of ${String(maxMs)}ms`);
  return normalized;
}

/**
 * Get a page for a target, ensuring page state is initialized and role refs are restored.
 */
export async function getRestoredPageForTarget(opts: { cdpUrl: string; targetId?: string }): Promise<Page> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return page;
}

// ── Ref Locator ──

export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith('@') ? ref.slice(1) : ref.startsWith('ref=') ? ref.slice(4) : ref;
  if (normalized.trim() === '') throw new Error('ref is required');

  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);

    // Aria mode: use aria-ref locator
    if (state?.roleRefsMode === 'aria') {
      return (
        state.roleRefsFrameSelector !== undefined && state.roleRefsFrameSelector !== ''
          ? page.frameLocator(state.roleRefsFrameSelector)
          : page
      ).locator(`aria-ref=${normalized}`);
    }

    // Role mode: use getByRole
    const info = state?.roleRefs?.[normalized];
    if (!info) throw new Error(`Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`);

    const locAny =
      state.roleRefsFrameSelector !== undefined && state.roleRefsFrameSelector !== ''
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
    const role = info.role as Parameters<Page['getByRole']>[0];
    const locator =
      info.name !== undefined && info.name !== ''
        ? locAny.getByRole(role, { name: info.name, exact: true })
        : locAny.getByRole(role);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}

// ── Error Helpers ──

export function toAIFriendlyError(error: unknown, selector: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('strict mode violation')) {
    const countMatch = /resolved to (\d+) elements/.exec(message);
    const count = countMatch ? countMatch[1] : 'multiple';
    return new Error(
      `Selector "${selector}" matched ${count} elements. Run a new snapshot to get updated refs, or use a different ref.`,
    );
  }
  if (
    (message.includes('Timeout') || message.includes('waiting for')) &&
    (message.includes('to be visible') || message.includes('not visible'))
  ) {
    return new Error(
      `Element "${selector}" not found or not visible. Run a new snapshot to see current page elements.`,
    );
  }
  if (
    message.includes('intercepts pointer events') ||
    message.includes('not visible') ||
    message.includes('not receive pointer events')
  ) {
    return new Error(
      `Element "${selector}" is not interactable (hidden or covered). Try scrolling it into view, closing overlays, or re-snapshotting.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number, maxMs = 120000): number {
  return Math.max(500, Math.min(maxMs, timeoutMs ?? fallback));
}
