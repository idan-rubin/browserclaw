import { afterEach, describe, expect, it, vi } from 'vitest';

import * as transport from './cdp-transport.js';
import { startConnectionCdpServer } from './connection-cdp.test-support.js';
import { connectBrowser, disconnectBrowser } from './connection.js';
import { UnresponsiveCdpTargetError } from './errors.js';

describe('CDP connection retry classification', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectBrowser();
  });

  it('does not retry when a page target never answered initialization', async () => {
    const cdp = await startConnectionCdpServer();
    const unresponsive = new UnresponsiveCdpTargetError(['HUNG-TARGET']);
    const connect = vi.spyOn(transport, 'connectOverPinnedCdp').mockRejectedValue(unresponsive);
    try {
      const configured = `${cdp.httpUrl.replace('http:', 'ws:')}/devtools/browser/configured`;
      await expect(connectBrowser(configured)).rejects.toBe(unresponsive);
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      await cdp.close();
    }
  });

  it('control: retries an ordinary connect timeout', async () => {
    const cdp = await startConnectionCdpServer();
    const connect = vi.spyOn(transport, 'connectOverPinnedCdp').mockRejectedValue(new Error('Timeout 5000ms exceeded'));
    try {
      const configured = `${cdp.httpUrl.replace('http:', 'ws:')}/devtools/browser/configured`;
      await expect(connectBrowser(configured)).rejects.toThrow('Timeout 5000ms exceeded');
      expect(connect).toHaveBeenCalledTimes(3);
    } finally {
      await cdp.close();
    }
  });

  it('backs off and retries an HTTP429 websocket handshake', async () => {
    const cdp = await startConnectionCdpServer({ handshakeStatuses: [429, 101] });
    try {
      const started = Date.now();
      expect((await connectBrowser(cdp.httpUrl)).browser.isConnected()).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
      expect(cdp.handshakes).toBe(2);
      expect(cdp.connections).toBe(1);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('retries a rate-limit error during the real Playwright handshake', async () => {
    const cdp = await startConnectionCdpServer({
      commandFailures: [{ method: 'Browser.getVersion', message: 'rate limit exceeded' }],
    });
    try {
      expect((await connectBrowser(cdp.httpUrl)).browser.isConnected()).toBe(true);
      expect(cdp.connections).toBe(2);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });

  it('control: retries a transient HTTP503 and connects successfully', async () => {
    const cdp = await startConnectionCdpServer({ handshakeStatuses: [503, 101] });
    try {
      const connected = await connectBrowser(cdp.httpUrl);
      expect(connected.browser.isConnected()).toBe(true);
      expect(cdp.handshakes).toBe(2);
      expect(cdp.connections).toBe(1);
    } finally {
      await disconnectBrowser();
      await cdp.close();
    }
  });
});
