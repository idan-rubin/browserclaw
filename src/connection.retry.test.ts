import { afterEach, describe, expect, it } from 'vitest';

import { startConnectionCdpServer } from './connection-cdp.test-support.js';
import { connectBrowser, disconnectBrowser } from './connection.js';

describe('CDP connection retry classification', () => {
  afterEach(async () => {
    await disconnectBrowser();
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
