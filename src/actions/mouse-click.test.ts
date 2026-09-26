import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';

import { mouseClickViaPlaywright } from './interaction.js';
import type * as NavigationModule from './navigation.js';

const mocks = vi.hoisted(() => ({ page: vi.fn(), click: vi.fn(), guard: vi.fn() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionModule>()),
  getRestoredPageForTarget: mocks.page,
}));
vi.mock('./navigation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof NavigationModule>()),
  assertInteractionNavigationCompletedSafely: mocks.guard,
}));

describe('coordinate click cancellation', () => {
  const options = { cdpUrl: 'local', targetId: 'tab', x: 10, y: 20, ssrfPolicy: {} };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.page.mockResolvedValue({ url: () => 'about:blank', mouse: { click: mocks.click } });
    mocks.click.mockResolvedValue(undefined);
    mocks.guard.mockImplementation((opts: { action: () => Promise<void> }) => opts.action());
  });

  it('rejects pre-abort before acquiring the page, with a normal option-preserving control', async () => {
    const reason = new Error('already cancelled');
    await expect(mouseClickViaPlaywright({ ...options, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(mocks.page).not.toHaveBeenCalled();
    expect(mocks.click).not.toHaveBeenCalled();
    await mouseClickViaPlaywright({ ...options, button: 'right', clickCount: 3, delayMs: 17 });
    expect(mocks.click).toHaveBeenCalledWith(10, 20, { button: 'right', clickCount: 3, delay: 17 });
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining(options));
  });

  it('rejects abort during page acquisition without dispatching mouse input', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel acquisition');
    mocks.page.mockImplementationOnce(() => {
      controller.abort(reason);
      return Promise.resolve({ url: () => 'about:blank', mouse: { click: mocks.click } });
    });
    await expect(mouseClickViaPlaywright({ ...options, signal: controller.signal })).rejects.toBe(reason);
    expect(mocks.click).not.toHaveBeenCalled();
    expect(mocks.guard).not.toHaveBeenCalled();
  });

  it('returns on abort but retains the request guard until dispatched input settles', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel click');
    let settle!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mocks.click.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
          entered();
        }),
    );
    let guardActive = false;
    mocks.guard.mockImplementation(async (opts: { action: () => Promise<void>; abortPromise: Promise<never> }) => {
      guardActive = true;
      const guarded = opts.action().finally(() => {
        guardActive = false;
      });
      await Promise.race([guarded, opts.abortPromise]);
    });
    const rejected = expect(mouseClickViaPlaywright({ ...options, signal: controller.signal })).rejects.toBe(reason);
    await started;
    controller.abort(reason);
    await rejected;
    expect(guardActive).toBe(true);
    settle();
    await vi.waitFor(() => {
      expect(guardActive).toBe(false);
    });
    await mouseClickViaPlaywright(options);
    expect(mocks.click).toHaveBeenCalledTimes(2);
  });
});
