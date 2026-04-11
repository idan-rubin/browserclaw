import type { Browser, BrowserContext, Page, Route, Request } from 'playwright-core';

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

/**
 * Post-interaction navigation safety check. Call after any interaction that
 * could trigger navigation (click, type-submit, press) — validates the final
 * page URL against the SSRF policy and closes the tab if blocked.
 *
 * No-op if no policy is provided.
 */
export async function assertPostInteractionNavigationSafe(opts: {
  cdpUrl: string;
  page: Page;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<void> {
  if (!opts.ssrfPolicy) return;
  await assertPageNavigationCompletedSafely({
    cdpUrl: opts.cdpUrl,
    page: opts.page,
    response: null,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
  });
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
  const handler = async (route: Route, request: Request) => {
    if (state.blocked !== null) {
      await route.abort().catch((e: unknown) => {
        console.warn('[browserclaw] route abort failed', e);
      });
      return;
    }
    if (!isTopLevelNavigationRequest(opts.page, request)) {
      await route.continue();
      return;
    }
    // Only guard navigations initiated by this call:
    // - initial request must match our target URL
    // - redirects (redirectedFrom !== null) are always checked since they may be part of our chain
    const isRedirect = request.redirectedFrom() !== null;
    if (!isRedirect && request.url() !== opts.url) {
      await route.continue();
      return;
    }
    try {
      await assertBrowserNavigationAllowed({ url: request.url(), ...navigationPolicy });
    } catch (err) {
      if (isPolicyDenyNavigationError(err)) {
        state.blocked = err as Error;
        await route.abort().catch((e: unknown) => {
          console.warn('[browserclaw] route abort failed', e);
        });
        return;
      }
      throw err;
    }
    await route.continue();
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
