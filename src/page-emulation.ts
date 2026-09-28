import type { CDPSession, Page } from 'playwright-core';

interface Viewport {
  width: number;
  height: number;
}

interface PageEmulationState {
  session?: Promise<CDPSession>;
  metricsOwner?: { session: CDPSession; viewport: Viewport };
  touch?: { session: CDPSession; enabled: boolean; maxTouchPoints: number };
  transitionTail?: Promise<void>;
  transitionAbort?: AbortController;
}

// Emulation belongs to the Page, not the public PageState observation shape.
const states = new WeakMap<Page, PageEmulationState>();

export function getPageEmulationState(page: Page): PageEmulationState {
  let state = states.get(page);
  if (state) return state;
  state = {};
  states.set(page, state);
  const ownedState = state;
  page.once('close', () => {
    states.delete(page);
    ownedState.session?.then((session) => session.detach()).catch(() => undefined);
  });
  return state;
}

export function getPageEmulationSession(page: Page): Promise<CDPSession> {
  const state = getPageEmulationState(page);
  if (state.session) return state.session;
  const pending = page.context().newCDPSession(page);
  state.session = pending;
  pending.catch(() => {
    if (state.session === pending) delete state.session;
  });
  return pending;
}

export async function setViewportSizeOnPage(page: Page, viewport: Viewport): Promise<void> {
  const state = getPageEmulationState(page);
  const owner = state.metricsOwner;
  if (owner && (owner.viewport.width !== viewport.width || owner.viewport.height !== viewport.height)) {
    await owner.session.send('Emulation.clearDeviceMetricsOverride');
    delete state.metricsOwner;
  }
  await page.setViewportSize(viewport);
}

/** Keep screenshots and device changes ordered, including work that outlives cancellation. */
export async function runPageEmulationTransition<T>(
  page: Page,
  run: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const state = getPageEmulationState(page);
  const interrupted = (state.transitionAbort ??= new AbortController());
  interrupted.signal.throwIfAborted();
  const combined = signal ? AbortSignal.any([signal, interrupted.signal]) : interrupted.signal;
  let rejectAbort: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(combined.reason);
  };
  combined.addEventListener('abort', onAbort, { once: true });
  const transition = (state.transitionTail ?? Promise.resolve()).then(async () => {
    combined.throwIfAborted();
    const interrupt = () => {
      interrupted.abort(
        new Error('A cancelled screenshot or emulation operation is still running. Retry when it finishes.'),
      );
    };
    signal?.addEventListener('abort', interrupt, { once: true });
    try {
      return await run();
    } finally {
      signal?.removeEventListener('abort', interrupt);
    }
  });
  const tail = transition
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (state.transitionTail === tail) {
        delete state.transitionTail;
        delete state.transitionAbort;
      }
    });
  state.transitionTail = tail;
  try {
    return await Promise.race([transition, aborted]);
  } finally {
    combined.removeEventListener('abort', onAbort);
  }
}
