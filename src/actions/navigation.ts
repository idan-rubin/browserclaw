import type { Browser, BrowserContext, Page, Route, Request, Frame } from 'playwright-core';

import {
  BrowserTabNotFoundError,
  BlockedBrowserTargetError,
  connectBrowser,
  getPageForTargetId,
  ensurePageState,
  ensureContextState,
  observeContext,
  pageTargetId,
  getAllPages,
  forceDisconnectPlaywrightConnection,
  resolvePageByTargetIdOrThrow,
  withPageScopedCdpClient,
  isBlockedTarget,
  isBlockedPageRef,
  markTargetBlocked,
  markPageRefBlocked,
  clearBlockedPageRef,
  clearBlockedTarget,
} from '../connection.js';
import {
  InvalidBrowserNavigationUrlError,
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  withBrowserNavigationPolicy,
} from '../security.js';
import type { BrowserTab, SsrfPolicy } from '../types.js';

const recordingContexts = new Map<string, BrowserContext>();

export function clearRecordingContext(cdpUrl: string): void {
  recordingContexts.delete(cdpUrl);
}

async function createRecordingContext(
  browser: Browser,
  cdpUrl: string,
  recordVideo: { dir: string; size?: { width: number; height: number } },
): Promise<BrowserContext> {
  const context = await browser.newContext({ recordVideo });
  await observeContext(context);
  recordingContexts.set(cdpUrl, context);
  context.on('close', () => recordingContexts.delete(cdpUrl));
  return context;
}

function isRetryableNavigateError(err: unknown): boolean {
  const msg = typeof err === 'string' ? err.toLowerCase() : err instanceof Error ? err.message.toLowerCase() : '';
  return msg.includes('frame has been detached') || msg.includes('target page, context or browser has been closed');
}

function isPolicyDenyNavigationError(err: unknown): boolean {
  return err instanceof InvalidBrowserNavigationUrlError;
}

function isTopLevelNavigationRequest(page: Page, request: Request): boolean {
  let sameMainFrame = false;
  try {
    sameMainFrame = request.frame() === page.mainFrame();
  } catch {
    sameMainFrame = true;
  }
  if (!sameMainFrame) return false;
  try {
    if (request.isNavigationRequest()) return true;
  } catch {
    /* fall through to resourceType check */
  }
  try {
    return request.resourceType() === 'document';
  } catch {
    return false;
  }
}

function isSubframeDocumentNavigationRequest(page: Page, request: Request): boolean {
  let sameMainFrame = false;
  try {
    sameMainFrame = request.frame() === page.mainFrame();
  } catch {
    return true;
  }
  if (sameMainFrame) return false;
  try {
    if (request.isNavigationRequest()) return true;
  } catch {
    /* fall through to resourceType check */
  }
  try {
    return request.resourceType() === 'document';
  } catch {
    return false;
  }
}

async function closeBlockedNavigationTarget(opts: { cdpUrl: string; page: Page; targetId?: string }): Promise<void> {
  markPageRefBlocked(opts.cdpUrl, opts.page);
  const resolvedTargetId = await pageTargetId(opts.page).catch(() => null);
  const fallbackTargetId = opts.targetId?.trim() ?? '';
  const targetIdToBlock = resolvedTargetId ?? fallbackTargetId;
  if (targetIdToBlock) markTargetBlocked(opts.cdpUrl, targetIdToBlock);
  await opts.page.close().catch((e: unknown) => {
    console.warn('[browserclaw] failed to close blocked page', e);
  });
}

export async function assertPageNavigationCompletedSafely(opts: {
  cdpUrl: string;
  page: Page;
  response: Awaited<ReturnType<Page['goto']>>;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<void> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy);
  try {
    await assertBrowserNavigationRedirectChainAllowed({ request: opts.response?.request(), ...navigationPolicy });
    await assertBrowserNavigationResultAllowed({ url: opts.page.url(), ...navigationPolicy });
  } catch (err) {
    if (isPolicyDenyNavigationError(err))
      await closeBlockedNavigationTarget({ cdpUrl: opts.cdpUrl, page: opts.page, targetId: opts.targetId });
    throw err;
  }
}

// ── Interaction-time navigation guard ──────────────────────────────

const INTERACTION_NAVIGATION_GRACE_MS = 250;
const pendingInteractionNavigationGuardCleanup = new WeakMap<Page, () => void>();

