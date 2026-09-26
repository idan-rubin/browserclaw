import { afterEach, describe, expect, it } from 'vitest';

import { startConnectionCdpServer } from './connection-cdp.test-support.js';
import { connectBrowser, disconnectBrowser } from './connection.js';

describe('CDP connection retry classification', () => {
  afterEach(async () => {
    await disconnectBrowser();
  });

  it('does not retry an actual HTTP429 websocket handshake', async () => {
    const cdp = await startConnectionCdpServer({ handshakeStatuses: [429, 101] });
    try {
      await expect(connectBrowser(cdp.httpUrl)).rejects.toThrow('CDP WebSocket HTTP 429');
      expect(cdp.handshakes).toBe(1);
      expect(cdp.connections).toBe(0);
    } finally {
      await cdp.close();
    }
  });

  it('does not retry a rate-limit error during the real Playwright handshake', async () => {
    const cdp = await startConnectionCdpServer({
      commandFailures: [{ method: 'Browser.getVersion', message: 'rate limit exceeded' }],
    });
    try {
      await expect(connectBrowser(cdp.httpUrl)).rejects.toThrow('rate limit exceeded');
      expect(cdp.connections).toBe(1);
    } finally {
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
