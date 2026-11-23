import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isBlockedPageRef } from '../connection.js';
import * as Security from '../security.js';

import { createFakeNavigationFence } from './navigation-fence.test-support.js';
import {
  assertInteractionNavigationCompletedSafely,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from './navigation.js';

const { InvalidBrowserNavigationUrlError } = Security;
const preserved = { continued: false, errorReason: 'Aborted' };

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const frame = {};
  let url = 'about:blank';
  const fence = createFakeNavigationFence({ url: () => url });
  const page = {
    url: () => url,
    context: () => ({ newCDPSession: fence.newCDPSession }),
    on: vi.fn(),
    off: vi.fn(),
    mainFrame: () => frame,
    isClosed: () => false,
  } as unknown as Page;
  const dispatch = async (targetUrl: string, options: { subframe?: boolean; failPreserve?: boolean } = {}) => {
    const outcome = await fence.pauseDocument(targetUrl, options);
    if (outcome.continued && options.subframe !== true) url = targetUrl;
    return outcome;
  };
  return {
    page,
    fence,
    dispatch,
    setUrl: (value: string) => {
      url = value;
    },
  };
}

describe('interaction request policy enforcement', () => {
  it('denies a private baseline before acting, while the explicit opt-in remains usable', async () => {
    const { page, setUrl } = fixture();
    setUrl('http://127.0.0.1/private');
    const action = vi.fn().mockResolvedValue('clicked');
    await expect(
      withPageNavigationRequestGuard({ cdpUrl: 'http://localhost:39994', page, action }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    expect(action).not.toHaveBeenCalled();
    await expect(
      withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39994',
        page,
        action,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      }),
    ).resolves.toBe('clicked');
    expect(action).toHaveBeenCalledOnce();
  });

  it('waits for an in-flight policy check and reports its denial over an action failure', async () => {
    const { page, dispatch } = fixture();
    let rejectPolicy!: (error: Error) => void;
    const check = new Promise<void>((_resolve, reject) => {
      rejectPolicy = reject;
    });
    vi.spyOn(Security, 'assertBrowserNavigationAllowed').mockReturnValueOnce(check);
    let dispatched: ReturnType<typeof dispatch> | undefined;
    let checkStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      checkStarted = resolve;
    });
    const operation = withPageNavigationRequestGuard({
      cdpUrl: 'http://localhost:39995',
      page,
      onPolicyCheckStarted: () => {
        checkStarted();
      },
      action: () => {
        dispatched = dispatch('http://127.0.0.1/private');
        return Promise.reject(new Error('action cancelled'));
      },
    });
    const assertion = expect(operation).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    await started;
    rejectPolicy(new InvalidBrowserNavigationUrlError('late policy denial'));
    await assertion;
    expect(await dispatched).toEqual(preserved);
  });

  it('preserves an already detected policy denial over caller abort', async () => {
    const { page, fence, dispatch } = fixture();
    let rejectPolicy!: (error: Error) => void;
    const check = new Promise<void>((_resolve, reject) => {
      rejectPolicy = reject;
    });
    vi.spyOn(Security, 'assertBrowserNavigationAllowed').mockReturnValueOnce(check);
    let abort!: (error: Error) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abort = reject;
    });
    let releaseNative!: () => void;
    const native = new Promise<void>((resolve) => {
      releaseNative = resolve;
    });
    let dispatched: ReturnType<typeof dispatch> | undefined;
    let started!: () => void;
    const actionStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const operation = assertInteractionNavigationCompletedSafely({
      cdpUrl: 'http://localhost:39998',
      page,
      previousUrl: page.url(),
      abortPromise,
      action: async () => {
        dispatched = dispatch('http://127.0.0.1/private');
        started();
        await native;
      },
    });
    const settled = vi.fn();
    void operation.then(settled, settled);
    const assertion = expect(operation).rejects.toThrow('pending document denied');
    await actionStarted;
    rejectPolicy(new InvalidBrowserNavigationUrlError('pending document denied'));
    const outcome = await dispatched;
    abort(new Error('caller cancelled'));
    expect(outcome).toEqual(preserved);
    expect(settled).not.toHaveBeenCalled();
    expect(fence.releases()).toBe(0);
    releaseNative();
    await assertion;
    expect(fence.releases()).toBe(1);
  });

  it.each([false, true])(
    'returns caller abort while policy is stalled, retaining the guard (deny=%s)',
    async (deny) => {
      const { page, fence, dispatch } = fixture();
      let allowPolicy!: () => void;
      let denyPolicy!: (error: Error) => void;
      const check = new Promise<void>((resolve, reject) => {
        allowPolicy = resolve;
        denyPolicy = reject;
      });
      vi.spyOn(Security, 'assertBrowserNavigationAllowed').mockReturnValueOnce(check);
      let abort!: (error: Error) => void;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        abort = reject;
      });
      let releaseNative!: () => void;
      const native = new Promise<void>((resolve) => {
        releaseNative = resolve;
      });
      let dispatched: ReturnType<typeof dispatch> | undefined;
      let started!: () => void;
      const actionStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cancelled = new Error('caller cancelled');
      const operation = assertInteractionNavigationCompletedSafely({
        cdpUrl: 'http://localhost:39999',
        page,
        previousUrl: page.url(),
        abortPromise,
        action: async () => {
          // A subframe keeps the about:blank baseline independent of the policy mock.
          dispatched = dispatch('https://allowed.invalid/frame', { subframe: true });
          started();
          await native;
        },
      });
      const settled = vi.fn();
      void operation.then(settled, settled);
      await actionStarted;
      abort(cancelled);
      try {
        await vi.waitFor(
          () => {
            expect(settled).toHaveBeenCalledWith(cancelled);
          },
          { timeout: 100 },
        );
        expect(fence.releases()).toBe(0);
        if (deny) denyPolicy(new InvalidBrowserNavigationUrlError('late denial'));
        else allowPolicy();
        expect(await dispatched).toEqual(deny ? preserved : { continued: true });
      } finally {
        allowPolicy();
        releaseNative();
        await vi.waitFor(() => {
          expect(fence.releases()).toBe(1);
        });
      }
    },
  );

  it('ignores cleanup failure only for an already closed page', async () => {
    const { page, fence } = fixture();
    fence.failNext('Runtime.evaluate', new Error('target closed'));
    page.isClosed = () => true;
    await expect(
      withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39996',
        page,
        action: () => Promise.resolve('completed'),
      }),
    ).resolves.toBe('completed');
  });

  it('does not conceal a document that could not be resumed', async () => {
    const { page, fence, dispatch } = fixture();
    fence.failNext('Fetch.continueRequest', new Error('resume transport failed'));
    let outcome: Awaited<ReturnType<typeof dispatch>> | undefined;
    await expect(
      withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39997',
        page,
        action: async () => {
          outcome = await dispatch('http://8.8.8.8/next');
        },
      }),
    ).rejects.toThrow('resume transport failed');
    expect(outcome).toEqual({ continued: false, errorReason: 'Failed' });
    expect(fence.stops()).toBeGreaterThan(0);
  });

  it.each([false, true])(
    'blocks a private document before dispatch (subframe=%s), preserving the source',
    async (subframe) => {
      const { page, fence, dispatch } = fixture();
      let outcome: Awaited<ReturnType<typeof dispatch>> | undefined;
      let denial: unknown;
      try {
        await assertInteractionNavigationCompletedSafely({
          cdpUrl: 'http://localhost:39990',
          page,
          previousUrl: page.url(),
          action: async () => {
            outcome = await dispatch('http://169.254.169.254/latest/meta-data/', { subframe });
          },
        });
      } catch (err) {
        denial = err;
      }
      expect(denial).toBeInstanceOf(InvalidBrowserNavigationUrlError);
      expect(outcome).toEqual(preserved);
      expect(page.url()).toBe('about:blank');
      expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(denial)).toBe(true);
      expect(isBlockedPageRef('http://localhost:39990', page)).toBe(false);
      expect(fence.releases()).toBe(1);
    },
  );

  it('admits the identical private request with an explicit opt-in (non-vacuous control)', async () => {
    const { page, dispatch } = fixture();
    const outcome = await withPageNavigationRequestGuard({
      cdpUrl: 'http://localhost:39990',
      page,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      action: () => dispatch('http://169.254.169.254/latest/meta-data/'),
    });
    expect(outcome).toEqual({ continued: true });
    expect(page.url()).toContain('169.254.169.254');
  });

  it('pauses documents only, leaving every other request to the browser', async () => {
    const { page, fence } = fixture();
    await withPageNavigationRequestGuard({
      cdpUrl: 'http://localhost:39990',
      page,
      action: () => Promise.resolve(),
    });
    const enabled = fence.session.send.mock.calls.filter(([method]) => method === 'Fetch.enable');
    expect(enabled).toEqual([
      ['Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }],
    ]);
  });

  it('preserves the policy error over an action cancellation and quarantines if the source cannot be kept', async () => {
    const { page, dispatch } = fixture();
    let outcome: Awaited<ReturnType<typeof dispatch>> | undefined;
    await expect(
      assertInteractionNavigationCompletedSafely({
        cdpUrl: 'http://localhost:39991',
        page,
        previousUrl: page.url(),
        action: async () => {
          outcome = await dispatch('http://127.0.0.1/private', { failPreserve: true });
          throw new Error('action cancelled');
        },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    expect(outcome).toEqual({ continued: false, errorReason: 'Failed' });
    expect(isBlockedPageRef('http://localhost:39991', page)).toBe(true);
  });

  it('keeps the request guard through delayed navigation after the action settles', async () => {
    const { page, dispatch } = fixture();
    let delayed: Promise<unknown> | undefined;
    await expect(
      assertInteractionNavigationCompletedSafely({
        cdpUrl: 'http://localhost:39992',
        page,
        previousUrl: page.url(),
        action: () => {
          setTimeout(() => {
            delayed = dispatch('http://127.0.0.1/private');
          }, 10);
          return Promise.resolve();
        },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    await delayed;
    expect(page.url()).toBe('about:blank');
  });

  it('keeps the tab navigable under its policy after a cleanup failure', async () => {
    const { page, fence, dispatch } = fixture();
    fence.failNext('Runtime.evaluate', new Error('cleanup barrier failed'));
    await expect(
      withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: () => Promise.resolve('clicked'),
      }),
    ).rejects.toThrow('cleanup barrier failed');
    expect(await dispatch('http://8.8.8.8/next')).toEqual({ continued: true });
    expect(await dispatch('http://127.0.0.1/denied')).toEqual({ continued: false, errorReason: 'BlockedByClient' });
    await expect(
      withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: async () => {
          expect(await dispatch('http://8.8.8.8/again')).toEqual({ continued: true });
          return 'again';
        },
      }),
    ).resolves.toBe('again');
  });

  it('returns from a finished action while the page keeps requesting documents', async () => {
    const { page, dispatch } = fixture();
    vi.spyOn(Security, 'assertBrowserNavigationAllowed').mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 40)),
    );
    const stream = setInterval(() => void dispatch('http://8.8.8.8/stream'), 5);
    try {
      const guarded = withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return 'clicked';
        },
      });
      const outcome = await Promise.race([
        guarded,
        new Promise<string>((resolve) => setTimeout(resolve, 1000, 'still waiting')),
      ]);
      expect(outcome).toBe('clicked');
    } finally {
      clearInterval(stream);
    }
  });

  describe('a frame at an origin no policy check has passed', () => {
    const settleFirstAction = async (page: Page): Promise<void> => {
      await withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: () => Promise.resolve(),
      });
    };

    it('is checked when it asks for another document from that origin between actions', async () => {
      const { page, fence, dispatch } = fixture();
      await settleFirstAction(page);
      fence.emit('Page.frameNavigated', { frame: { id: 'subframe', url: 'http://127.0.0.1/inner' } });
      expect(await dispatch('http://127.0.0.1/secret', { subframe: true })).toEqual(preserved);
    });

    it('is checked again once a stricter policy replaces the one that passed its origin', async () => {
      const { page, fence, dispatch } = fixture();
      await withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        action: async () => {
          expect(await dispatch('http://127.0.0.1/inner', { subframe: true })).toEqual({ continued: true });
        },
      });
      fence.emit('Page.frameNavigated', { frame: { id: 'subframe', url: 'http://127.0.0.1/inner' } });
      expect(await dispatch('http://127.0.0.1/more', { subframe: true })).toEqual({ continued: true });
      await settleFirstAction(page);
      expect(await dispatch('http://127.0.0.1/secret', { subframe: true })).toEqual(preserved);
    });

    it('rechecks a document whose check was still running when a stricter policy took over', async () => {
      const { page, fence, dispatch } = fixture();
      await withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
        action: () => Promise.resolve(),
      });
      fence.emit('Page.frameNavigated', { frame: { id: 'subframe', url: 'http://127.0.0.1/inner' } });
      let finishOldCheck!: () => void;
      const check = vi.spyOn(Security, 'assertBrowserNavigationAllowed').mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishOldCheck = resolve;
          }),
      );
      const requested = dispatch('http://127.0.0.1/first', { subframe: true });
      await vi.waitFor(() => {
        expect(check).toHaveBeenCalledOnce();
      });
      await settleFirstAction(page);
      finishOldCheck();
      expect(await requested).toEqual(preserved);
      expect(await dispatch('http://127.0.0.1/second', { subframe: true })).toEqual(preserved);
    });

    it('control: skips the check once a document for that origin has passed one', async () => {
      const { page, fence, dispatch } = fixture();
      await settleFirstAction(page);
      expect(await dispatch('http://8.8.8.8/inner', { subframe: true })).toEqual({ continued: true });
      fence.emit('Page.frameNavigated', { frame: { id: 'subframe', url: 'http://8.8.8.8/inner' } });
      const check = vi.spyOn(Security, 'assertBrowserNavigationAllowed');
      expect(await dispatch('http://8.8.8.8/next', { subframe: true })).toEqual({ continued: true });
      expect(check).not.toHaveBeenCalled();
    });
  });

  describe('release while Chrome holds renderer commands', () => {
    const settledWithin = async (operation: Promise<unknown>, ms: number): Promise<boolean> => {
      const settled = operation.then(
        () => true,
        () => true,
      );
      return await Promise.race([settled, new Promise<boolean>((resolve) => setTimeout(resolve, ms, false))]);
    };

    it('returns once a top-level document is pending, without waiting for the held flush', async () => {
      const { page, fence, dispatch } = fixture();
      fence.hold(['Runtime.evaluate', 'Network.disable']);
      const guarded = withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: async () => {
          expect(await dispatch('http://8.8.8.8/slow')).toEqual({ continued: true });
          return 'clicked';
        },
      });
      await expect(guarded).resolves.toBe('clicked');
      expect(fence.releases()).toBe(1);
      expect(await dispatch('http://127.0.0.1/after-hand-off')).toEqual({
        continued: false,
        errorReason: 'BlockedByClient',
      });
    });

    it('control: waits for the flush when only a subframe document is pending', async () => {
      const { page, fence, dispatch } = fixture();
      const answer = fence.hold(['Runtime.evaluate']);
      const guarded = withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: async () => {
          expect(await dispatch('http://8.8.8.8/frame', { subframe: true })).toEqual({ continued: true });
          return 'clicked';
        },
      });
      expect(await settledWithin(guarded, 50)).toBe(false);
      answer();
      await expect(guarded).resolves.toBe('clicked');
    });

    it('stops a pending top-level document after a guard error without waiting for the held flush', async () => {
      const { page, fence, dispatch } = fixture();
      fence.hold(['Runtime.evaluate'], { until: 'Page.stopLoading' });
      const guarded = withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: async () => {
          expect(await dispatch('http://8.8.8.8/slow')).toEqual({ continued: true });
          await dispatch('http://127.0.0.1/private-frame', { subframe: true });
        },
      });
      expect(await settledWithin(guarded, 1000)).toBe(true);
      await expect(guarded).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
      expect(fence.stops()).toBeGreaterThan(0);
    });

    it('claims a tab whose earlier release Chrome is still holding', async () => {
      const { page, fence, dispatch } = fixture();
      const first = withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: async () => {
          fence.hold(['Runtime.evaluate', 'Network.disable', 'Network.enable']);
          expect(await dispatch('http://8.8.8.8/slow')).toEqual({ continued: true });
          return 'first';
        },
      });
      await expect(first).resolves.toBe('first');
      const second = withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39993',
        page,
        action: async () => {
          expect(await dispatch('http://127.0.0.1/private')).toEqual(preserved);
          return 'second';
        },
      });
      expect(await settledWithin(second, 1000)).toBe(true);
      await expect(second).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    });
  });

  it('fails closed if the fence cannot be installed or released on a live page', async () => {
    const { page, fence } = fixture();
    const action = vi.fn().mockResolvedValue('done');
    fence.newCDPSession.mockRejectedValueOnce(new Error('install failed'));
    await expect(withPageNavigationRequestGuard({ cdpUrl: 'http://localhost:39993', page, action })).rejects.toThrow(
      'install failed',
    );
    expect(action).not.toHaveBeenCalled();
    fence.failNext('Runtime.evaluate', new Error('release failed'));
    await expect(withPageNavigationRequestGuard({ cdpUrl: 'http://localhost:39993', page, action })).rejects.toThrow(
      'release failed',
    );
    expect(action).toHaveBeenCalledOnce();
  });
});
