import { describe, it, expect, afterEach } from 'vitest';

import { listPagesViaPlaywright } from './actions/navigation.js';
import {
  connectBrowser,
  disconnectBrowser,
  hasCachedPlaywrightBrowserConnection,
  tryTerminateExecutionViaCdp,
} from './connection.js';
import { startFakeCdpServer, startTcpSink } from './fake-cdp.test-support.js';
import { BrowserCdpEndpointBlockedError } from './security.js';

const STRICT_POLICY = { dangerouslyAllowPrivateNetwork: false };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('connectBrowser discovery under a strict policy', () => {
  afterEach(async () => {
    await disconnectBrowser();
  });

  it('rejects a discovered endpoint that changes authority and never lets Playwright dial it', async () => {
    const forbidden = await startTcpSink();
    forbidden.release();
    const cdp = await startFakeCdpServer({
      versionWsUrl: () => `ws://127.0.0.1:${String(forbidden.port)}/devtools/browser/x`,
    });
    try {
      await expect(connectBrowser(cdp.httpUrl, undefined, STRICT_POLICY)).rejects.toThrow(
        BrowserCdpEndpointBlockedError,
      );
      await sleep(50);
      expect(forbidden.connections).toBe(0);
    } finally {
      await cdp.close();
      await forbidden.close();
    }
  });

  it('control: without a policy the advertised endpoint is dialed', async () => {
    const advertised = await startTcpSink();
    advertised.release();
    const cdp = await startFakeCdpServer({
      versionWsUrl: () => `ws://127.0.0.1:${String(advertised.port)}/devtools/browser/x`,
    });
    try {
      await expect(connectBrowser(cdp.httpUrl)).rejects.toThrow();
      expect(advertised.connections).toBeGreaterThan(0);
    } finally {
      await cdp.close();
      await advertised.close();
    }
  }, 20_000);
});

describe('connectBrowser cancellation of a queued attempt', () => {
  afterEach(async () => {
    await disconnectBrowser();
  });

  it("cancels an attempt still queued behind another URL's dial", async () => {
    const a = await startTcpSink();
    const b = await startTcpSink();
    const aUrl = `ws://127.0.0.1:${String(a.port)}/devtools/browser/a`;
    const bUrl = `ws://127.0.0.1:${String(b.port)}/devtools/browser/b`;
    try {
      const aConnect = connectBrowser(aUrl);
      aConnect.catch(() => undefined);
      await sleep(150);
      expect(a.connections).toBe(1);

      await expect(listPagesViaPlaywright({ cdpUrl: bUrl, timeoutMs: 30 })).rejects.toThrow('timed out');

      a.release();
      await expect(aConnect).rejects.toThrow();
      await sleep(100);
      expect(b.connections).toBe(0);
      expect(hasCachedPlaywrightBrowserConnection(bUrl)).toBe(false);
    } finally {
      await a.close();
      await b.close();
    }
  }, 20_000);
});

describe('tryTerminateExecutionViaCdp against an endpoint that requires Basic auth', () => {
  const auth = `Basic ${Buffer.from('user:pass').toString('base64')}`;
  const targets = (port: number) => [
    { id: 'T1', webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/page/T1` },
  ];

  it('authenticates both /json/list and the socket, then sends Runtime.terminateExecution', async () => {
    const cdp = await startFakeCdpServer({ requireAuthorization: auth, listTargets: targets });
    try {
      await tryTerminateExecutionViaCdp(`http://user:pass@127.0.0.1:${String(cdp.port)}`, 'T1');
      expect(cdp.authSeen).toEqual([auth, auth]);
      expect(cdp.frames.map((f) => f.method)).toContain('Runtime.terminateExecution');
    } finally {
      await cdp.close();
    }
  });

  it('control: without credentials the endpoint rejects the listing and nothing is sent', async () => {
    const cdp = await startFakeCdpServer({ requireAuthorization: auth, listTargets: targets });
    try {
      await tryTerminateExecutionViaCdp(`http://127.0.0.1:${String(cdp.port)}`, 'T1');
      expect(cdp.upgrades).toBe(0);
      expect(cdp.frames).toEqual([]);
    } finally {
      await cdp.close();
    }
  });
});
