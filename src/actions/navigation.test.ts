import type { Browser } from 'playwright-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type * as ConnectionModule from '../connection.js';
import type * as SecurityModule from '../security.js';

const {
  mockConnectBrowser,
  mockObserveContext,
  mockEnsurePageState,
  mockClearBlockedPageRef,
  mockClearBlockedTarget,
  mockPageTargetId,
  mockGetStealthEnabledForCdpUrl,
  mockAssertBrowserNavigationAllowed,
  mockAssertBrowserNavigationResultAllowed,
  mockAssertBrowserNavigationRedirectChainAllowed,
} = vi.hoisted(() => ({
  mockConnectBrowser: vi.fn<() => Promise<{ browser: Browser; cdpUrl: string }>>(),
  mockObserveContext: vi.fn().mockResolvedValue(undefined),
  mockEnsurePageState: vi.fn().mockReturnValue({}),
  mockClearBlockedPageRef: vi.fn(),
  mockClearBlockedTarget: vi.fn(),
  mockPageTargetId: vi.fn().mockResolvedValue('t-new'),
  mockGetStealthEnabledForCdpUrl: vi.fn().mockReturnValue(false),
  mockAssertBrowserNavigationAllowed: vi.fn().mockResolvedValue(undefined),
  mockAssertBrowserNavigationResultAllowed: vi.fn().mockResolvedValue(undefined),
  mockAssertBrowserNavigationRedirectChainAllowed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    connectBrowser: mockConnectBrowser,
    observeContext: mockObserveContext,
    ensurePageState: mockEnsurePageState,
    clearBlockedPageRef: mockClearBlockedPageRef,
    clearBlockedTarget: mockClearBlockedTarget,
    pageTargetId: mockPageTargetId,
    getStealthEnabledForCdpUrl: mockGetStealthEnabledForCdpUrl,
  };
});

vi.mock('../security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SecurityModule>();
  return {
    ...actual,
    assertBrowserNavigationAllowed: mockAssertBrowserNavigationAllowed,
    assertBrowserNavigationResultAllowed: mockAssertBrowserNavigationResultAllowed,
    assertBrowserNavigationRedirectChainAllowed: mockAssertBrowserNavigationRedirectChainAllowed,
  };
});

const { createPageViaPlaywright, assertPageNavigationCompletedSafely, listPagesViaPlaywright } =
  await import('./navigation.js');
const { InvalidBrowserNavigationUrlError } = await import('../security.js');

interface FakePage {
  goto: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  route: ReturnType<typeof vi.fn>;
  unroute: ReturnType<typeof vi.fn>;
  url: () => string;
  title: () => Promise<string>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  waitForEvent: ReturnType<typeof vi.fn>;
  mainFrame: () => unknown;
  isClosed: () => boolean;
}

function buildFakePage(overrides: Partial<FakePage> = {}): FakePage {
  return {
    goto: vi.fn().mockResolvedValue({ request: () => ({ redirectedFrom: () => null }) }),
    close: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    unroute: vi.fn().mockResolvedValue(undefined),
    url: () => 'https://example.test/',
    title: () => Promise.resolve('ok'),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    waitForEvent: vi.fn(),
    mainFrame: () => ({}),
    isClosed: () => false,
    ...overrides,
  };
}

interface FakeContext {
  newPage: ReturnType<typeof vi.fn>;
}

interface FakeBrowser {
  contexts: () => FakeContext[];
  newContext: ReturnType<typeof vi.fn>;
}

function buildFakeBrowser(page: FakePage): { browser: FakeBrowser; context: FakeContext } {
  const context: FakeContext = {
    newPage: vi.fn().mockResolvedValue(page),
  };
  const browser: FakeBrowser = {
    contexts: () => [context],
    newContext: vi.fn().mockResolvedValue(context),
  };
  return { browser, context };
}

describe('createPageViaPlaywright leak prevention', () => {
  beforeEach(() => {
    mockConnectBrowser.mockReset();
    mockObserveContext.mockClear();
    mockEnsurePageState.mockClear();
    mockClearBlockedPageRef.mockClear();
    mockClearBlockedTarget.mockClear();
    mockPageTargetId.mockReset();
    mockPageTargetId.mockResolvedValue('t-new');
    mockAssertBrowserNavigationAllowed.mockReset();
    mockAssertBrowserNavigationAllowed.mockResolvedValue(undefined);
    mockAssertBrowserNavigationResultAllowed.mockReset();
    mockAssertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
    mockAssertBrowserNavigationRedirectChainAllowed.mockReset();
    mockAssertBrowserNavigationRedirectChainAllowed.mockResolvedValue(undefined);
  });

  it('does not allocate a tab when URL preflight policy denies the URL', async () => {
    const page = buildFakePage();
    const { browser, context } = buildFakeBrowser(page);
    mockConnectBrowser.mockResolvedValue({
      browser: browser as unknown as Browser,
      cdpUrl: 'http://localhost:9222',
    });
    mockAssertBrowserNavigationAllowed.mockRejectedValue(
      new InvalidBrowserNavigationUrlError('Navigation blocked: example denial'),
    );

    await expect(
      createPageViaPlaywright({ cdpUrl: 'http://localhost:9222', url: 'https://blocked.example/' }),
    ).rejects.toThrow(/example denial/);

    // The fix: preflight runs before connectBrowser, so neither connection nor
    // tab allocation happens.
    expect(mockConnectBrowser).not.toHaveBeenCalled();
    expect(context.newPage).not.toHaveBeenCalled();
    expect(page.close).not.toHaveBeenCalled();
  });

  it('closes the freshly-created tab when navigation throws', async () => {
    const page = buildFakePage({
      goto: vi.fn().mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED')),
    });
    const { browser, context } = buildFakeBrowser(page);
    mockConnectBrowser.mockResolvedValue({
      browser: browser as unknown as Browser,
      cdpUrl: 'http://localhost:9222',
    });

    await expect(
      createPageViaPlaywright({
        cdpUrl: 'http://localhost:9222',
        url: 'https://no-such-host.invalid/',
      }),
    ).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);

    expect(context.newPage).toHaveBeenCalledTimes(1);
    // Tab must be closed so we don't leak a chrome-error://chromewebdata/ page.
    expect(page.close).toHaveBeenCalled();
  });

  it('returns the tab on successful navigation without closing it', async () => {
    const page = buildFakePage();
    const { browser } = buildFakeBrowser(page);
    mockConnectBrowser.mockResolvedValue({
      browser: browser as unknown as Browser,
      cdpUrl: 'http://localhost:9222',
    });

    const tab = await createPageViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      url: 'https://example.test/',
    });

    expect(tab.targetId).toBe('t-new');
    expect(page.close).not.toHaveBeenCalled();
  });
});

