import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';
import { InvalidBrowserNavigationUrlError } from '../security.js';

import { batchViaPlaywright } from './batch.js';
import type * as InteractionModule from './interaction.js';

const mocks = vi.hoisted(() => ({ getPage: vi.fn(), click: vi.fn(), mouseClick: vi.fn() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionModule>()),
  getPageForTargetId: mocks.getPage,
}));
vi.mock('./interaction.js', async (importOriginal) => ({
  ...(await importOriginal<typeof InteractionModule>()),
  clickViaPlaywright: mocks.click,
  mouseClickViaPlaywright: mocks.mouseClick,
}));

describe('batch document boundaries', () => {
  let events: EventEmitter;
  let mainFrame: object;
  let closed: boolean;
  beforeEach(() => {
    vi.clearAllMocks();
    events = new EventEmitter();
    mainFrame = {};
    closed = false;
    mocks.getPage.mockResolvedValue(
      Object.assign(events, {
        mainFrame: () => mainFrame,
        url: () => 'https://example.com/same-url',
        isClosed: () => closed,
      }) as unknown as Page,
    );
    mocks.click.mockResolvedValue(undefined);
    mocks.mouseClick.mockResolvedValue(undefined);
  });
  const actions = [
    { kind: 'click' as const, ref: 'e1' },
    { kind: 'click' as const, ref: 'e2' },
  ];
  const options = { cdpUrl: 'http://localhost:9222', actions };

  it('dispatches coordinate clicks with default/explicit targets and composed cancellation', async () => {
    const global = new AbortController();
    const local = new AbortController();
    const ssrfPolicy = {};
    await expect(
      batchViaPlaywright({
        cdpUrl: options.cdpUrl,
        targetId: 'default-tab',
        ssrfPolicy,
        signal: global.signal,
        actions: [
          { kind: 'mouseClick', x: 1, y: 2, clickCount: 3, delayMs: 17 },
          { kind: 'mouseClick', x: 3, y: 4, targetId: 'explicit-tab', button: 'right', signal: local.signal },
        ],
      }),
    ).resolves.toEqual({ results: [{ ok: true }, { ok: true }] });
    expect(mocks.mouseClick).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cdpUrl: options.cdpUrl,
        targetId: 'default-tab',
        ssrfPolicy,
        signal: global.signal,
        x: 1,
        y: 2,
        clickCount: 3,
        delayMs: 17,
      }),
    );
    expect(mocks.mouseClick).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        targetId: 'explicit-tab',
        x: 3,
        y: 4,
        button: 'right',
      }),
    );
    const passed = mocks.mouseClick.mock.calls[1][0] as { signal: AbortSignal };
    expect(passed.signal.aborted).toBe(false);
    global.abort(new Error('stop batch'));
    expect(passed.signal.aborted).toBe(true);
  });

  it('never dispatches coordinate input for a pre-aborted batch', async () => {
    const reason = new Error('stop coordinates');
    await expect(
      batchViaPlaywright({
        cdpUrl: options.cdpUrl,
        signal: AbortSignal.abort(reason),
        actions: [{ kind: 'mouseClick', x: 1, y: 2 }],
      }),
    ).rejects.toBe(reason);
    expect(mocks.mouseClick).not.toHaveBeenCalled();
  });

  it('stops after same-URL main-frame navigation and cleans its observer', async () => {
    mocks.click.mockImplementationOnce(() => {
      events.emit('framenavigated', mainFrame);
      return Promise.resolve();
    });
    expect(await batchViaPlaywright(options)).toEqual({ results: [{ ok: true }] });
    expect(mocks.click).toHaveBeenCalledOnce();
    expect(events.listenerCount('framenavigated')).toBe(0);
  });
  it('continues normally after unrelated subframe navigation', async () => {
    mocks.click.mockImplementationOnce(() => {
      events.emit('framenavigated', {});
      return Promise.resolve();
    });
    expect(await batchViaPlaywright(options)).toEqual({ results: [{ ok: true }, { ok: true }] });
    expect(mocks.click).toHaveBeenCalledTimes(2);
  });
  it('stops after page closure regardless of stopOnError', async () => {
    mocks.click.mockImplementationOnce(() => {
      closed = true;
      return Promise.resolve();
    });
    expect(await batchViaPlaywright({ ...options, stopOnError: false })).toEqual({ results: [{ ok: true }] });
    expect(mocks.click).toHaveBeenCalledOnce();
  });
  it('surfaces nested failures instead of reporting nested success', async () => {
    mocks.click.mockRejectedValueOnce(new Error('nested failure'));
    expect(await batchViaPlaywright({ ...options, actions: [{ kind: 'batch', actions }] })).toEqual({
      results: [{ ok: false, error: 'nested failure' }],
    });
  });
  it('does not swallow a policy denial even when stopOnError is false', async () => {
    const denied = new InvalidBrowserNavigationUrlError('blocked navigation');
    mocks.click.mockRejectedValueOnce(denied);
    await expect(batchViaPlaywright({ ...options, stopOnError: false })).rejects.toBe(denied);
    expect(mocks.click).toHaveBeenCalledOnce();
    expect(events.listenerCount('framenavigated')).toBe(0);
  });
  it('still continues after ordinary errors when requested', async () => {
    mocks.click.mockRejectedValueOnce(new Error('ordinary error'));
    expect(await batchViaPlaywright({ ...options, stopOnError: false })).toEqual({
      results: [{ ok: false, error: 'ordinary error' }, { ok: true }],
    });
  });

  it('rejects pre-aborted batches before acquiring a page', async () => {
    const reason = new Error('batch cancelled');
    await expect(batchViaPlaywright({ ...options, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(mocks.getPage).not.toHaveBeenCalled();
    expect(mocks.click).not.toHaveBeenCalled();
  });

  it('forwards cancellation into nested actions and never dispatches the next action', async () => {
    const controller = new AbortController();
    const reason = new Error('batch cancelled');
    mocks.click.mockImplementationOnce((opts: { signal: AbortSignal }) => {
      expect(opts.signal).toBe(controller.signal);
      controller.abort(reason);
      return Promise.resolve();
    });
    await expect(
      batchViaPlaywright({
        ...options,
        stopOnError: false,
        signal: controller.signal,
        actions: [{ kind: 'batch', actions }],
      }),
    ).resolves.toEqual({ results: [{ ok: false, error: reason.message }] });
    expect(mocks.click).toHaveBeenCalledOnce();
    expect(events.listenerCount('framenavigated')).toBe(0);
  });
});
