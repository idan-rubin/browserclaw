import { devices } from 'playwright-core';

import { getPageForTargetId, ensurePageState, withPageScopedCdpClient } from '../connection.js';
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

export async function setDeviceViaPlaywright(opts: { cdpUrl: string; targetId?: string; name: string }): Promise<void> {
  const name = opts.name.trim();
  if (!name) throw new Error('device name is required');

  const device:
    | {
        viewport: { width: number; height: number } | null;
        userAgent: string;
        deviceScaleFactor: number;
        isMobile: boolean;
        hasTouch: boolean;
        defaultBrowserType: string;
        locale?: string;
      }
    | undefined = devices[name] as ((typeof devices)[string] & { locale?: string }) | undefined;
  if (device === undefined) {
    throw new Error(`Unknown device "${name}".`);
  }

  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  if (device.viewport !== null) {
    await page.setViewportSize({
      width: device.viewport.width,
      height: device.viewport.height,
    });
  }

  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      const locale = device.locale;
      if (device.userAgent !== '' || (locale !== undefined && locale !== '')) {
        await send('Emulation.setUserAgentOverride', {
          userAgent: device.userAgent,
          acceptLanguage: locale,
        });
      }
      if (device.viewport !== null) {
        await send('Emulation.setDeviceMetricsOverride', {
          mobile: device.isMobile,
          width: device.viewport.width,
          height: device.viewport.height,
          deviceScaleFactor: device.deviceScaleFactor,
          screenWidth: device.viewport.width,
          screenHeight: device.viewport.height,
        });
      }
      if (device.hasTouch) {
        await send('Emulation.setTouchEmulationEnabled', { enabled: true });
      }
    },
  });
}

export async function setExtraHTTPHeadersViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  headers: Record<string, string>;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  await page.context().setExtraHTTPHeaders(opts.headers);
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

  if (opts.clear === true) {
    await context.setGeolocation(null);
    await context.clearPermissions().catch(() => {
      /* intentional no-op */
    });
    return;
  }

  if (typeof opts.latitude !== 'number' || typeof opts.longitude !== 'number') {
    throw new Error('latitude and longitude are required (or set clear=true)');
  }

  await context.setGeolocation({
    latitude: opts.latitude,
    longitude: opts.longitude,
    accuracy: typeof opts.accuracy === 'number' ? opts.accuracy : undefined,
  });

  const origin =
    (opts.origin !== undefined && opts.origin !== '' ? opts.origin.trim() : '') ||
    (() => {
      try {
        return new URL(page.url()).origin;
      } catch {
        return '';
      }
    })();
  if (origin !== '')
    await context.grantPermissions(['geolocation'], { origin }).catch(() => {
      /* intentional no-op */
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

  if (opts.clear === true) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    await page.context().setHTTPCredentials(null);
    return;
  }

  const username = opts.username ?? '';
  const password = opts.password ?? '';
  if (!username) throw new Error('username is required (or set clear=true)');

  // eslint-disable-next-line @typescript-eslint/no-deprecated
  await page.context().setHTTPCredentials({ username, password });
}

export async function setLocaleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  locale: string;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const locale = opts.locale.trim();
  if (!locale) throw new Error('locale is required');

  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      try {
        await send('Emulation.setLocaleOverride', { locale });
      } catch (err) {
        if (String(err).includes('Another locale override is already in effect')) return;
        throw err;
      }
    },
  });
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

  const timezoneId = opts.timezoneId.trim();
  if (!timezoneId) throw new Error('timezoneId is required');

  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      try {
        await send('Emulation.setTimezoneOverride', { timezoneId });
      } catch (err) {
        const msg = String(err);
        if (msg.includes('Timezone override is already in effect')) return;
        if (msg.includes('Invalid timezone')) throw new Error(`Invalid timezone ID: ${timezoneId}`, { cause: err });
        throw err;
      }
    },
  });
}
