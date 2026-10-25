import type { BrowserContext, Frame, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { startConnectionCdpServer } from './connection-cdp.test-support.js';
import { connectBrowser, disconnectBrowser, hasCachedPlaywrightBrowserConnection } from './connection.js';
import { guardHeadlessContext, observeContext } from './page-utils.js';

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await disconnectBrowser();
});

describe('headless passkey guard through a real CDP connection', () => {
  it.each([
    '/test/chrome --headless=new',
    '/test/chrome-headless-shell',
    'C:\\browsers\\headless_shell.exe --remote-debugging-port=9222',
    '"C:\\Browser Cache\\headless_shell.exe" --remote-debugging-port=9222',
    'C:\\browsers\\chrome-headless-shell.exe --remote-debugging-port=9222',
    '"C:\\Browser Cache\\chrome-headless-shell.exe" --remote-debugging-port=9222',
    'headless_shell.exe --remote-debugging-port=9222',
    '"chrome-headless-shell.exe" --remote-debugging-port=9222',
  ])('guards modal requests and preserves conditional and ordinary credentials for %s', async (browserCommandLine) => {
    const cdp = await startConnectionCdpServer({ browserCommandLine });
    try {
      const { browser } = await connectBrowser(cdp.httpUrl);
      expect(cdp.frames.some((frame) => frame.method === 'SystemInfo.getInfo')).toBe(true);
      const get = vi.fn(() => Promise.resolve('native get'));
      const create = vi.fn(() => Promise.resolve('native create'));
      class Credentials {
        get = get;
        create = create;
      }
      // The real browser API has prototype methods rather than instance fields.
      Object.assign(Credentials.prototype, { get, create });
      const nativeToString = Reflect.get(Function.prototype, 'toString') as (this: unknown) => string;
      const functionScope = { prototype: { toString: nativeToString } };
      const scope = { CredentialsContainer: Credentials, DOMException, Function: functionScope };
      type Installer = (scope?: unknown) => void;
      const scripts: Installer[] = [];
      const evaluate = vi.fn((script: Installer) => {
        scripts.push(script);
        return Promise.resolve();
      });
      const addInitScript = vi.fn((script: Installer) => {
        scripts.push(script);
        return Promise.resolve();
      });
      const context = {
        browser: () => browser,
        addInitScript,
        pages: () => [{ frames: () => [{ evaluate }, { evaluate }] } as unknown as Page],
      } as unknown as BrowserContext;
      await guardHeadlessContext(context);
      await guardHeadlessContext(context);
      expect(addInitScript).toHaveBeenCalledTimes(1);
      expect(evaluate).toHaveBeenCalledTimes(2);
      scripts[0](scope);
      const credentials = Object.create(Credentials.prototype) as Credentials;
      const invoke = credentials.get as (options: object) => Promise<unknown>;
      const enroll = credentials.create as (options: object) => Promise<unknown>;
      await expect(invoke.call(credentials, { publicKey: {} })).rejects.toMatchObject({ name: 'NotAllowedError' });
      await expect(enroll.call(credentials, { publicKey: {} })).rejects.toMatchObject({ name: 'NotAllowedError' });
      expect(get).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      await expect(invoke.call(credentials, { publicKey: {}, mediation: 'conditional' })).resolves.toBe('native get');
      await expect(enroll.call(credentials, { publicKey: {}, mediation: 'conditional' })).resolves.toBe(
        'native create',
      );
      await expect(enroll.call(credentials, { password: {} })).resolves.toBe('native create');
      expect(get.mock.contexts[0]).toBe(credentials);
      expect(create.mock.contexts[0]).toBe(credentials);
      const maskedToString = functionScope.prototype.toString;
      expect(maskedToString).not.toBe(nativeToString);
      expect(maskedToString.call(invoke)).toBe(nativeToString.call(get));
      expect(maskedToString.call(enroll)).toBe(nativeToString.call(create));
      expect(maskedToString.call(maskedToString)).toBe(nativeToString.call(nativeToString));
      expect(maskedToString.call(get)).toBe(nativeToString.call(get));
      expect(invoke.name).toBe(get.name);

      const lateAddInitScript = vi.fn(() => Promise.resolve());
      const lateContext = {
        browser: () => browser,
        addInitScript: lateAddInitScript,
        pages: () => [],
        on: vi.fn(),
        once: vi.fn(),
      } as unknown as BrowserContext;
      await observeContext(lateContext);
      expect(lateAddInitScript).toHaveBeenCalledTimes(1);
      await disconnectBrowser();
      expect(hasCachedPlaywrightBrowserConnection(cdp.httpUrl)).toBe(false);
    } finally {
      await cdp.close();
    }
  });

  it.each([
    '/test/chrome --disable-gpu',
    '"C:\\Browser Cache\\chrome.exe" --disable-gpu',
    'C:\\browsers\\headless_shell.exe.backup --disable-gpu',
    'C:\\browsers\\not-headless_shell.exe --disable-gpu',
    '"C:\\Browser Cache\\chrome-headless-shell.exe-helper" --disable-gpu',
    'C:\\headless_shell.exe\\chrome.exe --disable-gpu',
  ])('control: a headed browser or lookalike does not install a passkey override: %s', async (browserCommandLine) => {
    const cdp = await startConnectionCdpServer({ browserCommandLine });
    try {
      const { browser } = await connectBrowser(cdp.httpUrl);
      const addInitScript = vi.fn();
      const context = {
        browser: () => browser,
        addInitScript,
        pages: () => [{ frames: () => [{ evaluate: vi.fn() } as unknown as Frame] }],
      } as unknown as BrowserContext;
      await guardHeadlessContext(context);
      expect(addInitScript).not.toHaveBeenCalled();
    } finally {
      await cdp.close();
    }
  });

  it('keeps credentials from a failed CDP mode probe out of its warning', async () => {
    const cdp = await startConnectionCdpServer({
      commandFailures: [{ method: 'SystemInfo.getInfo', message: 'failed for http://user:secret@localhost/' }],
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect((await connectBrowser(cdp.httpUrl)).browser.isConnected()).toBe(true);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Could not read the browser launch mode'));
      expect(warning.mock.calls.flat().join(' ')).not.toContain('secret');
    } finally {
      await cdp.close();
    }
  });

  it('detaches a CDP session that arrives after launch-mode detection timed out', async () => {
    let release!: () => void;
    let attached!: () => void;
    const entered = new Promise<void>((resolve) => {
      attached = resolve;
    });
    const cdp = await startConnectionCdpServer({
      browserAttachGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
      onBrowserAttach: attached,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const connecting = connectBrowser(cdp.httpUrl);
      await entered;
      await new Promise((resolve) => setTimeout(resolve, 5100));
      const { browser } = await connecting;
      expect(browser.isConnected()).toBe(true);
      release();
      await vi.waitFor(() => {
        expect(cdp.frames.some((frame) => frame.method === 'Target.detachFromTarget')).toBe(true);
      });
      expect(cdp.frames.some((frame) => frame.method === 'SystemInfo.getInfo')).toBe(false);
    } finally {
      release();
      await cdp.close();
    }
  }, 10_000);

  it('rejects a browser that disconnects during initialization instead of returning the dead adapter', async () => {
    const cdp = await startConnectionCdpServer({ disconnectOnBrowserInfo: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(connectBrowser(cdp.httpUrl)).rejects.toThrow('Browser disconnected while connecting.');
      expect(cdp.connections).toBe(3);
      expect(hasCachedPlaywrightBrowserConnection(cdp.httpUrl)).toBe(false);
    } finally {
      await cdp.close();
    }
  }, 20_000);
});
