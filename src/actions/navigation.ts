import type { Browser, BrowserContext, Page, Route, Request, Frame } from 'playwright-core';

import { isCdpUrlProxyRouted } from '../chrome-launcher.js';
import {
  BrowserTabNotFoundError,
  connectBrowser,
  getPageForTargetId,
  ensurePageState,
  observeContext,
  getStealthEnabledForCdpUrl,
  hasCachedPlaywrightBrowserConnection,
  evictStaleConnection,
  isRecoverablePlaywrightDisconnectError,
  pageTargetId,
  getAllPages,
  forceDisconnectPlaywrightConnection,
  resolvePageByTargetIdOrThrow,
  withPageScopedCdpClient,
  isBlockedTarget,
  isBlockedPageRef,
  isBrowserInternalTargetUrl,
  quarantineBlockedTarget,
  assertSelectedPageAllowed,
  clearBlockedPageRef,
  clearBlockedTarget,
} from '../connection.js';
import { runPageEmulationTransition, setViewportSizeOnPage } from '../page-emulation.js';
import { pageTargetInfo } from '../page-target.js';
import {
  InvalidBrowserNavigationUrlError,
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  withBrowserNavigationPolicy,
} from '../security.js';
import type { BrowserTab, DownloadResult, SsrfPolicy } from '../types.js';

import {
  NAVIGATION_DOWNLOAD_GRACE_MS,
  NAVIGATION_DOWNLOAD_TIMEOUT_MESSAGE,
  armNavigationDownloadCapture,
  isDownloadStartingNavigationError,
} from './download.js';

/** Navigation-policy proxy-mode addendum for a cdpUrl whose Chrome is proxy-routed. */
function proxyModeOpts(cdpUrl: string): { browserProxyMode?: 'explicit-browser-proxy' } {
  return isCdpUrlProxyRouted(cdpUrl) ? { browserProxyMode: 'explicit-browser-proxy' } : {};
}

const recordingContexts = new Map<string, BrowserContext>();

export function clearRecordingContext(cdpUrl: string): void {
  recordingContexts.delete(cdpUrl);
}

async function createRecordingContext(
  browser: Browser,
  cdpUrl: string,
  recordVideo: { dir: string; size?: { width: number; height: number } },
  stealth?: boolean,
): Promise<BrowserContext> {
  const context = await browser.newContext({ recordVideo });
  await observeContext(context, { stealth: stealth ?? getStealthEnabledForCdpUrl(cdpUrl) });
  recordingContexts.set(cdpUrl, context);
  context.on('close', () => recordingContexts.delete(cdpUrl));
  return context;
}

function isRetryableNavigateError(err: unknown): boolean {
  const msg = typeof err === 'string' ? err.toLowerCase() : err instanceof Error ? err.message.toLowerCase() : '';
  return msg.includes('frame has been detached') || msg.includes('target page, context or browser has been closed');
}

function isPolicyDenyNavigationError(err: unknown): boolean {
  return err instanceof InvalidBrowserNavigationUrlError;
}

function classifyBrowserDocumentNavigationRequest(page: Page, request: Request): 'top-level' | 'subframe' | null {
  let kind: 'top-level' | 'subframe';
  let frameResolutionFailed = false;
  try {
    kind = request.frame() === page.mainFrame() ? 'top-level' : 'subframe';
  } catch {
    kind = 'top-level';
    frameResolutionFailed = true;
  }
  try {
    if (request.isNavigationRequest()) return kind;
  } catch {
    /* fall through to resourceType check */
  }
  try {
    if (request.resourceType() === 'document') return kind;
  } catch {
    /* fail closed for requests whose frame cannot be resolved */
  }
  return frameResolutionFailed ? 'subframe' : null;
}

async function continueRouteSafely(route: Route): Promise<void> {
  try {
    await route.continue();
  } catch (err) {
    if (err instanceof Error && /already handled/i.test(err.message)) return;
    throw err;
  }
}

async function fallbackRouteSafely(route: Route): Promise<void> {
  try {
    await route.fallback();
  } catch (err) {
    if (err instanceof Error && /already handled/i.test(err.message)) return;
    throw err;
  }
}

type NavigationRouteHandler = (route: Route, request: Request) => Promise<void>;

async function removePageNavigationRequestGuard(page: Page, handler: NavigationRouteHandler): Promise<unknown> {
  try {
    await page.unroute('**', handler);
  } catch (err) {
    try {
      if (page.isClosed()) return;
    } catch {
      /* retain the unroute failure */
    }
    return err;
  }
}

const sourcePreservedPolicyDenials = new WeakSet();

export function wasBrowserNavigationSourcePreservedAfterPolicyDenial(error: unknown): boolean {
  return typeof error === 'object' && error !== null && sourcePreservedPolicyDenials.has(error);
}