describe('assertPageNavigationCompletedSafely policy denial', () => {
  beforeEach(() => {
    mockAssertBrowserNavigationResultAllowed.mockReset();
    mockAssertBrowserNavigationResultAllowed.mockResolvedValue(undefined);
    mockAssertBrowserNavigationRedirectChainAllowed.mockReset();
    mockAssertBrowserNavigationRedirectChainAllowed.mockResolvedValue(undefined);
  });

  it('does not close the page on policy denial (read-only assertion)', async () => {
    const page = buildFakePage({ url: () => 'https://blocked.example/' });
    mockAssertBrowserNavigationResultAllowed.mockRejectedValue(
      new InvalidBrowserNavigationUrlError('Navigation blocked: example denial'),
    );

    await expect(
      assertPageNavigationCompletedSafely({
        cdpUrl: 'http://localhost:9222',
        page: page as never,
        response: null,
      }),
    ).rejects.toThrow(/example denial/);

    expect(page.close).not.toHaveBeenCalled();
  });
});

describe('listPagesViaPlaywright browser-internal filter', () => {
  beforeEach(() => {
    mockConnectBrowser.mockReset();
    mockPageTargetId.mockReset();
  });

  function pageWithUrl(url: string): FakePage {
    return buildFakePage({ url: () => url });
  }

  it('filters out chrome:// and devtools:// pages from listings', async () => {
    const realPage = pageWithUrl('https://example.test/');
    const chromePage = pageWithUrl('chrome://settings/');
    const devtoolsPage = pageWithUrl('devtools://devtools/bundled/inspector.html');
    const edgePage = pageWithUrl('edge://flags/');
    const context = { pages: () => [realPage, chromePage, devtoolsPage, edgePage] };
    const browser = { contexts: () => [context] };
    mockConnectBrowser.mockResolvedValue({
      browser: browser as unknown as Browser,
      cdpUrl: 'http://localhost:9222',
    });

    const calls = new Map<FakePage, string>([
      [realPage, 't-real'],
      [chromePage, 't-chrome'],
      [devtoolsPage, 't-devtools'],
      [edgePage, 't-edge'],
    ]);
    mockPageTargetId.mockImplementation((p: FakePage) => Promise.resolve(calls.get(p) ?? ''));

    const tabs = await listPagesViaPlaywright({ cdpUrl: 'http://localhost:9222' });
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.targetId).toBe('t-real');
    expect(tabs[0]?.url).toBe('https://example.test/');
  });

  it('keeps default new-tab pages in the listing', async () => {
    const newtab = pageWithUrl('chrome://newtab/');
    const newTabPage = pageWithUrl('chrome://new-tab-page/');
    const settings = pageWithUrl('chrome://settings/');
    const real = pageWithUrl('https://example.test/');
    const context = { pages: () => [newtab, newTabPage, settings, real] };
    const browser = { contexts: () => [context] };
    mockConnectBrowser.mockResolvedValue({
      browser: browser as unknown as Browser,
      cdpUrl: 'http://localhost:9222',
    });
    const calls = new Map<FakePage, string>([
      [newtab, 't-newtab'],
      [newTabPage, 't-ntp'],
      [settings, 't-settings'],
      [real, 't-real'],
    ]);
    mockPageTargetId.mockImplementation((p: FakePage) => Promise.resolve(calls.get(p) ?? ''));

    const tabs = await listPagesViaPlaywright({ cdpUrl: 'http://localhost:9222' });
    expect(tabs.map((t) => t.targetId)).toEqual(['t-newtab', 't-ntp', 't-real']);
  });

  it('matches prefixes case-insensitively and after trimming', async () => {
    const upperChrome = pageWithUrl('  CHROME://VERSION  ');
    const realPage = pageWithUrl('https://example.test/');
    const context = { pages: () => [upperChrome, realPage] };
    const browser = { contexts: () => [context] };
    mockConnectBrowser.mockResolvedValue({
      browser: browser as unknown as Browser,
      cdpUrl: 'http://localhost:9222',
    });
    const calls = new Map<FakePage, string>([
      [upperChrome, 't-up'],
      [realPage, 't-real'],
    ]);
    mockPageTargetId.mockImplementation((p: FakePage) => Promise.resolve(calls.get(p) ?? ''));

    const tabs = await listPagesViaPlaywright({ cdpUrl: 'http://localhost:9222' });
    expect(tabs.map((t) => t.targetId)).toEqual(['t-real']);
  });
});