function didCrossDocumentUrlChange(page: Page, previousUrl: string): boolean {
  const currentUrl = page.url();
  if (currentUrl === previousUrl) return false;
  try {
    const prev = new URL(previousUrl);
    const curr = new URL(currentUrl);
    if (prev.origin === curr.origin && prev.pathname === curr.pathname && prev.search === curr.search) return false;
  } catch {
    /* invalid URLs — treat as cross-document */
  }
  return true;
}

function isHashOnlyNavigation(currentUrl: string, previousUrl: string): boolean {
  if (currentUrl === previousUrl) return false;
  try {
    const prev = new URL(previousUrl);
    const curr = new URL(currentUrl);
    return prev.origin === curr.origin && prev.pathname === curr.pathname && prev.search === curr.search;
  } catch {
    return false;
  }
}

function isMainFrameNavigation(page: Page, frame: Frame): boolean {
  if (typeof page.mainFrame !== 'function') return true;
  return frame === page.mainFrame();
}

async function assertSubframeNavigationAllowed(frameUrl: string, ssrfPolicy?: SsrfPolicy): Promise<void> {
  if (!ssrfPolicy) return;
  if (!frameUrl.startsWith('http://') && !frameUrl.startsWith('https://')) return;
  await assertBrowserNavigationResultAllowed({ url: frameUrl, ...withBrowserNavigationPolicy(ssrfPolicy) });
}

function snapshotNetworkFrameUrl(frame: Frame): string | null {
  try {
    const frameUrl = frame.url();
    return frameUrl.startsWith('http://') || frameUrl.startsWith('https://') ? frameUrl : null;
  } catch {
    return null;
  }
}

interface ObservedNavigations {
  mainFrameNavigated: boolean;
  subframes: string[];
}

function formatThrown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'unknown error';
}

async function assertObservedDelayedNavigations(opts: {
  cdpUrl: string;
  page: Page;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
  observed: ObservedNavigations;
}): Promise<void> {
  let subframeError: Error | undefined;
  try {
    for (const frameUrl of opts.observed.subframes) await assertSubframeNavigationAllowed(frameUrl, opts.ssrfPolicy);
  } catch (err) {
    subframeError = err instanceof Error ? err : new Error(formatThrown(err));
  }
  if (opts.observed.mainFrameNavigated) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }
  if (subframeError !== undefined) throw subframeError;
}

function observeDelayedInteractionNavigation(page: Page, previousUrl: string): Promise<ObservedNavigations> {
  if (didCrossDocumentUrlChange(page, previousUrl)) {
    return Promise.resolve({ mainFrameNavigated: true, subframes: [] });
  }
  if (typeof page.on !== 'function' || typeof page.off !== 'function') {
    return Promise.resolve({ mainFrameNavigated: false, subframes: [] });
  }
  return new Promise((resolve) => {
    const subframes: string[] = [];
    const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
    const cleanup = (): void => {
      if (timer.id !== undefined) clearTimeout(timer.id);
      page.off('framenavigated', onFrameNavigated);
    };
    const onFrameNavigated = (frame: Frame): void => {
      if (!isMainFrameNavigation(page, frame)) {
        const frameUrl = snapshotNetworkFrameUrl(frame);
        if (frameUrl !== null) subframes.push(frameUrl);
        return;
      }
      if (isHashOnlyNavigation(page.url(), previousUrl)) return;
      cleanup();
      resolve({ mainFrameNavigated: true, subframes });
    };
    timer.id = setTimeout(() => {
      cleanup();
      resolve({ mainFrameNavigated: didCrossDocumentUrlChange(page, previousUrl), subframes });
    }, INTERACTION_NAVIGATION_GRACE_MS);
    page.on('framenavigated', onFrameNavigated);
  });
}

