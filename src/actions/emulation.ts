import { devices } from 'playwright-core';

import { getPageForTargetId, ensurePageState, withPageScopedCdpClient } from '../connection.js';
import type { ColorScheme } from '../types.js';

// Matches iOS/Android defaults. Chromium's Emulation.setTouchEmulationEnabled
// defaults to 1 if unspecified; real phones report 5.
const TOUCH_MAX_POINTS = 5;

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

  // Apply all emulation settings via CDP in a single session for atomicity
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
        // Pass maxTouchPoints so `navigator.maxTouchPoints` reflects the emulated device.
        // Without this the renderer defaults to 1, leaving a `hasTouch && maxTouchPoints <= 1`
        // mismatch that bot-detection scripts flag as headless.
        await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: TOUCH_MAX_POINTS });
      }
    },
  });

  if (device.hasTouch) {
    // Belt-and-suspenders: also define `navigator.maxTouchPoints` on every new
    // document via init script. The CDP override above is sufficient for most
    // frames, but a page-scoped init script ensures the value is present in
    // any subsequent document (navigations, same-page reloads) without needing
    // to re-send the CDP command. Note: if the caller later switches to a
    // non-touch device on the same page, this init script persists — callers
    // who need to toggle touch mid-session should create a fresh page.
    await page
      .addInitScript((max: number) => {
        try {
          Object.defineProperty(Navigator.prototype, 'maxTouchPoints', {
            configurable: true,
            get: () => max,
          });
        } catch (e: unknown) {
          // Most likely: a prior init script already defined this property
          // non-configurably. Logged to the browser console for debugging.
          try {
            console.warn('[browserclaw] maxTouchPoints override failed:', e instanceof Error ? e.message : String(e));
          } catch {
            /* page may have replaced console — nothing we can do */
          }
        }
      }, TOUCH_MAX_POINTS)
      .catch((err: unknown) => {
        console.warn(
          `[browserclaw] addInitScript(maxTouchPoints) failed: ${err instanceof Error ? err.message : String(err)} (CDP-level override above still applies to the current frame)`,
        );
      });
  }

  // Also set viewport at the Playwright level for proper layout
  if (device.viewport !== null) {
    await page.setViewportSize({
      width: device.viewport.width,
      height: device.viewport.height,
    });
  }
}

export async function setExtraHTTPHeadersViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  headers: Record<string, string>;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  // Use CDP Network.setExtraHTTPHeaders for page-scoped headers instead of
  // context-level setExtraHTTPHeaders which affects all tabs
  await withPageScopedCdpClient({
    cdpUrl: opts.cdpUrl,
    page,
    targetId: opts.targetId,
    fn: async (send) => {
      await send('Network.setExtraHTTPHeaders', { headers: opts.headers });
    },
  });
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
    await context.clearPermissions().catch((err: unknown) => {
      console.warn(`[browserclaw] clearPermissions failed: ${err instanceof Error ? err.message : String(err)}`);
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
