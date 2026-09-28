import type * as DnsPromises from 'node:dns/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { closeCdpSocket, fetchCdpJson, openPinnedCdpSocket } from './cdp-network.js';
import { connectOverPinnedCdp } from './cdp-transport.js';
import { getChromeWebSocketUrl } from './chrome-launcher.js';
import { startConnectionCdpServer } from './connection-cdp.test-support.js';
import { connectBrowser, disconnectBrowser } from './connection.js';
import { createPinnedLookup } from './security.js';

const { dnsMock } = vi.hoisted(() => ({ dnsMock: vi.fn() }));
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof DnsPromises>()),
  lookup: dnsMock,
}));

async function httpFixture(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${String(port)}`,
    port,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

describe('pinned CDP network', () => {
  afterEach(async () => {
    await disconnectBrowser();
    vi.restoreAllMocks();
    dnsMock.mockReset();
  });

  it('rejects malformed UTF-8 JSON instead of replacing invalid bytes', async () => {
    const malformed = Buffer.concat([Buffer.from('{"title":"'), Buffer.from([0x80]), Buffer.from('"}')]);
    const http = await httpFixture((_req, res) => {
      res.end(malformed);
    });
    try {
      // Control: lossy decoding produces otherwise valid JSON.
      expect(JSON.parse(malformed.toString('utf8'))).toEqual({ title: '\uFFFD' });
      await expect(fetchCdpJson(http.url, { timeoutMs: 500 })).rejects.toThrow('CDP malformed JSON response');
    } finally {
      await http.close();
    }
  });

  it('control: accepts multibyte UTF-8 split across response chunks', async () => {
    const bytes = Buffer.from('{"title":"頁面🙂"}');
    const http = await httpFixture((_req, res) => {
      for (const byte of bytes) res.write(Buffer.from([byte]));
      res.end();
    });
    try {
      await expect(fetchCdpJson(http.url, { timeoutMs: 500 })).resolves.toEqual({ title: '頁面🙂' });
    } finally {
      await http.close();
    }
  });

  it('uses the supplied validated lookup for HTTP and keeps credentials out of the request target', async () => {
    const seen: { auth?: string; host?: string; url?: string }[] = [];
    const http = await httpFixture((req, res) => {
      seen.push({ auth: req.headers.authorization, host: req.headers.host, url: req.url });
      res.end('{"ok":true}');
    });
    const lookup = createPinnedLookup({ hostname: 'pin-http.invalid', addresses: ['127.0.0.1'] });
    try {
      await expect(
        fetchCdpJson(`http://user:p%40ss@pin-http.invalid:${String(http.port)}/json/version`, {
          timeoutMs: 500,
          lookup,
        }),
      ).resolves.toEqual({ ok: true });
      expect(seen).toEqual([
        {
          auth: `Basic ${Buffer.from('user:p@ss').toString('base64')}`,
          host: `pin-http.invalid:${String(http.port)}`,
          url: '/json/version',
        },
      ]);
    } finally {
      await http.close();
    }
  });

  it('pins actual Playwright WebSocket dialing and preserves Basic authentication', async () => {
    const cdp = await startConnectionCdpServer();
    const port = new URL(cdp.httpUrl).port;
    const lookup = createPinnedLookup({ hostname: 'pin-ws.invalid', addresses: ['127.0.0.1'] });
    try {
      const browser = await connectOverPinnedCdp(
        { url: `ws://user:pass@pin-ws.invalid:${port}/devtools/browser/x`, lookup },
        { timeoutMs: 1000 },
      );
      expect(browser.isConnected()).toBe(true);
      expect(cdp.authSeen).toContain(`Basic ${Buffer.from('user:pass').toString('base64')}`);
      await browser.close();
    } finally {
      await cdp.close();
    }
  });

  it('gives explicit mixed-case authorization priority over URL credentials on HTTP and WebSocket', async () => {
    const cdp = await startConnectionCdpServer();
    const url = cdp.httpUrl.replace('http://', 'http://user:pass@');
    try {
      await fetchCdpJson(`${url}/json/version`, { timeoutMs: 500, headers: { authorization: 'Bearer explicit-http' } });
      const socket = await openPinnedCdpSocket(
        { url: `${url.replace('http:', 'ws:')}/devtools/browser/x` },
        { timeoutMs: 500, headers: { aUtHoRiZaTiOn: 'Bearer explicit-ws' } },
      );
      closeCdpSocket(socket);
      expect(cdp.authSeen).toEqual(['Bearer explicit-http', 'Bearer explicit-ws']);
    } finally {
      await cdp.close();
    }
  });

  it('resumes and detaches contextless auto-attached targets without exposing them to Playwright', async () => {
    const cdp = await startConnectionCdpServer({ contextlessTarget: true });
    try {
      const browser = await connectOverPinnedCdp(
        { url: `${cdp.httpUrl.replace('http:', 'ws:')}/devtools/browser/x` },
        { timeoutMs: 1000 },
      );
      await vi.waitFor(() => {
        expect(cdp.frames.some((frame) => frame.method === 'Target.detachFromTarget')).toBe(true);
      });
      expect(cdp.frames.find((frame) => frame.method === 'Runtime.runIfWaitingForDebugger')?.sessionId).toBe(
        'contextless',
      );
      expect(browser.isConnected()).toBe(true);
      await browser.close();
    } finally {
      await cdp.close();
    }
  });

  it.each([{}, { sessionId: '' }])(
    'discards contextless targets with unusable session IDs: %j',
    async (contextlessTarget) => {
      const cdp = await startConnectionCdpServer({ contextlessTarget });
      try {
        const browser = await connectOverPinnedCdp(
          { url: `${cdp.httpUrl.replace('http:', 'ws:')}/devtools/browser/x` },
          { timeoutMs: 1000 },
        );
        // A subsequent round trip proves malformed events did not reach Playwright
        // and abort the connection; valid responses still pass through the filter.
        const session = await browser.newBrowserCDPSession();
        await expect(session.send('Browser.getVersion')).resolves.toMatchObject({ product: 'Chrome/150.0.0.0' });
        expect(browser.isConnected()).toBe(true);
        expect(cdp.frames.some((frame) => frame.method === 'Runtime.runIfWaitingForDebugger')).toBe(false);
        expect(cdp.frames.some((frame) => frame.method === 'Target.detachFromTarget')).toBe(false);
        await browser.close();
      } finally {
        await cdp.close();
      }
    },
  );

  it('does not double the deadline for credentialed discovery fallback', async () => {
    let requests = 0;
    const source = await httpFixture((_req, res) => {
      requests += 1;
      res.writeHead(200);
      res.write('{');
    });
    try {
      const started = Date.now();
      await expect(getChromeWebSocketUrl(source.url, 50, 'token')).resolves.toBeNull();
      expect(requests).toBe(1);
      expect(Date.now() - started).toBeLessThan(300);
    } finally {
      await source.close();
    }
  });

  it('bounds policy DNS resolution inside endpoint discovery', async () => {
    dnsMock.mockReturnValue(new Promise(() => undefined));
    const started = Date.now();
    await expect(getChromeWebSocketUrl('http://dns-hangs.invalid:9222', 30, undefined, {})).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(300);
  });

  it('carries the policy-validated DNS answer through discovery and Playwright without a dial-time lookup', async () => {
    const cdp = await startConnectionCdpServer();
    // A permissive private endpoint policy is intentional for this local fixture.
    // Every validation lookup succeeds; an unpinned native dial cannot resolve this host.
    dnsMock.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    try {
      const url = cdp.httpUrl.replace('127.0.0.1', 'pin-end-to-end.invalid');
      const connected = await connectBrowser(url, 'wire-token', { dangerouslyAllowPrivateNetwork: true });
      expect(connected.browser.isConnected()).toBe(true);
      expect(dnsMock).toHaveBeenCalled();
      expect(cdp.authSeen.every((auth) => auth === 'Bearer wire-token')).toBe(true);
      expect(cdp.connections).toBe(1);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('blocks a rebinding answer during a later policy check before any private endpoint dial', async () => {
    const cdp = await startConnectionCdpServer();
    dnsMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    try {
      await expect(
        connectBrowser(cdp.httpUrl.replace('127.0.0.1', 'rebind-check.invalid'), undefined, {}),
      ).rejects.toThrow();
      expect(cdp.connections).toBe(0);
      expect(cdp.authSeen).toHaveLength(0);
    } finally {
      await cdp.close();
    }
  });

  it('rejects cross-authority HTTP redirects before connecting to the destination', async () => {
    let forbiddenRequests = 0;
    const forbidden = await httpFixture((_req, res) => {
      forbiddenRequests += 1;
      res.end('{}');
    });
    const source = await httpFixture((_req, res) => {
      res.writeHead(302, { location: forbidden.url });
      res.end();
    });
    try {
      await expect(fetchCdpJson(source.url, { timeoutMs: 500 })).rejects.toThrow('redirect changed authority');
      expect(forbiddenRequests).toBe(0);
    } finally {
      await source.close();
      await forbidden.close();
    }
  });

  it('control: follows same-authority HTTP redirects with authentication intact', async () => {
    const auth: string[] = [];
    const source = await httpFixture((req, res) => {
      auth.push(req.headers.authorization ?? '');
      if (req.url === '/start') {
        res.writeHead(302, { location: '/json/version' });
        res.end();
      } else res.end('{"ok":true}');
    });
    try {
      await expect(
        fetchCdpJson(`${source.url}/start`, { timeoutMs: 500, headers: { Authorization: 'Bearer test' } }),
      ).resolves.toEqual({ ok: true });
      expect(auth).toEqual(['Bearer test', 'Bearer test']);
    } finally {
      await source.close();
    }
  });

  it('bounds full response consumption even after successful headers', async () => {
    const source = await httpFixture((_req, res) => {
      res.writeHead(200);
      res.write('{');
    });
    try {
      const started = Date.now();
      await expect(fetchCdpJson(source.url, { timeoutMs: 40 })).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await source.close();
    }
  });

  it('rejects oversized response bodies', async () => {
    const source = await httpFixture((_req, res) => {
      res.end(`"${'x'.repeat(16 * 1024 * 1024)}"`);
    });
    try {
      await expect(fetchCdpJson(source.url, { timeoutMs: 1000 })).rejects.toThrow(/exceeds|aborted/);
    } finally {
      await source.close();
    }
  });

  it('rejects cross-port WebSocket redirects before any destination connection', async () => {
    let forbiddenRequests = 0;
    const forbidden = await httpFixture((_req, res) => {
      forbiddenRequests += 1;
      res.end();
    });
    const source = await httpFixture((_req, res) => {
      res.writeHead(302, { location: forbidden.url.replace('http:', 'ws:') });
      res.end();
    });
    try {
      await expect(
        openPinnedCdpSocket({ url: source.url.replace('http:', 'ws:') }, { timeoutMs: 500 }),
      ).rejects.toThrow('redirect changed authority');
      expect(forbiddenRequests).toBe(0);
    } finally {
      await source.close();
      await forbidden.close();
    }
  });

  it('control: follows a same-authority WebSocket redirect with credentials', async () => {
    const auth: string[] = [];
    const source = await httpFixture((req, res) => {
      auth.push(req.headers.authorization ?? '');
      res.writeHead(302, { location: '/socket' });
      res.end();
    });
    const sockets = new WebSocketServer({ noServer: true });
    source.server.on('upgrade', (req, socket, head) => {
      if (req.url === '/socket') {
        auth.push(req.headers.authorization ?? '');
        sockets.handleUpgrade(req, socket, head, (ws) => {
          sockets.emit('connection', ws, req);
        });
      } else {
        auth.push(req.headers.authorization ?? '');
        socket.end('HTTP/1.1 302 Found\r\nLocation: /socket\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    });
    try {
      const socket = await openPinnedCdpSocket(
        { url: `${source.url.replace('http:', 'ws:')}/start` },
        { timeoutMs: 500, headers: { Authorization: 'Bearer socket' } },
      );
      expect(auth).toEqual(['Bearer socket', 'Bearer socket']);
      closeCdpSocket(socket);
    } finally {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await source.close();
    }
  });
});