function scheduleDelayedInteractionNavigationGuard(opts: {
  cdpUrl: string;
  page: Page;
  previousUrl: string;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<void> {
  if (!opts.ssrfPolicy) return Promise.resolve();
  const page = opts.page;
  if (didCrossDocumentUrlChange(page, opts.previousUrl)) {
    return assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }
  if (typeof page.on !== 'function' || typeof page.off !== 'function') return Promise.resolve();
  // Cancels overlap when two interactions race on the same page (Promise.all).
  pendingInteractionNavigationGuardCleanup.get(opts.page)?.();
  return new Promise<void>((resolve, reject) => {
    const subframes: string[] = [];
    const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
    const settle = (err?: unknown): void => {
      cleanup();
      if (err !== undefined) {
        reject(err instanceof Error ? err : new Error(formatThrown(err)));
        return;
      }
      resolve();
    };
    const cleanup = (): void => {
      if (timer.id !== undefined) clearTimeout(timer.id);
      page.off('framenavigated', onFrameNavigated);
      if (pendingInteractionNavigationGuardCleanup.get(opts.page) === settle) {
        pendingInteractionNavigationGuardCleanup.delete(opts.page);
      }
    };
    const onFrameNavigated = (frame: Frame): void => {
      if (!isMainFrameNavigation(page, frame)) {
        const frameUrl = snapshotNetworkFrameUrl(frame);
        if (frameUrl !== null) subframes.push(frameUrl);
        return;
      }
      if (isHashOnlyNavigation(page.url(), opts.previousUrl)) return;
      cleanup();
      assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
        observed: { mainFrameNavigated: true, subframes },
      }).then(() => {
        settle();
      }, settle);
    };
    timer.id = setTimeout(() => {
      cleanup();
      assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
        observed: {
          mainFrameNavigated: didCrossDocumentUrlChange(page, opts.previousUrl),
          subframes,
        },
      }).then(() => {
        settle();
      }, settle);
    }, INTERACTION_NAVIGATION_GRACE_MS);
    pendingInteractionNavigationGuardCleanup.set(opts.page, settle);
    page.on('framenavigated', onFrameNavigated);
  });
}

