/* eslint-disable @typescript-eslint/unbound-method -- Page methods below are vi.fn mocks. */
import type { Page, Request, Route } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isBlockedPageRef } from '../connection.js';
import * as Security from '../security.js';

import {
  assertInteractionNavigationCompletedSafely,
  wasBrowserNavigationSourcePreservedAfterPolicyDenial,
  withPageNavigationRequestGuard,
} from './navigation.js';

type Handler = (route: Route, request: Request) => Promise<void>;
const { InvalidBrowserNavigationUrlError } = Security;

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let handler: Handler | undefined;
  const frame = {};
  let url = 'about:blank';
  const page = {
    url: () => url,
    route: vi.fn((_pattern: string, value: Handler) => {
      handler = value;
      return Promise.resolve();
    }),
    unroute: vi.fn(() => {
      handler = undefined;
      return Promise.resolve();
    }),
    on: vi.fn(),
    off: vi.fn(),
    mainFrame: () => frame,
    isClosed: () => false,
  } as unknown as Page;
  const dispatch = async (
    targetUrl: string,
    options: { subframe?: boolean; failFulfill?: boolean; resourceType?: string } = {},
  ) => {
    const send = vi.fn(() => {
      if (options.subframe !== true) url = targetUrl;
      return Promise.resolve();
    });
    const route = {
      fallback: send,
      continue: send,
      fulfill: vi.fn(() =>
        options.failFulfill === true ? Promise.reject(new Error('fulfill failed')) : Promise.resolve(),
      ),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const request = {
      url: () => targetUrl,
      frame: () => (options.subframe === true ? {} : frame),
      isNavigationRequest: () => options.resourceType === undefined,
      resourceType: () => options.resourceType ?? 'document',
    };
    if (handler) await handler(route as unknown as Route, request as unknown as Request);
    else await send();
    return route;
  };
  return {
    page,
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
    const route = await dispatched;
    expect(route?.fallback).not.toHaveBeenCalled();
    expect(route?.fulfill).toHaveBeenCalledOnce();
  });

  it('preserves an already detected policy denial over caller abort', async () => {
    const { page, dispatch } = fixture();
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
    const route = await dispatched;
    abort(new Error('caller cancelled'));
    expect(route?.fallback).not.toHaveBeenCalled();
    expect(route?.fulfill).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    expect(page.unroute).not.toHaveBeenCalled();
    releaseNative();
    await assertion;
    expect(page.unroute).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'returns caller abort while policy is stalled, retaining the guard (deny=%s)',
    async (deny) => {
      const { page, dispatch } = fixture();
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
        expect(page.unroute).not.toHaveBeenCalled();
        if (deny) denyPolicy(new InvalidBrowserNavigationUrlError('late denial'));
        else allowPolicy();
        const route = await dispatched;
        expect(route?.fallback).toHaveBeenCalledTimes(deny ? 0 : 1);
        expect(route?.fulfill).toHaveBeenCalledTimes(deny ? 1 : 0);
      } finally {
        allowPolicy();
        releaseNative();
        await vi.waitFor(() => {
          expect(page.unroute).toHaveBeenCalledOnce();
        });
      }
    },
  );

  it('ignores cleanup failure only for an already closed page', async () => {
    const { page } = fixture();
    vi.mocked(page.unroute).mockRejectedValueOnce(new Error('target closed'));
    page.isClosed = () => true;
    await expect(
      withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39996',
        page,
        action: () => Promise.resolve('completed'),
      }),
    ).resolves.toBe('completed');
  });

  it('does not conceal fallback failures for ordinary non-document requests', async () => {
    let handler: Handler | undefined;
    const { page } = fixture();
    vi.mocked(page.route).mockImplementation((_pattern, callback) => {
      handler = callback;
      return Promise.resolve({ dispose: () => Promise.resolve(), [Symbol.asyncDispose]: () => Promise.resolve() });
    });
    const route = {
      fallback: vi.fn().mockRejectedValue(new Error('fallback transport failed')),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const request = { frame: () => page.mainFrame(), isNavigationRequest: () => false, resourceType: () => 'image' };
    await expect(
      withPageNavigationRequestGuard({
        cdpUrl: 'http://localhost:39997',
        page,
        action: async () => {
          await handler?.(route as unknown as Route, request as unknown as Request);
        },
      }),
    ).rejects.toThrow('fallback transport failed');
    expect(route.abort).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    'blocks a private document before dispatch (subframe=%s), preserving the source',
    async (subframe) => {
      const { page, dispatch } = fixture();
      let route: Awaited<ReturnType<typeof dispatch>> | undefined;
      let denial: unknown;
      try {
        await assertInteractionNavigationCompletedSafely({
          cdpUrl: 'http://localhost:39990',
          page,
          previousUrl: page.url(),
          action: async () => {
            route = await dispatch('http://169.254.169.254/latest/meta-data/', { subframe });
          },
        });
      } catch (err) {
        denial = err;
      }
      expect(denial).toBeInstanceOf(InvalidBrowserNavigationUrlError);
      expect(route?.fallback).not.toHaveBeenCalled();
      expect(route?.fulfill).toHaveBeenCalledWith({ status: 204, body: '' });
      expect(page.url()).toBe('about:blank');
      expect(wasBrowserNavigationSourcePreservedAfterPolicyDenial(denial)).toBe(true);
      expect(isBlockedPageRef('http://localhost:39990', page)).toBe(false);
      expect(page.unroute).toHaveBeenCalled();
    },
  );

  it('admits the identical private request with an explicit opt-in (non-vacuous control)', async () => {
    const { page, dispatch } = fixture();
    const route = await withPageNavigationRequestGuard({
      cdpUrl: 'http://localhost:39990',
      page,
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      action: () => dispatch('http://169.254.169.254/latest/meta-data/'),
    });
    expect(route.fallback).toHaveBeenCalledOnce();
    expect(route.fulfill).not.toHaveBeenCalled();
    expect(page.url()).toContain('169.254.169.254');
  });

  it('keeps ordinary non-document requests available', async () => {
    const { page, dispatch } = fixture();
    const route = await withPageNavigationRequestGuard({
      cdpUrl: 'http://localhost:39990',
      page,
      action: () => dispatch('https://example.test/image.png', { subframe: true, resourceType: 'image' }),
    });
    expect(route.fallback).toHaveBeenCalledOnce();
  });

  it('preserves the policy error over an action cancellation and quarantines if204 fails', async () => {
    const { page, dispatch } = fixture();
    let route: Awaited<ReturnType<typeof dispatch>> | undefined;
    await expect(
      assertInteractionNavigationCompletedSafely({
        cdpUrl: 'http://localhost:39991',
        page,
        previousUrl: page.url(),
        action: async () => {
          route = await dispatch('http://127.0.0.1/private', { failFulfill: true });
          throw new Error('action cancelled');
        },
      }),
    ).rejects.toBeInstanceOf(InvalidBrowserNavigationUrlError);
    expect(route?.fallback).not.toHaveBeenCalled();
    expect(route?.abort).toHaveBeenCalledOnce();
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

  it('fails closed if route installation or live-page removal fails', async () => {
    const { page } = fixture();
    const action = vi.fn().mockResolvedValue('done');
    vi.mocked(page.route).mockRejectedValueOnce(new Error('install failed'));
    await expect(withPageNavigationRequestGuard({ cdpUrl: 'http://localhost:39993', page, action })).rejects.toThrow(
      'install failed',
    );
    expect(action).not.toHaveBeenCalled();
    expect(page.unroute).toHaveBeenCalledOnce();
    vi.mocked(page.unroute).mockRejectedValueOnce(new Error('remove failed'));
    await expect(withPageNavigationRequestGuard({ cdpUrl: 'http://localhost:39993', page, action })).rejects.toThrow(
      'remove failed',
    );
    expect(action).toHaveBeenCalledOnce();
  });
});
