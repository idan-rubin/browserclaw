import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';
import { InvalidBrowserNavigationUrlError } from '../security.js';
import type { SsrfPolicy } from '../types.js';

const mocks = vi.hoisted(() => ({ page: vi.fn<() => Promise<Page>>() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: mocks.page,
}));
import {
  assertInteractionNavigationCompletedSafely,
  navigateViaPlaywright,
  withPageNavigationRequestGuard,
} from './navigation.js';

const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  existsSync,
);

const cdpUrl = 'test';
// `localhost` is exempted by name; the same server reached as 127.0.0.1 stays private.
const strict: SsrfPolicy = { allowedHostnames: ['localhost'] };
// Two exempt sites let a frame live in its own process while [::1] stays private.
const twoSites: SsrfPolicy = { allowedHostnames: ['localhost', '127.0.0.1'] };
const permissive: SsrfPolicy = { dangerouslyAllowPrivateNetwork: true };

interface Hits {
  secret: number;
  preflight: number;
  api: number;
}

function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => {
      resolve();
    });
  });
}

const probe = createServer();
const hasIpv6Loopback = await listen(probe, '::1').then(
  () => true,
  () => false,
);
await close(probe);

describe.skipIf(executablePath === undefined)('navigation authority fence (real Chromium)', () => {
  let browser: Browser;
  let page: Page;
  let site: Server;
  let site6: Server;
  let api: Server;
  let allowed: string;
  let denied: string;
  let denied6: string;
  let apiOrigin: string;
  const hits: Hits = { secret: 0, preflight: 0, api: 0 };
  const targets = new Map<string, string>();
  const route = (base: string, pathname: string, target: string): string => {
    const key = String(targets.size);
    targets.set(key, target);
    return `${base}${pathname}?to=${key}`;
  };

  const html = (res: ServerResponse, body: string): void => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>fence</title>${body}`);
  };

  beforeAll(async () => {
    const serveSite = (req: IncomingMessage, res: ServerResponse): void => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      const to = targets.get(url.searchParams.get('to') ?? '') ?? '';
      switch (url.pathname) {
        case '/secret':
          hits.secret += 1;
          html(res, '<p id="secret">internal</p>');
          return;
        case '/redirect':
          res.writeHead(302, { location: to });
          res.end();
          return;
        case '/slow-redirect':
          setTimeout(() => {
            res.writeHead(302, { location: to });
            res.end();
          }, 500);
          return;
        case '/hang':
          return;
        case '/with-asset':
          html(res, '<p>whole</p><img src="/slow-asset">');
          return;
        case '/slow-asset':
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'image/gif' });
            res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
          }, 500);
          return;
        case '/replace':
          html(
            res,
            `<p data-next=${JSON.stringify(to)}>source</p><script>location.replace(document.querySelector('p').dataset.next);</script>`,
          );
          return;
        case '/later':
          html(
            res,
            `<p data-next=${JSON.stringify(to)}>source</p><script>setTimeout(() => { location.href = document.querySelector('p').dataset.next; }, 150);</script>`,
          );
          return;
        case '/frame-host':
          html(res, `<p>host</p><iframe src=${JSON.stringify(to)}></iframe>`);
          return;
        default:
          html(res, '<p>home</p>');
      }
    };
    site = createServer(serveSite);
    site6 = createServer(serveSite);
    api = createServer((req: IncomingMessage, res: ServerResponse) => {
      const cors = {
        'access-control-allow-origin': req.headers.origin ?? '*',
        'access-control-allow-methods': 'PUT',
        'access-control-allow-headers': 'content-type',
      };
      if (req.method === 'OPTIONS') {
        hits.preflight += 1;
        res.writeHead(204, cors);
        res.end();
        return;
      }
      hits.api += 1;
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      res.end('{}');
    });
    const [sitePort, apiPort] = await Promise.all([listen(site), listen(api)]);
    allowed = `http://localhost:${String(sitePort)}`;
    denied = `http://127.0.0.1:${String(sitePort)}`;
    if (hasIpv6Loopback) denied6 = `http://[::1]:${String(await listen(site6, '::1'))}`;
    apiOrigin = `http://localhost:${String(apiPort)}`;
    browser = await chromium.launch({ headless: true, executablePath });
  });
  beforeEach(async () => {
    hits.secret = 0;
    hits.preflight = 0;
    hits.api = 0;
    page = await browser.newPage();
    mocks.page.mockResolvedValue(page);
  });
  afterEach(async () => {
    await page.close().catch(() => undefined);
  });
  afterAll(async () => {
    await browser.close();
    await Promise.all([close(site), close(site6), close(api)]);
  });

  const redirectTo = (target: string): string => route(allowed, '/redirect', target);

  it('never sends a redirect hop the policy denies', async () => {
    await expect(
      navigateViaPlaywright({ cdpUrl, url: redirectTo(`${denied}/secret`), ssrfPolicy: strict }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    expect(hits.secret).toBe(0);
  });

  it('control: the same redirect reaches its target under a policy that allows it', async () => {
    const result = await navigateViaPlaywright({
      cdpUrl,
      url: redirectTo(`${denied}/secret`),
      ssrfPolicy: permissive,
    });
    expect(result.url).toBe(`${denied}/secret`);
    expect(hits.secret).toBe(1);
  });

  it('stops a denied document the page requests between actions and keeps the source', async () => {
    const source = route(allowed, '/later', `${denied}/secret`);
    await navigateViaPlaywright({ cdpUrl, url: source, ssrfPolicy: strict });
    await page.waitForTimeout(600);
    expect(hits.secret).toBe(0);
    expect(page.url()).toBe(source);
    expect(await page.locator('p').textContent()).toBe('source');
  });

  it('control: an allowed document the page requests between actions still loads', async () => {
    const source = route(allowed, '/later', `${denied}/secret`);
    await navigateViaPlaywright({ cdpUrl, url: source, ssrfPolicy: permissive });
    await page.waitForURL(`${denied}/secret`);
    expect(hits.secret).toBe(1);
  });

  it('stops a denied subframe document without failing the top-level navigation', async () => {
    const host = route(allowed, '/frame-host', redirectTo(`${denied}/secret`));
    const result = await navigateViaPlaywright({ cdpUrl, url: host, ssrfPolicy: strict });
    await page.waitForTimeout(600);
    expect(result.url).toBe(host);
    expect(hits.secret).toBe(0);
    expect(await page.locator('p').textContent()).toBe('host');
  });

  const separatelyHostedFrame = async (): Promise<boolean> => {
    const session = await browser.newBrowserCDPSession();
    const { targetInfos } = await session.send('Target.getTargets');
    await session.detach();
    return targetInfos.some((target) => target.type === 'iframe' && target.url.startsWith(denied));
  };

  describe.skipIf(!hasIpv6Loopback)('separately hosted iframes', () => {
    const hostWithSelfNavigatingFrame = (): string =>
      route(allowed, '/frame-host', route(denied, '/later', `${denied6}/secret`));

    it('stops a denied document the frame requests between actions', async () => {
      await navigateViaPlaywright({ cdpUrl, url: hostWithSelfNavigatingFrame(), ssrfPolicy: twoSites });
      await page.waitForTimeout(800);
      expect(await separatelyHostedFrame()).toBe(true);
      expect(hits.secret).toBe(0);
    });

    it('control: the frame reaches the same document under a policy that allows it', async () => {
      await navigateViaPlaywright({ cdpUrl, url: hostWithSelfNavigatingFrame(), ssrfPolicy: permissive });
      await page.frames()[1]?.waitForURL(`${denied6}/secret`);
      expect(hits.secret).toBe(1);
    });

    it('refuses a guarded action that sends the frame to a denied document', async () => {
      const host = route(allowed, '/frame-host', `${denied}/`);
      await navigateViaPlaywright({ cdpUrl, url: host, ssrfPolicy: twoSites });
      await page.frames()[1]?.waitForURL(`${denied}/`);
      expect(await separatelyHostedFrame()).toBe(true);
      await expect(
        withPageNavigationRequestGuard({
          cdpUrl,
          page,
          ssrfPolicy: twoSites,
          action: async () => {
            await page.frames()[1]?.evaluate((url) => {
              location.href = url;
            }, `${denied6}/secret`);
            await page.waitForTimeout(400);
          },
        }),
      ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
      expect(hits.secret).toBe(0);
    });

    it('returns from an action that leaves the frame waiting on its server and keeps the tab usable', async () => {
      const host = route(allowed, '/frame-host', `${denied}/`);
      await navigateViaPlaywright({ cdpUrl, url: host, ssrfPolicy: twoSites });
      await page.frames()[1]?.waitForURL(`${denied}/`);
      expect(await separatelyHostedFrame()).toBe(true);
      const started = Date.now();
      await assertInteractionNavigationCompletedSafely({
        cdpUrl,
        page,
        previousUrl: page.url(),
        ssrfPolicy: twoSites,
        action: async () => {
          await page.frames()[1]?.evaluate((url) => {
            setTimeout(() => {
              location.href = url;
            }, 0);
          }, `${denied}/hang`);
        },
      });
      await expect(
        withPageNavigationRequestGuard({
          cdpUrl,
          page,
          ssrfPolicy: twoSites,
          action: () => page.evaluate(() => document.querySelector('p')?.textContent),
        }),
      ).resolves.toBe('host');
      const next = await navigateViaPlaywright({ cdpUrl, url: `${allowed}/?next`, ssrfPolicy: twoSites });
      expect(next.url).toBe(`${allowed}/?next`);
      expect(Date.now() - started).toBeLessThan(8000);
    }, 40_000);
  });

  describe('while a top-level navigation waits on its server', () => {
    it('reports a navigation timeout promptly and leaves the tab usable', async () => {
      await navigateViaPlaywright({ cdpUrl, url: `${allowed}/`, ssrfPolicy: strict });
      const started = Date.now();
      await expect(
        navigateViaPlaywright({ cdpUrl, url: `${allowed}/hang`, ssrfPolicy: strict, timeoutMs: 1000 }),
      ).rejects.toThrow(/Timeout 1000ms exceeded/);
      expect(Date.now() - started).toBeLessThan(8000);
      const answered = await Promise.race([
        page.evaluate(() => document.querySelector('p')?.textContent),
        page.waitForTimeout(3000).then(() => 'unanswered'),
      ]);
      expect(answered).toBe('home');
      const next = await navigateViaPlaywright({ cdpUrl, url: `${allowed}/?next`, ssrfPolicy: strict });
      expect(next.url).toBe(`${allowed}/?next`);
    }, 40_000);

    it('lets a newer navigation replace a pending one and load in full', async () => {
      await navigateViaPlaywright({ cdpUrl, url: `${allowed}/`, ssrfPolicy: strict });
      const replaced = navigateViaPlaywright({ cdpUrl, url: `${allowed}/hang`, ssrfPolicy: strict }).then(
        () => 'resolved',
        () => 'rejected',
      );
      await page.waitForTimeout(300);
      const newer = await navigateViaPlaywright({ cdpUrl, url: `${allowed}/with-asset`, ssrfPolicy: strict });
      expect(newer.url).toBe(`${allowed}/with-asset`);
      expect(await replaced).toBe('rejected');
      await page.waitForFunction(() => document.querySelector('img')?.complete === true);
      expect(await page.evaluate(() => document.querySelector('img')?.naturalWidth)).toBe(1);
    }, 40_000);

    it('returns at commit when the page starts a navigation of its own', async () => {
      const source = route(allowed, '/replace', `${allowed}/hang`);
      const started = Date.now();
      const result = await navigateViaPlaywright({ cdpUrl, url: source, ssrfPolicy: strict });
      expect(Date.now() - started).toBeLessThan(8000);
      expect(result.url).toBe(source);
    }, 40_000);

    it('lets an interaction return and keeps the tab usable', async () => {
      await navigateViaPlaywright({ cdpUrl, url: `${allowed}/`, ssrfPolicy: strict });
      const started = Date.now();
      await assertInteractionNavigationCompletedSafely({
        cdpUrl,
        page,
        previousUrl: page.url(),
        ssrfPolicy: strict,
        action: () =>
          page.evaluate((url) => {
            setTimeout(() => {
              location.href = url;
            }, 0);
          }, `${allowed}/hang`),
      });
      expect(Date.now() - started).toBeLessThan(8000);
      const next = await navigateViaPlaywright({ cdpUrl, url: `${allowed}/?next`, ssrfPolicy: strict });
      expect(next.url).toBe(`${allowed}/?next`);
      expect(Date.now() - started).toBeLessThan(8000);
    }, 40_000);

    it('starts the next navigation while one the page began between actions is still waiting', async () => {
      await navigateViaPlaywright({ cdpUrl, url: route(allowed, '/later', `${allowed}/hang`), ssrfPolicy: strict });
      await page.waitForTimeout(700);
      const started = Date.now();
      const next = await navigateViaPlaywright({ cdpUrl, url: `${allowed}/?next`, ssrfPolicy: strict });
      expect(next.url).toBe(`${allowed}/?next`);
      expect(Date.now() - started).toBeLessThan(8000);
    }, 40_000);

    it('refuses a denied redirect hop that arrives after the navigation returned', async () => {
      const source = route(allowed, '/replace', route(allowed, '/slow-redirect', `${denied}/secret`));
      const result = await navigateViaPlaywright({ cdpUrl, url: source, ssrfPolicy: strict });
      expect(result.url).toBe(source);
      await page.waitForTimeout(1200);
      expect(hits.secret).toBe(0);
    }, 40_000);

    it('control: the same late redirect hop is followed under a policy that allows it', async () => {
      const source = route(allowed, '/replace', route(allowed, '/slow-redirect', `${denied}/secret`));
      await navigateViaPlaywright({ cdpUrl, url: source, ssrfPolicy: permissive });
      await page.waitForURL(`${denied}/secret`);
      expect(hits.secret).toBe(1);
    }, 40_000);
  });

  it('leaves CORS preflights to the server during a guarded action', async () => {
    await navigateViaPlaywright({ cdpUrl, url: `${allowed}/`, ssrfPolicy: strict });
    const status = await withPageNavigationRequestGuard({
      cdpUrl,
      page,
      ssrfPolicy: strict,
      action: () =>
        page.evaluate(async (url) => {
          const response = await fetch(url, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          return response.status;
        }, `${apiOrigin}/api`),
    });
    expect(status).toBe(200);
    expect(hits.api).toBe(1);
    expect(hits.preflight).toBe(1);
  });
});
