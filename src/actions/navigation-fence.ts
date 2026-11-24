// Ported from OpenClaw 2026.11.6: pw-session-navigation-standing.ts, pw-session-navigation-fence.ts,
// cdp-fetch-interception.ts.
import { EventEmitter } from 'node:events';

import type { CDPSession, Page } from 'playwright-core';

import { assertBrowserNavigationAllowed, type BrowserNavigationPolicyOptions } from '../security.js';

const NAVIGATION_AUTHORITY_TIMEOUT_MS = 20_000;

type FailureReason = 'Aborted' | 'BlockedByClient' | 'Failed';

interface FrameTree {
  frame: { id: string; url: string };
  childFrames?: FrameTree[];
}

interface PausedRequest {
  requestId: string;
  request: { url: string; headers: Record<string, string> };
  frameId?: string;
  resourceType?: string;
  networkId?: string;
  redirectedRequestId?: string;
}

interface TrackedRequest {
  requestId: string;
  type?: string;
  frameId?: string;
}

interface AttachedTarget {
  sessionId: string;
  targetInfo: { targetId: string; url: string };
}

interface TargetMessage {
  sessionId: string;
  message: string;
}

interface FenceTarget {
  events: EventEmitter;
  parent?: FenceTarget;
  frameId?: string;
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
}

interface TargetState {
  documents: Map<string, string | undefined>;
  finishedDocuments: Set<string>;
  transferredFrames: Set<string>;
  documentPending: () => boolean;
  removeListeners: () => void;
}

export interface FencedDocumentControls {
  continue: () => Promise<void>;
  fallback: () => Promise<void>;
  abort: () => Promise<void>;
  preserve: () => Promise<void>;
}

export interface FencedDocumentRequest {
  url: () => string;
  isTopLevel: () => boolean;
}

export type FencedDocumentHandler = (controls: FencedDocumentControls, request: FencedDocumentRequest) => Promise<void>;

interface FenceInvocation {
  policy: BrowserNavigationPolicyOptions;
  handleDocument?: FencedDocumentHandler;
  inFlight: Set<Promise<void>>;
  admitsDocuments: () => boolean;
  isOpen: () => boolean;
  fail: (error: unknown) => void;
  assertTargetCurrent: () => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Awaited only through races; a rejection nobody is racing must not surface as unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRetiredFetchInterceptionError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Invalid InterceptionId');
}

function networkOrigin(url: string): string | undefined {
  const origin = URL.canParse(url) ? new URL(url).origin : 'null';
  return origin !== 'null' ? origin : undefined;
}