/** Guard selected-page document requests before an interaction can dispatch them. */
type NavigationPolicyDenialEvent =
  | { state: 'detected'; error: unknown }
  | { state: 'handled'; error: unknown; sourcePreserved: boolean };

interface PageNavigationRequestGuardOptions<T> {
  cdpUrl: string;
  page: Page;
  ssrfPolicy?: SsrfPolicy;
  action: (baselineUrl: string) => Promise<T>;
  onPolicyCheckStarted?: (check: Promise<void>) => void;
  onPolicyDenied?: (event: NavigationPolicyDenialEvent) => void;
}

type GuardedActionOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export async function withPageNavigationRequestGuard<T>(opts: PageNavigationRequestGuardOptions<T>): Promise<T> {
  // Keep Browserclaw's secure default even when callers omit a policy.
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy ?? {}, proxyModeOpts(opts.cdpUrl));
  const inFlight = new Set<Promise<void>>();
  const guardState = { hasError: false };
  let firstGuardError: unknown;
  let deniedDocumentCount = 0;
  let fulfilledDeniedDocumentCount = 0;
  let pendingDeniedDocumentCount = 0;
  let unpreservedDocumentCount = 0;
  let policyDeniedDetected = false;
  let lastNotifiedSourcePreserved: boolean | undefined;
  const recordGuardError = (err: unknown): void => {
    if (guardState.hasError) {
      if (!isPolicyDenyNavigationError(firstGuardError) && isPolicyDenyNavigationError(err)) firstGuardError = err;
      return;
    }
    guardState.hasError = true;
    firstGuardError = err;
  };
  const emitPolicyDenied = (event: NavigationPolicyDenialEvent): void => {
    try {
      opts.onPolicyDenied?.(event);
    } catch {
      /* observers cannot weaken the policy guard */
    }
  };
  const updateImmediateSourcePreservation = (): void => {
    if (typeof firstGuardError !== 'object' || firstGuardError === null) return;
    let sourcePreserved: boolean | undefined;
    if (unpreservedDocumentCount > 0) sourcePreserved = false;
    else if (
      isPolicyDenyNavigationError(firstGuardError) &&
      deniedDocumentCount > 0 &&
      pendingDeniedDocumentCount === 0 &&
      fulfilledDeniedDocumentCount === deniedDocumentCount
    )
      sourcePreserved = true;
    if (sourcePreserved === undefined) {
      sourcePreservedPolicyDenials.delete(firstGuardError);
      return;
    }
    if (sourcePreserved) sourcePreservedPolicyDenials.add(firstGuardError);
    else sourcePreservedPolicyDenials.delete(firstGuardError);
    if (policyDeniedDetected && sourcePreserved !== lastNotifiedSourcePreserved) {
      lastNotifiedSourcePreserved = sourcePreserved;
      emitPolicyDenied({ state: 'handled', error: firstGuardError, sourcePreserved });
    }
  };
  const notifyPolicyDeniedDetected = (): void => {
    if (policyDeniedDetected || !isPolicyDenyNavigationError(firstGuardError)) return;
    policyDeniedDetected = true;
    emitPolicyDenied({ state: 'detected', error: firstGuardError });
  };
  const stopGuardedRoute = async (route: Route, preserveDocument: boolean, requestError: unknown): Promise<void> => {
    if (preserveDocument && isPolicyDenyNavigationError(requestError)) {
      deniedDocumentCount++;
      pendingDeniedDocumentCount++;
      try {
        await route.fulfill({ status: 204, body: '' });
        fulfilledDeniedDocumentCount++;
        pendingDeniedDocumentCount--;
        updateImmediateSourcePreservation();
        return;
      } catch {
        pendingDeniedDocumentCount--;
      }
    }
    if (preserveDocument) {
      unpreservedDocumentCount++;
      updateImmediateSourcePreservation();
    }
    await route.abort().catch(() => {
      /* already closed/handled */
    });
  };
  const handleRoute: NavigationRouteHandler = async (route, request) => {
    if (!classifyBrowserDocumentNavigationRequest(opts.page, request)) {
      try {
        await fallbackRouteSafely(route);
      } catch (err) {
        recordGuardError(err);
        await stopGuardedRoute(route, false, err);
      }
      return;
    }
    const policyCheck = assertBrowserNavigationAllowed({ url: request.url(), ...navigationPolicy });
    try {
      opts.onPolicyCheckStarted?.(policyCheck);
    } catch {
      /* observers cannot weaken the policy guard */
    }
    try {
      await policyCheck;
    } catch (err) {
      recordGuardError(err);
      notifyPolicyDeniedDetected();
      await stopGuardedRoute(route, true, err);
      return;
    }
    try {
      await fallbackRouteSafely(route);
    } catch (err) {
      recordGuardError(err);
      await stopGuardedRoute(route, true, err);
    }
  };
  const handler: NavigationRouteHandler = (route, request) => {
    const operation = handleRoute(route, request).catch(async (err: unknown) => {
      recordGuardError(err);
      await stopGuardedRoute(route, true, err);
    });
    inFlight.add(operation);
    void operation.finally(() => inFlight.delete(operation));
    return operation;
  };
  try {
    await opts.page.route('**', handler);
  } catch (err) {
    await removePageNavigationRequestGuard(opts.page, handler);
    throw err;
  }
  let outcome: GuardedActionOutcome<T>;
  try {
    let baselineUrl = opts.page.url();
    await assertBrowserNavigationResultAllowed({ url: baselineUrl, ...navigationPolicy });
    const latestUrl = opts.page.url();
    if (latestUrl !== baselineUrl) {
      await assertBrowserNavigationResultAllowed({ url: latestUrl, ...navigationPolicy });
      baselineUrl = latestUrl;
    }
    outcome = { ok: true, value: await opts.action(baselineUrl) };
  } catch (err) {
    outcome = { ok: false, error: err };
    if (isPolicyDenyNavigationError(err)) {
      recordGuardError(err);
      notifyPolicyDeniedDetected();
      unpreservedDocumentCount++;
      updateImmediateSourcePreservation();
    }
  }
  const cleanupError = await removePageNavigationRequestGuard(opts.page, handler);
  while (inFlight.size > 0) await Promise.allSettled(inFlight);
  if (guardState.hasError) {
    const sourcePreserved =
      isPolicyDenyNavigationError(firstGuardError) &&
      deniedDocumentCount > 0 &&
      fulfilledDeniedDocumentCount === deniedDocumentCount &&
      unpreservedDocumentCount === 0 &&
      !(!outcome.ok && isPolicyDenyNavigationError(outcome.error));
    if (typeof firstGuardError === 'object' && firstGuardError !== null) {
      if (sourcePreserved) sourcePreservedPolicyDenials.add(firstGuardError);
      else sourcePreservedPolicyDenials.delete(firstGuardError);
    }
    throw toNavigationError(firstGuardError);
  }
  if (!outcome.ok) throw toNavigationError(outcome.error);
  if (cleanupError !== undefined) throw toNavigationError(cleanupError);
  return outcome.value;
}

