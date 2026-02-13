import { chromium } from 'playwright-core';
import type { Browser, Page, BrowserContext } from 'playwright-core';
import { getChromeWebSocketUrl } from './chrome-launcher.js';
import type { PageState, RoleRefs } from './types.js';

/** Page extended with Playwright's private `_snapshotForAI` method. */
export type PageWithAI = Page & {
  _snapshotForAI?: (opts: { timeout: number; track: string }) => Promise<{ full?: string }>;
};

// ── Persistent Connection Cache ──

let cached: { browser: Browser; cdpUrl: string } | null = null;
const connectingByUrl = new Map<string, Promise<{ browser: Browser; cdpUrl: string }>>();

const pageStates = new WeakMap<Page, PageState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

// Ref cache: keyed by "cdpUrl::targetId"
const roleRefsByTarget = new Map<string, {
  refs: RoleRefs;
  frameSelector?: string;
  mode?: 'role' | 'aria';
}>();
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

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) return existing;

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
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
        message: err?.message ? String(err.message) : String(err),
        name: err?.name ? String(err.name) : undefined,
        stack: err?.stack ? String(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS) state.errors.shift();
    });

    page.on('request', (req) => {
      state.nextRequestId += 1;
      const id = `r${state.nextRequestId}`;
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
      if (!id) return;
      for (let i = state.requests.length - 1; i >= 0; i--) {
        const rec = state.requests[i];
        if (rec && rec.id === id) {
          rec.status = resp.status();
          rec.ok = resp.ok();
          break;
        }
      }
    });

    page.on('requestfailed', (req) => {
      const id = state.requestIds.get(req);
      if (!id) return;
      for (let i = state.requests.length - 1; i >= 0; i--) {
        const rec = state.requests[i];
        if (rec && rec.id === id) {
          rec.failureText = req.failure()?.errorText;
          rec.ok = false;
          break;
        }
      }
    });

    page.on('close', () => {
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}

// ── Stealth: hide navigator.webdriver ──

const STEALTH_SCRIPT = `Object.defineProperty(navigator, 'webdriver', { get: () => undefined })`;

function applyStealthToPage(page: Page): void {
  page.evaluate(STEALTH_SCRIPT).catch(() => {});
}

function observeContext(context: BrowserContext): void {
  if (observedContexts.has(context)) return;
  observedContexts.add(context);

  // Hide navigator.webdriver for all future navigations in this context
  context.addInitScript(STEALTH_SCRIPT).catch(() => {});

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

export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: 'role' | 'aria';
}): void {
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsMode = opts.mode;

  const targetId = opts.targetId?.trim();
  if (!targetId) return;
  roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    refs: opts.refs,
    ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done) break;
    roleRefsByTarget.delete(first.value);
  }
}

export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = opts.targetId?.trim() || '';
  if (!targetId) return;
  const entry = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
  if (!entry) return;
  const state = ensurePageState(opts.page);
  if (state.roleRefs) return;
  state.roleRefs = entry.refs;
  state.roleRefsFrameSelector = entry.frameSelector;
  state.roleRefsMode = entry.mode;
}

// ── Connect to Browser ──

export async function connectBrowser(cdpUrl: string): Promise<{ browser: Browser; cdpUrl: string }> {
  const normalized = normalizeCdpUrl(cdpUrl);
  if (cached?.cdpUrl === normalized) return cached;

  const existing = connectingByUrl.get(normalized);
  if (existing) return await existing;

  const connectWithRetry = async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const timeout = 5000 + attempt * 2000;
        const endpoint = await getChromeWebSocketUrl(normalized, timeout).catch(() => null) ?? normalized;
        const browser = await chromium.connectOverCDP(endpoint, { timeout });
        const connected = { browser, cdpUrl: normalized };
        cached = connected;
        observeBrowser(browser);
        browser.on('disconnected', () => {
          if (cached?.browser === browser) cached = null;
          for (const key of roleRefsByTarget.keys()) {
            if (key.startsWith(normalized + '::')) roleRefsByTarget.delete(key);
          }
        });
        return connected;
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 250 + attempt * 250));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('CDP connect failed');
  };

  const promise = connectWithRetry().finally(() => { connectingByUrl.delete(normalized); });
  connectingByUrl.set(normalized, promise);
  return await promise;
}

