import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { captureScreenshotWithEmulation } from './screenshot-capture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function fixture() {
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn<(method: string, params?: unknown) => Promise<void>>().mockResolvedValue(undefined),
    detach: vi.fn(() => Promise.resolve()),
  });
  const context = { newCDPSession: vi.fn(() => Promise.resolve(cdp)) };
  const page = Object.assign(new EventEmitter(), {
    context: () => context,
    screenshot: vi.fn(() => Promise.resolve(Buffer.from('image'))),
    bringToFront: vi.fn(),
  });
  const capture = (signal?: AbortSignal) =>
    captureScreenshotWithEmulation(page as unknown as Page, { type: 'png', signal });
  return { cdp, context, page, capture };
}

describe('headed screenshot rendering', () => {
  it('starts and acknowledges the small screencast during capture, then stops it and detaches even on failure', async () => {
    const { cdp, page, capture } = fixture();
    const problem = new Error('image capture failed');
    page.screenshot.mockImplementationOnce(() => {
      expect(cdp.send).toHaveBeenCalledWith('Page.startScreencast', {
        format: 'jpeg',
        quality: 1,
        maxWidth: 1,
        maxHeight: 1,
      });
      cdp.emit('Page.screencastFrame', { sessionId: 23 });
      expect(cdp.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 23 });
      expect(cdp.detach).not.toHaveBeenCalled();
      return Promise.reject(problem);
    });
    await expect(capture()).rejects.toBe(problem);
    expect(cdp.send).toHaveBeenLastCalledWith('Page.stopScreencast');
    expect(cdp.detach).toHaveBeenCalledOnce();
    expect(page.bringToFront).not.toHaveBeenCalled();
    await expect(capture()).resolves.toEqual(Buffer.from('image'));
  });

  it('releases a cancelled session acquisition and detaches it when it eventually connects', async () => {
    const { cdp, context, page, capture } = fixture();
    const late = deferred<typeof cdp>();
    const entered = deferred<undefined>();
    context.newCDPSession.mockImplementationOnce(() => {
      entered.resolve(undefined);
      return late.promise;
    });
    const controller = new AbortController();
    const reason = new Error('cancelled acquisition');
    const interrupted = expect(capture(controller.signal)).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    await interrupted;
    expect(page.screenshot).not.toHaveBeenCalled();
    await expect(capture()).resolves.toEqual(Buffer.from('image'));
    late.resolve(cdp);
    await vi.waitFor(() => {
      expect(cdp.detach).toHaveBeenCalledTimes(2);
    });
    expect(page.screenshot).toHaveBeenCalledOnce();
  });

  it('detaches a stalled screencast command on abort and permits another capture', async () => {
    const { cdp, page, capture } = fixture();
    const started = deferred<undefined>();
    const stalled = deferred<undefined>();
    cdp.send.mockImplementationOnce(() => {
      started.resolve(undefined);
      return stalled.promise;
    });
    const controller = new AbortController();
    const reason = new Error('cancelled screencast');
    const interrupted = expect(capture(controller.signal)).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    await interrupted;
    expect(cdp.detach).toHaveBeenCalledOnce();
    expect(page.screenshot).not.toHaveBeenCalled();
    await expect(capture()).resolves.toEqual(Buffer.from('image'));
    stalled.resolve(undefined);
    expect(page.screenshot).toHaveBeenCalledOnce();
  });
});
