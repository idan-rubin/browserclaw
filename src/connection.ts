import http from 'node:http';
import https from 'node:https';

import type { Browser, Page, Frame, CDPSession } from 'playwright-core';

import { closeCdpSocket, fetchCdpJson, openPinnedCdpSocket, sendCdpCommand, type CdpEndpoint } from './cdp-network.js';
import { connectOverPinnedCdp } from './cdp-transport.js';
import {
  getChromeWebSocketEndpoint,
  isWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  normalizeCdpWsUrl,
  isLoopbackHost,
  hasProxyEnvConfigured,
} from './chrome-launcher.js';
import { BrowserTabNotFoundError } from './errors.js';
import { pageTargetInfo } from './page-target.js';
import { ensurePageState, observeBrowser, setDialogHandlerOnPage, type ObserveOptions } from './page-utils.js';
import { clearRoleRefsForCdpUrl, normalizeCdpUrl } from './ref-resolver.js';
import {
  BrowserCdpEndpointBlockedError,
  InvalidBrowserNavigationUrlError,
  assertCdpEndpointAllowed,
  resolveCdpEndpointPin,
  getHeadersWithAuth,
  isPrivateNetworkAllowedByPolicy,
  scopeCdpPolicyToConfiguredEndpoint,
  stripUrlCredentials,
} from './security.js';
import type { DialogHandler, SsrfPolicy } from './types.js';

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
  truncateUtf16Safe,
} from './page-utils.js';

export {
  rememberRoleRefsForTarget,
  storeRoleRefsForTarget,
  clearRoleRefsForCdpUrl,
  parseRoleRef,
  requireRef,
  requireRefOrSelector,
  resolveInteractionTimeoutMs,
  resolveBoundedDelayMs,
  refLocator,
} from './ref-resolver.js';

// ── Errors ──

export { BrowserTabNotFoundError, StaleRefError, SnapshotHydrationError, NavigationRaceError } from './errors.js';

/**
 * Page extended with Playwright's AI-snapshot APIs.
 *
 * Playwright <1.59 exposed `_snapshotForAI` on the client Page class; Playwright >=1.59
 * removed it and promoted the capability to `ariaSnapshot({ mode: 'ai' })`.
 * We keep both shapes here and pick whichever is available at runtime.
 */
export type PageWithAI = Page & {
  _snapshotForAI?: (opts: { timeout: number }) => Promise<{ full?: string }>;
  ariaSnapshot?: (opts: { timeout?: number; mode?: string }) => Promise<string>;
};

/**
 * Take an AI-mode snapshot using whichever API the installed playwright-core exposes.
 * Returns the raw snapshot text (the `e1`/`e2` ref-style aria tree).
 */
export async function takeAiSnapshotText(page: Page, timeoutMs: number): Promise<string> {
  const pageWithAI = page as PageWithAI;
  if (typeof pageWithAI._snapshotForAI === 'function') {
    const result = await pageWithAI._snapshotForAI({ timeout: timeoutMs });
    return result.full ?? '';
  }
  if (typeof pageWithAI.ariaSnapshot === 'function') {
    return await pageWithAI.ariaSnapshot({ timeout: timeoutMs, mode: 'ai' });
  }
  throw new Error(
    'AI snapshot API not available. Install playwright-core >=1.50 (uses _snapshotForAI) or >=1.59 (uses ariaSnapshot with mode: "ai").',
  );
}

