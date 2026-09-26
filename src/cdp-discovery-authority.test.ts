import { describe, expect, it } from 'vitest';

import { startConnectionCdpServer } from './connection-cdp.test-support.js';
import { connectBrowser, disconnectBrowser } from './connection.js';
import { startFakeCdpServer } from './fake-cdp.test-support.js';
import { BrowserCdpEndpointBlockedError } from './security.js';

describe('CDP discovery authority with explicit private-host trust', () => {
  it('rejects changed-port discovery before dialing despite the private-network opt-in', async () => {
    const target = await startConnectionCdpServer();
    const discovery = await startFakeCdpServer({
      versionWsUrl: () => `${target.httpUrl.replace('http:', 'ws:')}/devtools/browser/fake`,
    });
    try {
      await expect(
        connectBrowser(discovery.httpUrl, undefined, {
          dangerouslyAllowPrivateNetwork: true,
          allowedHostnames: ['127.0.0.1'],
        }),
      ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
      expect(discovery.authSeen.length).toBeGreaterThan(0);
      expect(target.handshakes).toBe(0);
      expect(target.connections).toBe(0);
    } finally {
      await disconnectBrowser();
      await discovery.close();
      await target.close();
    }
  });

  it('control: a broad private-network opt-in actually connects to the same discovered changed port', async () => {
    const target = await startConnectionCdpServer();
    const discovery = await startFakeCdpServer({
      versionWsUrl: () => `${target.httpUrl.replace('http:', 'ws:')}/devtools/browser/fake`,
    });
    try {
      const connected = await connectBrowser(discovery.httpUrl, undefined, {
        dangerouslyAllowPrivateNetwork: true,
      });
      expect(connected.browser.isConnected()).toBe(true);
      expect(target.handshakes).toBe(1);
      expect(target.connections).toBe(1);
    } finally {
      await disconnectBrowser();
      await discovery.close();
      await target.close();
    }
  });
});