async function closeBlockedNavigationTarget(opts: { cdpUrl: string; page: Page; targetId?: string }): Promise<void> {
  await quarantineBlockedTarget(opts);
  await opts.page.close().catch((e: unknown) => {
    console.warn('[browserclaw] failed to close blocked page', e);
  });
}

export async function assertPageNavigationCompletedSafely(opts: {
  cdpUrl: string;
  page: Page;
  response: Awaited<ReturnType<Page['goto']>>;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<void> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, proxyModeOpts(opts.cdpUrl));
  try {
    await assertBrowserNavigationRedirectChainAllowed({ request: opts.response?.request(), ...navigationPolicy });
  } catch (err) {
    if (isPolicyDenyNavigationError(err))
      await quarantineBlockedTarget({ cdpUrl: opts.cdpUrl, page: opts.page, targetId: opts.targetId });
    throw err;
  }
  await assertSelectedPageAllowed(opts);
}

// ── Interaction-time navigation guard ──────────────────────────────

const INTERACTION_NAVIGATION_GRACE_MS = 250;
const pendingInteractionNavigationGuardCleanup = new WeakMap<Page, () => void>();

export function didCrossDocumentUrlChange(page: Page, previousUrl: string): boolean {
  const currentUrl = page.url();
  if (currentUrl === previousUrl) return false;
  try {
    const prev = new URL(previousUrl);
    const curr = new URL(currentUrl);
    if (prev.origin === curr.origin && prev.pathname === curr.pathname && prev.search === curr.search) return false;
  } catch {
    /* invalid URLs — treat as cross-document */
  }
  return true;
}

function isHashOnlyNavigation(currentUrl: string, previousUrl: string): boolean {
  if (currentUrl === previousUrl) return false;
  try {
    const prev = new URL(previousUrl);
    const curr = new URL(currentUrl);
    return prev.origin === curr.origin && prev.pathname === curr.pathname && prev.search === curr.search;
  } catch {
    return false;
  }
}

function isMainFrameNavigation(page: Page, frame: Frame): boolean {
  if (typeof page.mainFrame !== 'function') return true;
  return frame === page.mainFrame();
}

