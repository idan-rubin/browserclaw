import { beforeEach, describe, expect, it, vi } from 'vitest';

import { insertTextViaPlaywright, pressKeyViaPlaywright } from './keyboard.js';

const mocks = vi.hoisted(() => ({ getPage: vi.fn(), guard: vi.fn(), insert: vi.fn() }));
vi.mock('../connection.js', () => ({ getPageForTargetId: mocks.getPage, ensurePageState: vi.fn() }));
vi.mock('./navigation.js', () => ({ assertInteractionNavigationCompletedSafely: mocks.guard }));

describe('insert focused text', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getPage.mockResolvedValue({ url: () => 'https://example.test/', keyboard: { insertText: mocks.insert } });
    mocks.guard.mockImplementation((opts: { action: () => Promise<void> }) => opts.action());
    mocks.insert.mockResolvedValue(undefined);
  });
  it('pastes through the navigation guard with the caller policy and CDP URL', async () => {
    const options = { cdpUrl: 'http://localhost:9222', targetId: 'tab', text: 'pasted text', ssrfPolicy: {} };
    await insertTextViaPlaywright(options);
    expect(mocks.insert).toHaveBeenCalledWith('pasted text');
    expect(mocks.guard).toHaveBeenCalledWith(expect.objectContaining(options));
  });
  it('reports how to recover when the focused control cannot accept text', async () => {
    mocks.insert.mockRejectedValue(new Error('protocol error'));
    await expect(insertTextViaPlaywright({ cdpUrl: 'local', text: 'text' })).rejects.toThrow('Focus an editable field');
  });
});

describe.each(['press', 'insert'] as const)('keyboard %s cancellation', (kind) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guard.mockImplementation((opts: { action: () => Promise<void> }) => opts.action());
  });
  const run = (signal?: AbortSignal) =>
    kind === 'press'
      ? pressKeyViaPlaywright({ cdpUrl: 'local', key: 'Enter', signal })
      : insertTextViaPlaywright({ cdpUrl: 'local', text: 'hello', signal });

  it('does not dispatch an already-aborted action', async () => {
    const native = vi.fn().mockResolvedValue(undefined);
    mocks.getPage.mockResolvedValue({ url: () => 'about:blank', keyboard: { press: native, insertText: native } });
    const reason = new Error('pre-aborted');
    await expect(run(AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(native).not.toHaveBeenCalled();
    await run();
    expect(native).toHaveBeenCalledOnce();
  });

  it('returns on abort but leaves the request guard until native work settles', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel keyboard');
    let settle!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const native = vi.fn(
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
    mocks.getPage.mockResolvedValue({ url: () => 'about:blank', keyboard: { press: native, insertText: native } });
    const action = run(controller.signal);
    const rejected = expect(action).rejects.toBe(reason);
    await started;
    controller.abort(reason);
    await rejected;
    expect(guardActive).toBe(true);
    settle();
    await vi.waitFor(() => {
      expect(guardActive).toBe(false);
    });
  });
});
