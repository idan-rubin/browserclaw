import { EventEmitter } from 'node:events';

import type { CDPSession, Page } from 'playwright-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildRoleSnapshotFromAriaSnapshot } from './ref-map.js';

// ─────────────────────────────────────────────────────────────────────────────
// Empty and degenerate input handling
// (guards the same path as formatAriaNodes empty-input crash)
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshot empty/degenerate input handling', () => {
  it('buildRoleSnapshotFromAriaSnapshot returns (empty) for empty string', () => {
    const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot('');
    expect(snapshot).toBe('(empty)');
    expect(Object.keys(refs)).toHaveLength(0);
  });

  it('buildRoleSnapshotFromAriaSnapshot returns no refs for whitespace-only input', () => {
    expect(Object.keys(buildRoleSnapshotFromAriaSnapshot('   \n  \n  ').refs)).toHaveLength(0);
  });

  it('buildRoleSnapshotFromAriaSnapshot does not throw on input with only non-matching lines', () => {
    // Lines that don't match the `- role` pattern are passed through unchanged
    expect(() => buildRoleSnapshotFromAriaSnapshot('no match here\nalso no match')).not.toThrow();
  });

  it('buildRoleSnapshotFromAriaSnapshot returns (no interactive elements) for interactive mode with empty input', () => {
    const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot('', { interactive: true });
    expect(snapshot).toBe('(no interactive elements)');
    expect(Object.keys(refs)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// snapshotAria timeout + CDP session detach
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../actions/navigation.js', () => ({
  assertPageNavigationCompletedSafely: () => Promise.resolve(),
}));

const { mockGetPageForTargetId, mockWithCdpSession, mockStoreRoleRefsForTarget } = vi.hoisted(() => ({
  mockGetPageForTargetId: vi.fn<(opts: unknown) => Promise<Page>>(),
  mockWithCdpSession: vi.fn(),
  mockStoreRoleRefsForTarget: vi.fn(),
}));

vi.mock('../connection.js', () => ({
  getPageForTargetId: mockGetPageForTargetId,
  ensurePageState: () => ({}),
  storeRoleRefsForTarget: mockStoreRoleRefsForTarget,
  normalizeTimeoutMs: (timeoutMs: number | undefined, fallback: number) => timeoutMs ?? fallback,
  withPlaywrightPageCdpSession: mockWithCdpSession,
  takeAiSnapshotText: () => Promise.resolve(''),
}));

const { snapshotAria, snapshotRole } = await import('./aria-snapshot.js');

function makeMockPage(): Page {
  const frame = { isDetached: () => false };
  return Object.assign(new EventEmitter(), {
    url: () => 'https://example.test/',
    mainFrame: () => frame,
    locator: () => ({ evaluateAll: () => Promise.resolve() }),
  }) as unknown as Page;
}

function makeSession(opts: { hang?: boolean }): { session: CDPSession; detach: ReturnType<typeof vi.fn> } {
  const detach = vi.fn(() => Promise.resolve());
  const send = vi.fn((method: string) =>
    method === 'Accessibility.getFullAXTree'
      ? opts.hang === true
        ? new Promise(() => undefined)
        : Promise.resolve({ nodes: [] })
      : method === 'DOM.getDocument'
        ? Promise.resolve({ root: { backendNodeId: 1 } })
        : method === 'DOM.resolveNode'
          ? Promise.resolve({ object: { objectId: 'document' } })
          : Promise.resolve({}),
  );
  return { session: { send, detach } as unknown as CDPSession, detach };
}

describe('snapshotAria timeout', () => {
  beforeEach(() => {
    mockGetPageForTargetId.mockReset();
    mockWithCdpSession.mockReset();
    mockStoreRoleRefsForTarget.mockReset();
    mockGetPageForTargetId.mockResolvedValue(makeMockPage());
  });

  it('rejects an aborted raw capture before marking or publishing refs', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel raw snapshot');
    const { session } = makeSession({ hang: false });
    const send = vi.spyOn(session, 'send');
    mockWithCdpSession.mockImplementation((_page: Page, fn: (s: CDPSession) => Promise<unknown>) => {
      controller.abort(reason);
      return fn(session);
    });
    await expect(snapshotAria({ cdpUrl: 'test', signal: controller.signal })).rejects.toBe(reason);
    expect(mockStoreRoleRefsForTarget).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalledWith('DOM.getDocument', expect.anything());
    mockWithCdpSession.mockClear();
    await expect(snapshotAria({ cdpUrl: 'test', signal: controller.signal })).rejects.toBe(reason);
    await expect(snapshotRole({ cdpUrl: 'test', signal: controller.signal })).rejects.toBe(reason);
    expect(mockWithCdpSession).not.toHaveBeenCalled();
  });

  it('clamps below the 500ms floor and passes the deadline to the bounded session owner', async () => {
    const { session } = makeSession({ hang: true });
    mockWithCdpSession.mockImplementation((_page: Page, fn: (s: CDPSession) => Promise<unknown>) => fn(session));

    await expect(snapshotAria({ cdpUrl: 'http://localhost:9222', targetId: 't1', timeoutMs: 50 })).rejects.toThrow(
      'Browser snapshot capture timed out.',
    );

    // The shared bounded helper owns detach, including late session attachment.
    expect(mockWithCdpSession).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 500);
    expect(mockStoreRoleRefsForTarget).not.toHaveBeenCalled();
  });

  it('resolves and does not force-detach when the tree returns before the timeout', async () => {
    const { session, detach } = makeSession({ hang: false });
    mockWithCdpSession.mockImplementation((_page: Page, fn: (s: CDPSession) => Promise<unknown>) => fn(session));

    const result = await snapshotAria({ cdpUrl: 'http://localhost:9222', targetId: 't1', timeoutMs: 5000 });

    expect(result.nodes).toEqual([]);
    expect(detach).not.toHaveBeenCalled();
    expect(mockStoreRoleRefsForTarget).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded 5000ms default when timeoutMs is omitted', async () => {
    const { session, detach } = makeSession({ hang: false });
    mockWithCdpSession.mockImplementation((_page: Page, fn: (s: CDPSession) => Promise<unknown>) => fn(session));

    const result = await snapshotAria({ cdpUrl: 'http://localhost:9222', targetId: 't1' });

    expect(result.nodes).toEqual([]);
    expect(detach).not.toHaveBeenCalled();
    expect(mockWithCdpSession).toHaveBeenCalledWith(expect.anything(), expect.any(Function), 5000);
  });
});