async function assertSubframeNavigationAllowed(
  cdpUrl: string,
  frameUrl: string,
  ssrfPolicy?: SsrfPolicy,
): Promise<void> {
  if (!ssrfPolicy) return;
  if (!frameUrl.startsWith('http://') && !frameUrl.startsWith('https://')) return;
  await assertBrowserNavigationResultAllowed({
    url: frameUrl,
    ...withBrowserNavigationPolicy(ssrfPolicy, proxyModeOpts(cdpUrl)),
  });
}

function snapshotNetworkFrameUrl(frame: Frame): string | null {
  try {
    const frameUrl = frame.url();
    return frameUrl.startsWith('http://') || frameUrl.startsWith('https://') ? frameUrl : null;
  } catch {
    return null;
  }
}

interface ObservedNavigations {
  mainFrameNavigated: boolean;
  subframes: string[];
}

function formatThrown(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return 'unknown error';
}

function toNavigationError(value: unknown): Error {
  return value instanceof Error ? value : new Error(formatThrown(value));
}

async function assertObservedDelayedNavigations(opts: {
  cdpUrl: string;
  page: Page;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
  observed: ObservedNavigations;
}): Promise<void> {
  let subframeError: Error | undefined;
  try {
    for (const frameUrl of opts.observed.subframes)
      await assertSubframeNavigationAllowed(opts.cdpUrl, frameUrl, opts.ssrfPolicy);
  } catch (err) {
    subframeError = err instanceof Error ? err : new Error(formatThrown(err));
  }
  if (opts.observed.mainFrameNavigated) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }
  if (subframeError !== undefined) throw subframeError;
}

function observeDelayedInteractionNavigation(page: Page, previousUrl: string): Promise<ObservedNavigations> {
  if (didCrossDocumentUrlChange(page, previousUrl)) {
    return Promise.resolve({ mainFrameNavigated: true, subframes: [] });
  }
  if (typeof page.on !== 'function' || typeof page.off !== 'function') {
    return Promise.resolve({ mainFrameNavigated: false, subframes: [] });
  }
  return new Promise((resolve) => {
    const subframes: string[] = [];
    const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
    const cleanup = (): void => {
      if (timer.id !== undefined) clearTimeout(timer.id);
      page.off('framenavigated', onFrameNavigated);
    };
    const onFrameNavigated = (frame: Frame): void => {
      if (!isMainFrameNavigation(page, frame)) {
        const frameUrl = snapshotNetworkFrameUrl(frame);
        if (frameUrl !== null) subframes.push(frameUrl);
        return;
      }
      if (isHashOnlyNavigation(page.url(), previousUrl)) return;
      cleanup();
      resolve({ mainFrameNavigated: true, subframes });
    };
    timer.id = setTimeout(() => {
      cleanup();
      resolve({ mainFrameNavigated: didCrossDocumentUrlChange(page, previousUrl), subframes });
    }, INTERACTION_NAVIGATION_GRACE_MS);
    page.on('framenavigated', onFrameNavigated);
  });
}

function scheduleDelayedInteractionNavigationGuard(opts: {
  cdpUrl: string;
  page: Page;
  previousUrl: string;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<void> {
  if (!opts.ssrfPolicy) return Promise.resolve();
  const page = opts.page;
  if (didCrossDocumentUrlChange(page, opts.previousUrl)) {
    return assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }
  if (typeof page.on !== 'function' || typeof page.off !== 'function') return Promise.resolve();
  // Cancels overlap when two interactions race on the same page (Promise.all).
  pendingInteractionNavigationGuardCleanup.get(opts.page)?.();
  return new Promise<void>((resolve, reject) => {
    const subframes: string[] = [];
    const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
    const settle = (err?: unknown): void => {
      cleanup();
      if (err !== undefined) {
        reject(err instanceof Error ? err : new Error(formatThrown(err)));
        return;
      }
      resolve();
    };
    const cleanup = (): void => {
      if (timer.id !== undefined) clearTimeout(timer.id);
      page.off('framenavigated', onFrameNavigated);
      if (pendingInteractionNavigationGuardCleanup.get(opts.page) === settle) {
        pendingInteractionNavigationGuardCleanup.delete(opts.page);
      }
    };
    const onFrameNavigated = (frame: Frame): void => {
      if (!isMainFrameNavigation(page, frame)) {
        const frameUrl = snapshotNetworkFrameUrl(frame);
        if (frameUrl !== null) subframes.push(frameUrl);
        return;
      }
      if (isHashOnlyNavigation(page.url(), opts.previousUrl)) return;
      cleanup();
      assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
        observed: { mainFrameNavigated: true, subframes },
      }).then(() => {
        settle();
      }, settle);
    };
    timer.id = setTimeout(() => {
      cleanup();
      assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
        observed: {
          mainFrameNavigated: didCrossDocumentUrlChange(page, opts.previousUrl),
          subframes,
        },
      }).then(() => {
        settle();
      }, settle);
    }, INTERACTION_NAVIGATION_GRACE_MS);
    pendingInteractionNavigationGuardCleanup.set(opts.page, settle);
    page.on('framenavigated', onFrameNavigated);
  });
}

