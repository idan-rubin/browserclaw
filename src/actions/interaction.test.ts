import type { Page } from 'playwright-core';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import type * as ConnectionModule from '../connection.js';

const {
  mockGetPageForTargetId,
  mockEnsurePageState,
  mockBumpUploadArmId,
  mockNormalizeTimeoutMs,
} = vi.hoisted(() => ({
  mockGetPageForTargetId: vi.fn<(opts: unknown) => Promise<Page>>(),
  mockEnsurePageState: vi.fn<(page: unknown) => Record<string, number>>(),
  mockBumpUploadArmId: vi.fn<(state: Record<string, number>) => number>(),
  mockNormalizeTimeoutMs: vi.fn<(timeoutMs: number | undefined, fallback: number) => number>(),
}));

vi.mock('../connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConnectionModule>();
  return {
    ...actual,
    getPageForTargetId: mockGetPageForTargetId,
    ensurePageState: mockEnsurePageState,
    bumpUploadArmId: mockBumpUploadArmId,
    normalizeTimeoutMs: mockNormalizeTimeoutMs,
  };
});

const { awaitActionWithAbort, armFileUploadViaPlaywright } = await import('./interaction.js');

// ─────────────────────────────────────────────────────────────────────────────
// awaitActionWithAbort
// ─────────────────────────────────────────────────────────────────────────────

