import type { Locator, Page } from 'playwright-core';

import { getPageEmulationState, runPageEmulationTransition } from '../page-emulation.js';

interface CaptureOptions {
  type: 'png' | 'jpeg';
  fullPage?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Use the session that owns device metrics so capture does not reset mobile emulation. */
async function capturePageScreenshot(
  page: Page,
  options: CaptureOptions,
  signal: AbortSignal,
  locator?: Locator,
): Promise<Buffer> {
  signal.throwIfAborted();
  const state = getPageEmulationState(page);
  const owner = state.metricsOwner;
  const element = await locator?.elementHandle({ timeout: options.timeoutMs ?? 20_000 });
  try {
    await element?.scrollIntoViewIfNeeded({ timeout: options.timeoutMs ?? 20_000, signal });
    signal.throwIfAborted();
    if (!owner) {
      return await (element
        ? element.screenshot({ type: options.type, timeout: 0 })
        : page.screenshot({ type: options.type, fullPage: Boolean(options.fullPage), timeout: 0 }));
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
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          controller.abort(new Error(`Screenshot via Playwright timed out after ${String(timeoutMs)}ms`));
        }, timeoutMs)
      : undefined;
  try {
    return await runPageEmulationTransition(page, () => capturePageScreenshot(page, options, signal, locator), signal);
  } finally {
    clearTimeout(timer);
  }
}
