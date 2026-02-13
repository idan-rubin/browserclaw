import { devices } from 'playwright-core';
import {
  getPageForTargetId,
  ensurePageState,
} from '../connection.js';
import type { ColorScheme } from '../types.js';

export async function emulateMediaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  colorScheme: ColorScheme;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.emulateMedia({ colorScheme: opts.colorScheme });
}

export async function setDeviceViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  name: string;
}): Promise<void> {
  const device = devices[opts.name];
  if (!device) {
    const available = Object.keys(devices).slice(0, 10).join(', ');
    throw new Error(`Unknown device "${opts.name}". Some available devices: ${available}...`);
  }

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  if (device.viewport) {
    await page.setViewportSize(device.viewport);
  }
  if (device.userAgent) {
    const context = page.context();
    // Playwright doesn't expose setUserAgent on context directly via CDP,
    // so we use CDP Emulation.setUserAgentOverride
    const session = await context.newCDPSession(page);
    try {
      await session.send('Emulation.setUserAgentOverride', {
        userAgent: device.userAgent,
      });
    } finally {
      await session.detach().catch(() => {});
    }
  }
}

export async function setExtraHTTPHeadersViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  headers: Record<string, string>;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.setExtraHTTPHeaders(opts.headers);
}

export async function setGeolocationViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  origin?: string;
  clear?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  const context = page.context();

  if (opts.clear) {
    await context.setGeolocation(null);
    await context.clearPermissions();
    return;
  }

  if (opts.latitude === undefined || opts.longitude === undefined) {
    throw new Error('latitude and longitude are required when not clearing geolocation.');
  }

  await context.grantPermissions(['geolocation'], opts.origin ? { origin: opts.origin } : undefined);
  await context.setGeolocation({
    latitude: opts.latitude,
    longitude: opts.longitude,
    accuracy: opts.accuracy,
  });
}

/**
 * Set or clear HTTP credentials for the browser context.
 * Note: Playwright's `setHTTPCredentials()` is deprecated — prefer providing credentials
 * at context creation time. This function is retained for CDP-connected contexts where
 * context creation is not controlled by the library.
 */
export async function setHttpCredentialsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  username?: string;
  password?: string;
  clear?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  const context = page.context();

  if (opts.clear) {
    await context.setHTTPCredentials({ username: '', password: '' });
    return;
  }

  await context.setHTTPCredentials({
    username: opts.username ?? '',
    password: opts.password ?? '',
  });
}

export async function setLocaleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  locale: string;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setLocaleOverride', { locale: opts.locale });
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function setOfflineViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  offline: boolean;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.context().setOffline(opts.offline);
}

export async function setTimezoneViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timezoneId: string;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Emulation.setTimezoneOverride', { timezoneId: opts.timezoneId });
  } finally {
    await session.detach().catch(() => {});
  }
}