async function observeInteractionNavigationCompletedSafely<T>(opts: {
  action: () => Promise<T>;
  cdpUrl: string;
  page: Page;
  previousUrl: string;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<T> {
  const navPage = opts.page;
  const navState: { observed: boolean } = { observed: false };
  const subframeNavigationsDuringAction: string[] = [];
  const onFrameNavigated = (frame: Frame): void => {
    if (!isMainFrameNavigation(navPage, frame)) {
      const frameUrl = snapshotNetworkFrameUrl(frame);
      if (frameUrl !== null) subframeNavigationsDuringAction.push(frameUrl);
      return;
    }
    if (!isHashOnlyNavigation(opts.page.url(), opts.previousUrl)) navState.observed = true;
  };
  if (typeof navPage.on === 'function') navPage.on('framenavigated', onFrameNavigated);
  let result: T | undefined;
  let actionError: Error | undefined;
  try {
    result = await opts.action();
  } catch (err) {
    actionError = err instanceof Error ? err : new Error(formatThrown(err));
  } finally {
    if (typeof navPage.off === 'function') navPage.off('framenavigated', onFrameNavigated);
  }
  const navigationObserved = navState.observed || didCrossDocumentUrlChange(opts.page, opts.previousUrl);
  let subframeError: Error | undefined;
  try {
    for (const frameUrl of subframeNavigationsDuringAction) {
      await assertSubframeNavigationAllowed(opts.cdpUrl, frameUrl, opts.ssrfPolicy ?? {});
    }
  } catch (err) {
    subframeError = err instanceof Error ? err : new Error(formatThrown(err));
  }
  // `?? {}` enforces block-private even with no caller policy (secure by
  // default) — for observed, delayed, and error-path navigations alike.
  const effectivePolicy = opts.ssrfPolicy ?? {};
  if (navigationObserved) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      response: null,
      ssrfPolicy: effectivePolicy,
      targetId: opts.targetId,
    });
  } else if (actionError !== undefined) {
    const observed = await observeDelayedInteractionNavigation(opts.page, opts.previousUrl);
    if (observed.mainFrameNavigated || observed.subframes.length > 0) {
      await assertObservedDelayedNavigations({
        cdpUrl: opts.cdpUrl,
        page: opts.page,
        ssrfPolicy: effectivePolicy,
        targetId: opts.targetId,
        observed,
      });
    }
  } else {
    await scheduleDelayedInteractionNavigationGuard({
      cdpUrl: opts.cdpUrl,
      page: opts.page,
      previousUrl: opts.previousUrl,
      ssrfPolicy: effectivePolicy,
      targetId: opts.targetId,
    });
  }
  // Precedence: SSRF block > action error. The security signal wins.
  if (subframeError !== undefined) throw subframeError;
  if (actionError !== undefined) throw actionError;
  return result as T;
}

