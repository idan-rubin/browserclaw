import { vi, type Mock } from 'vitest';

export const FAKE_MAIN_FRAME_ID = 'main-frame';

export interface FakeDocumentOutcome {
  continued: boolean;
  /** `Aborted` keeps the source document; `Failed` replaces it with an error page. */
  errorReason?: string;
}

type Listener = (payload: unknown) => void;

interface FakeFenceSession {
  send: Mock<(method: string, params?: Record<string, unknown>) => Promise<unknown>>;
  on: (event: string, listener: Listener) => void;
  off: (event: string, listener: Listener) => void;
  detach: Mock<() => Promise<void>>;
}

export interface FakeNavigationFence {
  session: FakeFenceSession;
  emit: (event: string, payload?: unknown) => void;
  newCDPSession: Mock<() => Promise<FakeFenceSession>>;
  /** Resolves with the fence's answer, or as continued when nothing fences the page. */
  pauseDocument: (
    url: string,
    options?: { subframe?: boolean; failPreserve?: boolean },
  ) => Promise<FakeDocumentOutcome>;
  failNext: (method: string, error: Error) => void;
  claims: () => number;
  releases: () => number;
  stops: () => number;
}

/** A CDP session double that pauses documents the way Chromium's Fetch domain does. */
export function createFakeNavigationFence(page: {
  url: () => string;
  respond?: (method: string) => unknown;
}): FakeNavigationFence {
  const listeners = new Map<string, Set<Listener>>();
  const pending = new Map<string, (outcome: FakeDocumentOutcome) => void>();
  const unpreservable = new Set<string>();
  const failures = new Map<string, Error>();
  let nextRequest = 0;
  const emit = (event: string, payload?: unknown): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
  };
  const send: FakeFenceSession['send'] = vi.fn((method, params) => {
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      return Promise.reject(failure);
    }
    if (method === 'Page.getFrameTree')
      return Promise.resolve({ frameTree: { frame: { id: FAKE_MAIN_FRAME_ID, url: page.url() } } });
    if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
      const requestId = String(params?.requestId);
      const errorReason = method === 'Fetch.failRequest' ? String(params?.errorReason) : undefined;
      if (errorReason === 'Aborted' && unpreservable.has(requestId))
        return Promise.reject(new Error('preserve failed'));
      pending.get(requestId)?.(errorReason === undefined ? { continued: true } : { continued: false, errorReason });
      pending.delete(requestId);
    }
    return Promise.resolve(page.respond?.(method) ?? {});
  });
  const session: FakeFenceSession = {
    send,
    on: (event: string, listener: Listener): void => {
      const registered = listeners.get(event) ?? new Set<Listener>();
      registered.add(listener);
      listeners.set(event, registered);
    },
    off: (event: string, listener: Listener): void => {
      listeners.get(event)?.delete(listener);
    },
    detach: vi.fn(() => Promise.resolve()),
  };
  const sent = (method: string): number => send.mock.calls.filter(([name]) => name === method).length;
  return {
    session,
    emit,
    newCDPSession: vi.fn(() => Promise.resolve(session)),
    pauseDocument(url, options = {}) {
      if ((listeners.get('Fetch.requestPaused')?.size ?? 0) === 0) return Promise.resolve({ continued: true });
      const requestId = `interception-${String(++nextRequest)}`;
      if (options.failPreserve === true) unpreservable.add(requestId);
      return new Promise((resolve) => {
        pending.set(requestId, resolve);
        emit('Fetch.requestPaused', {
          requestId,
          request: { url, headers: {} },
          frameId: options.subframe === true ? 'subframe' : FAKE_MAIN_FRAME_ID,
          resourceType: 'Document',
        });
      });
    },
    failNext: (method, error) => {
      failures.set(method, error);
    },
    claims: () => sent('Network.enable'),
    releases: () => sent('Network.disable'),
    stops: () => sent('Page.stopLoading'),
  };
}
