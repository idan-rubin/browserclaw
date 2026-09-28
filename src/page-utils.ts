import { stripVTControlCharacters } from 'node:util';

import type { Page, Frame, BrowserContext, Browser } from 'playwright-core';

import { BlockedBrowserTargetError } from './connection.js';
import { BrowserTabNotFoundError, NavigationRaceError, SnapshotHydrationError, StaleRefError } from './errors.js';
import { BrowserCdpEndpointBlockedError, InvalidBrowserNavigationUrlError } from './security.js';
import { STEALTH_SCRIPT } from './stealth.js';
import type { PageState, ContextState, NetworkRequest, DialogHandler } from './types.js';

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;
const MAX_OBSERVED_PAGE_TEXT_CHARS = 2048;

function truncateObservedPageText(value: string): string {
  return truncateUtf16Safe(value, MAX_OBSERVED_PAGE_TEXT_CHARS);
}

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();
const contextStealthSettings = new WeakMap<BrowserContext, boolean>();
const stealthInitScriptContexts = new WeakSet<BrowserContext>();
const stealthAppliedPages = new WeakSet<Page>();

export interface ObserveOptions {
  stealth?: boolean;
}

// ── Arm ID Counters ──

export function bumpUploadArmId(state: PageState): number {
  state.nextArmIdUpload += 1;
  return state.nextArmIdUpload;
}
export function bumpDialogArmId(state: PageState): number {
  state.nextArmIdDialog += 1;
  return state.nextArmIdDialog;
}
export function bumpDownloadArmId(state: PageState): number {
  state.nextArmIdDownload += 1;
  return state.nextArmIdDownload;
}

// ── Context State Management ──

export function ensureContextState(context: BrowserContext): ContextState {
  const existing = contextStates.get(context);
  if (existing) return existing;
  const state: ContextState = { traceActive: false };
  contextStates.set(context, state);
  return state;
}

// ── Page State Management ──

/** Read-only access to a page's state (returns undefined if not initialized). */
export function getPageState(page: Page): PageState | undefined {
  return pageStates.get(page);
}

