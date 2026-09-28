import type { CDPSession, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pageTargetInfo } from './page-target.js';

describe('bounded browser-owned page metadata', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fixture(send = vi.fn().mockResolvedValue({ targetInfo: { targetId: 'tab-1', title: 'First title' } })) {
    const detach = vi.fn().mockResolvedValue(undefined);
    const session = { send, detach } as unknown as CDPSession;
    const attach = vi.fn().mockResolvedValue(session);
    const title = vi.fn(() => new Promise<string>(() => undefined));
    const page = { context: () => ({ newCDPSession: attach }), title } as unknown as Page;
    return { page, send, detach, attach, title };
  }

  it('does not ask a hung renderer for its title and refreshes on the next read', async () => {
    const { page, send, title, attach, detach } = fixture();
    const first = pageTargetInfo(page);
    expect(pageTargetInfo(page)).toBe(first);
    expect(await first).toEqual({ targetId: 'tab-1', title: 'First title' });
    send.mockResolvedValue({ targetInfo: { targetId: 'tab-1', title: 'Changed title' } });
    expect(await pageTargetInfo(page)).toEqual({ targetId: 'tab-1', title: 'Changed title' });
    expect(title).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledTimes(2);
    expect(detach).toHaveBeenCalledTimes(2);
  });

  it('bounds a hung target-info command and detaches its session', async () => {
    vi.useFakeTimers();
    const { page, detach } = fixture(vi.fn(() => new Promise(() => undefined)));
    const result = pageTargetInfo(page);
    const rejected = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(detach).toHaveBeenCalledOnce();
  });
});
