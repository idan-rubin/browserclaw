import type { Page, BrowserContext, Browser } from 'playwright-core';

import { STEALTH_SCRIPT } from './stealth.js';
import type { PageState, ContextState, NetworkRequest, DialogHandler } from './types.js';

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

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
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);

    page.on('console', (msg) => {
      state.console.push({
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      });
      // Evict oldest entries in bulk to avoid O(n) shift() on every overflow
      if (state.console.length > MAX_CONSOLE_MESSAGES + 50) state.console.splice(0, 50);
    });

    page.on('pageerror', (err) => {
      state.errors.push({
        message: err.message !== '' ? err.message : String(err),
        name: err.name !== '' ? err.name : undefined,
        stack: err.stack !== undefined && err.stack !== '' ? err.stack : undefined,
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
        rec.failureText = req.failure()?.errorText;
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

    page.on('close', () => {
      pageStates.delete(page);
      observedPages.delete(page);
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

let stealthEnabled = false;

export function setStealthEnabled(enabled: boolean): void {
  stealthEnabled = enabled;
}

async function applyStealthToPage(page: Page): Promise<void> {
  if (!stealthEnabled) return;
  try {
    await page.evaluate(STEALTH_SCRIPT);
  } catch (e: unknown) {
    if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
      console.warn('[browserclaw] stealth evaluate failed:', e instanceof Error ? e.message : String(e));
  }
}

export async function observeContext(context: BrowserContext): Promise<void> {
  if (observedContexts.has(context)) return;
  observedContexts.add(context);
  ensureContextState(context);

  if (stealthEnabled) {
    try {
      await context.addInitScript(STEALTH_SCRIPT);
    } catch (e: unknown) {
      if (process.env.DEBUG !== undefined && process.env.DEBUG !== '')
        console.warn('[browserclaw] stealth initScript failed:', e instanceof Error ? e.message : String(e));
    }
  }

  for (const page of context.pages()) {
    ensurePageState(page);
    await applyStealthToPage(page);
  }
  const onPage = (page: Page) => {
    ensurePageState(page);
    applyStealthToPage(page).catch(() => {
      /* noop — best-effort stealth for new pages */
    });
  };
  context.on('page', onPage);
  context.once('close', () => {
    context.off('page', onPage);
  });
}

export async function observeBrowser(browser: Browser): Promise<void> {
  for (const context of browser.contexts()) await observeContext(context);
}

// ── Error Helpers ──

export function toAIFriendlyError(error: unknown, selector: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('strict mode violation')) {
    const countMatch = /resolved to (\d+) elements/.exec(message);
    const count = countMatch ? countMatch[1] : 'multiple';
    return new Error(
      `Selector "${selector}" matched ${count} elements. Run a new snapshot to get updated refs, or use a different ref.`,
    );
  }
  if (
    (message.includes('Timeout') || message.includes('waiting for')) &&
    (message.includes('to be visible') || message.includes('not visible'))
  ) {
    return new Error(
      `Element "${selector}" not found or not visible. Run a new snapshot to see current page elements.`,
    );
  }
  if (
    message.includes('intercepts pointer events') ||
    message.includes('not visible') ||
    message.includes('not receive pointer events')
  ) {
    return new Error(
      `Element "${selector}" is not interactable (hidden or covered). Try scrolling it into view, closing overlays, or re-snapshotting.`,
    );
  }
  const timeoutMatch = /Timeout (\d+)ms exceeded/.exec(message);
  if (timeoutMatch) {
    return new Error(
      `Element "${selector}" timed out after ${timeoutMatch[1]}ms — element may be hidden or not interactable. Run a new snapshot to see current page elements.`,
    );
  }
  // Strip Playwright locator internals so AI agents don't see implementation details
  const cleaned = message
    .replace(/locator\([^)]*\)\./g, '')
    .replace(/waiting for locator\([^)]*\)/g, '')
    .trim();
  return new Error(cleaned || message);
}

export function normalizeTimeoutMs(timeoutMs: number | undefined, fallback: number, maxMs = 120000): number {
  return Math.max(500, Math.min(maxMs, timeoutMs ?? fallback));
}