function createStandingNavigationPolicy() {
  let policy: BrowserNavigationPolicyOptions | undefined;
  let policyKey: string | undefined;
  let warned = false;
  const committedOrigins = new Map<string, string>();
  // A frame can already sit at an origin when the tab is fenced; only a passed check makes that origin exempt.
  const checkedOrigins = new Set<string>();
  const requestedNavigations = new Map<string, string>();
  const requestedHops = new Map<string, string>();
  const frameCommitted = (frameId: string, url: string): void => {
    const origin = networkOrigin(url);
    if (origin !== undefined) committedOrigins.set(frameId, origin);
    else committedOrigins.delete(frameId);
  };
  const seed = (tree: FrameTree): void => {
    frameCommitted(tree.frame.id, tree.frame.url);
    for (const child of tree.childFrames ?? []) seed(child);
  };
  return {
    set({ standingSsrfPolicy, browserProxyMode }: BrowserNavigationPolicyOptions): void {
      if (!standingSsrfPolicy) return;
      const next = { ssrfPolicy: standingSsrfPolicy, ...(browserProxyMode ? { browserProxyMode } : {}) };
      const key = JSON.stringify(next);
      // An origin that passed under another policy has not passed under this one.
      if (key !== policyKey) checkedOrigins.clear();
      policyKey = key;
      policy = next;
    },
    frameCommitted,
    seed,
    observe(events: EventEmitter): () => void {
      const onNavigated = (event: { frame: { id: string; url: string } }): void => {
        frameCommitted(event.frame.id, event.frame.url);
      };
      const onRequested = (event: { frameId: string; url: string }): void => {
        requestedNavigations.set(event.frameId, event.url.split('#', 1)[0] ?? event.url);
      };
      const onDetached = (event: { frameId: string; reason?: string }): void => {
        if (event.reason !== 'swap') {
          committedOrigins.delete(event.frameId);
          requestedNavigations.delete(event.frameId);
          requestedHops.delete(event.frameId);
        }
      };
      events.on('Page.frameNavigated', onNavigated);
      events.on('Page.frameRequestedNavigation', onRequested);
      events.on('Page.frameDetached', onDetached);
      return () => {
        events.off('Page.frameNavigated', onNavigated);
        events.off('Page.frameRequestedNavigation', onRequested);
        events.off('Page.frameDetached', onDetached);
      };
    },
    // A redirect hop carries on the navigation that requested the first one, whoever decided that one.
    pageRequested(frameId: string | undefined, event: PausedRequest): boolean {
      if (frameId === undefined) return false;
      const started = requestedNavigations.get(frameId) === event.request.url;
      if (started) requestedNavigations.delete(frameId);
      const requested =
        started ||
        (event.redirectedRequestId !== undefined && requestedHops.get(frameId) === event.redirectedRequestId);
      if (requested) requestedHops.set(frameId, event.requestId);
      else requestedHops.delete(frameId);
      return requested;
    },
    async denial(request: {
      url: string;
      headers: Record<string, string>;
      frameId?: string;
      mainFrameId?: string;
      pageRequested: boolean;
    }): Promise<FailureReason | undefined> {
      const { frameId, mainFrameId, pageRequested } = request;
      if (!policy) return undefined;
      const origin = networkOrigin(request.url);
      for (;;) {
        if (
          origin !== undefined &&
          checkedOrigins.has(origin) &&
          ((frameId !== undefined && committedOrigins.get(frameId) === origin) ||
            (mainFrameId !== undefined && committedOrigins.get(mainFrameId) === origin))
        )
          return undefined;
        const checkedUnder = policyKey;
        const refusal = await assertBrowserNavigationAllowed({ url: request.url, ...policy }).then(
          () => undefined,
          (error: unknown) => ({ error }),
        );
        // A policy that took over while the check ran decides this document, whichever way the old one answered.
        if (checkedUnder !== policyKey) continue;
        if (refusal === undefined) {
          if (origin !== undefined) checkedOrigins.add(origin);
          return undefined;
        }
        if (!warned) {
          warned = true;
          console.warn(
            `[browserclaw] stopped a document the page requested between browser actions (${refusal.error instanceof Error ? refusal.error.name : 'error'})`,
          );
        }
        break;
      }
      const hasReferer = Object.keys(request.headers).some((name) => name.toLowerCase() === 'referer');
      return frameId === mainFrameId && !pageRequested && !hasReferer ? 'BlockedByClient' : 'Aborted';
    },
  };
}

async function settleInterception(target: FenceTarget, method: string, params: Record<string, unknown>): Promise<void> {
  try {
    await target.send(method, params);
  } catch (error) {
    if (!isRetiredFetchInterceptionError(error)) throw error;
  }
}

type TabFence = ReturnType<typeof createTabFence>;

const tabFences = new WeakMap<Page, TabFence>();