export async function disconnectBrowser(): Promise<void> {
  if (connectingByUrl.size) {
    for (const p of connectingByUrl.values()) {
      try { await p; } catch {}
    }
  }
  const cur = cached;
  cached = null;
  if (cur) await cur.browser.close().catch(() => {});
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

export async function getAllPages(browser: Browser) {
  return browser.contexts().flatMap(c => c.pages());
}

export async function pageTargetId(page: Page): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = await session.send('Target.getTargetInfo');
    const targetInfo = (info as { targetInfo?: { targetId?: string } }).targetInfo;
    return String(targetInfo?.targetId ?? '').trim() || null;
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function findPageByTargetId(browser: Browser, targetId: string, cdpUrl?: string) {
  const pages = await getAllPages(browser);
  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid && tid === targetId) return page;
  }

  // Fallback: match by URL from /json/list
  if (cdpUrl) {
    try {
      const listUrl = `${cdpUrl.replace(/\/+$/, '').replace(/^ws:/, 'http:').replace(/\/cdp$/, '')}/json/list`;
      const response = await fetch(listUrl);
      if (response.ok) {
        const targets = await response.json() as CdpTarget[];
        const target = targets.find(t => t.id === targetId);
        if (target) {
          const urlMatch = pages.filter(p => p.url() === target.url);
          if (urlMatch.length === 1) return urlMatch[0];
          if (urlMatch.length > 1) {
            const sameUrlTargets = targets.filter(t => t.url === target.url);
            if (sameUrlTargets.length === urlMatch.length) {
              const idx = sameUrlTargets.findIndex(t => t.id === targetId);
              if (idx >= 0 && idx < urlMatch.length) return urlMatch[idx];
            }
          }
        }
      }
    } catch {}
  }
  return null;
}

export async function getPageForTargetId(opts: { cdpUrl: string; targetId?: string }) {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  if (!pages.length) throw new Error('No pages available in the connected browser.');
  const first = pages[0]!;
  if (!opts.targetId) return first;
  const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!found) {
    if (pages.length === 1) return first;
    throw new Error(`Tab not found (targetId: ${opts.targetId}). Use browser.tabs() to list open tabs.`);
  }
  return found;
}

// ── Ref Locator ──

export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith('@') ? ref.slice(1) : ref.startsWith('ref=') ? ref.slice(4) : ref;

  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);

    // Aria mode: use aria-ref locator
    if (state?.roleRefsMode === 'aria') {
      return (state.roleRefsFrameSelector ? page.frameLocator(state.roleRefsFrameSelector) : page)
        .locator(`aria-ref=${normalized}`);
    }

    // Role mode: use getByRole
    const info = state?.roleRefs?.[normalized];
    if (!info) throw new Error(`Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`);

    const locAny = state?.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    const role = info.role as Parameters<Page['getByRole']>[0];
    const locator = info.name
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
    const countMatch = message.match(/resolved to (\d+) elements/);
    const count = countMatch ? countMatch[1] : 'multiple';
    return new Error(`Selector "${selector}" matched ${count} elements. Run a new snapshot to get updated refs, or use a different ref.`);
  }
  if ((message.includes('Timeout') || message.includes('waiting for')) &&
      (message.includes('to be visible') || message.includes('not visible'))) {
    return new Error(`Element "${selector}" not found or not visible. Run a new snapshot to see current page elements.`);
  }
  if (message.includes('intercepts pointer events') || message.includes('not visible') || message.includes('not receive pointer events')) {
    return new Error(`Element "${selector}" is not interactable (hidden or covered). Try scrolling it into view, closing overlays, or re-snapshotting.`);
  }
  return error instanceof Error ? error : new Error(message);
}

export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number, maxMs = 120000): number {
  return Math.max(500, Math.min(maxMs, timeoutMs ?? fallback));
}
