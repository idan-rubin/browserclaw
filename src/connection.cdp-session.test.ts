import type { CDPSession, Frame, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withPlaywrightPageCdpSession } from './connection.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pageWithSession(attach: (target: Page | Frame) => Promise<CDPSession>): Page {
  return { context: () => ({ newCDPSession: attach }) } as unknown as Page;
}

describe('bounded page CDP sessions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('detaches a session that arrives after the deadline without invoking the callback', async () => {
    vi.useFakeTimers();
    const attached = deferred<CDPSession>();
    const detach = vi.fn().mockResolvedValue(undefined);
    const callback = vi.fn();
    const operation = withPlaywrightPageCdpSession(
      pageWithSession(() => attached.promise),
      callback,
      20,
    );
    const rejected = expect(operation).rejects.toThrow('Page CDP operation timed out');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    attached.resolve({ detach } as unknown as CDPSession);
    await vi.advanceTimersByTimeAsync(0);
    expect(detach).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it('bounds a hung callback and starts detach exactly once', async () => {
    vi.useFakeTimers();
    const callback = deferred<string>();
    const detach = vi.fn().mockResolvedValue(undefined);
    const session = { detach } as unknown as CDPSession;
    const operation = withPlaywrightPageCdpSession(
      pageWithSession(() => Promise.resolve(session)),
      () => callback.promise,
      20,
    );
    const rejected = expect(operation).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(detach).toHaveBeenCalledOnce();
    callback.resolve('late');
    await vi.advanceTimersByTimeAsync(0);
    expect(detach).toHaveBeenCalledOnce();
  });

  it('bounds detach as part of the same whole-operation deadline', async () => {
    vi.useFakeTimers();
    const detached = deferred<undefined>();
    const detach = vi.fn(() => detached.promise);
    const session = { detach } as unknown as CDPSession;
    const operation = withPlaywrightPageCdpSession(
      pageWithSession(() => Promise.resolve(session)),
      () => Promise.resolve('ok'),
      20,
    );
    const rejected = expect(operation).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(detach).toHaveBeenCalledOnce();
    detached.resolve(undefined);
  });

  it('control: returns successful results and detaches before resolving', async () => {
    const detach = vi.fn().mockResolvedValue(undefined);
    const session = { detach } as unknown as CDPSession;
    await expect(
      withPlaywrightPageCdpSession(
        pageWithSession(() => Promise.resolve(session)),
        () => Promise.resolve(42),
      ),
    ).resolves.toBe(42);
    expect(detach).toHaveBeenCalledOnce();
  });

  it('climbs same-process frame owners, then attaches to the page', async () => {
    const parent = { parentFrame: () => null } as unknown as Frame;
    const frame = { parentFrame: () => parent } as unknown as Frame;
    const detach = vi.fn().mockResolvedValue(undefined);
    const session = { detach } as unknown as CDPSession;
    const attach = vi
      .fn<(target: Page | Frame) => Promise<CDPSession>>()
      .mockRejectedValueOnce(new Error('This frame does not have a separate CDP session'))
      .mockRejectedValueOnce(new Error('This frame does not have a separate CDP session'))
      .mockResolvedValueOnce(session);
    const page = pageWithSession(attach);
    await expect(withPlaywrightPageCdpSession(page, () => Promise.resolve(42), 100, frame)).resolves.toBe(42);
    expect(attach.mock.calls.map((call) => call[0])).toEqual([frame, parent, page]);
    expect(detach).toHaveBeenCalledOnce();
  });

  it('control: does not retry unrelated frame attachment failures', async () => {
    const frame = { parentFrame: vi.fn() } as unknown as Frame;
    const attach = vi.fn().mockRejectedValue(new Error('Target closed'));
    await expect(
      withPlaywrightPageCdpSession(pageWithSession(attach), () => Promise.resolve(42), 100, frame),
    ).rejects.toThrow('Target closed');
    expect(attach).toHaveBeenCalledOnce();
  });
});