export async function assertInteractionNavigationCompletedSafely<T>(opts: {
  action: () => Promise<T>;
  abortPromise?: Promise<never>;
  cdpUrl: string;
  page: Page;
  previousUrl: string;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<T> {
  let observedPolicyError: unknown;
  let unsafeSourceQuarantine: Promise<void> | undefined;
  const quarantineUnsafeSource = (): Promise<void> => (unsafeSourceQuarantine ??= quarantineBlockedTarget(opts));
  const guardedAction = withPageNavigationRequestGuard({
    ...opts,
    onPolicyDenied: (event) => {
      observedPolicyError = event.error;
      if (event.state === 'handled' && !event.sourcePreserved) {
        void quarantineUnsafeSource().catch(() => {
          /* final guard reports the denial */
        });
      }
    },
    action: async (baselineUrl) => {
      let actionSettledAt: number | undefined;
      try {
        return await observeInteractionNavigationCompletedSafely({
          ...opts,
          previousUrl: baselineUrl,
          action: async () => {
            try {
              return await opts.action();
            } finally {
              actionSettledAt = Date.now();
            }
          },
        });
      } finally {
        if (actionSettledAt !== undefined) {
          const remainingMs = Math.max(0, INTERACTION_NAVIGATION_GRACE_MS - Math.max(0, Date.now() - actionSettledAt));
          if (remainingMs > 0)
            await new Promise<void>((resolve) => {
              setTimeout(resolve, remainingMs);
            });
          await assertPageNavigationCompletedSafely({ ...opts, response: null, ssrfPolicy: opts.ssrfPolicy ?? {} });
        }
      }
    },
  }).catch(async (err: unknown) => {
    if (isPolicyDenyNavigationError(err) && !wasBrowserNavigationSourcePreservedAfterPolicyDenial(err)) {
      await quarantineUnsafeSource();
    }
    throw err;
  });
  try {
    return await (opts.abortPromise ? Promise.race([guardedAction, opts.abortPromise]) : guardedAction);
  } catch (err) {
    // Pending checks stay owned by guardedAction; cancellation must not wait for DNS.
    // Denials already observed still outrank the caller's abort.
    if (observedPolicyError !== undefined) {
      await guardedAction;
      throw toNavigationError(observedPolicyError);
    }
    throw err;
  }
}

async function gotoPageWithNavigationGuard(opts: {
  cdpUrl: string;
  page: Page;
  url: string;
  timeoutMs: number;
  ssrfPolicy?: SsrfPolicy;
  targetId?: string;
}): Promise<Awaited<ReturnType<Page['goto']>>> {
  const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy, proxyModeOpts(opts.cdpUrl));
  const state: { blocked: Error | null } = { blocked: null };
  const safeAbort = async (route: Route): Promise<void> => {
    try {
      await route.abort();
    } catch (e) {
      if (e instanceof Error && /already handled/i.test(e.message)) return;
      console.warn('[browserclaw] route abort failed', e);
    }
  };
  const handler = async (route: Route, request: Request) => {
    if (state.blocked !== null) {
      await safeAbort(route);
      return;
    }
    const requestKind = classifyBrowserDocumentNavigationRequest(opts.page, request);
    if (!requestKind) {
      await continueRouteSafely(route);
      return;
    }
    try {
      await assertBrowserNavigationAllowed({ url: request.url(), ...navigationPolicy });
    } catch (err) {
      if (isPolicyDenyNavigationError(err)) {
        if (requestKind === 'top-level') {
          state.blocked = err as Error;
        } else {
          console.warn(
            `[browserclaw] blocked subframe navigation to ${request.url()}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        await safeAbort(route);
        return;
      }
      throw err;
    }
    await continueRouteSafely(route);
  };
  try {
    await opts.page.route('**', handler);
  } catch (err) {
    await removePageNavigationRequestGuard(opts.page, handler);
    throw err;
  }
  let response: Awaited<ReturnType<Page['goto']>> = null;
  let navigationFailed = false;
  let navigationError: unknown;
  try {
    response = await opts.page.goto(opts.url, { timeout: opts.timeoutMs, waitUntil: 'commit' });
  } catch (err) {
    navigationFailed = true;
    navigationError = err;
  }
  const cleanupError = await removePageNavigationRequestGuard(opts.page, handler);
  if (state.blocked !== null) {
    await closeBlockedNavigationTarget({ cdpUrl: opts.cdpUrl, page: opts.page, targetId: opts.targetId });
    throw state.blocked;
  }
  if (navigationFailed) throw toNavigationError(navigationError);
  if (cleanupError !== undefined) throw toNavigationError(cleanupError);
  return response;
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  /** @deprecated Use ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } instead */
  allowInternal?: boolean;
}): Promise<{ url: string; download?: DownloadResult }> {
  const url = opts.url.trim();
  if (!url) throw new Error('url is required');
  /* eslint-disable @typescript-eslint/no-deprecated */
  const policy =
    opts.allowInternal === true ? { ...opts.ssrfPolicy, dangerouslyAllowPrivateNetwork: true } : opts.ssrfPolicy;
  /* eslint-enable @typescript-eslint/no-deprecated */
  await assertBrowserNavigationAllowed({ url, ...withBrowserNavigationPolicy(policy, proxyModeOpts(opts.cdpUrl)) });

  const timeout = Math.max(1000, Math.min(120000, opts.timeoutMs ?? 20000));
  let page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: policy });
  let pageState = ensurePageState(page);

  const navigate = async () =>
    await gotoPageWithNavigationGuard({
      cdpUrl: opts.cdpUrl,
      page,
      url,
      timeoutMs: timeout,
      ssrfPolicy: policy,
      targetId: opts.targetId,
    });

  const navigateWithDownloadCapture = async (): Promise<{
    response: Awaited<ReturnType<typeof navigate>>;
    download?: DownloadResult;
  }> => {
    const capture = armNavigationDownloadCapture(page, pageState, timeout, url, policy, opts.cdpUrl);
    try {
      const response = await navigate();
      capture.cancel();
      return { response };
    } catch (err) {
      if (!capture.armed || !isDownloadStartingNavigationError(err, url)) {
        capture.cancel();
        throw err;
      }
      try {
        return { response: null, download: await capture.settle(NAVIGATION_DOWNLOAD_GRACE_MS) };
      } catch (downloadErr) {
        if (downloadErr instanceof Error && downloadErr.message === NAVIGATION_DOWNLOAD_TIMEOUT_MESSAGE) throw err;
        if (isPolicyDenyNavigationError(downloadErr))
          await closeBlockedNavigationTarget({ cdpUrl: opts.cdpUrl, page, targetId: opts.targetId });
        throw downloadErr;
      }
    }
  };

  let navigationResult;
  try {
    navigationResult = await navigateWithDownloadCapture();
  } catch (err) {
    if (!isRetryableNavigateError(err)) throw err;
    const recordingContext = recordingContexts.get(opts.cdpUrl);
    if (recordingContext) {
      if (recordingContext.browser() === page.context().browser()) recordingContexts.delete(opts.cdpUrl);
    }
    await forceDisconnectPlaywrightConnection({
      cdpUrl: opts.cdpUrl,
      page,
      targetId: opts.targetId,
      reason: 'retry navigate after detached frame',
      ssrfPolicy: policy,
    }).catch(() => {
      /* intentional no-op */
    });
    page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: policy });
    pageState = ensurePageState(page);
    navigationResult = await navigateWithDownloadCapture();
  }

  if (!navigationResult.download) {
    try {
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response: navigationResult.response,
        ssrfPolicy: policy,
        targetId: opts.targetId,
      });
    } catch (err) {
      if (isPolicyDenyNavigationError(err))
        await closeBlockedNavigationTarget({ cdpUrl: opts.cdpUrl, page, targetId: opts.targetId });
      throw err;
    }
  }
  return {
    url: navigationResult.download?.url ?? page.url(),
    ...(navigationResult.download ? { download: navigationResult.download } : {}),
  };
}

async function listPagesViaPlaywrightOnce(cdpUrl: string, browser: Browser): Promise<BrowserTab[]> {
  const pages = getAllPages(browser);
  const results = await Promise.all(
    pages.map(async (page): Promise<BrowserTab | null> => {
      if (isBlockedPageRef(cdpUrl, page)) return null;
      const info = await pageTargetInfo(page).catch((error: unknown) => {
        if (isRecoverablePlaywrightDisconnectError(error) && (!page.isClosed() || !browser.isConnected())) throw error;
        return null;
      });
      if (info === null || isBlockedTarget(cdpUrl, info.targetId)) return null;
      const url = page.url();
      if (isBrowserInternalTargetUrl(url)) return null;
      return {
        targetId: info.targetId,
        title: info.title,
        url,
        type: 'page',
      };
    }),
  );
  return results.filter((tab): tab is BrowserTab => tab !== null);
}

interface PageEnumerationAttempt {
  cancelled: boolean;
  browser?: Browser;
  signal?: AbortSignal;
}

async function listPagesWithRecovery(
  cdpUrl: string,
  ssrfPolicy?: SsrfPolicy,
  attempt: PageEnumerationAttempt = { cancelled: false },
): Promise<BrowserTab[]> {
  const reusedCachedBrowser = hasCachedPlaywrightBrowserConnection(cdpUrl);
  const cancelled = (): boolean => attempt.cancelled;
  const read = async (): Promise<BrowserTab[]> => {
    const { browser } = await connectBrowser(cdpUrl, undefined, ssrfPolicy, undefined, attempt.signal);
    attempt.browser = browser;
    if (cancelled()) {
      evictStaleConnection(cdpUrl, browser);
      throw new Error('Playwright page enumeration was cancelled.');
    }
    return await listPagesViaPlaywrightOnce(cdpUrl, browser);
  };
  try {
    return await read();
  } catch (err) {
    if (!reusedCachedBrowser || !isRecoverablePlaywrightDisconnectError(err) || cancelled()) throw err;
    if (attempt.browser) evictStaleConnection(cdpUrl, attempt.browser);
    if (cancelled()) throw err;
    return await read();
  }
}

export async function listPagesViaPlaywright(opts: {
  cdpUrl: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<BrowserTab[]> {
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : undefined;
  if (timeoutMs === undefined) return await listPagesWithRecovery(opts.cdpUrl, opts.ssrfPolicy, { cancelled: false });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: Error | undefined;
  const controller = new AbortController();
  const attempt: PageEnumerationAttempt = { cancelled: false, signal: controller.signal };
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      attempt.cancelled = true;
      timeoutError = new Error(`Playwright page enumeration timed out after ${String(timeoutMs)}ms`);
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([listPagesWithRecovery(opts.cdpUrl, opts.ssrfPolicy, attempt), timeout]);
  } catch (err) {
    if (timeoutError !== undefined && err === timeoutError && attempt.browser)
      evictStaleConnection(opts.cdpUrl, attempt.browser);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createPageViaPlaywright(opts: {
  cdpUrl: string;
  url?: string;
  ssrfPolicy?: SsrfPolicy;
  stealth?: boolean;
  /** @deprecated Use ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } instead */
  allowInternal?: boolean;
  recordVideo?: { dir: string; size?: { width: number; height: number } };
}): Promise<BrowserTab> {
  /* eslint-disable @typescript-eslint/no-deprecated */
  const policy =
    opts.allowInternal === true ? { ...opts.ssrfPolicy, dangerouslyAllowPrivateNetwork: true } : opts.ssrfPolicy;
  /* eslint-enable @typescript-eslint/no-deprecated */
  const targetUrl = (opts.url ?? '').trim() || 'about:blank';

  // Preflight URL policy *before* allocating a tab. Otherwise a denial would
  // leak the freshly-created blank tab into the browser session.
  if (targetUrl !== 'about:blank') {
    await assertBrowserNavigationAllowed({
      url: targetUrl,
      ...withBrowserNavigationPolicy(policy, proxyModeOpts(opts.cdpUrl)),
    });
  }

  const { browser } = await connectBrowser(opts.cdpUrl, undefined, policy, { stealth: opts.stealth });
  const context = opts.recordVideo
    ? (recordingContexts.get(opts.cdpUrl) ??
      (await createRecordingContext(browser, opts.cdpUrl, opts.recordVideo, opts.stealth)))
    : (browser.contexts()[0] ?? (await browser.newContext()));
  await observeContext(context, { stealth: opts.stealth ?? getStealthEnabledForCdpUrl(opts.cdpUrl) });
  const page = await context.newPage();

  try {
    ensurePageState(page);
    clearBlockedPageRef(opts.cdpUrl, page);
    const createdTargetId = await pageTargetId(page).catch(() => null);
    clearBlockedTarget(opts.cdpUrl, createdTargetId ?? undefined);

    if (targetUrl !== 'about:blank') {
      const response = await gotoPageWithNavigationGuard({
        cdpUrl: opts.cdpUrl,
        page,
        url: targetUrl,
        timeoutMs: 30000,
        ssrfPolicy: policy,
        targetId: createdTargetId ?? undefined,
      });
      await assertPageNavigationCompletedSafely({
        cdpUrl: opts.cdpUrl,
        page,
        response,
        ssrfPolicy: policy,
        targetId: createdTargetId ?? undefined,
      });
    }

    const tid = createdTargetId ?? (await pageTargetId(page).catch(() => null));
    if (tid === null || tid === '') throw new Error('Failed to get targetId for new page');
    return {
      targetId: tid,
      title: await page.title().catch(() => ''),
      url: page.url(),
      type: 'page',
    };
  } catch (err) {
    await page.close().catch(() => undefined);
    throw err;
  }
}

export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);
  await page.close();
}

export async function closePageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  try {
    await (await resolvePageByTargetIdOrThrow(opts)).close();
  } catch (err) {
    if (err instanceof BrowserTabNotFoundError) return;
    throw err;
  }
}

export async function focusPageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await resolvePageByTargetIdOrThrow(opts);
  try {
    await page.bringToFront();
  } catch (err) {
    try {
      await withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send('Page.bringToFront');
        },
      });
      return;
    } catch {
      throw err;
    }
  }
}

export async function waitForTabViaPlaywright(opts: {
  cdpUrl: string;
  urlContains?: string;
  titleContains?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<BrowserTab> {
  if (opts.urlContains === undefined && opts.titleContains === undefined)
    throw new Error('urlContains or titleContains is required');
  const timeout = Math.max(1000, Math.min(120000, opts.timeoutMs ?? 30000));
  const start = Date.now();
  const POLL_INTERVAL_MS = 250;

  while (Date.now() - start < timeout) {
    const tabs = await listPagesViaPlaywright({ cdpUrl: opts.cdpUrl, ssrfPolicy: opts.ssrfPolicy });
    const match = tabs.find((t) => {
      if (opts.urlContains !== undefined && !t.url.includes(opts.urlContains)) return false;
      if (opts.titleContains !== undefined && !t.title.includes(opts.titleContains)) return false;
      return true;
    });
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const criteria: string[] = [];
  if (opts.urlContains !== undefined) criteria.push(`url contains "${opts.urlContains}"`);
  if (opts.titleContains !== undefined) criteria.push(`title contains "${opts.titleContains}"`);
  throw new Error(`Timed out waiting for tab: ${criteria.join(', ')}`);
}

export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);
  await runPageEmulationTransition(
    page,
    () =>
      setViewportSizeOnPage(page, {
        width: Math.max(1, Math.floor(opts.width)),
        height: Math.max(1, Math.floor(opts.height)),
      }),
    opts.signal,
  );
}
