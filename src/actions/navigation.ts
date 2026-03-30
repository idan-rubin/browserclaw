import type { Browser, BrowserContext } from 'playwright-core';

import {
  BrowserTabNotFoundError,
  connectBrowser,
  getPageForTargetId,
  ensurePageState,
  ensureContextState,
  observeContext,
  pageTargetId,
  getAllPages,
  forceDisconnectPlaywrightForTarget,
  resolvePageByTargetIdOrThrow,
  withPageScopedCdpClient,
} from '../connection.js';
import {
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
  observeContext(context);
  recordingContexts.set(cdpUrl, context);
  context.on('close', () => recordingContexts.delete(cdpUrl));
  return context;
}

function isRetryableNavigateError(err: unknown): boolean {
  const msg = typeof err === 'string' ? err.toLowerCase() : err instanceof Error ? err.message.toLowerCase() : '';
  return msg.includes('frame has been detached') || msg.includes('target page, context or browser has been closed');
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

  const navigate = async () => await page.goto(url, { timeout });

  let response;
  try {
    response = await navigate();
  } catch (err) {
    if (!isRetryableNavigateError(err)) throw err;
    await forceDisconnectPlaywrightForTarget({
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

  await assertBrowserNavigationRedirectChainAllowed({
    request: response?.request(),
    ...withBrowserNavigationPolicy(policy),
  });
  const finalUrl = page.url();
  await assertBrowserNavigationResultAllowed({ url: finalUrl, ...withBrowserNavigationPolicy(policy) });
  return { url: finalUrl };
}

export async function listPagesViaPlaywright(opts: { cdpUrl: string }): Promise<BrowserTab[]> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = getAllPages(browser);
  const results: BrowserTab[] = [];
  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid !== null && tid !== '')
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

  const targetUrl = (opts.url ?? '').trim() || 'about:blank';
  /* eslint-disable @typescript-eslint/no-deprecated */
  const policy =
    opts.allowInternal === true ? { ...opts.ssrfPolicy, dangerouslyAllowPrivateNetwork: true } : opts.ssrfPolicy;
  /* eslint-enable @typescript-eslint/no-deprecated */

  if (targetUrl !== 'about:blank') {
    const navigationPolicy = withBrowserNavigationPolicy(policy);
    await assertBrowserNavigationAllowed({ url: targetUrl, ...navigationPolicy });
    await assertBrowserNavigationRedirectChainAllowed({
      request: (await page.goto(targetUrl, { timeout: 30000 }).catch(() => null))?.request(),
      ...navigationPolicy,
    });
    await assertBrowserNavigationResultAllowed({ url: page.url(), ...navigationPolicy });
  }

  const tid = await pageTargetId(page).catch(() => null);
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
