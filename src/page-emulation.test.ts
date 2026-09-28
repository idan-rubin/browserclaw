import { EventEmitter } from 'node:events';

import type { CDPSession, Locator, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setDeviceViaPlaywright, setLocaleViaPlaywright, setTimezoneViaPlaywright } from './actions/emulation.js';
import { resizeViewportViaPlaywright } from './actions/navigation.js';
import { captureScreenshotWithEmulation } from './capture/screenshot-capture.js';
import { getPageForTargetId } from './connection.js';
import {
  getPageEmulationSession,
  getPageEmulationState,
  runPageEmulationTransition,
  setViewportSizeOnPage,
} from './page-emulation.js';

vi.mock('./connection.js', () => ({
  getPageForTargetId: vi.fn(),
  ensurePageState: vi.fn(),
  withPageScopedCdpClient: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const commands: string[] = [];
  const send = vi.fn((method: string) => {
    commands.push(method);
    if (method === 'Page.getLayoutMetrics')
      return Promise.resolve({
        cssVisualViewport: { pageX: 4, pageY: 12, scale: 2 },
        cssContentSize: { x: 0, y: 0, width: 800, height: 1400 },
      });
    if (method === 'Page.captureScreenshot') return Promise.resolve({ data: Buffer.from('image').toString('base64') });
    return Promise.resolve({});
  });
  const detach = vi.fn(() => Promise.resolve());
  const session = { send, detach } as unknown as CDPSession;
  const attach = vi.fn(() => Promise.resolve(session));
  const events = new EventEmitter();
  const viewport = vi.fn(() => {
    commands.push('viewport');
    return Promise.resolve();
  });
  const screenshot = vi.fn(() => Promise.resolve(Buffer.from('plain')));
  const page = Object.assign(events, {
    context: () => ({ newCDPSession: attach }),
    setViewportSize: viewport,
    addInitScript: vi.fn(() => Promise.resolve()),
    screenshot,
  }) as unknown as Page;
  vi.mocked(getPageForTargetId).mockResolvedValue(page);
  return { page, events, session, send, detach, attach, viewport, screenshot, commands };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('page-owned emulation', () => {
  it('rejects cancelled device and resize requests before changing the page', async () => {
    const f = fixture();
    const reason = new Error('emulation cancelled');
    const signal = AbortSignal.abort(reason);
    await expect(setDeviceViaPlaywright({ cdpUrl: 'test', name: 'iPhone 13', signal })).rejects.toBe(reason);
    await expect(resizeViewportViaPlaywright({ cdpUrl: 'test', width: 900, height: 700, signal })).rejects.toBe(reason);
    expect(f.viewport).not.toHaveBeenCalled();
    expect(f.attach).not.toHaveBeenCalled();
  });

  it('retains one session across device, locale and timezone changes and detaches on close', async () => {
    const f = fixture();
    await setDeviceViaPlaywright({ cdpUrl: 'http://localhost:9222', name: 'iPhone 13' });
    await setLocaleViaPlaywright({ cdpUrl: 'http://localhost:9222', locale: 'en-GB' });
    await setTimezoneViaPlaywright({ cdpUrl: 'http://localhost:9222', timezoneId: 'Europe/London' });
    expect(f.attach).toHaveBeenCalledTimes(1);
    expect(f.detach).not.toHaveBeenCalled();
    expect(f.commands.indexOf('viewport')).toBeLessThan(f.commands.indexOf('Emulation.setDeviceMetricsOverride'));
    expect(f.send).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        screenWidth: 390,
        screenHeight: 844,
        screenOrientation: { angle: 0, type: 'portraitPrimary' },
      }),
    );
    f.events.emit('close');
    await Promise.resolve();
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it('explicitly disables CDP touch when changing from a phone to a desktop', async () => {
    const f = fixture();
    await setDeviceViaPlaywright({ cdpUrl: 'http://localhost:9222', name: 'iPhone 13' });
    await setDeviceViaPlaywright({ cdpUrl: 'http://localhost:9222', name: 'Desktop Chrome' });
    expect(f.send).toHaveBeenLastCalledWith('Emulation.setTouchEmulationEnabled', {
      enabled: false,
      maxTouchPoints: 5,
    });
  });

  it('clears device metrics only when resizing away from their owning viewport', async () => {
    const f = fixture();
    const state = getPageEmulationState(f.page);
    state.metricsOwner = { session: f.session, viewport: { width: 390, height: 664 } };
    await setViewportSizeOnPage(f.page, { width: 390, height: 664 });
    expect(f.send).not.toHaveBeenCalled();
    await setViewportSizeOnPage(f.page, { width: 900, height: 700 });
    expect(f.commands).toEqual(['viewport', 'Emulation.clearDeviceMetricsOverride', 'viewport']);
    expect(state.metricsOwner).toBeUndefined();
  });

  it('retries failed attachment and cleans up an attachment that resolves after page close', async () => {
    const f = fixture();
    f.attach.mockRejectedValueOnce(new Error('attach failed'));
    await expect(getPageEmulationSession(f.page)).rejects.toThrow('attach failed');
    const attached = deferred<CDPSession>();
    f.attach.mockReturnValueOnce(attached.promise);
    const pending = getPageEmulationSession(f.page);
    f.events.emit('close');
    attached.resolve(f.session);
    await pending;
    await Promise.resolve();
    expect(f.detach).toHaveBeenCalledOnce();
  });

  it('serializes operations and refuses overlap while cancelled work is still running', async () => {
    const f = fixture();
    const work = deferred<undefined>();
    const controller = new AbortController();
    const first = runPageEmulationTransition(f.page, () => work.promise, controller.signal);
    const rejected = expect(first).rejects.toThrow('cancelled');
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    await rejected;
    const next = vi.fn(() => Promise.resolve(2));
    await expect(runPageEmulationTransition(f.page, next)).rejects.toThrow('still running');
    expect(next).not.toHaveBeenCalled();
    work.resolve(undefined);
    await getPageEmulationState(f.page).transitionTail;
    await expect(runPageEmulationTransition(f.page, next)).resolves.toBe(2);
  });
});

describe('emulation-safe screenshot', () => {
  it('captures via the metrics-owning session with visual viewport scale and restores touch', async () => {
    const f = fixture();
    const state = getPageEmulationState(f.page);
    state.metricsOwner = { session: f.session, viewport: { width: 390, height: 664 } };
    state.touch = { session: f.session, enabled: true, maxTouchPoints: 5 };
    expect(await captureScreenshotWithEmulation(f.page, { type: 'png' })).toEqual(Buffer.from('image'));
    expect(f.send).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 4, y: 12, width: 195, height: 332, scale: 2 },
      captureBeyondViewport: false,
    });
    expect(f.send).toHaveBeenLastCalledWith('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    expect(f.screenshot).not.toHaveBeenCalled();
  });

  it('uses native Playwright capture when no device metrics are owned', async () => {
    const f = fixture();
    expect(await captureScreenshotWithEmulation(f.page, { type: 'jpeg', fullPage: true })).toEqual(
      Buffer.from('plain'),
    );
    expect(f.screenshot).toHaveBeenCalledOnce();
    const timeout = (f.screenshot.mock.calls[0] as unknown as [{ timeout: number }])[0].timeout;
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(20_000);
    expect(f.attach).not.toHaveBeenCalled();
  });

  it('keeps a timed-out capture fenced until its underlying work settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const work = deferred<ReturnType<typeof Buffer.from>>();
    f.screenshot.mockReturnValueOnce(work.promise);
    const capture = captureScreenshotWithEmulation(f.page, { type: 'png', timeoutMs: 25 });
    const rejected = expect(capture).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    await expect(captureScreenshotWithEmulation(f.page, { type: 'png' })).rejects.toThrow('still running');
    work.resolve(Buffer.from('late'));
    await getPageEmulationState(f.page).transitionTail;
    await expect(captureScreenshotWithEmulation(f.page, { type: 'png' })).resolves.toEqual(Buffer.from('plain'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels element preparation before it can start a late screenshot', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const screenshot = vi.fn();
    const dispose = vi.fn(() => Promise.resolve());
    const scrollIntoViewIfNeeded = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
            },
            { once: true },
          );
        }),
    );
    const locator = {
      elementHandle: () => Promise.resolve({ scrollIntoViewIfNeeded, screenshot, dispose }),
    } as unknown as Locator;
    const capture = captureScreenshotWithEmulation(f.page, { type: 'png', timeoutMs: 25 }, locator);
    const rejected = expect(capture).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    await getPageEmulationState(f.page).transitionTail;
    const preparation = scrollIntoViewIfNeeded.mock.calls[0][0];
    expect(preparation.signal).toBeInstanceOf(AbortSignal);
    expect(preparation.signal.aborted).toBe(true);
    expect(screenshot).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(captureScreenshotWithEmulation(f.page, { type: 'png' })).resolves.toEqual(Buffer.from('plain'));
  });

  it('honors caller cancellation and keeps late native work fenced until it settles', async () => {
    const f = fixture();
    const reason = new Error('caller cancelled screenshot');
    await expect(
      captureScreenshotWithEmulation(f.page, {
        type: 'png',
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
    expect(f.screenshot).not.toHaveBeenCalled();
    const work = deferred<ReturnType<typeof Buffer.from>>();
    f.screenshot.mockReturnValueOnce(work.promise);
    const controller = new AbortController();
    const capture = captureScreenshotWithEmulation(f.page, { type: 'png', signal: controller.signal });
    const rejected = expect(capture).rejects.toBe(reason);
    await vi.waitFor(() => {
      expect(f.screenshot).toHaveBeenCalledOnce();
    });
    controller.abort(reason);
    await rejected;
    await expect(captureScreenshotWithEmulation(f.page, { type: 'png' })).rejects.toThrow('still running');
    work.resolve(Buffer.from('late'));
    await getPageEmulationState(f.page).transitionTail;
    await expect(captureScreenshotWithEmulation(f.page, { type: 'png' })).resolves.toEqual(Buffer.from('plain'));
  });
});
