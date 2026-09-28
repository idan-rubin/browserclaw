import type { Locator, Page } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';
import { ensurePageState } from '../page-utils.js';

import { clickViaPlaywright, fillFormViaPlaywright, typeViaPlaywright } from './interaction.js';
import type * as NavigationModule from './navigation.js';

const mocks = vi.hoisted(() => ({
  getPage: vi.fn(),
  disconnect: vi.fn(),
  locator: vi.fn(),
}));

vi.mock('../connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    getRestoredPageForTarget: mocks.getPage,
    refLocator: mocks.locator,
    forceDisconnectPlaywrightConnection: mocks.disconnect,
  };
});
vi.mock('./navigation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof NavigationModule>();
  return {
    ...actual,
    assertInteractionNavigationCompletedSafely: (opts: { action: () => Promise<void> }) => opts.action(),
  };
});

const cdpUrl = 'http://localhost:9222';

describe('native action cancellation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function setLocator(locator: Partial<Locator>) {
    mocks.locator.mockReturnValue(locator);
    mocks.getPage.mockResolvedValue({
      url: () => 'about:blank',
      locator: () => locator,
    } as unknown as Page);
  }

  it('cancels the actual click signal without disconnecting the browser', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel this action');
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const click = vi.fn<Locator['click']>(
      (options) =>
        new Promise((resolve, reject) => {
          expect(options?.signal).toBe(controller.signal);
          options?.signal?.addEventListener(
            'abort',
            () => {
              reject(reason);
            },
            { once: true },
          );
          entered();
        }),
    );
    setLocator({ click });
    const action = clickViaPlaywright({ cdpUrl, selector: '#button', signal: controller.signal });
    const rejected = expect(action).rejects.toBe(reason);
    await started;
    controller.abort(reason);
    await rejected;
    expect(mocks.disconnect).not.toHaveBeenCalled();

    // A subsequent action still uses the same page/connection successfully.
    click.mockResolvedValue(undefined);
    await clickViaPlaywright({ cdpUrl, selector: '#other' });
    expect(click).toHaveBeenCalledTimes(2);
  });

  it.each(['before click', 'after click'])('cancels a stalled checked-state read %s', async (stage) => {
    let release!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const evaluate = vi.fn<Locator['evaluate']>().mockImplementation(() => {
      entered();
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    if (stage === 'after click') evaluate.mockResolvedValueOnce('false');
    const click = vi.fn<Locator['click']>().mockResolvedValue(undefined);
    setLocator({ evaluate: evaluate as Locator['evaluate'], click });
    const page = { url: () => 'about:blank', on: vi.fn() } as unknown as Page;
    ensurePageState(page).roleRefs = { e1: { role: 'checkbox', name: 'Check' } };
    mocks.getPage.mockResolvedValue(page);
    const controller = new AbortController();
    const reason = new Error('cancel checked read');
    const settled = vi.fn();
    const action = clickViaPlaywright({ cdpUrl, ref: 'e1', signal: controller.signal });
    void action.then(settled, settled);
    try {
      await started;
      controller.abort(reason);
      await vi.waitFor(
        () => {
          expect(settled).toHaveBeenCalledWith(reason);
        },
        { timeout: 100 },
      );
    } finally {
      release('false');
      await action.catch(() => undefined);
    }
    expect(click).toHaveBeenCalledTimes(stage === 'after click' ? 1 : 0);
  });

  it('never dispatches a pre-aborted click', async () => {
    const click = vi.fn<Locator['click']>();
    setLocator({ click });
    const reason = new Error('already cancelled');
    await expect(clickViaPlaywright({ cdpUrl, selector: '#button', signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    expect(click).not.toHaveBeenCalled();
    expect(mocks.disconnect).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'unrelated abort', 'matching abort'] as const)(
    'preserves the native error unless cancellation caused it: %s',
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      const nativeError = new Error('native operation failed', {
        cause: kind === 'matching abort' ? reason : new Error('unrelated cause'),
      });
      if (kind !== 'ordinary') nativeError.name = 'AbortError';
      setLocator({
        click: vi.fn<Locator['click']>(() => {
          controller.abort(reason);
          return Promise.reject(nativeError);
        }),
      });
      await expect(clickViaPlaywright({ cdpUrl, selector: '#button', signal: controller.signal })).rejects.toBe(
        kind === 'matching abort' ? reason : nativeError,
      );
    },
  );

  it('does not submit after typing is cancelled, with a completing control', async () => {
    const controller = new AbortController();
    const reason = new Error('stop before submit');
    const fill = vi.fn<Locator['fill']>(() => {
      controller.abort(reason);
      return Promise.resolve();
    });
    const press = vi.fn<Locator['press']>().mockResolvedValue(undefined);
    setLocator({ fill, press });
    await expect(
      typeViaPlaywright({ cdpUrl, ref: 'e1', text: 'hello', submit: true, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(press).not.toHaveBeenCalled();
    fill.mockResolvedValue(undefined);
    await typeViaPlaywright({ cdpUrl, ref: 'e1', text: 'hello', submit: true });
    expect(press).toHaveBeenCalledOnce();
  });

  it('does not run the checked fallback or later fields after cancellation', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel checked action');
    const setChecked = vi.fn<Locator['setChecked']>(() => {
      controller.abort(reason);
      return Promise.reject(reason);
    });
    const evaluate = vi.fn();
    const fill = vi.fn<Locator['fill']>();
    setLocator({ setChecked, evaluate, fill });
    await expect(
      fillFormViaPlaywright({
        cdpUrl,
        signal: controller.signal,
        fields: [
          { ref: 'e1', type: 'checkbox', value: true },
          { ref: 'e2', value: 'not written' },
        ],
      }),
    ).rejects.toBe(reason);
    expect(evaluate).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
  });

  it.each(['ordinary', 'matching abort'] as const)(
    'retains fill error semantics during cancellation: %s',
    async (kind) => {
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      const error = new Error('native fill failed', { cause: reason });
      if (kind === 'matching abort') error.name = 'AbortError';
      setLocator({
        fill: vi.fn<Locator['fill']>(() => {
          controller.abort(reason);
          return Promise.reject(error);
        }),
      });
      const result = fillFormViaPlaywright({
        cdpUrl,
        signal: controller.signal,
        fields: [{ ref: 'e1', value: 'value' }],
      });
      if (kind === 'matching abort') await expect(result).rejects.toBe(reason);
      else await expect(result).rejects.toThrow('native fill failed');
    },
  );
});