/** Find a network request by ID in the page state. */
export function findNetworkRequestById(state: PageState, id: string): NetworkRequest | undefined {
  for (let i = state.requests.length - 1; i >= 0; i--) {
    const candidate = state.requests[i];
    if (candidate.id === id) return candidate;
  }
  return undefined;
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) return existing;

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    armIdUpload: 0,
    armIdDialog: 0,
    armIdDownload: 0,
    nextArmIdUpload: 0,
    nextArmIdDialog: 0,
    nextArmIdDownload: 0,
    downloadWaiterDepth: 0,
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);

    page.on('console', (msg) => {
      const location = msg.location();
      state.console.push({
        type: truncateObservedPageText(msg.type()),
        text: truncateObservedPageText(msg.text()),
        timestamp: new Date().toISOString(),
        location: { ...location, url: truncateObservedPageText(location.url) },
      });
      // Evict oldest entries in bulk to avoid O(n) shift() on every overflow
      if (state.console.length > MAX_CONSOLE_MESSAGES + 50) state.console.splice(0, 50);
    });

    page.on('pageerror', (err) => {
      state.errors.push({
        message: truncateObservedPageText(err.message !== '' ? err.message : String(err)),
        name: err.name !== '' ? truncateObservedPageText(err.name) : undefined,
        stack: err.stack !== undefined && err.stack !== '' ? truncateObservedPageText(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS + 20) state.errors.splice(0, 20);
    });

    page.on('request', (req) => {
      state.nextRequestId += 1;
      const id = `r${String(state.nextRequestId)}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK_REQUESTS + 50) state.requests.splice(0, 50);
    });

    page.on('response', (resp) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (id === undefined) return;
      const rec = findNetworkRequestById(state, id);
      if (rec) {
        rec.status = resp.status();
        rec.ok = resp.ok();
      }
    });

    page.on('requestfailed', (req) => {
      const id = state.requestIds.get(req);
      if (id === undefined) return;
      const rec = findNetworkRequestById(state, id);
      if (rec) {
        const failure = req.failure()?.errorText;
        rec.failureText = failure !== undefined && failure !== '' ? truncateObservedPageText(failure) : undefined;
        rec.ok = false;
      }
    });

    page.on('dialog', (dialog) => {
      // If a one-shot armDialog is active, let it handle the dialog.
      if (state.armIdDialog > 0) return;

      // If a persistent onDialog handler is registered, invoke it.
      if (state.dialogHandler) {
        const handler = state.dialogHandler;
        let handled = false;
        const event = {
          type: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
          accept: (promptText?: string) => {
            handled = true;
            return dialog.accept(promptText);
          },
          dismiss: () => {
            handled = true;
            return dialog.dismiss();
          },
        };
        Promise.resolve()
          .then(() => handler(event))
          .then(() => {
            if (!handled) {
              dialog.dismiss().catch((err: unknown) => {
                console.warn(
                  `[browserclaw] Failed to auto-dismiss dialog: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }
          })
          .catch((err: unknown) => {
            console.warn(`[browserclaw] onDialog handler error: ${err instanceof Error ? err.message : String(err)}`);
            if (!handled) {
              dialog.dismiss().catch((dismissErr: unknown) => {
                console.warn(
                  `[browserclaw] Failed to dismiss dialog after handler error: ${dismissErr instanceof Error ? dismissErr.message : String(dismissErr)}`,
                );
              });
            }
          });
        return;
      }

      // Default: auto-dismiss unexpected dialogs.
      dialog.dismiss().catch((err: unknown) => {
        console.warn(`[browserclaw] Failed to dismiss dialog: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    const invalidateFrameRefs = (frame: Frame) => {
      if (frame !== page.mainFrame() && state.roleRefsMode !== 'aria' && frame !== state.roleRefsFrame) return;
      state.roleRefs = undefined;
      state.roleRefsMode = undefined;
      state.roleRefsFrame = undefined;
      state.roleRefsFrameSelector = undefined;
      state.roleRefsStoredAt = undefined;
    };
    page.on('framenavigated', invalidateFrameRefs);
    page.on('framedetached', invalidateFrameRefs);

    page.on('close', () => {
      pageStates.delete(page);
      observedPages.delete(page);
      stealthAppliedPages.delete(page);
    });
  }

  return state;
}

// ── Dialog Handler ──

/**
 * Set or clear a persistent dialog handler for a page.
 * When set, this handler is called for every dialog that is not covered by armDialog().
 * Pass `undefined` to clear the handler and restore default auto-dismiss.
 */
export function setDialogHandlerOnPage(page: Page, handler?: DialogHandler): void {
  const state = ensurePageState(page);
  state.dialogHandler = handler;
}

// ── Stealth ──

function resolveContextStealth(context: BrowserContext, opts?: ObserveOptions): boolean {
  const current = contextStealthSettings.get(context) ?? false;
  if (opts?.stealth === true && !current) contextStealthSettings.set(context, true);
  return contextStealthSettings.get(context) ?? false;
}

function contextStealthEnabled(context: BrowserContext): boolean {
  return contextStealthSettings.get(context) ?? false;
}

async function installStealthInitScript(context: BrowserContext): Promise<void> {
  if (stealthInitScriptContexts.has(context)) return;
  stealthInitScriptContexts.add(context);
  try {
    await context.addInitScript(STEALTH_SCRIPT);
  } catch (e: unknown) {
    stealthInitScriptContexts.delete(context);
    if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
      console.warn('[browserclaw] stealth initScript failed:', e instanceof Error ? e.message : String(e));
  }
}

async function applyStealthToPage(page: Page, stealthEnabled: boolean): Promise<void> {
  if (!stealthEnabled) return;
  if (stealthAppliedPages.has(page)) return;
  try {
    await page.evaluate(STEALTH_SCRIPT);
    stealthAppliedPages.add(page);
  } catch (e: unknown) {
    if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
      console.warn('[browserclaw] stealth evaluate failed:', e instanceof Error ? e.message : String(e));
  }
}

export async function observeContext(context: BrowserContext, opts?: ObserveOptions): Promise<void> {
  const stealthEnabled = resolveContextStealth(context, opts);
  ensureContextState(context);

  if (stealthEnabled) await installStealthInitScript(context);

  for (const page of context.pages()) {
    ensurePageState(page);
    await applyStealthToPage(page, stealthEnabled);
  }

  if (observedContexts.has(context)) return;
  observedContexts.add(context);

  const onPage = (page: Page) => {
    ensurePageState(page);
    applyStealthToPage(page, contextStealthEnabled(context)).catch(() => {
      /* noop — best-effort stealth for new pages */
    });
  };
  context.on('page', onPage);
  context.once('close', () => {
    context.off('page', onPage);
    stealthInitScriptContexts.delete(context);
  });
}

export async function observeBrowser(browser: Browser, opts?: ObserveOptions): Promise<void> {
  for (const context of browser.contexts()) await observeContext(context, opts);
}

// ── Error Helpers ──

export function toAIFriendlyError(error: unknown, selector: string): Error {
  if (
    error instanceof BrowserTabNotFoundError ||
    error instanceof NavigationRaceError ||
    error instanceof SnapshotHydrationError ||
    error instanceof StaleRefError ||
    error instanceof InvalidBrowserNavigationUrlError ||
    error instanceof BrowserCdpEndpointBlockedError ||
    error instanceof BlockedBrowserTargetError
  )
    return error;

  const message = stripVTControlCharacters(error instanceof Error ? error.message : String(error));
  const headline = (message.split('\n', 1)[0] ?? message).replace(
    /^(?:Error:\s*)?(?:locator(?:\([^)]*\))?\.\w+:\s*)?(?:Error:\s*)?/,
    '',
  );
  const label = truncateUtf16Safe(stripVTControlCharacters(selector), 200);
  const timeoutMatch = /^Timeout (\d+)ms exceeded(?:\.|\s|$)/.exec(headline);
  if (headline.startsWith('strict mode violation')) {
    const countMatch = /resolved to (\d+) elements/.exec(headline);
    const count = countMatch ? countMatch[1] : 'multiple';
    return new Error(
      `Selector "${label}" matched ${count} elements. Run a new snapshot to get updated refs, or use a different ref.`,
    );
  }

  const inputFailures: readonly (readonly [RegExp, string])[] = [
    [
      /^Element is not an <input>/i,
      'is not editable: this control does not support text input. Use an editable input, textarea, or contenteditable element.',
    ],
    [/^Cannot type text into input\[type=number\]/i, 'requires a numeric value. Use a valid number instead of text.'],
    [
      /^Input of type "[^"]+" cannot be filled/i,
      'has an input type that cannot be filled. Use the interaction appropriate for this control.',
    ],
    [/^Malformed value/i, 'rejected the value format. Use a value supported by this input type.'],
  ];
  for (const [pattern, detail] of inputFailures) {
    if (pattern.test(headline)) return new Error(`Element "${label}" ${detail}`);
  }

  // The final retry diagnostic describes the state at timeout, not an earlier transient failure.
  const diagnostics = timeoutMatch ? message.split('\n').reverse() : [headline];
  for (const line of diagnostics) {
    const diagnostic = line.trim().replace(/^(?:-\s*|\d+\s*×\s*)/, '');
    const state = /^element is not (editable|enabled|visible|stable)$/i.exec(diagnostic)?.[1]?.toLowerCase();
    if (state === 'editable')
      return new Error(`Element "${label}" is not editable (for example, read-only). Use an editable control.`);
    if (state === 'enabled')
      return new Error(`Element "${label}" is not enabled. Complete any prerequisites that enable the control.`);
    if (state === 'stable')
      return new Error(
        `Element "${label}" is not stable. Wait for movement or animation to finish before interacting.`,
      );
    if (
      state === 'visible' ||
      /^(?:<.*>.*|element )intercepts pointer events$/i.test(diagnostic) ||
      /^Element is not (?:receiving|receive) pointer events/i.test(diagnostic)
    ) {
      return new Error(
        `Element "${label}" is not interactable (hidden or covered). Try scrolling it into view, closing overlays, or re-snapshotting.`,
      );
    }
  }
  // Do not infer visibility from a generic "waiting for locator" (known difference #66).
  if (timeoutMatch && !message.includes('locator resolved to') && message.includes('to be visible')) {
    return new Error(`Element "${label}" not found or not visible. Run a new snapshot to see current page elements.`);
  }
  if (timeoutMatch) {
    return new Error(
      `Element "${label}" timed out after ${timeoutMatch[1]}ms — element may be hidden or not interactable. Run a new snapshot to see current page elements.`,
    );
  }
  // Strip Playwright locator internals so AI agents don't see implementation details
  const cleaned = message
    .replace(/locator\([^)]*\)\./g, '')
    .replace(/waiting for locator\([^)]*\)/g, '')
    .trim();
  return error instanceof Error && cleaned === error.message ? error : new Error(cleaned || message);
}

export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number, maxMs = 120000): number {
  return Math.max(500, Math.min(maxMs, timeoutMs ?? fallback));
}

/** Truncate to `maxLength` UTF-16 code units without splitting a surrogate pair. */
export function truncateUtf16Safe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  let end = Math.max(0, Math.trunc(maxLength));
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