export async function assertInteractionNavigationCompletedSafely<T>(opts: {
  action: () => Promise<T>;
  cdpUrl: string;
  page: Page;
  previousUrl: string;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<T> {
  if (!opts.ssrfPolicy) return await opts.action();
  const navPage = opts.page;
  const navState: { observed: boolean } = { observed: false };
  const subframeNavigationsDuringAction: string[] = [];
  const onFrameNavigated = (frame: Frame): void => {
    if (!isMainFrameNavigation(navPage, frame)) {
      const frameUrl = snapshotNetworkFrameUrl(frame);
      if (frameUrl !== null) subframeNavigationsDuringAction.push(frameUrl);
      return;
    }
    if (!isHashOnlyNavigation(opts.page.url(), opts.previousUrl)) navState.observed = true;
  };
  if (typeof navPage.on === 'function') navPage.on('framenavigated', onFrameNavigated);
  let result: T | undefined;
  let actionError: Error | undefined;
  try {
    result = await opts.action();
  } catch (err) {
    actionError = err instanceof Error ? err : new Error(formatThrown(err));
  } finally {
    if (typeof navPage.off === 'function') navPage.off('framenavigated', onFrameNavigated);
  }
  const navigationObserved = navState.observed || didCrossDocumentUrlChange(opts.page, opts.previousUrl);
  let subframeError: Error | undefined;
  try {
    for (const frameUrl of subframeNavigationsDuringAction) {
      await assertSubframeNavigationAllowed(frameUrl, opts.ssrfPolicy);
    }
  } catch (err) {
    subframeError = err instanceof Error ? err : new Error(formatThrown(err));
  }
  if (navigationObserved) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  } else if (actionError !== undefined) {
    const observed = await observeDelayedInteractionNavigation(opts.page, opts.previousUrl);
    if (observed.mainFrameNavigated || observed.subframes.length > 0) {
      await assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
        observed,
      });
    }
  } else {
    await scheduleDelayedInteractionNavigationGuard({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      previousUrl: opts.previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }
  // Precedence: SSRF block > action error. The security signal wins.
  if (subframeError !== undefined) throw subframeError;
  if (actionError !== undefined) throw actionError;
  return result as T;
}

async function gotoPageWithNavigationGuard(opts: {
  cdpUrl: string;
  page: Page;
  url: string;
  timeoutMs: number;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<Awaited<ReturnType<Page['goto']>>> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy);
  const state: { blocked: Error | null } = { blocked: null };
  const safeContinue = async (route: Route): Promise<void> => {
    try {
      await route.continue();
    } catch (e) {
      if (e instanceof Error && /already handled/i.test(e.message)) return;
      console.warn('[browserclaw] route continue failed', e);
    }
  };
  const safeAbort = async (route: Route): Promise<void> => {
    try {
      await route.abort();
    } catch (e) {
      if (e instanceof Error && /already handled/i.test(e.message)) return;
      console.warn('[browserclaw] route abort failed', e);
    }
  };
  const handler = async (route: Route, request: Request) => {
    if (state.blocked !== null) {
      await safeAbort(route);
      return;
    }
    const isTopLevel = isTopLevelNavigationRequest(opts.page, request);
    const isSubframeDocument = !isTopLevel && isSubframeDocumentNavigationRequest(opts.page, request);
    if (!isTopLevel && !isSubframeDocument) {
      await safeContinue(route);
      return;
    }
    if (isTopLevel) {
      const isRedirect = request.redirectedFrom() !== null;
      if (!isRedirect && request.url() !== opts.url) {
        await safeContinue(route);
        return;
      }
    }
    try {
      await assertBrowserNavigationAllowed({ url: request.url(), ...navigationPolicy });
    } catch (err) {
      if (isPolicyDenyNavigationError(err)) {
        if (isTopLevel) {
          state.blocked = err as Error;
        } else {
          console.warn(
            `[browserclaw] blocked subframe navigation to ${request.url()}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await safeAbort(route);
        return;
      }
      throw err;
    }
    await safeContinue(route);
  };
  await opts.page.route('**', handler);
  try {
    const response = await opts.page.goto(opts.url, { timeout: opts.timeoutMs });
    if (state.blocked !== null) throw state.blocked;
    return response;
  } catch (err) {
    if (state.blocked !== null) throw state.blocked;
    throw err;
  } finally {
    await opts.page.unroute('**', handler).catch((e: unknown) => {
      console.warn('[browserclaw] route unroute failed', e);
    });
    if (state.blocked !== null)
      await closeBlockedNavigationTarget({ cdpUrl: opts.cdpUrl, page: opts.page, targetId: opts.targetId });
  }
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  /** @deprecated Use ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } instead */
  allowInternal?: boolean;
}): Promise<{ url: string }> {
  const url = opts.url.trim();
  if (!url) throw new Error('url is required');
  /* eslint-disable @typescript-eslint/no-deprecated */
  const policy =
    opts.allowInternal === true ? { ...opts.ssrfPolicy, dangerouslyAllowPrivateNetwork: true } : opts.ssrfPolicy;
  /* eslint-enable @typescript-eslint/no-deprecated */
  await assertBrowserNavigationAllowed({ url, ...withBrowserNavigationPolicy(policy) });

  const timeout = Math.max(1000, Math.min(120000, opts.timeoutMs ?? 20000));
  let page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const navigate = async () =>
    await gotoPageWithNavigationGuard({
      cdpUrl: opts.cdpUrl,
      page,
      url,
      timeoutMs: timeout,
      ssrfPolicy: policy,
      targetId: opts.targetId,
    });

  let response;
  try {
    response = await navigate();
  } catch (err) {
    if (!isRetryableNavigateError(err)) throw err;
    // Clean recording context before force-disconnect to prevent stale references
    recordingContexts.delete(opts.cdpUrl);
    await forceDisconnectPlaywrightConnection({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      reason: 'retry navigate after detached frame',
    }).catch(() => {
      /* intentional no-op */
    });
    page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
    ensurePageState(page);
    response = await navigate();
  }

  await assertPageNavigationCompletedSafely({
    cdpUrl: opts.cdpUrl,
    page,
    response,
    ssrfPolicy: policy,
    targetId: opts.targetId,
  });
  return { url: page.url() };
}

export async function listPagesViaPlaywright(opts: { cdpUrl: string }): Promise<BrowserTab[]> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = getAllPages(browser);
  const results: BrowserTab[] = [];
  for (const page of pages) {
    if (isBlockedPageRef(opts.cdpUrl, page)) continue;
    const tid = await pageTargetId(page).catch(() => null);
    if (tid !== null && tid !== '' && !isBlockedTarget(opts.cdpUrl, tid))
      results.push({
        targetId: tid,
        title: await page.title().catch(() => ''),
        url: page.url(),
        type: 'page',
      });
  }
  return results;
}

export async function createPageViaPlaywright(opts: {
  cdpUrl: string;
  url?: string;
  ssrfPolicy?: SsrfPolicy;
  /** @deprecated Use ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } instead */
  allowInternal?: boolean;
  recordVideo?: { dir: string; size?: { width: number; height: number } };
}): Promise<BrowserTab> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const context = opts.recordVideo
    ? (recordingContexts.get(opts.cdpUrl) ?? (await createRecordingContext(browser, opts.cdpUrl, opts.recordVideo)))
    : (browser.contexts()[0] ?? (await browser.newContext()));
  ensureContextState(context);
  const page = await context.newPage();
  ensurePageState(page);
  clearBlockedPageRef(opts.cdpUrl, page);
  const createdTargetId = await pageTargetId(page).catch(() => null);
  clearBlockedTarget(opts.cdpUrl, createdTargetId ?? undefined);

  const targetUrl = (opts.url ?? '').trim() || 'about:blank';
  /* eslint-disable @typescript-eslint/no-deprecated */
  const policy =
    opts.allowInternal === true ? { ...opts.ssrfPolicy, dangerouslyAllowPrivateNetwork: true } : opts.ssrfPolicy;
  /* eslint-enable @typescript-eslint/no-deprecated */

  if (targetUrl !== 'about:blank') {
    await assertBrowserNavigationAllowed({ url: targetUrl, ...withBrowserNavigationPolicy(policy) });
    let response: Awaited<ReturnType<Page['goto']>> = null;
    try {
      response = await gotoPageWithNavigationGuard({
        cdpUrl: opts.cdpUrl,
        page,
        url: targetUrl,
        timeoutMs: 30000,
        ssrfPolicy: policy,
        targetId: createdTargetId ?? undefined,
      });
    } catch (err) {
      if (isPolicyDenyNavigationError(err) || err instanceof BlockedBrowserTargetError) throw err;
      console.warn(`[browserclaw] createPage navigation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response,
      ssrfPolicy: policy,
      targetId: createdTargetId ?? undefined,
    });
  }

  const tid = createdTargetId ?? (await pageTargetId(page).catch(() => null));
  if (tid === null || tid === '') throw new Error('Failed to get targetId for new page');
  return {
    targetId: tid,
    title: await page.title().catch(() => ''),
    url: page.url(),
    type: 'page',
  };
}

export async function closePageViaPlaywright(opts: { cdpUrl: string; targetId?: string }): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.close();
}

export async function closePageByTargetIdViaPlaywright(opts: { cdpUrl: string; targetId: string }): Promise<void> {
  try {
    await (await resolvePageByTargetIdOrThrow(opts)).close();
  } catch (err) {
    if (err instanceof BrowserTabNotFoundError) return;
    throw err;
  }
}

export async function focusPageByTargetIdViaPlaywright(opts: { cdpUrl: string; targetId: string }): Promise<void> {
  const page = await resolvePageByTargetIdOrThrow(opts);
  try {
    await page.bringToFront();
  } catch (err) {
    try {
      await withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send('Page.bringToFront');
        },
      });
      return;
    } catch {
      throw err;
    }
  }
}

