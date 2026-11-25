import type { CDPSession, Locator, Page } from 'playwright-core';

import { raceWithAbort } from '../abort.js';
import { getPageEmulationState, runPageEmulationTransition } from '../page-emulation.js';
import { isHeadlessContext } from '../page-utils.js';

interface CaptureOptions {
  type: 'png' | 'jpeg';
  fullPage?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Keep the target rendering for the capture without focusing a headed browser. */
export async function withScreenshotRendering<T>(
  page: Page,
  signal: AbortSignal | undefined,
  capture: () => Promise<T>,
  renderingTimeoutMs?: number,
): Promise<T> {
  const renderDeadline = () =>
    signal ?? (renderingTimeoutMs === undefined ? undefined : AbortSignal.timeout(renderingTimeoutMs));
  let stageSignal = renderDeadline();
  stageSignal?.throwIfAborted();
  if (isHeadlessContext(page.context())) {
    await raceWithAbort(
      page.bringToFront().catch(() => undefined),
      stageSignal,
    );
    stageSignal?.throwIfAborted();
    return await capture();
  }

  // A one-pixel screencast keeps Chrome producing frames for a background tab.
  const pending = page
    .context()
    .newCDPSession(page)
    .catch(() => undefined);
  let session: CDPSession | undefined;
  let detached: Promise<void> | undefined;
  const detach = () => (detached ??= pending.then((cdp) => cdp?.detach()).catch(() => undefined));
  const onAbort = () => {
    void detach();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    session = await raceWithAbort(pending, stageSignal);
    stageSignal?.throwIfAborted();
    if (session) {
      const cdp = session;
      cdp.on('Page.screencastFrame', ({ sessionId }) => {
        void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
      });
      await raceWithAbort(
        cdp
          .send('Page.startScreencast', { format: 'jpeg', quality: 1, maxWidth: 1, maxHeight: 1 })
          .catch(() => undefined),
        stageSignal,
      );
    }
    stageSignal?.throwIfAborted();
    // The native screenshot can have its own page/context timeout. Only an
    // explicit caller deadline spans both the native capture and CDP cleanup.
    stageSignal = signal;
    return await capture();
  } finally {
    const cleanupSignal = stageSignal ?? renderDeadline();
    try {
      if (session && cleanupSignal?.aborted !== true) {
        await raceWithAbort(
          session.send('Page.stopScreencast').catch(() => undefined),
          cleanupSignal,
        );
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      const released = detach();
      if (cleanupSignal?.aborted !== true) await raceWithAbort(released, cleanupSignal);
    }
  }
}

/** Use the session that owns device metrics so capture does not reset mobile emulation. */
async function capturePageScreenshot(
  page: Page,
  options: CaptureOptions,
  signal: AbortSignal,
  locator?: Locator,
  deadline?: number,
): Promise<Buffer> {
  signal.throwIfAborted();
  const remaining = () => (deadline === undefined ? 0 : Math.max(1, deadline - Date.now()));
  const state = getPageEmulationState(page);
  const owner = state.metricsOwner;
  const element = await locator?.elementHandle({ timeout: remaining() });
  try {
    await element?.scrollIntoViewIfNeeded({ timeout: remaining(), signal });
    signal.throwIfAborted();
    if (!owner) {
      return await (element
        ? element.screenshot({ type: options.type, timeout: remaining() })
        : page.screenshot({ type: options.type, fullPage: Boolean(options.fullPage), timeout: remaining() }));
    }
    const box = element ? await element.boundingBox() : undefined;
    if (locator && (box === null || box === undefined || box.width === 0 || box.height === 0)) {
      throw new Error('Cannot take a screenshot of an element that is not visible or has no size');
    }
    const metrics = await owner.session.send('Page.getLayoutMetrics');
    const visual = metrics.cssVisualViewport;
    let clip = { ...metrics.cssContentSize, scale: 1 };
    if (box) {
      const x = Math.floor(box.x + visual.pageX);
      const y = Math.floor(box.y + visual.pageY);
      clip = {
        x,
        y,
        width: Math.ceil(box.x + visual.pageX + box.width) - x,
        height: Math.ceil(box.y + visual.pageY + box.height) - y,
        scale: 1,
      };
    } else if (options.fullPage !== true) {
      clip = {
        x: visual.pageX,
        y: visual.pageY,
        width: Math.ceil(owner.viewport.width / visual.scale),
        height: Math.ceil(owner.viewport.height / visual.scale),
        scale: visual.scale,
      };
    }
    const captureBeyondViewport =
      (options.fullPage === true || locator !== undefined) &&
      (clip.width > owner.viewport.width || clip.height > owner.viewport.height);
    signal.throwIfAborted();
    const result = await owner.session.send('Page.captureScreenshot', {
      format: options.type,
      clip,
      captureBeyondViewport,
    });
    return Buffer.from(result.data, 'base64');
  } finally {
    try {
      if (state.touch) {
        await state.touch.session.send('Emulation.setTouchEmulationEnabled', {
          enabled: state.touch.enabled,
          maxTouchPoints: state.touch.maxTouchPoints,
        });
      }
    } finally {
      await element?.dispose();
    }
  }
}

export async function captureScreenshotWithEmulation(
  page: Page,
  options: CaptureOptions,
  locator?: Locator,
): Promise<Buffer> {
  if (locator && options.fullPage === true) throw new Error('fullPage is not supported for element screenshots');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  signal.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : undefined;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort(new Error(`Screenshot via Playwright timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs)
      : undefined;
  try {
    return await runPageEmulationTransition(
      page,
      () =>
        withScreenshotRendering(page, signal, () => capturePageScreenshot(page, options, signal, locator, deadline)),
      signal,
    );
  } finally {
    clearTimeout(timer);
  }
}