describe('awaitActionWithAbort', () => {
  it('resolves with action result when no abort promise provided', async () => {
    const result = await awaitActionWithAbort(Promise.resolve(42));
    expect(result).toBe(42);
  });

  it('resolves with action result when abort promise is pending', async () => {
    const abortPromise = new Promise<never>(() => {
      /* never rejects */
    });
    abortPromise.catch(() => {
      /* suppress */
    });
    const result = await awaitActionWithAbort(Promise.resolve('ok'), abortPromise);
    expect(result).toBe('ok');
  });

  it('throws action error when action rejects before abort', async () => {
    const actionError = new Error('action failed');
    let abortReject!: (r: unknown) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {
      /* suppress */
    });
    await expect(awaitActionWithAbort(Promise.reject(actionError), abortPromise)).rejects.toThrow('action failed');
    abortReject(new Error('cleanup'));
  });

  it('throws abort error when abort promise rejects before action resolves', async () => {
    const abortError = new Error('aborted');
    let abortReject!: (r: unknown) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {
      /* suppress */
    });

    const slowAction = new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve('done');
      }, 100),
    );
    const racePromise = awaitActionWithAbort(slowAction, abortPromise);
    abortReject(abortError);

    await expect(racePromise).rejects.toThrow('aborted');
  });

  it('swallows losing action rejection after abort wins — no unhandled rejection', async () => {
    let abortReject!: (r: unknown) => void;
    const abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {
      /* suppress */
    });

    let actionReject!: (r: unknown) => void;
    const actionPromise = new Promise<never>((_, reject) => {
      actionReject = reject;
    });

    const racePromise = awaitActionWithAbort(actionPromise, abortPromise);
    abortReject(new Error('aborted'));
    await expect(racePromise).rejects.toThrow('aborted');
    // Rejecting the action after abort has won must not cause unhandled rejection
    actionReject(new Error('late action error'));
    // Give microtasks a tick to flush
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// armFileUploadViaPlaywright — two-phase contract regression tests
// ─────────────────────────────────────────────────────────────────────────────

interface FakeFileChooser {
  setFiles: ReturnType<typeof vi.fn>;
  element: () => null;
}

interface FakeKeyboard {
  press: ReturnType<typeof vi.fn>;
}

interface FakePage {
  waitForEvent: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  keyboard: FakeKeyboard;
}

function buildFakePage(): {
  page: FakePage;
  fireFileChooser: (chooser: FakeFileChooser) => void;
  failFileChooser: (err: Error) => void;
  waitRegistered: Promise<void>;
} {
  let fireFileChooser!: (chooser: FakeFileChooser) => void;
  let failFileChooser!: (err: Error) => void;
  let signalRegistered!: () => void;
  const waitRegistered = new Promise<void>((resolve) => {
    signalRegistered = resolve;
  });

  const page: FakePage = {
    waitForEvent: vi.fn((eventName: string) => {
      // Mark the listener as armed at the moment waitForEvent is called.
      if (eventName === 'filechooser') signalRegistered();
      return new Promise<FakeFileChooser>((resolve, reject) => {
        fireFileChooser = resolve;
        failFileChooser = reject;
      });
    }),
    once: vi.fn(),
    off: vi.fn(),
    keyboard: {
      press: vi.fn().mockResolvedValue(undefined),
    },
  };

  return {
    page,
    fireFileChooser: (chooser) => {
      fireFileChooser(chooser);
    },
    failFileChooser: (err) => {
      failFileChooser(err);
    },
    waitRegistered,
  };
}

describe('armFileUploadViaPlaywright', () => {
  beforeEach(() => {
    mockGetPageForTargetId.mockReset();
    mockEnsurePageState.mockReset();
    mockBumpUploadArmId.mockReset();
    mockNormalizeTimeoutMs.mockReset();

    mockNormalizeTimeoutMs.mockImplementation((value, fallback) => value ?? fallback);
    mockBumpUploadArmId.mockReturnValue(1);
    mockEnsurePageState.mockReturnValue({ armIdUpload: 0, nextArmIdUpload: 0 });
  });

  it('does not return until the filechooser listener is armed (closes the arming race)', async () => {
    const { page, waitRegistered } = buildFakePage();

    let pageResolve!: (p: FakePage) => void;
    mockGetPageForTargetId.mockImplementation(
      () =>
        new Promise<FakePage>((resolve) => {
          pageResolve = resolve;
        }) as unknown as Promise<Page>,
    );

    const armPromise = armFileUploadViaPlaywright({ cdpUrl: 'http://localhost:9222' });
    let armed = false;
    void armPromise.then(() => {
      armed = true;
    });

    // Listener has not been registered yet — getPageForTargetId is still pending.
    await Promise.resolve();
    expect(page.waitForEvent).not.toHaveBeenCalled();
    expect(armed).toBe(false);

    pageResolve(page);
    await waitRegistered;
    await armPromise;

    expect(armed).toBe(true);
    expect(page.waitForEvent).toHaveBeenCalledWith(
      'filechooser',
      expect.objectContaining({ timeout: expect.any(Number) as unknown as number }),
    );
  });

  it('returns a `done` promise that resolves only after setFiles completes', async () => {
    const { page, fireFileChooser } = buildFakePage();

    let setFilesResolve!: () => void;
    const setFilesPromise = new Promise<void>((resolve) => {
      setFilesResolve = resolve;
    });
    const fakeChooser: FakeFileChooser = {
      setFiles: vi.fn().mockReturnValue(setFilesPromise),
      element: () => null,
    };

    mockGetPageForTargetId.mockResolvedValue(page as unknown as Page);

    // Use empty paths to skip the path-validation branch (which hits the real
    // filesystem-bound resolver). The completion promise still waits for the
    // chooser to fire — that's the contract under test.
    const { done } = await armFileUploadViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      paths: [],
    });

    let resolved = false;
    void done.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    fireFileChooser(fakeChooser);
    await done;
    expect(resolved).toBe(true);
    setFilesResolve();
  });

  it('rejects `done` when the filechooser listener errors (e.g., timeout)', async () => {
    const { page, failFileChooser } = buildFakePage();
    mockGetPageForTargetId.mockResolvedValue(page as unknown as Page);

    const { done } = await armFileUploadViaPlaywright({
      cdpUrl: 'http://localhost:9222',
      paths: [],
      timeoutMs: 50,
    });

    failFileChooser(new Error('Timeout 50ms exceeded while waiting for event "filechooser"'));
    await expect(done).rejects.toThrow(/filechooser/);
  });
});