function createTabFence(page: Page, session: CDPSession) {
  let mainFrameId: string | undefined;
  const states = new Map<FenceTarget, TargetState>();
  const invocations = new Set<FenceInvocation>();
  let released: Promise<unknown> = Promise.resolve();
  let change = createDeferred<undefined>();
  const standing = createStandingNavigationPolicy();
  const notify = (): void => {
    change.resolve(undefined);
    change = createDeferred<undefined>();
  };
  const failInvocations = (error: unknown): void => {
    for (const invocation of invocations) invocation.fail(error);
  };
  // Chrome answers a target's renderer commands only once that target's pending document commits or stops.
  const answeredUnlessHeld = async (target: FenceTarget, operation: Promise<unknown>): Promise<void> => {
    const progress = { settled: false };
    const isSettled = (): boolean => progress.settled;
    const isHeld = (): boolean => states.get(target)?.documentPending() === true;
    const settled = operation.finally(() => {
      progress.settled = true;
      notify();
    });
    const held = async (): Promise<void> => {
      for (;;) {
        while (!isSettled() && !isHeld()) await change.promise;
        if (isSettled()) break;
        await session.send('Target.getTargetInfo');
        if (!isSettled() && isHeld()) return;
      }
      await settled;
    };
    await Promise.race([settled, held()]);
  };
  const decideStanding = async (
    target: FenceTarget,
    event: PausedRequest,
    frameId: string | undefined,
    pageRequested: boolean,
  ): Promise<void> => {
    const errorReason = await standing.denial({
      url: event.request.url,
      headers: event.request.headers,
      ...(frameId !== undefined ? { frameId } : {}),
      ...(mainFrameId !== undefined ? { mainFrameId } : {}),
      pageRequested,
    });
    await (
      errorReason === undefined
        ? settleInterception(target, 'Fetch.continueRequest', { requestId: event.requestId })
        : settleInterception(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason })
    ).catch((error: unknown) => {
      if (states.has(target))
        console.warn(
          `[browserclaw] could not settle a document requested between browser actions: ${error instanceof Error ? error.message : String(error)}`,
        );
    });
  };
  const enableFetch = (target: FenceTarget): Promise<unknown> =>
    target.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
  let networkEnabled = new Map<FenceTarget, Promise<unknown>>();
  const enableNetwork = (target: FenceTarget): Promise<unknown> => {
    const pending =
      networkEnabled.get(target) ??
      target.send('Network.enable').catch((error: unknown) => {
        if (states.has(target)) throw error;
      });
    networkEnabled.set(target, pending);
    return pending;
  };
  const attachTarget = async (target: FenceTarget): Promise<void> => {
    const documents = new Map<string, string | undefined>();
    const finishedDocuments = new Set<string>();
    const transferredFrames = new Set<string>();
    let documentPending = false;
    const setDocumentPending = (pending: boolean): void => {
      if (documentPending === pending) return;
      documentPending = pending;
      notify();
    };
    const hostsFrame = (frameId: string | undefined): boolean =>
      frameId === undefined || frameId === (target.parent ? target.frameId : mainFrameId);
    const onRequestWillBeSent = (event: TrackedRequest): void => {
      if (
        invocations.size > 0 &&
        event.type === 'Document' &&
        !finishedDocuments.has(event.requestId) &&
        !(event.frameId !== undefined && transferredFrames.has(event.frameId))
      ) {
        documents.set(event.requestId, event.frameId);
        notify();
      }
    };
    const onLoadingDone = (event: { requestId: string }): void => {
      if (documents.delete(event.requestId)) {
        finishedDocuments.add(event.requestId);
        notify();
      }
    };
    const onFrameNavigated = (event: { frame: { id: string } }): void => {
      for (const [requestId, frameId] of documents)
        if (frameId === event.frame.id) {
          documents.delete(requestId);
          finishedDocuments.add(requestId);
        }
      if (hostsFrame(event.frame.id)) documentPending = false;
      notify();
    };
    const onFrameStoppedLoading = (event: { frameId: string }): void => {
      if (hostsFrame(event.frameId)) setDocumentPending(false);
    };
    const decide = async (event: PausedRequest, remaining: FenceInvocation[]): Promise<void> => {
      if (remaining.length === 0) {
        await settleInterception(target, 'Fetch.continueRequest', { requestId: event.requestId });
        return;
      }
      const [invocation, ...rest] = remaining;
      const { policy, handleDocument } = invocation;
      try {
        if (invocation.isOpen()) {
          if (handleDocument) {
            const isTopLevel = !target.parent && (event.frameId === undefined || event.frameId === mainFrameId);
            const retireDocument = (): void => {
              const frameId = event.frameId ?? (target.parent ? target.frameId : mainFrameId);
              const ids = new Set(
                [event.networkId, event.requestId].filter((id): id is string => id !== undefined && id !== ''),
              );
              for (const [requestId, documentFrameId] of documents)
                if (ids.has(requestId) || (frameId !== undefined && documentFrameId === frameId)) {
                  documents.delete(requestId);
                  finishedDocuments.add(requestId);
                }
              for (const id of ids) finishedDocuments.add(id);
              notify();
            };
            const next = async (): Promise<void> => {
              invocation.assertTargetCurrent();
              await decide(event, rest);
            };
            await handleDocument(
              {
                continue: next,
                fallback: next,
                abort: async () => {
                  await settleInterception(target, 'Fetch.failRequest', {
                    requestId: event.requestId,
                    errorReason: 'Failed',
                  });
                  retireDocument();
                },
                preserve: async () => {
                  await settleInterception(target, 'Fetch.failRequest', {
                    requestId: event.requestId,
                    errorReason: 'Aborted',
                  });
                  retireDocument();
                },
              },
              { url: () => event.request.url, isTopLevel: () => isTopLevel },
            );
            return;
          }
          if (event.resourceType === 'Document')
            await assertBrowserNavigationAllowed({ url: event.request.url, ...policy });
          if (!states.has(target)) return;
          if (invocation.isOpen()) {
            await decide(event, rest);
            return;
          }
        }
      } catch (error) {
        if (!states.has(target)) return;
        invocation.fail(error);
      }
      if (!states.has(target)) return;
      await settleInterception(target, 'Fetch.failRequest', {
        requestId: event.requestId,
        errorReason: 'Aborted',
      }).catch((error: unknown) => {
        if (states.has(target)) invocation.fail(error);
      });
    };
    const onRequestPaused = (event: PausedRequest): void => {
      if (hostsFrame(event.frameId)) setDocumentPending(true);
      if (event.networkId !== undefined && event.networkId !== '')
        onRequestWillBeSent({ requestId: event.networkId, type: event.resourceType, frameId: event.frameId });
      const frameId = event.frameId ?? (target.parent ? target.frameId : mainFrameId);
      const pageRequested = standing.pageRequested(frameId, event);
      const claiming = [...invocations].filter((invocation) => invocation.admitsDocuments());
      const operation = (
        claiming.length > 0 ? decide(event, claiming) : decideStanding(target, event, frameId, pageRequested)
      ).catch((error: unknown) => {
        console.warn(
          `[browserclaw] navigation fence decision failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      for (const invocation of claiming) invocation.inFlight.add(operation);
      void operation.then(() => {
        for (const invocation of claiming) invocation.inFlight.delete(operation);
        notify();
      });
    };
    const stopObserving = standing.observe(target.events);
    const state: TargetState = {
      documents,
      finishedDocuments,
      transferredFrames,
      documentPending: () => documentPending,
      removeListeners: () => {
        target.events.off('Fetch.requestPaused', onRequestPaused);
        target.events.off('Network.requestWillBeSent', onRequestWillBeSent);
        target.events.off('Network.loadingFinished', onLoadingDone);
        target.events.off('Network.loadingFailed', onLoadingDone);
        target.events.off('Page.frameNavigated', onFrameNavigated);
        target.events.off('Page.frameStoppedLoading', onFrameStoppedLoading);
        stopObserving();
      },
    };
    states.set(target, state);
    target.events.on('Fetch.requestPaused', onRequestPaused);
    target.events.on('Network.requestWillBeSent', onRequestWillBeSent);
    target.events.on('Network.loadingFinished', onLoadingDone);
    target.events.on('Network.loadingFailed', onLoadingDone);
    target.events.on('Page.frameNavigated', onFrameNavigated);
    target.events.on('Page.frameStoppedLoading', onFrameStoppedLoading);
    if (target.parent && target.frameId !== undefined) {
      const parentState = states.get(target.parent);
      parentState?.transferredFrames.add(target.frameId);
      for (const [requestId, frameId] of parentState?.documents ?? [])
        if (frameId === target.frameId) {
          parentState?.documents.delete(requestId);
          parentState?.finishedDocuments.add(requestId);
        }
    }
    notify();
    await target.send('Page.enable');
    if (invocations.size > 0) await enableNetwork(target);
    await enableFetch(target);
  };
  const dispose = (): void => {
    tabFences.delete(page);
    for (const state of states.values()) state.removeListeners();
    for (const disposer of disposers) disposer();
    disposers.clear();
    states.clear();
    page.off('close', onPageClose);
    void session.detach().catch(() => undefined);
  };
  const detachTarget = (target: FenceTarget): void => {
    states.get(target)?.removeListeners();
    states.delete(target);
    if (target.parent && target.frameId !== undefined)
      states.get(target.parent)?.transferredFrames.delete(target.frameId);
    else if (!page.isClosed()) {
      dispose();
      failInvocations(new Error('Browser navigation authority target detached'));
    }
    notify();
  };
  // CDPSession has no child-session factory: non-flat Target messages keep frame targets under this session.
  const initialization = new Set<Promise<void>>();
  const disposers = new Set<() => void>();
  const rootEvents = new EventEmitter();
  const rawSession = session as unknown as {
    send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    on: (event: string, listener: (payload: unknown) => void) => void;
    off: (event: string, listener: (payload: unknown) => void) => void;
  };
  const rootTarget: FenceTarget = {
    events: rootEvents,
    send: (method, params) => rawSession.send(method, params),
  };
  for (const name of [
    'Network.requestWillBeSent',
    'Network.loadingFinished',
    'Network.loadingFailed',
    'Fetch.requestPaused',
    'Page.frameNavigated',
    'Page.frameStoppedLoading',
    'Page.frameRequestedNavigation',
    'Page.frameDetached',
    'Target.attachedToTarget',
    'Target.receivedMessageFromTarget',
    'Target.detachedFromTarget',
  ]) {
    const forward = (payload: unknown): void => {
      rootEvents.emit(name, payload);
    };
    rawSession.on(name, forward);
    disposers.add(() => {
      rawSession.off(name, forward);
    });
  }
  const onSessionClose = (): void => {
    rootEvents.emit('navigationDetached');
    detachTarget(rootTarget);
  };
  rawSession.on('close', onSessionClose);
  disposers.add(() => {
    rawSession.off('close', onSessionClose);
  });
  const adoptTarget = async (target: FenceTarget, isChild = false): Promise<void> => {
    const children = new Map<string, { target: FenceTarget; reject: (error: Error) => void }>();
    const onAttached = (event: AttachedTarget): void => {
      const events = new EventEmitter();
      const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();
      let nextId = 0;
      let detached = false;
      const reject = (error: Error): void => {
        if (detached) return;
        detached = true;
        for (const command of pending.values()) command.reject(error);
        pending.clear();
        events.emit('navigationDetached');
        detachTarget(child);
      };
      events.on('protocol', (message: { id?: number; result?: unknown; error?: { message: string } }) => {
        if (message.id === undefined) return;
        const command = pending.get(message.id);
        if (!command) return;
        pending.delete(message.id);
        if (message.error) command.reject(new Error(message.error.message));
        else command.resolve(message.result);
      });
      const child: FenceTarget = {
        events,
        parent: target,
        frameId: event.targetInfo.targetId,
        send: (method, params) => {
          if (detached) return Promise.reject(new Error('Navigation frame target detached'));
          const id = ++nextId;
          const result = new Promise<unknown>((resolve, rejectCommand) => {
            pending.set(id, { resolve, reject: rejectCommand });
          });
          target
            .send('Target.sendMessageToTarget', {
              sessionId: event.sessionId,
              message: JSON.stringify({ id, method, params }),
            })
            .catch((error: unknown) => {
              pending.get(id)?.reject(error);
              pending.delete(id);
            });
          return result;
        },
      };
      children.set(event.sessionId, { target: child, reject });
      standing.frameCommitted(event.targetInfo.targetId, event.targetInfo.url);
      const init = adoptTarget(child, true).catch((error: unknown) => {
        if (!detached) failInvocations(error);
      });
      initialization.add(init);
      notify();
      void init.then(() => {
        initialization.delete(init);
        notify();
      });
    };
    const onMessage = (event: TargetMessage): void => {
      const child = children.get(event.sessionId);
      if (!child) return;
      try {
        const parsed: unknown = JSON.parse(event.message);
        if (!isRecord(parsed)) throw new Error('Invalid navigation target protocol message');
        const message = {
          id: typeof parsed.id === 'number' ? parsed.id : undefined,
          method: typeof parsed.method === 'string' ? parsed.method : undefined,
          params: isRecord(parsed.params) ? parsed.params : undefined,
          result: parsed.result,
          error: isRecord(parsed.error)
            ? {
                message:
                  typeof parsed.error.message === 'string' ? parsed.error.message : 'Navigation target command failed',
              }
            : undefined,
        };
        child.target.events.emit('protocol', message);
        if (message.method !== undefined) child.target.events.emit(message.method, message.params);
      } catch (error) {
        failInvocations(error);
      }
    };
    const onDetached = (event: { sessionId: string }): void => {
      const child = children.get(event.sessionId);
      if (!child) return;
      children.delete(event.sessionId);
      child.reject(new Error('Navigation frame target detached'));
    };
    const removeListeners = (): void => {
      target.events.off('navigationDetached', onAncestorDetached);
      target.events.off('Target.attachedToTarget', onAttached);
      target.events.off('Target.receivedMessageFromTarget', onMessage);
      target.events.off('Target.detachedFromTarget', onDetached);
      for (const child of children.values()) child.reject(new Error('Navigation authority fence ended'));
    };
    const onAncestorDetached = (): void => {
      disposers.delete(removeListeners);
      for (const child of children.values()) child.reject(new Error('Navigation frame ancestor detached'));
      children.clear();
    };
    target.events.on('navigationDetached', onAncestorDetached);
    target.events.on('Target.attachedToTarget', onAttached);
    target.events.on('Target.receivedMessageFromTarget', onMessage);
    target.events.on('Target.detachedFromTarget', onDetached);
    disposers.add(removeListeners);
    await attachTarget(target);
    await target.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: false,
      filter: [{ type: 'iframe' }, { exclude: true }],
    });
    if (isChild) await target.send('Runtime.runIfWaitingForDebugger');
  };
  const onPageClose = (): void => {
    for (const state of states.values()) state.documents.clear();
    dispose();
    notify();
  };
  page.on('close', onPageClose);
  const ready = (async () => {
    const tree = (await rootTarget.send('Page.getFrameTree')) as { frameTree: FrameTree };
    mainFrameId = tree.frameTree.frame.id;
    standing.seed(tree.frameTree);
    await adoptTarget(rootTarget);
  })();
  ready.catch(dispose);
  return {
    session: rootTarget,
    states,
    initialization,
    invocations,
    standing,
    ready,
    notify,
    changed: () => change.promise,
    answeredUnlessHeld,
    untilReleased: async (): Promise<void> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          released,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('Browser navigation interception was not released in time'));
            }, NAVIGATION_AUTHORITY_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    claim: () => Promise.all([...states.keys()].map((target) => answeredUnlessHeld(target, enableNetwork(target)))),
    release: (): Promise<unknown> => {
      networkEnabled = new Map();
      released = Promise.allSettled(
        [...states.keys()].map((target) => answeredUnlessHeld(target, target.send('Network.disable'))),
      ).then(() => {
        for (const state of states.values()) {
          state.documents.clear();
          state.finishedDocuments.clear();
        }
      });
      return released;
    },
  };
}

export type NavigationAuthorityRelease = ((options?: {
  stopLoading?: boolean;
  handOffPendingDocuments?: boolean;
}) => Promise<unknown>) & { stopAdmittingDocuments: () => void };

export async function installNavigationAuthorityFence(
  page: Page,
  policy: BrowserNavigationPolicyOptions,
  onFailure: (error: unknown) => void,
  handleDocument?: FencedDocumentHandler,
): Promise<NavigationAuthorityRelease> {
  let fence = tabFences.get(page);
  if (!fence) {
    const session = await page.context().newCDPSession(page);
    fence = tabFences.get(page);
    if (fence) void session.detach().catch(() => undefined);
    else {
      fence = createTabFence(page, session);
      tabFences.set(page, fence);
    }
  }
  const tab = fence;
  const { session, states, initialization, invocations, notify } = tab;
  const inFlight = new Set<Promise<void>>();
  let closed = false;
  let failed = false;
  let admitting = true;
  const fail = (error: unknown): void => {
    failed = true;
    onFailure(error);
    notify();
  };
  const assertTargetCurrent = (): void => {
    if (closed || failed) throw new Error('Browser navigation authority fence is no longer admitting targets');
  };
  const invocation: FenceInvocation = {
    policy,
    handleDocument,
    inFlight,
    admitsDocuments: () => admitting,
    isOpen: () => !closed && !failed,
    fail,
    assertTargetCurrent,
  };
  invocations.add(invocation);
  tab.standing.set(policy);
  // Later documents go to the standing policy, so a page that keeps asking cannot hold a finished action open.
  const stopAdmittingDocuments = (): void => {
    admitting = false;
  };
  const cleanUp = async (options: Parameters<NavigationAuthorityRelease>[0] = {}): Promise<unknown> => {
    stopAdmittingDocuments();
    const deadline = createDeferred<never>();
    const timer = setTimeout(() => {
      deadline.reject(new Error('Browser navigation did not settle before authority cleanup'));
    }, NAVIGATION_AUTHORITY_TIMEOUT_MS);
    const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadline.promise]);
    const stopLoading = async (): Promise<void> => {
      if (!page.isClosed()) {
        await bounded(session.send('Page.stopLoading'));
        for (const state of states.values()) state.documents.clear();
        notify();
      }
    };
    const drain = async (): Promise<void> => {
      while (!page.isClosed() && (inFlight.size > 0 || initialization.size > 0))
        await bounded(Promise.allSettled([...inFlight, ...initialization]));
    };
    try {
      await bounded(tab.answeredUnlessHeld(session, session.send('Runtime.evaluate', { expression: 'void 0' })));
      let stopped = false;
      for (;;) {
        const changed = tab.changed();
        if (!stopped && options.stopLoading === true) {
          await stopLoading();
          stopped = true;
        }
        const documentsPending =
          options.handOffPendingDocuments !== true && [...states.values()].some((state) => state.documents.size > 0);
        if (failed || page.isClosed() || (!documentsPending && inFlight.size === 0 && initialization.size === 0)) break;
        await bounded(changed);
      }
      closed = true;
      if (failed) await stopLoading();
      await drain();
      if (failed) {
        await stopLoading();
        await drain();
      }
      invocations.delete(invocation);
      notify();
      if (invocations.size === 0) await bounded(tab.release());
      return undefined;
    } catch (error) {
      closed = true;
      if (page.isClosed()) {
        invocations.delete(invocation);
        notify();
        return undefined;
      }
      fail(error);
      for (const state of states.values()) state.documents.clear();
      // A closed invocation left here would refuse every later document on the tab.
      invocations.delete(invocation);
      notify();
      if (invocations.size === 0) void tab.release();
      return error;
    } finally {
      clearTimeout(timer);
    }
  };
  const release: NavigationAuthorityRelease = Object.assign(cleanUp, { stopAdmittingDocuments });
  let claimed = false;
  try {
    await tab.ready;
    await tab.untilReleased();
    claimed = true;
    await tab.claim();
    while (initialization.size > 0) await Promise.all(initialization);
    assertTargetCurrent();
  } catch (error) {
    fail(error);
    if (claimed) await release();
    else {
      invocations.delete(invocation);
      notify();
    }
    throw error;
  }
  return release;
}