async function fetchJsonForCdp(
  url: string,
  timeoutMs: number,
  ssrfPolicy?: SsrfPolicy,
  configuredUrl?: string,
): Promise<unknown> {
  const fetchUrl = stripUrlCredentials(url);
  try {
    return await fetchCdpJson(url, { timeoutMs, ssrfPolicy, configuredUrl });
  } catch (err) {
    if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
      console.warn(
        `[browserclaw] fetchJsonForCdp ${fetchUrl} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    return null;
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
export async function withPlaywrightPageCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>,
  timeoutMs = 10_000,
  frame?: Frame,
): Promise<T> {
  let session: CDPSession | undefined;
  let expired = false;
  const isExpired = (): boolean => expired;
  let detach: Promise<void> | undefined;
  const releaseSession = (): Promise<void> | undefined => {
    if (session) detach ??= session.detach().catch(() => undefined);
    return detach;
  };
  const operation = (async () => {
    let ownerFrame = frame;
    for (;;) {
      try {
        session = await page.context().newCDPSession(ownerFrame ?? page);
        break;
      } catch (error) {
        if (!ownerFrame || !(error instanceof Error) || !error.message.includes('does not have a separate CDP session'))
          throw error;
        if (isExpired()) throw error;
        ownerFrame = ownerFrame.parentFrame() ?? undefined;
      }
    }
    try {
      if (isExpired()) throw new Error('Page CDP operation has already expired.');
      return await fn(session);
    } finally {
      await releaseSession();
    }
  })();
  try {
    return await withOperationTimeout(operation, timeoutMs, 'Page CDP operation');
  } finally {
    expired = true;
    void releaseSession();
  }
}

async function withOperationTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            reject(new Error(`${label} timed out.`));
          },
          Math.max(1, timeoutMs),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a function with a page-scoped CDP client.
 */
export async function withPageScopedCdpClient<T>(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  timeoutMs?: number;
  frame?: Frame;
  fn: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>;
}): Promise<T> {
  return await withPlaywrightPageCdpSession(
    opts.page,
    async (session) => opts.fn((method, params) => session.send(method as Parameters<CDPSession['send']>[0], params)),
    opts.timeoutMs,
    opts.frame,
  );
}

// ── NO_PROXY Lease Manager (for loopback CDP URLs) ──

const LOOPBACK_ENTRIES = 'localhost,127.0.0.1,[::1]';

function noProxyValueCoversLocalhost(value: string | undefined): boolean {
  const entries = new Set(
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  return entries.has('localhost') && entries.has('127.0.0.1') && entries.has('[::1]');
}

function noProxyAlreadyCoversLocalhost(): boolean {
  return noProxyValueCoversLocalhost(process.env.NO_PROXY) && noProxyValueCoversLocalhost(process.env.no_proxy);
}

function appendLoopbackEntries(value: string | undefined): string {
  return value !== undefined && value !== '' ? `${value},${LOOPBACK_ENTRIES}` : LOOPBACK_ENTRIES;
}

function isLoopbackCdpUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Every overlapping operation owns a lease; restoring on an earlier completion
// would expose the remaining caller's loopback traffic to its configured proxy.
let noProxyLeaseCount = 0;
let noProxySnapshot: { upper?: string; lower?: string; appliedUpper: string; appliedLower: string } | undefined;

/**
 * Scoped NO_PROXY bypass for loopback CDP URLs.
 * Restores after the final lease, without overwriting external environment changes.
 */
export async function withNoProxyForCdpUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
  if (!isLoopbackCdpUrl(url) || !hasProxyEnvConfigured()) return fn();

  if (noProxyLeaseCount === 0 && !noProxyAlreadyCoversLocalhost()) {
    const upper = process.env.NO_PROXY;
    const lower = process.env.no_proxy;
    const appliedUpper = appendLoopbackEntries(upper ?? lower);
    const appliedLower = appendLoopbackEntries(lower ?? upper);
    noProxySnapshot = { upper, lower, appliedUpper, appliedLower };
    process.env.NO_PROXY = appliedUpper;
    process.env.no_proxy = appliedLower;
  }
  noProxyLeaseCount += 1;
  try {
    return await fn();
  } finally {
    noProxyLeaseCount -= 1;
    if (noProxyLeaseCount === 0 && noProxySnapshot) {
      const snapshot = noProxySnapshot;
      noProxySnapshot = undefined;
      if (process.env.NO_PROXY === snapshot.appliedUpper) {
        if (snapshot.upper !== undefined) process.env.NO_PROXY = snapshot.upper;
        else delete process.env.NO_PROXY;
      }
      if (process.env.no_proxy === snapshot.appliedLower) {
        if (snapshot.lower !== undefined) process.env.no_proxy = snapshot.lower;
        else delete process.env.no_proxy;
      }
    }
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
export { getHeadersWithAuth, stripUrlCredentials } from './security.js';

// ── Persistent Connection Cache ──

interface CachedConnection {
  browser: Browser;
  cdpUrl: string;
  onDisconnected?: () => void;
}

interface ConnectionAttempt {
  cancelled: boolean;
  retired?: CachedConnection;
  browser?: Browser;
}

interface PendingConnection {
  waiters: number;
  attempt: ConnectionAttempt;
  promise: Promise<CachedConnection>;
}

const cachedByCdpUrl = new Map<string, CachedConnection>();
const connectingByCdpUrl = new Map<string, PendingConnection>();
const retainedClosingByCdpUrl = new Map<string, Set<CachedConnection>>();
const closeConnectionPromises = new WeakMap<CachedConnection, Promise<void>>();
const PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS = 2000;
const stealthByCdpUrl = new Map<string, boolean>();
// Remembered per-URL so reconnects re-run assertCdpEndpointAllowed even when
// the action function chain doesn't thread a policy through. Closes the
// DNS-rebinding window between connect attempts.
const lastPolicyByCdpUrl = new Map<string, SsrfPolicy>();

export function getStealthEnabledForCdpUrl(cdpUrl: string): boolean {
  return stealthByCdpUrl.get(normalizeCdpUrl(cdpUrl)) ?? false;
}

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
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  setDialogHandlerOnPage(page, opts.handler);
}

// ── Connect to Browser ──

/** Keep failed or slow adapter closes reachable so a later close can retry them. */
function closeTrackedConnection(connection: CachedConnection): Promise<void> {
  const existing = closeConnectionPromises.get(connection);
  if (existing) return existing;
  const retained = retainedClosingByCdpUrl.get(connection.cdpUrl) ?? new Set<CachedConnection>();
  retained.add(connection);
  retainedClosingByCdpUrl.set(connection.cdpUrl, retained);
  const closing = Promise.resolve()
    .then(() => connection.browser.close())
    .then(
      () => {
        retained.delete(connection);
        if (retained.size === 0 && retainedClosingByCdpUrl.get(connection.cdpUrl) === retained)
          retainedClosingByCdpUrl.delete(connection.cdpUrl);
      },
      (error: unknown) => {
        closeConnectionPromises.delete(connection);
        throw error;
      },
    );
  closeConnectionPromises.set(connection, closing);
  return closing;
}

function takeCachedConnection(normalized: string, expectedBrowser?: Browser): CachedConnection | undefined {
  const connection = cachedByCdpUrl.get(normalized);
  if (expectedBrowser && connection?.browser !== expectedBrowser) return undefined;
  cachedByCdpUrl.delete(normalized);
  const pending = connectingByCdpUrl.get(normalized);
  if (pending) pending.attempt.cancelled = true;
  connectingByCdpUrl.delete(normalized);
  clearRoleRefsForCdpUrl(normalized);
  if (connection?.onDisconnected) connection.browser.off('disconnected', connection.onDisconnected);
  return connection;
}

export function evictStaleConnection(cdpUrl: string, expectedBrowser: Browser): void {
  const connection = takeCachedConnection(normalizeCdpUrl(cdpUrl), expectedBrowser);
  if (connection) void closeTrackedConnection(connection).catch(() => undefined);
}

async function awaitPendingConnection(
  normalized: string,
  pending: PendingConnection,
  signal?: AbortSignal,
): Promise<CachedConnection> {
  pending.waiters++;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
  try {
    return await Promise.race([pending.promise, aborted]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    pending.waiters--;
    // Only retire an unfinished attempt when its last waiter cancels.
    if (signal?.aborted === true && pending.waiters === 0 && connectingByCdpUrl.get(normalized) === pending) {
      pending.attempt.cancelled = true;
      connectingByCdpUrl.delete(normalized);
      if (pending.attempt.browser) evictStaleConnection(normalized, pending.attempt.browser);
    }
  }
}

/** Snapshot ownership before awaiting anything; never collect a later successor. */
function retireConnectionExact(normalized: string): Promise<void> {
  const pending = connectingByCdpUrl.get(normalized);
  const connection = takeCachedConnection(normalized);
  const captured = new Set(retainedClosingByCdpUrl.get(normalized));
  if (connection) captured.add(connection);
  const closing = [...captured].map(closeTrackedConnection);
  if (pending) {
    closing.push(
      pending.promise.then(
        async (connected) => closeTrackedConnection(connected),
        async () => {
          if (pending.attempt.retired) await closeTrackedConnection(pending.attempt.retired);
        },
      ),
    );
  }
  return withOperationTimeout(
    Promise.allSettled(closing).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    }),
    PLAYWRIGHT_CONNECTION_CLOSE_TIMEOUT_MS,
    'Playwright adapter disconnect',
  );
}

export async function connectBrowser(
  cdpUrl: string,
  authToken?: string,
  ssrfPolicy?: SsrfPolicy,
  observeOptions?: ObserveOptions,
  signal?: AbortSignal,
): Promise<CachedConnection> {
  signal?.throwIfAborted();
  const normalized = normalizeCdpUrl(cdpUrl);
  if (observeOptions?.stealth === true && stealthByCdpUrl.get(normalized) !== true)
    stealthByCdpUrl.set(normalized, true);
  const effectiveObserveOptions: ObserveOptions = { stealth: getStealthEnabledForCdpUrl(normalized) };
  const observeCached = async (connected: CachedConnection): Promise<CachedConnection> => {
    if (observeOptions?.stealth === true) await observeBrowser(connected.browser, { stealth: true });
    return connected;
  };

  // Only return a cached connection once its initialization has completed.
  const existing_cached = cachedByCdpUrl.get(normalized);
  if (existing_cached && !connectingByCdpUrl.has(normalized)) return await observeCached(existing_cached);

  if (ssrfPolicy !== undefined) lastPolicyByCdpUrl.set(normalized, ssrfPolicy);
  const effectivePolicy = ssrfPolicy ?? lastPolicyByCdpUrl.get(normalized);
  const configuredPin = await resolveCdpEndpointPin(normalized, effectivePolicy, undefined, signal);
  signal?.throwIfAborted();

  const existing = connectingByCdpUrl.get(normalized);
  if (existing) return await observeCached(await awaitPendingConnection(normalized, existing, signal));

  const connectionAttempt: ConnectionAttempt = { cancelled: false };
  const isCancelled = (): boolean => connectionAttempt.cancelled;
  const isPolicyError = (err: unknown): boolean =>
    err instanceof BrowserCdpEndpointBlockedError || err instanceof InvalidBrowserNavigationUrlError;
  const connectWithRetry = async (): Promise<CachedConnection> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (isCancelled()) break;
      try {
        const timeout = 5000 + attempt * 2000;
        let discovered: CdpEndpoint | null;
        try {
          discovered = await getChromeWebSocketEndpoint(normalized, timeout, authToken, effectivePolicy);
        } catch (discoveryErr) {
          if (isPolicyError(discoveryErr)) throw discoveryErr;
          discovered = null;
        }
        if (discovered === null && !isWebSocketUrl(normalized)) {
          if (stripUrlCredentials(normalized) !== normalized)
            throw new Error('Authenticated CDP HTTP endpoint did not expose a usable WebSocket URL.');
          if (effectivePolicy !== undefined && !isPrivateNetworkAllowedByPolicy(effectivePolicy))
            throw new Error('CDP HTTP endpoint did not expose a usable WebSocket URL; refusing an unvalidated dial.');
        }
        const endpoint = discovered ?? { url: normalized, lookup: configuredPin?.lookup };
        const connectAt = async (target: CdpEndpoint) => {
          const headers: Record<string, string> = getHeadersWithAuth(target.url);
          if (authToken !== undefined && authToken !== '' && !headers.Authorization)
            headers.Authorization = `Bearer ${authToken}`;
          // Credentials travel in the Authorization header; never in the dialed URL.
          const connectionUrl = stripUrlCredentials(target.url);
          // The custom transport only accepts an actual WebSocket endpoint; it
          // never delegates unvalidated HTTP discovery to a dependency.
          return await withNoProxyForCdpUrl(connectionUrl, () =>
            connectOverPinnedCdp({ ...target, url: connectionUrl }, { timeoutMs: timeout, headers }),
          );
        };
        let browser: Browser;
        try {
          browser = await connectAt(endpoint);
        } catch (connectErr) {
          if (!isWebSocketUrl(normalized) || endpoint.url === normalized) throw connectErr;
          browser = await connectAt({ url: normalized, lookup: configuredPin?.lookup });
        }
        if (isCancelled()) {
          connectionAttempt.retired = { browser, cdpUrl: normalized };
          void closeTrackedConnection(connectionAttempt.retired).catch(() => undefined);
          throw new Error('Playwright connection attempt was superseded.');
        }
        const onDisconnected = () => {
          if (cachedByCdpUrl.get(normalized)?.browser === browser) {
            cachedByCdpUrl.delete(normalized);
            clearRoleRefsForCdpUrl(normalized);
          }
        };
        const connected: CachedConnection = { browser, cdpUrl: normalized, onDisconnected };
        connectionAttempt.browser = browser;
        cachedByCdpUrl.set(normalized, connected);
        browser.on('disconnected', onDisconnected);
        try {
          await observeBrowser(browser, effectiveObserveOptions);
          if (isCancelled()) throw new Error('Playwright connection attempt was superseded.');
        } catch (error) {
          connectionAttempt.retired = connected;
          evictStaleConnection(normalized, browser);
          void closeTrackedConnection(connected).catch(() => undefined);
          throw error;
        }
        return connected;
      } catch (err) {
        if (isPolicyError(err)) throw err;
        lastErr = err;
        if (isCancelled()) break;
        const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
        if (message.includes('rate limit') || message.includes('cdp websocket http 429')) break;
        await new Promise((r) => setTimeout(r, 250 + attempt * 250));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('CDP connect failed');
  };

  const promise = withConnectionLock(async () => {
    if (isCancelled()) throw new Error('Playwright connection attempt was cancelled before it started.');
    const rechecked = cachedByCdpUrl.get(normalized);
    if (rechecked) return await observeCached(rechecked);
    return await connectWithRetry();
  }).finally(() => {
    if (connectingByCdpUrl.get(normalized)?.attempt === connectionAttempt) connectingByCdpUrl.delete(normalized);
  });
  const pending = { attempt: connectionAttempt, promise, waiters: 0 };
  connectingByCdpUrl.set(normalized, pending);
  return await awaitPendingConnection(normalized, pending, signal);
}

export async function disconnectBrowser(): Promise<void> {
  const urls = new Set([...cachedByCdpUrl.keys(), ...connectingByCdpUrl.keys(), ...retainedClosingByCdpUrl.keys()]);
  stealthByCdpUrl.clear();
  lastPolicyByCdpUrl.clear();
  clearBlockedTargetsForCdpUrl();
  clearBlockedPageRefsForCdpUrl();
  const results = await Promise.allSettled([...urls].map(retireConnectionExact));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

/**
 * Close the Playwright connection for a specific CDP URL without affecting other connections.
 */
export async function closePlaywrightBrowserConnection(opts?: {
  cdpUrl?: string;
  preserveSsrfState?: boolean;
}): Promise<void> {
  if (opts?.cdpUrl !== undefined && opts.cdpUrl !== '') {
    const normalized = normalizeCdpUrl(opts.cdpUrl);
    if (opts.preserveSsrfState !== true) {
      clearBlockedTargetsForCdpUrl(normalized);
      clearBlockedPageRefsForCdpUrl(normalized);
      stealthByCdpUrl.delete(normalized);
      lastPolicyByCdpUrl.delete(normalized);
    }
    await retireConnectionExact(normalized);
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
async function tryTerminateExecutionViaCdp(
  cdpUrl: string,
  targetId: string,
  ssrfPolicy?: SsrfPolicy,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (!isCurrent()) return;
  await assertCdpEndpointAllowed(cdpUrl, ssrfPolicy);
  if (!isCurrent()) return;
  const httpBase = normalizeCdpHttpBaseForJsonEndpoints(cdpUrl);
  const listUrl = appendCdpPath(httpBase, '/json/list');
  const controlPolicy = scopeCdpPolicyToConfiguredEndpoint(cdpUrl, ssrfPolicy);
  const targets = await fetchJsonForCdp(listUrl, 2000, controlPolicy, cdpUrl);

  if (!Array.isArray(targets) || !isCurrent()) return;
  const target = targets.find((entry: unknown) => {
    const e = entry as { id?: string; webSocketDebuggerUrl?: string };
    return (e.id ?? '').trim() === targetId;
  }) as { id?: string; webSocketDebuggerUrl?: string } | undefined;
  const wsUrlRaw = (target?.webSocketDebuggerUrl ?? '').trim();
  if (wsUrlRaw === '') return;

  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, httpBase);
  const pin = await resolveCdpEndpointPin(wsUrl, controlPolicy, {
    source: 'discovered',
    configuredUrl: cdpUrl,
  });
  if (!isCurrent()) return;
  const socket = await openPinnedCdpSocket({ url: wsUrl, lookup: pin?.lookup }, { timeoutMs: 2000 }).catch(() => null);
  if (socket === null) return;
  let sessionId: string | undefined;
  try {
    if (!isCurrent()) return;
    if (cdpSocketNeedsAttach(wsUrl)) {
      const attached = await sendCdpCommand(socket, 'Target.attachToTarget', { targetId, flatten: true });
      sessionId = typeof attached.sessionId === 'string' ? attached.sessionId : undefined;
      if (sessionId === undefined || sessionId === '') return;
    }
    if (isCurrent()) await sendCdpCommand(socket, 'Runtime.terminateExecution', undefined, sessionId);
  } catch {
    /* Termination is best effort. */
  } finally {
    if (sessionId !== undefined && sessionId !== '')
      await sendCdpCommand(socket, 'Target.detachFromTarget', { sessionId }, undefined, 300).catch(() => undefined);
    closeCdpSocket(socket);
  }
}

/** Terminate only while the originating page still owns this exact adapter. */
export async function tryTerminateExecutionForPage(opts: {
  cdpUrl: string;
  targetId: string;
  page: Page;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  const connection = cachedByCdpUrl.get(normalized);
  if (!connection) return;
  if (opts.page.context().browser() !== connection.browser) return;
  await tryTerminateExecutionViaCdp(
    normalized,
    opts.targetId,
    opts.ssrfPolicy,
    () => cachedByCdpUrl.get(normalized) === connection,
  );
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
  ssrfPolicy?: SsrfPolicy;
  page?: Page;
}): Promise<void> {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  const cur = cachedByCdpUrl.get(normalized);
  if (!cur) {
    // Legacy callers can time out while their first connection is still queued.
    // An originating page, however, must never cancel an unrelated successor.
    if (!opts.page) takeCachedConnection(normalized);
    return;
  }
  if (opts.page && opts.page.context().browser() !== cur.browser) return;

  const targetId = opts.targetId?.trim() ?? '';
  if (targetId !== '') {
    await tryTerminateExecutionViaCdp(
      normalized,
      targetId,
      opts.ssrfPolicy,
      () => cachedByCdpUrl.get(normalized) === cur,
    ).catch(() => {
      /* noop */
    });
  }

  evictStaleConnection(normalized, cur.browser);
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

export function getAllPages(browser: Browser) {
  return browser.contexts().flatMap((c) => c.pages().filter((p) => !p.url().startsWith('chrome://omnibox-popup')));
}

/** Cache of CDP target IDs — stable for a page's lifetime. */
const pageTargetIdCache = new WeakMap<Page, string>();

export async function pageTargetId(page: Page): Promise<string | null> {
  const cached = pageTargetIdCache.get(page);
  if (cached !== undefined) return cached;
  const id = (await pageTargetInfo(page))?.targetId ?? null;
  if (id !== null) pageTargetIdCache.set(page, id);
  return id;
}

export async function findPageByTargetId(browser: Browser, targetId: string, cdpUrl?: string, ssrfPolicy?: SsrfPolicy) {
  // Retain the exported signature, but never infer identity from a URL or list order.
  void ssrfPolicy;
  if (cdpUrl !== undefined && cdpUrl !== '' && isBlockedTarget(cdpUrl, targetId)) return null;
  const pages = getAllPages(browser);

  const results = await Promise.all(
    pages.map(async (page) => {
      if (cdpUrl !== undefined && cdpUrl !== '' && isBlockedPageRef(cdpUrl, page)) return { page, tid: null };
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

  return null;
}

async function partitionAccessiblePages(opts: {
  cdpUrl: string;
  pages: Page[];
}): Promise<{ accessible: Page[]; blockedCount: number }> {
  const accessible: Page[] = [];
  let blockedCount = 0;
  const candidates = await Promise.all(
    opts.pages.map(async (page) => ({
      page,
      targetId: isBlockedPageRef(opts.cdpUrl, page) ? null : await pageTargetId(page).catch(() => null),
    })),
  );
  for (const { page, targetId } of candidates) {
    if (isBlockedPageRef(opts.cdpUrl, page)) {
      blockedCount += 1;
      continue;
    }
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

export function hasCachedPlaywrightBrowserConnection(cdpUrl: string): boolean {
  return cachedByCdpUrl.has(normalizeCdpUrl(cdpUrl));
}

export function isRecoverablePlaywrightDisconnectError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    message.includes('target page, context or browser has been closed') ||
    message.includes('browser has been closed') ||
    message.includes('browser disconnected') ||
    message.includes('target closed') ||
    message.includes('connection closed') ||
    message.includes('websocket closed') ||
    message.includes('cdp socket closed')
  );
}

export function isRecoverableStalePageSelectionError(
  err: unknown,
  reusedCachedBrowser: boolean,
  hadExplicitTargetId?: boolean,
): boolean {
  // Retained for source compatibility; an explicit target now also gets one reconnect.
  void hadExplicitTargetId;
  if (!reusedCachedBrowser) return false;
  if (err instanceof Error && err.message.includes('No pages available in the connected browser.')) return true;
  if (err instanceof BrowserTabNotFoundError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('tab not found');
}

async function getPageForTargetIdOnce(opts: { cdpUrl: string; targetId?: string; ssrfPolicy?: SsrfPolicy }) {
  if (opts.targetId !== undefined && opts.targetId !== '' && isBlockedTarget(opts.cdpUrl, opts.targetId))
    throw new BlockedBrowserTargetError();
  const { browser } = await connectBrowser(opts.cdpUrl, undefined, opts.ssrfPolicy);
  const pages = getAllPages(browser);
  if (!pages.length) throw new Error('No pages available in the connected browser.');
  const { accessible, blockedCount } = await partitionAccessiblePages({ cdpUrl: opts.cdpUrl, pages });
  if (!accessible.length) {
    if (blockedCount > 0) throw new BlockedBrowserTargetError();
    throw new Error('No pages available in the connected browser.');
  }
  const first = accessible[0];
  if (opts.targetId === undefined || opts.targetId === '') return first;
  const identities = await Promise.all(
    accessible.map(async (page) => ({ page, targetId: await pageTargetId(page).catch(() => null) })),
  );
  const found = identities.find((entry) => entry.targetId === opts.targetId)?.page;
  if (!found) {
    throw new BrowserTabNotFoundError(
      `Tab not found (targetId: ${opts.targetId}). Call browser.tabs() to list open tabs.`,
    );
  }
  if (isBlockedPageRef(opts.cdpUrl, found)) throw new BlockedBrowserTargetError();
  const foundTargetId = await pageTargetId(found).catch(() => null);
  if (foundTargetId !== null && foundTargetId !== '' && isBlockedTarget(opts.cdpUrl, foundTargetId))
    throw new BlockedBrowserTargetError();
  return found;
}

export async function getPageForTargetId(opts: { cdpUrl: string; targetId?: string; ssrfPolicy?: SsrfPolicy }) {
  const cachedBrowser = cachedByCdpUrl.get(normalizeCdpUrl(opts.cdpUrl))?.browser;
  try {
    return await getPageForTargetIdOnce(opts);
  } catch (err) {
    if (!cachedBrowser || !isRecoverableStalePageSelectionError(err, true)) throw err;
    evictStaleConnection(opts.cdpUrl, cachedBrowser);
    return await getPageForTargetIdOnce(opts);
  }
}

/**
 * Resolve a page by targetId or throw BrowserTabNotFoundError.
 */
export async function resolvePageByTargetIdOrThrow(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<Page> {
  if (opts.targetId === '') throw new BrowserTabNotFoundError();
  try {
    return await getPageForTargetId(opts);
  } catch (error) {
    if (error instanceof Error && error.message === 'No pages available in the connected browser.')
      throw new BrowserTabNotFoundError();
    throw error;
  }
}

/**
 * Get a page for a target, ensuring page state is initialized.
 */
export async function getRestoredPageForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<Page> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  return page;
}

const BROWSER_INTERNAL_TARGET_URL_PREFIXES = [
  'chrome://',
  'chrome-untrusted://',
  'devtools://',
  'edge://',
  'brave://',
  'vivaldi://',
  'opera://',
];

function isVendorNewTabUrl(normalized: string): boolean {
  for (const prefix of BROWSER_INTERNAL_TARGET_URL_PREFIXES) {
    if (!normalized.startsWith(prefix)) continue;
    const rest = normalized.slice(prefix.length);
    if (rest === 'newtab' || rest === 'newtab/' || rest.startsWith('new-tab-page')) return true;
  }
  return false;
}

function isBlankUrl(url: string): boolean {
  if (url === '' || url === 'about:blank') return true;
  return isVendorNewTabUrl(url.trim().toLowerCase());
}

export function isBrowserInternalTargetUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  if (normalized === '' || normalized === 'about:blank') return false;
  if (isVendorNewTabUrl(normalized)) return false;
  return BROWSER_INTERNAL_TARGET_URL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Best-effort heuristic resolver for a usable page targetId.
 *
 * This does NOT query Chrome's actual focused/visible tab — CDP does not
 * expose a simple "which tab is foregrounded" signal, so the resolver
 * picks the most plausible candidate by this preference order:
 *
 *  1. The page matching `preferTargetId` when still accessible.
 *  2. A page whose URL matches `preferUrl` exactly (helpful after reloads).
 *  3. The first non-blank accessible page (skips `about:blank` placeholders).
 *  4. The first accessible page (even if blank).
 *
 * In multi-tab sessions without any prefer-hints, the first non-blank tab
 * "wins" regardless of which tab the user is actually looking at. Callers
 * that need true active-tab semantics should track `targetId` explicitly
 * via `browser.open()` / `browser.waitForTab()` instead.
 *
 * Returns null when no accessible pages remain.
 */
export async function resolveActiveTargetId(
  cdpUrl: string,
  opts?: { preferTargetId?: string; preferUrl?: string; ssrfPolicy?: SsrfPolicy },
): Promise<string | null> {
  const { browser } = await connectBrowser(cdpUrl, undefined, opts?.ssrfPolicy);
  const pages = getAllPages(browser);
  if (!pages.length) return null;
  const { accessible } = await partitionAccessiblePages({ cdpUrl, pages });
  if (!accessible.length) return null;

  return pickActiveTargetId({
    accessible,
    preferTargetId: opts?.preferTargetId?.trim() ?? '',
    preferUrl: opts?.preferUrl?.trim() ?? '',
    tidOf: (page) => pageTargetId(page).catch(() => null),
  });
}

/**
 * Pure selection logic for `resolveActiveTargetId`. Extracted so it can be
 * unit-tested without a live CDP connection.
 *
 * @internal Exported for testing.
 */
export async function pickActiveTargetId(opts: {
  accessible: Page[];
  preferTargetId: string;
  preferUrl: string;
  tidOf: (page: Page) => Promise<string | null>;
}): Promise<string | null> {
  const { accessible, preferTargetId, preferUrl, tidOf } = opts;

  if (preferTargetId !== '') {
    for (const page of accessible) {
      const tid = await tidOf(page);
      if (tid === preferTargetId) return tid;
    }
  }

  if (preferUrl !== '') {
    for (const page of accessible) {
      if (page.url() === preferUrl) {
        const tid = await tidOf(page);
        if (tid !== null && tid !== '') return tid;
      }
    }
  }

  for (const page of accessible) {
    const url = page.url();
    if (!isBlankUrl(url) && !isBrowserInternalTargetUrl(url)) {
      const tid = await tidOf(page);
      if (tid !== null && tid !== '') return tid;
    }
  }

  for (const page of accessible) {
    if (isBrowserInternalTargetUrl(page.url())) continue;
    const tid = await tidOf(page);
    if (tid !== null && tid !== '') return tid;
  }

  return null;
}