export async function waitForTabViaPlaywright(opts: {
  cdpUrl: string;
  urlContains?: string;
  titleContains?: string;
  timeoutMs?: number;
}): Promise<BrowserTab> {
  if (opts.urlContains === undefined && opts.titleContains === undefined)
    throw new Error('urlContains or titleContains is required');
  const timeout = Math.max(1000, Math.min(120000, opts.timeoutMs ?? 30000));
  const start = Date.now();
  const POLL_INTERVAL_MS = 250;

  while (Date.now() - start < timeout) {
    const tabs = await listPagesViaPlaywright({ cdpUrl: opts.cdpUrl });
    const match = tabs.find((t) => {
      if (opts.urlContains !== undefined && !t.url.includes(opts.urlContains)) return false;
      if (opts.titleContains !== undefined && !t.title.includes(opts.titleContains)) return false;
      return true;
    });
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const criteria: string[] = [];
  if (opts.urlContains !== undefined) criteria.push(`url contains "${opts.urlContains}"`);
  if (opts.titleContains !== undefined) criteria.push(`title contains "${opts.titleContains}"`);
  throw new Error(`Timed out waiting for tab: ${criteria.join(', ')}`);
}

export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.setViewportSize({
    width: Math.max(1, Math.floor(opts.width)),
    height: Math.max(1, Math.floor(opts.height)),
  });
}
