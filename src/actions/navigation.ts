import { connectBrowser, getPageForTargetId, ensurePageState, ensureContextState, pageTargetId, findPageByTargetId, getAllPages } from '../connection.js';
import type { BrowserTab } from '../types.js';

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  const url = String(opts.url ?? '').trim();
  if (!url) throw new Error('url is required');
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.goto(url, { timeout: Math.max(1000, Math.min(120000, opts.timeoutMs ?? 20000)) });
  return { url: page.url() };
}

export async function listPagesViaPlaywright(opts: { cdpUrl: string }): Promise<BrowserTab[]> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  const results: BrowserTab[] = [];
  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid) results.push({
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
}): Promise<BrowserTab> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const context = browser.contexts()[0] ?? await browser.newContext();
  ensureContextState(context);
  const page = await context.newPage();
  ensurePageState(page);
  const targetUrl = (opts.url ?? '').trim() || 'about:blank';
  if (targetUrl !== 'about:blank') {
    await page.goto(targetUrl, { timeout: 30000 });
  }
  const tid = await pageTargetId(page).catch(() => null);
  if (!tid) throw new Error('Failed to get targetId for new page');
  return {
    targetId: tid,
    title: await page.title().catch(() => ''),
    url: page.url(),
    type: 'page',
  };
}

export async function closePageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) throw new Error(`Tab not found (targetId: ${opts.targetId}). Use browser.tabs() to list open tabs.`);
  await page.close();
}

export async function focusPageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) throw new Error(`Tab not found (targetId: ${opts.targetId}). Use browser.tabs() to list open tabs.`);
  try {
    await page.bringToFront();
  } catch (err) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Page.bringToFront');
    } catch {
      throw err;
    } finally {
      await session.detach().catch(() => {});
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
