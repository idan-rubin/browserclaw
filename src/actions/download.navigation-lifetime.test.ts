import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page, Request, Route } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';
import { InvalidBrowserNavigationUrlError } from '../security.js';

const mocks = vi.hoisted(() => ({ page: vi.fn(), state: vi.fn(), locator: vi.fn() }));
vi.mock('../connection.js', async (original) => ({
  ...(await original<typeof Connection>()),
  getPageForTargetId: mocks.page,
  ensurePageState: mocks.state,
  refLocator: mocks.locator,
}));

import { downloadViaPlaywright } from './download.js';
import { navigateViaPlaywright } from './navigation.js';

type Handler = (route: Route, request: Request) => Promise<void>;
let directory: string;
const published: string[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bc-download-lifetime-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  for (const file of published.splice(0)) await rm(file, { force: true });
});

function fixture() {
  let handler: Handler | undefined;
  const frame = {};
  const page = Object.assign(new EventEmitter(), {
    url: () => 'about:blank',
    mainFrame: () => frame,
    isClosed: () => false,
    close: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn(),
    route: (_pattern: string, next: Handler) => {
      handler = next;
      return Promise.resolve();
    },
    unroute: () => {
      handler = undefined;
      return Promise.resolve();
    },
  });
  const fallback = vi.fn().mockResolvedValue(undefined);
  const fulfill = vi.fn().mockResolvedValue(undefined);
  const route = { fallback, fulfill, abort: vi.fn().mockResolvedValue(undefined) } as unknown as Route;
  const request = {
    url: () => 'http://169.254.169.254/latest/meta-data/',
    frame: () => frame,
    isNavigationRequest: () => true,
    resourceType: () => 'document',
  } as unknown as Request;
  const dispatch = async () => {
    if (handler) await handler(route, request);
    else await fallback();
  };
  mocks.page.mockResolvedValue(page as unknown as Page);
  mocks.state.mockReturnValue({ nextArmIdDownload: 0, armIdDownload: 0, downloadWaiterDepth: 0 });
  return { page, dispatch, fallback, fulfill, guarded: () => handler !== undefined };
}

describe('download navigation ownership', () => {
  it('waits for an aborted native click and preserves a later policy denial', async () => {
    const f = fixture();
    let finish: () => void = () => undefined;
    const native = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const click = vi.fn(() => native);
    mocks.locator.mockReturnValue({ click });
    const controller = new AbortController();
    let settled = false;
    const pending = downloadViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      targetId: 'T1',
      ref: 'e1',
      path: join(directory, 'payload.bin'),
      signal: controller.signal,
      timeoutMs: 5000,
    }).finally(() => {
      settled = true;
    });
    const rejection = expect(pending).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    await vi.waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    controller.abort(new Error('cancel download'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(settled).toBe(false);
    expect(f.guarded()).toBe(true);
    await f.dispatch();
    expect(f.fulfill).toHaveBeenCalledWith({ status: 204, body: '' });
    expect(f.fallback).not.toHaveBeenCalled();
    finish();
    await rejection;
    expect(f.guarded()).toBe(false);
    await f.dispatch();
    expect(f.fallback).toHaveBeenCalledOnce();
  });

  it.each([
    ['https://93.184.216.34/start', 'https://93.184.216.34/final.zip'],
    ['https://93.184.216.34/my file.zip', 'https://93.184.216.34/my%20file.zip'],
    ['https://93.184.216.34:443/file.zip', 'https://93.184.216.34/file.zip'],
  ])('confirms an aborted download by its event, not the input URL: %s', async (url, finalUrl) => {
    const f = fixture();
    f.page.goto.mockImplementation(() => {
      setTimeout(
        () =>
          f.page.emit('download', {
            url: () => finalUrl,
            suggestedFilename: () => 'payload.txt',
            saveAs: (file: string) => writeFile(file, 'download payload'),
          }),
        20,
      );
      return Promise.reject(new Error(`page.goto: net::ERR_ABORTED at ${finalUrl}`));
    });
    const result = await navigateViaPlaywright({ cdpUrl: 'http://localhost:9222', url, timeoutMs: 3000 });
    expect(result.download).toBeDefined();
    if (!result.download) throw new Error('Expected confirmed download');
    published.push(result.download.path);
    expect(await readFile(result.download.path, 'utf8')).toBe('download payload');
    expect(f.page.listenerCount('download')).toBe(0);
  });

  it('rethrows the original abort after the bounded grace when no download event arrives', async () => {
    const f = fixture();
    const error = new Error('page.goto: net::ERR_ABORTED at https://93.184.216.34/final');
    f.page.goto.mockRejectedValue(error);
    const started = Date.now();
    await expect(
      navigateViaPlaywright({
        cdpUrl: 'http://localhost:9222',
        url: 'https://93.184.216.34/start',
        timeoutMs: 10_000,
      }),
    ).rejects.toBe(error);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(4000);
    expect(f.page.listenerCount('download')).toBe(0);
  });
});
