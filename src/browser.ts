import type { BrowserContext, Page, Locator } from 'playwright-core';

import { batchViaPlaywright } from './actions/batch.js';
import type { BatchAction, BatchActionResult } from './actions/batch.js';
import { downloadViaPlaywright, waitForDownloadViaPlaywright } from './actions/download.js';
import {
  emulateMediaViaPlaywright,
  setDeviceViaPlaywright,
  setExtraHTTPHeadersViaPlaywright,
  setGeolocationViaPlaywright,
  setHttpCredentialsViaPlaywright,
  setLocaleViaPlaywright,
  setOfflineViaPlaywright,
  setTimezoneViaPlaywright,
} from './actions/emulation.js';
import { evaluateViaPlaywright, evaluateInAllFramesViaPlaywright, type FrameEvalResult } from './actions/evaluate.js';
import {
  clickViaPlaywright,
  mouseClickViaPlaywright,
  pressAndHoldViaCdp,
  clickByTextViaPlaywright,
  clickByRoleViaPlaywright,
  hoverViaPlaywright,
  typeViaPlaywright,
  selectOptionViaPlaywright,
  dragViaPlaywright,
  fillFormViaPlaywright,
  scrollIntoViewViaPlaywright,
  highlightViaPlaywright,
  setInputFilesViaPlaywright,
  armDialogViaPlaywright,
  armFileUploadViaPlaywright,
} from './actions/interaction.js';
import { pressKeyViaPlaywright } from './actions/keyboard.js';
import {
  navigateViaPlaywright,
  listPagesViaPlaywright,
  createPageViaPlaywright,
  closePageByTargetIdViaPlaywright,
  focusPageByTargetIdViaPlaywright,
  waitForTabViaPlaywright,
  resizeViewportViaPlaywright,
  clearRecordingContext,
} from './actions/navigation.js';
import { waitForViaPlaywright } from './actions/wait.js';
import { detectChallengeViaPlaywright, waitForChallengeViaPlaywright } from './anti-bot.js';
import {
  getConsoleMessagesViaPlaywright,
  getPageErrorsViaPlaywright,
  getNetworkRequestsViaPlaywright,
} from './capture/activity.js';
import { pdfViaPlaywright } from './capture/pdf.js';
import { responseBodyViaPlaywright, waitForRequestViaPlaywright } from './capture/response.js';
import { takeScreenshotViaPlaywright, screenshotWithLabelsViaPlaywright } from './capture/screenshot.js';
import { traceStartViaPlaywright, traceStopViaPlaywright } from './capture/trace.js';
import { launchChrome, stopChrome, isChromeReachable, discoverChromeCdpUrl } from './chrome-launcher.js';
import {
  connectBrowser,
  closePlaywrightBrowserConnection,
  getPageForTargetId,
  ensurePageState,
  pageTargetId,
  normalizeTimeoutMs,
  setDialogHandler,
  getRestoredPageForTarget,
  BrowserTabNotFoundError,
  resolveActiveTargetId,
} from './connection.js';
import { assertCdpEndpointAllowed } from './security.js';
import { snapshotAi } from './snapshot/ai-snapshot.js';
import { snapshotRole, snapshotAria } from './snapshot/aria-snapshot.js';
import {
  cookiesGetViaPlaywright,
  cookiesSetViaPlaywright,
  cookiesClearViaPlaywright,
  storageGetViaPlaywright,
  storageSetViaPlaywright,
  storageClearViaPlaywright,
} from './storage/index.js';
import type {
  LaunchOptions,
  ConnectOptions,
  SnapshotResult,
  SnapshotOptions,
  AriaSnapshotResult,
  BrowserTab,
  FormField,
  ClickOptions,
  TypeOptions,
  WaitOptions,
  ScreenshotOptions,
  ConsoleMessage,
  PageError,
  NetworkRequest,
  CookieData,
  StorageKind,
  RunningChrome,
  SsrfPolicy,
  DownloadResult,
  DialogOptions,
  DialogHandler,
  RequestResult,
  ResponseBodyResult,
  TraceStartOptions,
  ColorScheme,
  GeolocationOptions,
  HttpCredentials,
  ChallengeInfo,
  ChallengeWaitResult,
  AuthCheckRule,
  AuthCheckResult,
  AuthCheckDetail,
  ExitReason,
  RunTelemetry,
} from './types.js';

/**
 * Represents a single browser page/tab with ref-based automation.
 *
 * The workflow is: **snapshot → read refs → act on refs**.
 *
 * @example
 * ```ts
 * const page = await browser.open('https://demo.playwright.dev/todomvc');
 *
 * // 1. Take a snapshot to get refs
 * const { snapshot, refs } = await page.snapshot();
 * // snapshot: AI-readable text tree
 * // refs: { "e1": { role: "textbox", name: "What needs to be done?" }, ... }
 *
 * // 2. Act on refs
 * await page.type('e1', 'Buy groceries', { submit: true });
 * ```
 */
export class CrawlPage {
  private readonly cdpUrl: string;
  private _targetId: string;
  private readonly ssrfPolicy: SsrfPolicy | undefined;

  /** @internal */
  constructor(cdpUrl: string, targetId: string, ssrfPolicy?: SsrfPolicy) {
    this.cdpUrl = cdpUrl;
    this._targetId = targetId;
    this.ssrfPolicy = ssrfPolicy;
  }

  /** The CDP target ID for this page. Use this to identify the page in multi-tab scenarios. */
  get id(): string {
    return this._targetId;
  }

  /**
   * Refresh the target ID by re-resolving the page from the browser.
   * Useful after reconnection when the old target ID may be stale.
   *
   * If the current target is gone (tab closed or replaced after a hard
   * redesign), falls back to the browser's best guess for the active page
   * when `fallback: 'active'` is set. By default, throws
   * `BrowserTabNotFoundError` if the old target is gone.
   */
  async refreshTargetId(opts?: { fallback?: 'active' }): Promise<string> {
    try {
      const page = await getPageForTargetId({
        cdpUrl: this.cdpUrl,
        targetId: this._targetId,
        ssrfPolicy: this.ssrfPolicy,
      });
      const newId = await pageTargetId(page);
      if (newId !== null && newId !== '') this._targetId = newId;
      return this._targetId;
    } catch (err) {
      if (opts?.fallback !== 'active' || !(err instanceof BrowserTabNotFoundError)) throw err;
      const recovered = await resolveActiveTargetId(this.cdpUrl, { ssrfPolicy: this.ssrfPolicy });
      if (recovered === null)
        throw new BrowserTabNotFoundError(
          `Tab ${this._targetId} is gone and no fallback page is available. Call browser.tabs() or browser.open(url).`,
        );
      this._targetId = recovered;
      return this._targetId;
    }
  }

  /**
   * Re-bind this handle using the best-effort page resolver.
   *
   * Primitive for recovering from lost tab handles after navigation or
   * aggressive re-renders. Captures the page's current URL (when still
   * reachable) so the resolver can prefer the same page after a reload,
   * then falls back to the original targetId, then the first non-blank
   * accessible tab, then any accessible tab.
   *
   * NOTE: This does not query Chrome's actual focused tab. See
   * `BrowserClaw.currentPage()` for the same caveat — track `targetId`
   * explicitly when you need deterministic tab selection.
   *
   * @returns The (possibly new) target ID
   */
  async reacquire(): Promise<string> {
    let preferUrl: string | undefined;
    try {
      const page = await getPageForTargetId({
        cdpUrl: this.cdpUrl,
        targetId: this._targetId,
        ssrfPolicy: this.ssrfPolicy,
      });
      const url = page.url();
      if (url !== '' && url !== 'about:blank') preferUrl = url;
    } catch (err) {
      if (!(err instanceof BrowserTabNotFoundError)) throw err;
      // Old target is gone — recovery proceeds with whatever the resolver finds.
    }
    const recovered = await resolveActiveTargetId(this.cdpUrl, {
      preferTargetId: this._targetId,
      preferUrl,
      ssrfPolicy: this.ssrfPolicy,
    });
    if (recovered === null)
      throw new BrowserTabNotFoundError('No pages available to reacquire. Use browser.open(url) to create a tab.');
    this._targetId = recovered;
    return this._targetId;
  }

  // ── Snapshot ──────────────────────────────────────────────────

  /**
   * Take an AI-readable snapshot of the page.
   *
   * Returns a text tree with numbered refs (`e1`, `e2`, ...) that map to
   * interactive elements. Use these refs with actions like `click()` and `type()`.
   *
   * @param opts - Snapshot options (mode, filtering, depth limits)
   * @returns Snapshot text, ref map, and statistics
   *
   * @example
   * ```ts
   * // Default snapshot (aria mode)
   * const { snapshot, refs } = await page.snapshot();
   *
   * // Interactive elements only, compact
   * const result = await page.snapshot({ interactive: true, compact: true });
   *
   * // Role-based mode (uses getByRole resolution)
   * const result = await page.snapshot({ mode: 'role' });
   * ```
   */
  async snapshot(opts?: SnapshotOptions): Promise<SnapshotResult> {
    if (opts?.mode === 'role') {
      return snapshotRole({
        cdpUrl: this.cdpUrl,
        targetId: this._targetId,
        selector: opts.selector,
        frameSelector: opts.frameSelector,
        refsMode: opts.refsMode,
        timeoutMs: opts.timeoutMs,
        options: {
          interactive: opts.interactive,
          compact: opts.compact,
          maxDepth: opts.maxDepth,
        },
        ssrfPolicy: this.ssrfPolicy,
      });
    }
    if (
      (opts?.selector !== undefined && opts.selector !== '') ||
      (opts?.frameSelector !== undefined && opts.frameSelector !== '')
    ) {
      throw new Error(
        'selector and frameSelector are only supported in role mode. Use { mode: "role" } or omit these options.',
      );
    }
    return snapshotAi({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      maxChars: opts?.maxChars,
      timeoutMs: opts?.timeoutMs,
      options: {
        interactive: opts?.interactive,
        compact: opts?.compact,
        maxDepth: opts?.maxDepth,
        waitForHydration: opts?.waitForHydration,
        minInteractiveRefs: opts?.minInteractiveRefs,
      },
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Take a raw ARIA accessibility tree snapshot via CDP.
   *
   * Unlike `snapshot()`, this returns structured node data rather than
   * an AI-readable text tree. Useful for programmatic accessibility analysis.
   *
   * @param opts - Options (limit: max nodes to return, default 500)
   * @returns Array of accessibility tree nodes
   */
  async ariaSnapshot(opts?: { limit?: number }): Promise<AriaSnapshotResult> {
    return snapshotAria({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      limit: opts?.limit,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  // ── Interactions ─────────────────────────────────────────────

  /**
   * Click an element by ref.
   *
   * @param ref - Ref ID from a snapshot (e.g. `'e1'`)
   * @param opts - Click options (double-click, button, modifiers)
   *
   * @example
   * ```ts
   * await page.click('e1');
   * await page.click('e2', { doubleClick: true });
   * await page.click('e3', { button: 'right' });
   * await page.click('e4', { modifiers: ['Control'] });
   * ```
   */
  async click(ref: string, opts?: ClickOptions): Promise<void> {
    return clickViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ref,
      doubleClick: opts?.doubleClick,
      button: opts?.button,
      modifiers: opts?.modifiers,
      delayMs: opts?.delayMs,
      timeoutMs: opts?.timeoutMs,
      force: opts?.force,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Click an element by CSS selector (no snapshot/ref needed).
   *
   * Finds and clicks atomically — no stale ref problem.
   *
   * @param selector - CSS selector (e.g. `'#submit-btn'`, `'.modal button'`)
   * @param opts - Click options (double-click, button, modifiers)
   *
   * @example
   * ```ts
   * await page.clickBySelector('#submit-btn');
   * await page.clickBySelector('.modal .close', { button: 'right' });
   * ```
   */
  async clickBySelector(selector: string, opts?: ClickOptions): Promise<void> {
    return clickViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      selector,
      doubleClick: opts?.doubleClick,
      button: opts?.button,
      modifiers: opts?.modifiers,
      delayMs: opts?.delayMs,
      timeoutMs: opts?.timeoutMs,
      force: opts?.force,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Click at specific page coordinates.
   *
   * Useful for canvas elements, custom widgets, or elements without ARIA roles.
   *
   * @param x - X coordinate in pixels
   * @param y - Y coordinate in pixels
   * @param opts - Click options (button, clickCount, delayMs)
   *
   * @example
   * ```ts
   * await page.mouseClick(100, 200);
   * await page.mouseClick(100, 200, { button: 'right' });
   * await page.mouseClick(100, 200, { clickCount: 2 }); // double-click
   * ```
   */
  async mouseClick(
    x: number,
    y: number,
    opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number; delayMs?: number },
  ): Promise<void> {
    return mouseClickViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      x,
      y,
      button: opts?.button,
      clickCount: opts?.clickCount,
      delayMs: opts?.delayMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Press and hold at page coordinates using raw CDP events.
   *
   * Bypasses Playwright's automation layer by dispatching CDP
   * `Input.dispatchMouseEvent` directly — useful for anti-bot challenges
   * that detect automated clicks.
   *
   * @param x - X coordinate in CSS pixels
   * @param y - Y coordinate in CSS pixels
   * @param opts - Options (delay: ms before press, holdMs: hold duration)
   *
   * @example
   * ```ts
   * await page.pressAndHold(400, 300, { delay: 150, holdMs: 5000 });
   * ```
   */
  async pressAndHold(x: number, y: number, opts?: { delay?: number; holdMs?: number }): Promise<void> {
    return pressAndHoldViaCdp({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      x,
      y,
      delay: opts?.delay,
      holdMs: opts?.holdMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Click an element by its visible text content (no snapshot/ref needed).
   *
   * Finds and clicks atomically — no stale ref problem.
   *
   * @param text - Text content to match
   * @param opts - Options (exact: require full match, button, modifiers)
   *
   * @example
   * ```ts
   * await page.clickByText('Submit');
   * await page.clickByText('Save Changes', { exact: true });
   * ```
   */
  async clickByText(
    text: string,
    opts?: {
      exact?: boolean;
      button?: 'left' | 'right' | 'middle';
      modifiers?: ('Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift')[];
      timeoutMs?: number;
    },
  ): Promise<void> {
    return clickByTextViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      text,
      exact: opts?.exact,
      button: opts?.button,
      modifiers: opts?.modifiers,
      timeoutMs: opts?.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Click an element by its ARIA role and accessible name (no snapshot/ref needed).
   *
   * Finds and clicks atomically — no stale ref problem.
   *
   * @param role - ARIA role (e.g. `'button'`, `'link'`, `'menuitem'`)
   * @param name - Accessible name to match (optional)
   * @param opts - Click options
   *
   * @example
   * ```ts
   * await page.clickByRole('button', 'Save');
   * await page.clickByRole('link', 'Settings');
   * await page.clickByRole('menuitem', 'Delete');
   * ```
   */
  async clickByRole(
    role: string,
    name?: string,
    opts?: {
      index?: number;
      button?: 'left' | 'right' | 'middle';
      modifiers?: ('Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift')[];
      timeoutMs?: number;
    },
  ): Promise<void> {
    return clickByRoleViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      role,
      name,
      index: opts?.index,
      button: opts?.button,
      modifiers: opts?.modifiers,
      timeoutMs: opts?.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Type text into an input element by ref.
   *
   * By default, uses Playwright's `fill()` for instant input. Use `slowly: true`
   * to simulate real keystroke typing with a 75ms delay per character.
   *
   * @param ref - Ref ID of the input element (e.g. `'e3'`)
   * @param text - Text to type
   * @param opts - Type options (submit, slowly)
   *
   * @example
   * ```ts
   * await page.type('e3', 'hello world');
   * await page.type('e3', 'slow typing', { slowly: true });
   * await page.type('e3', 'search query', { submit: true }); // press Enter after
   * ```
   */
  async type(ref: string, text: string, opts?: TypeOptions): Promise<void> {
    return typeViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ref,
      text,
      submit: opts?.submit,
      slowly: opts?.slowly,
      timeoutMs: opts?.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Hover over an element by ref.
   *
   * @param ref - Ref ID from a snapshot
   * @param opts - Timeout options
   */
  async hover(ref: string, opts?: { timeoutMs?: number }): Promise<void> {
    return hoverViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ref,
      timeoutMs: opts?.timeoutMs,
    });
  }

  /**
   * Select option(s) in a `<select>` dropdown by ref.
   *
   * @param ref - Ref ID of the select element
   * @param values - One or more option labels/values to select
   *
   * @example
   * ```ts
   * await page.select('e5', 'Option A');
   * await page.select('e5', 'Option A', 'Option B'); // multi-select
   * ```
   */
  async select(ref: string, ...values: string[]): Promise<void> {
    return selectOptionViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ref,
      values,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Drag one element to another.
   *
   * @param startRef - Ref ID of the element to drag
   * @param endRef - Ref ID of the drop target
   * @param opts - Timeout options
   */
  async drag(startRef: string, endRef: string, opts?: { timeoutMs?: number }): Promise<void> {
    return dragViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      startRef,
      endRef,
      timeoutMs: opts?.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Fill multiple form fields at once.
   *
   * Supports text inputs, checkboxes, and radio buttons.
   *
   * @param fields - Array of form fields to fill
   *
   * @example
   * ```ts
   * await page.fill([
   *   { ref: 'e2', type: 'text', value: 'Jane Doe' },
   *   { ref: 'e4', type: 'text', value: 'jane@acme.test' },
   *   { ref: 'e6', type: 'checkbox', value: true },
   * ]);
   * ```
   */
  async fill(fields: FormField[]): Promise<void> {
    return fillFormViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      fields,
    });
  }

  /**
   * Scroll an element into the visible viewport.
   *
   * @param ref - Ref ID of the element to scroll to
   * @param opts - Timeout options
   */
  async scrollIntoView(ref: string, opts?: { timeoutMs?: number }): Promise<void> {
    return scrollIntoViewViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ref,
      timeoutMs: opts?.timeoutMs,
    });
  }

  /**
   * Highlight an element in the browser (Playwright built-in highlight).
   *
   * @param ref - Ref ID of the element to highlight
   */
  async highlight(ref: string): Promise<void> {
    return highlightViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ref,
    });
  }

  /**
   * Set files on an `<input type="file">` element.
   *
   * @param ref - Ref ID of the file input element
   * @param paths - Array of file paths to upload
   */
  async uploadFile(ref: string, paths: string[]): Promise<void> {
    return setInputFilesViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ref,
      paths,
    });
  }

  /**
   * Arm a one-shot dialog handler (alert, confirm, prompt). Fire-and-forget:
   * returns immediately once the arm is registered. The dialog is handled in
   * the background when it fires.
   *
   * Call this BEFORE triggering the action that opens the dialog.
   *
   * @param opts - Dialog options (accept/dismiss, prompt text, timeout)
   *
   * @example
   * ```ts
   * await page.armDialog({ accept: true }); // registers the handler, returns immediately
   * await page.click('e5');                 // triggers confirm() — handled in background
   * ```
   */
  async armDialog(opts: DialogOptions): Promise<void> {
    return armDialogViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      accept: opts.accept,
      promptText: opts.promptText,
      timeoutMs: opts.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Register a persistent dialog handler for all dialogs (alert, confirm, prompt, beforeunload).
   *
   * Unlike `armDialog()` which handles a single expected dialog, `onDialog()` handles
   * every dialog that appears until cleared. This prevents unexpected dialogs from
   * blocking the page.
   *
   * The handler receives a `DialogEvent` with `accept()` and `dismiss()` methods.
   * If the handler throws or doesn't call either, the dialog is auto-dismissed.
   *
   * Pass `undefined` or `null` to clear the handler and restore default auto-dismiss.
   *
   * Note: `armDialog()` takes priority — if a one-shot handler is armed, it handles
   * the next dialog instead of the persistent handler.
   *
   * @param handler - Callback for dialog events, or `undefined`/`null` to clear
   *
   * @example
   * ```ts
   * // Accept all confirm dialogs, dismiss everything else
   * page.onDialog((event) => {
   *   if (event.type === 'confirm') event.accept();
   *   else event.dismiss();
   * });
   *
   * // Log and auto-accept all dialogs
   * page.onDialog(async (event) => {
   *   console.log(`Dialog: ${event.type} — ${event.message}`);
   *   await event.accept();
   * });
   *
   * // Clear the handler (restore default auto-dismiss)
   * page.onDialog(undefined);
   * ```
   */
  async onDialog(handler: DialogHandler | undefined | null): Promise<void> {
    return setDialogHandler({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      handler: handler ?? undefined,
    });
  }

  /**
   * Arm a one-shot file chooser handler.
   *
   * Returns a promise — store it (don't await), trigger the file picker, then await it.
   *
   * @param paths - File paths to set when the chooser appears (empty to clear)
   * @param opts - Timeout options
   *
   * @example
   * ```ts
   * const uploadDone = page.armFileUpload(['/path/to/file.pdf']); // don't await here
   * await page.click('e3'); // triggers file picker
   * await uploadDone;       // wait for files to be set
   * ```
   */
  async armFileUpload(paths?: string[], opts?: { timeoutMs?: number }): Promise<void> {
    return armFileUploadViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      paths,
      timeoutMs: opts?.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Execute multiple browser actions in sequence.
   *
   * @param actions - Array of actions to execute
   * @param opts - Options (stopOnError: stop on first failure, default true)
   * @returns Array of per-action results
   */
  async batch(
    actions: BatchAction[],
    opts?: { stopOnError?: boolean; evaluateEnabled?: boolean },
  ): Promise<{ results: BatchActionResult[] }> {
    return batchViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      actions,
      stopOnError: opts?.stopOnError,
      evaluateEnabled: opts?.evaluateEnabled,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  // ── Keyboard ─────────────────────────────────────────────────

  /**
   * Press a keyboard key or key combination.
   *
   * Uses Playwright's key names. Supports combinations with `+`.
   *
   * @param key - Key to press (e.g. `'Enter'`, `'Tab'`, `'Control+a'`, `'Meta+c'`)
   * @param opts - Options (delayMs: hold time between keydown and keyup)
   *
   * @example
   * ```ts
   * await page.press('Enter');
   * await page.press('Control+a');
   * await page.press('Meta+Shift+p');
   * ```
   */
  async press(key: string, opts?: { delayMs?: number }): Promise<void> {
    return pressKeyViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      key,
      delayMs: opts?.delayMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  // ── Navigation ───────────────────────────────────────────────

  /**
   * Get the current URL of the page.
   */
  async url(): Promise<string> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this._targetId });
    return page.url();
  }

  /**
   * Get the page title.
   */
  async title(): Promise<string> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this._targetId });
    return page.title();
  }

  /**
   * Navigate to a URL.
   *
   * @param url - The URL to navigate to
   * @param opts - Timeout options
   * @returns The final URL after navigation (may differ due to redirects)
   */
  async goto(url: string, opts?: { timeoutMs?: number }): Promise<{ url: string }> {
    return navigateViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      url,
      timeoutMs: opts?.timeoutMs,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Reload the current page.
   *
   * @param opts - Timeout options
   */
  async reload(opts?: { timeoutMs?: number }): Promise<void> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this._targetId });
    ensurePageState(page);
    await page.reload({ timeout: normalizeTimeoutMs(opts?.timeoutMs, 20000) });
  }

  /**
   * Navigate back in browser history.
   *
   * @param opts - Timeout options
   */
  async goBack(opts?: { timeoutMs?: number }): Promise<void> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this._targetId });
    ensurePageState(page);
    await page.goBack({ timeout: normalizeTimeoutMs(opts?.timeoutMs, 20000) });
  }

  /**
   * Navigate forward in browser history.
   *
   * @param opts - Timeout options
   */
  async goForward(opts?: { timeoutMs?: number }): Promise<void> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this._targetId });
    ensurePageState(page);
    await page.goForward({ timeout: normalizeTimeoutMs(opts?.timeoutMs, 20000) });
  }

  // ── Wait ─────────────────────────────────────────────────────

  /**
   * Wait for various conditions on the page.
   *
   * Multiple conditions can be specified — they are checked in order.
   *
   * @param opts - Wait conditions (text, URL, load state, selector, etc.)
   *
   * @example
   * ```ts
   * await page.waitFor({ loadState: 'networkidle' });
   * await page.waitFor({ text: 'Welcome back' });
   * await page.waitFor({ url: '**\/dashboard' });
   * await page.waitFor({ timeMs: 1000 }); // sleep
   * ```
   */
  async waitFor(opts: WaitOptions): Promise<void> {
    return waitForViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ...opts,
    });
  }

  // ── Evaluate ─────────────────────────────────────────────────

  /**
   * Run JavaScript in the browser page context.
   *
   * The function string is evaluated in the browser's sandbox, not in Node.js.
   * Pass a `ref` to receive the element as the first argument.
   *
   * @param fn - JavaScript function body as a string
   * @param opts - Options (ref: scope evaluation to a specific element)
   * @returns The return value of the evaluated function
   *
   * @example
   * ```ts
   * const title = await page.evaluate('() => document.title');
   * const text = await page.evaluate('(el) => el.textContent', { ref: 'e1' });
   * const count = await page.evaluate('() => document.querySelectorAll("img").length');
   * ```
   */
  async evaluate(fn: string, opts?: { ref?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<unknown> {
    return evaluateViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      fn,
      ref: opts?.ref,
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Run JavaScript in ALL frames on the page (including cross-origin iframes).
   *
   * Playwright can access cross-origin frames via CDP, bypassing the same-origin policy.
   * This is essential for filling payment iframes (Stripe, etc.).
   *
   * @param fn - JavaScript function body as a string
   * @returns Array of results from each frame where evaluation succeeded
   *
   * @example
   * ```ts
   * const results = await page.evaluateInAllFrames(`() => {
   *   const el = document.querySelector('input[name="cardnumber"]');
   *   return el ? 'found' : null;
   * }`);
   * ```
   */
  async evaluateInAllFrames(fn: string): Promise<FrameEvalResult[]> {
    return evaluateInAllFramesViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      fn,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  // ── Capture ──────────────────────────────────────────────────

  /**
   * Take a screenshot of the page or a specific element.
   *
   * @param opts - Screenshot options (fullPage, ref, element, type)
   * @returns PNG or JPEG image as a Buffer
   *
   * @example
   * ```ts
   * const screenshot = await page.screenshot();
   * const fullPage = await page.screenshot({ fullPage: true });
   * const element = await page.screenshot({ ref: 'e1' });
   * ```
   */
  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const result = await takeScreenshotViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      fullPage: opts?.fullPage,
      ref: opts?.ref,
      element: opts?.element,
      type: opts?.type,
      ssrfPolicy: this.ssrfPolicy,
    });
    return result.buffer;
  }

  /**
   * Export the page as a PDF.
   *
   * Only works in headless mode.
   *
   * @returns PDF document as a Buffer
   */
  async pdf(): Promise<Buffer> {
    const result = await pdfViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ssrfPolicy: this.ssrfPolicy,
    });
    return result.buffer;
  }

  /**
   * Take a screenshot with numbered labels overlaid on referenced elements.
   *
   * Useful for visual debugging — each ref gets a numbered badge and border.
   *
   * @param refs - Array of ref IDs to label
   * @param opts - Options (maxLabels: limit, type: image format)
   * @returns Screenshot buffer, label positions, and any skipped refs
   *
   * @example
   * ```ts
   * const { buffer, labels, skipped } = await page.screenshotWithLabels(['e1', 'e2', 'e3']);
   * fs.writeFileSync('labeled.png', buffer);
   * ```
   */
  async screenshotWithLabels(
    refs: string[],
    opts?: { maxLabels?: number; type?: 'png' | 'jpeg' },
  ): Promise<{
    buffer: Buffer;
    labels: { ref: string; index: number; box: { x: number; y: number; width: number; height: number } }[];
    skipped: string[];
  }> {
    return screenshotWithLabelsViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      refs,
      maxLabels: opts?.maxLabels,
      type: opts?.type,
      ssrfPolicy: this.ssrfPolicy,
    });
  }

  /**
   * Start recording a Playwright trace.
   *
   * Traces capture screenshots, DOM snapshots, and network activity.
   * Stop with `traceStop()` to save the trace file.
   *
   * @param opts - Trace options (screenshots, snapshots, sources)
   */
  async traceStart(opts?: TraceStartOptions): Promise<void> {
    return traceStartViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      screenshots: opts?.screenshots,
      snapshots: opts?.snapshots,
      sources: opts?.sources,
    });
  }

  /**
   * Stop recording a trace and save it to a file.
   *
   * @param path - File path to save the trace (e.g. `'trace.zip'`)
   * @param opts - Options (allowedOutputRoots: constrain output to specific directories)
   */
  async traceStop(path: string, opts?: { allowedOutputRoots?: string[] }): Promise<void> {
    return traceStopViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      path,
      allowedOutputRoots: opts?.allowedOutputRoots,
    });
  }

  /**
   * Wait for a network response matching a URL pattern and return its body.
   *
   * @param url - URL string or pattern to match
   * @param opts - Options (timeoutMs, maxChars)
   * @returns Response body, status, headers, and truncation info
   *
   * @example
   * ```ts
   * const resp = await page.responseBody('/api/data');
   * console.log(resp.status, resp.body);
   * ```
   */
  async responseBody(url: string, opts?: { timeoutMs?: number; maxChars?: number }): Promise<ResponseBodyResult> {
    return responseBodyViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      url,
      timeoutMs: opts?.timeoutMs,
      maxChars: opts?.maxChars,
    });
  }

  /**
   * Wait for a network request matching a URL pattern and return request + response details.
   *
   * Unlike `networkRequests()` which only captures metadata, this method captures
   * the full request body (POST data) and response body.
   *
   * @param url - URL string or pattern to match (supports `*` wildcards and substring matching)
   * @param opts - Options (method filter, timeoutMs, maxChars for response body)
   * @returns Request method, postData, response status, and response body
   *
   * @example
   * ```ts
   * const reqPromise = page.waitForRequest('/api/submit', { method: 'POST' });
   * await page.click('e5'); // submit a form
   * const req = await reqPromise;
   * console.log(req.postData); // form body
   * console.log(req.status, req.responseBody); // response
   * ```
   */
  async waitForRequest(
    url: string,
    opts?: { method?: string; timeoutMs?: number; maxChars?: number },
  ): Promise<RequestResult> {
    return waitForRequestViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      url,
      method: opts?.method,
      timeoutMs: opts?.timeoutMs,
      maxChars: opts?.maxChars,
    });
  }

  /**
   * Get console messages captured from the page.
   *
   * Messages are buffered automatically. Use `level` to filter by minimum severity.
   *
   * @param opts - Filter options (level, clear)
   * @returns Array of captured console messages
   */
  async consoleLogs(opts?: { level?: string; clear?: boolean }): Promise<ConsoleMessage[]> {
    return getConsoleMessagesViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      level: opts?.level,
      clear: opts?.clear,
    });
  }

  /**
   * Get uncaught errors from the page.
   *
   * @param opts - Options (clear: reset the error buffer after reading)
   * @returns Array of captured page errors
   */
  async pageErrors(opts?: { clear?: boolean }): Promise<PageError[]> {
    const result = await getPageErrorsViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      clear: opts?.clear,
    });
    return result.errors;
  }

  /**
   * Get network requests captured from the page.
   *
   * @param opts - Options (filter: URL substring match, clear: reset the buffer)
   * @returns Array of captured network requests
   *
   * @example
   * ```ts
   * const all = await page.networkRequests();
   * const apiCalls = await page.networkRequests({ filter: '/api/' });
   * const fresh = await page.networkRequests({ clear: true }); // read and clear
   * ```
   */
  async networkRequests(opts?: { filter?: string; clear?: boolean }): Promise<NetworkRequest[]> {
    const result = await getNetworkRequestsViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      filter: opts?.filter,
      clear: opts?.clear,
    });
    return result.requests;
  }

  // ── Viewport ─────────────────────────────────────────────────

  /**
   * Resize the browser viewport.
   *
   * @param width - Viewport width in pixels
   * @param height - Viewport height in pixels
   */
  async resize(width: number, height: number): Promise<void> {
    return resizeViewportViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      width,
      height,
    });
  }

  // ── Storage ──────────────────────────────────────────────────

  /**
   * Get all cookies for the current browser context.
   *
   * @returns Array of cookie objects
   */
  async cookies(): Promise<Awaited<ReturnType<BrowserContext['cookies']>>> {
    const result = await cookiesGetViaPlaywright({ cdpUrl: this.cdpUrl, targetId: this._targetId });
    return result.cookies;
  }

  /**
   * Set a cookie in the browser context.
   *
   * @param cookie - Cookie data (must include `name`, `value`, and either `url` or `domain`+`path`)
   *
   * @example
   * ```ts
   * await page.setCookie({
   *   name: 'token',
   *   value: 'abc123',
   *   url: 'https://demo.playwright.dev/todomvc',
   * });
   * ```
   */
  async setCookie(cookie: CookieData): Promise<void> {
    return cookiesSetViaPlaywright({ cdpUrl: this.cdpUrl, targetId: this._targetId, cookie });
  }

  /** Clear all cookies in the browser context. */
  async clearCookies(): Promise<void> {
    return cookiesClearViaPlaywright({ cdpUrl: this.cdpUrl, targetId: this._targetId });
  }

  /**
   * Get values from localStorage or sessionStorage.
   *
   * @param kind - `'local'` for localStorage, `'session'` for sessionStorage
   * @param key - Optional specific key to retrieve (returns all if omitted)
   * @returns Key-value map of storage entries
   */
  async storageGet(kind: StorageKind, key?: string): Promise<Record<string, string>> {
    const result = await storageGetViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      kind,
      key,
    });
    return result.values;
  }

  /**
   * Set a value in localStorage or sessionStorage.
   *
   * @param kind - `'local'` for localStorage, `'session'` for sessionStorage
   * @param key - Storage key
   * @param value - Storage value
   */
  async storageSet(kind: StorageKind, key: string, value: string): Promise<void> {
    return storageSetViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      kind,
      key,
      value,
    });
  }

  /**
   * Clear all entries in localStorage or sessionStorage.
   *
   * @param kind - `'local'` for localStorage, `'session'` for sessionStorage
   */
  async storageClear(kind: StorageKind): Promise<void> {
    return storageClearViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      kind,
    });
  }

  // ── Downloads ───────────────────────────────────────────────

  /**
   * Click a ref and save the resulting file download.
   *
   * @param ref - Ref ID of the element that triggers the download
   * @param path - Local file path to save the download to
   * @param opts - Timeout options
   * @returns Download result with URL, suggested filename, and saved path
   *
   * @example
   * ```ts
   * const result = await page.download('e7', '/tmp/report.pdf');
   * console.log(result.suggestedFilename); // 'report.pdf'
   * ```
   */
  async download(
    ref: string,
    path: string,
    opts?: { timeoutMs?: number; allowedOutputRoots?: string[] },
  ): Promise<DownloadResult> {
    return downloadViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      ref,
      path,
      timeoutMs: opts?.timeoutMs,
      allowedOutputRoots: opts?.allowedOutputRoots,
    });
  }

  /**
   * Wait for the next download event (without clicking).
   *
   * Returns a promise — store it (don't await), trigger the download, then await it.
   *
   * @param opts - Options (path: save location, timeoutMs)
   * @returns Download result with URL, suggested filename, and saved path
   */
  async waitForDownload(opts?: {
    path?: string;
    timeoutMs?: number;
    allowedOutputRoots?: string[];
  }): Promise<DownloadResult> {
    return waitForDownloadViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      path: opts?.path,
      timeoutMs: opts?.timeoutMs,
      allowedOutputRoots: opts?.allowedOutputRoots,
    });
  }

  // ── Emulation ───────────────────────────────────────────────

  /**
   * Set the browser to offline or online mode.
   *
   * @param offline - `true` to go offline, `false` to go online
   */
  async setOffline(offline: boolean): Promise<void> {
    return setOfflineViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      offline,
    });
  }

  /**
   * Set extra HTTP headers for all requests.
   *
   * @param headers - Headers to add to every request
   *
   * @example
   * ```ts
   * await page.setExtraHeaders({ 'X-Custom': 'value' });
   * ```
   */
  async setExtraHeaders(headers: Record<string, string>): Promise<void> {
    return setExtraHTTPHeadersViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      headers,
    });
  }

  /**
   * Set HTTP authentication credentials.
   *
   * @param opts - Credentials (username, password) or `{ clear: true }` to remove
   */
  async setHttpCredentials(opts: HttpCredentials): Promise<void> {
    return setHttpCredentialsViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      username: opts.username,
      password: opts.password,
      clear: opts.clear,
    });
  }

  /**
   * Emulate a geolocation.
   *
   * @param opts - Geolocation coordinates or `{ clear: true }` to clear
   *
   * @example
   * ```ts
   * await page.setGeolocation({ latitude: 48.8566, longitude: 2.3522 }); // Paris
   * await page.setGeolocation({ clear: true }); // reset
   * ```
   */
  async setGeolocation(opts: GeolocationOptions): Promise<void> {
    return setGeolocationViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      latitude: opts.latitude,
      longitude: opts.longitude,
      accuracy: opts.accuracy,
      origin: opts.origin,
      clear: opts.clear,
    });
  }

  /**
   * Emulate a preferred color scheme.
   *
   * @param opts - Color scheme options
   *
   * @example
   * ```ts
   * await page.emulateMedia({ colorScheme: 'dark' });
   * ```
   */
  async emulateMedia(opts: { colorScheme: ColorScheme }): Promise<void> {
    return emulateMediaViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      colorScheme: opts.colorScheme,
    });
  }

  /**
   * Override the browser locale.
   *
   * @param locale - BCP-47 locale string (e.g. `'fr-FR'`, `'ja-JP'`)
   */
  async setLocale(locale: string): Promise<void> {
    return setLocaleViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      locale,
    });
  }

  /**
   * Override the browser timezone.
   *
   * @param timezoneId - IANA timezone ID (e.g. `'America/New_York'`, `'Asia/Tokyo'`)
   */
  async setTimezone(timezoneId: string): Promise<void> {
    return setTimezoneViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      timezoneId,
    });
  }

  /**
   * Emulate a specific device (viewport + user agent).
   *
   * @param name - Playwright device name (e.g. `'iPhone 13'`, `'Pixel 5'`)
   *
   * @example
   * ```ts
   * await page.setDevice('iPhone 13');
   * ```
   */
  async setDevice(name: string): Promise<void> {
    return setDeviceViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      name,
    });
  }

  // ── Anti-Bot ──────────────────────────────────────────────────

  /**
   * Detect whether the page is showing an anti-bot challenge
   * (Cloudflare, hCaptcha, reCAPTCHA, access-denied, rate-limit, etc.).
   *
   * Returns `null` if no challenge is detected.
   *
   * @example
   * ```ts
   * const challenge = await page.detectChallenge();
   * if (challenge) {
   *   console.log(challenge.kind);    // 'cloudflare-js'
   *   console.log(challenge.message); // 'Cloudflare JS challenge'
   * }
   * ```
   */
  async detectChallenge(): Promise<ChallengeInfo | null> {
    return detectChallengeViaPlaywright({ cdpUrl: this.cdpUrl, targetId: this._targetId });
  }

  /**
   * Wait for an anti-bot challenge to resolve on its own.
   *
   * Cloudflare JS challenges typically auto-resolve in ~5 seconds.
   * CAPTCHA challenges will only resolve if solved in a visible browser window.
   *
   * @param opts.timeoutMs - Maximum wait time (default: `15000`)
   * @param opts.pollMs - Poll interval (default: `500`)
   * @returns Whether the challenge resolved, and the remaining challenge info if not
   *
   * @example
   * ```ts
   * await page.goto('https://demo.playwright.dev/todomvc');
   * const challenge = await page.detectChallenge();
   * if (challenge?.kind === 'cloudflare-js') {
   *   const { resolved } = await page.waitForChallenge({ timeoutMs: 20000 });
   *   if (!resolved) throw new Error('Challenge did not resolve');
   * }
   * ```
   */
  async waitForChallenge(opts?: { timeoutMs?: number; pollMs?: number }): Promise<ChallengeWaitResult> {
    return waitForChallengeViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this._targetId,
      timeoutMs: opts?.timeoutMs,
      pollMs: opts?.pollMs,
    });
  }

  // ── Auth Health ──────────────────────────────────────────────

  /**
   * Check whether the current page session appears authenticated.
   *
   * Evaluates one or more rules against the page state. All rules must pass
   * for `authenticated` to be `true`. Returns per-rule details for debugging.
   *
   * @param rules - Array of auth check rules (url, cookie, selector, text, textGone, fn)
   * @returns Authentication status and per-rule check details
   *
   * @example
   * ```ts
   * // Check by URL and absence of login text
   * const result = await page.isAuthenticated([
   *   { url: '/dashboard' },
   *   { textGone: 'Sign in' },
   * ]);
   * if (!result.authenticated) {
   *   console.log('Auth failed:', result.checks.filter(c => !c.passed));
   * }
   *
   * // Check by cookie presence
   * const result = await page.isAuthenticated([{ cookie: 'session_id' }]);
   *
   * // Check with custom JS function
   * const result = await page.isAuthenticated([
   *   { fn: '() => !!document.querySelector("[data-user-id]")' },
   * ]);
   * ```
   */
  async isAuthenticated(rules: AuthCheckRule[]): Promise<AuthCheckResult> {
    if (!rules.length) return { authenticated: true, checks: [] };

    const page = await getRestoredPageForTarget({ cdpUrl: this.cdpUrl, targetId: this._targetId });
    const checks: AuthCheckDetail[] = [];

    // Pre-fetch body text once if any rule needs it, to avoid redundant evaluations
    const needsBodyText = rules.some((r) => r.text !== undefined || r.textGone !== undefined);
    let bodyText: string | null = null;
    if (needsBodyText) {
      try {
        const raw = await evaluateViaPlaywright({
          cdpUrl: this.cdpUrl,
          targetId: this._targetId,
          fn: '() => { const b = document.body; return b ? b.innerText : ""; }',
          ssrfPolicy: this.ssrfPolicy,
        });
        bodyText = typeof raw === 'string' ? raw : null;
      } catch (err) {
        console.warn(
          `[browserclaw] isAuthenticated body text fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const rule of rules) {
      if (rule.url !== undefined) {
        const currentUrl = page.url();
        const passed = currentUrl.includes(rule.url);
        checks.push({ rule: 'url', passed, detail: passed ? currentUrl : `expected "${rule.url}" in "${currentUrl}"` });
      }

      if (rule.cookie !== undefined) {
        const cookies = await page.context().cookies();
        const found = cookies.some((c) => c.name === rule.cookie && c.value !== '');
        checks.push({
          rule: 'cookie',
          passed: found,
          detail: found ? `cookie "${rule.cookie}" present` : `cookie "${rule.cookie}" missing or empty`,
        });
      }

      if (rule.selector !== undefined) {
        try {
          const count = await page.locator(rule.selector).count();
          const passed = count > 0;
          checks.push({
            rule: 'selector',
            passed,
            detail: passed ? `"${rule.selector}" found (${String(count)})` : `"${rule.selector}" not found`,
          });
        } catch (err) {
          console.warn(
            `[browserclaw] isAuthenticated selector check failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          checks.push({ rule: 'selector', passed: false, detail: `"${rule.selector}" error during evaluation` });
        }
      }

      if (rule.text !== undefined || rule.textGone !== undefined) {
        if (rule.text !== undefined) {
          if (bodyText === null) {
            checks.push({ rule: 'text', passed: false, detail: `"${rule.text}" error during evaluation` });
          } else {
            const passed = bodyText.includes(rule.text);
            checks.push({
              rule: 'text',
              passed,
              detail: passed ? `"${rule.text}" found` : `"${rule.text}" not found in page text`,
            });
          }
        }

        if (rule.textGone !== undefined) {
          if (bodyText === null) {
            checks.push({ rule: 'textGone', passed: false, detail: `"${rule.textGone}" error during evaluation` });
          } else {
            const passed = !bodyText.includes(rule.textGone);
            checks.push({
              rule: 'textGone',
              passed,
              detail: passed ? `"${rule.textGone}" absent (good)` : `"${rule.textGone}" still present`,
            });
          }
        }
      }

      if (rule.fn !== undefined) {
        try {
          const result: unknown = await evaluateViaPlaywright({
            cdpUrl: this.cdpUrl,
            targetId: this._targetId,
            fn: rule.fn,
            ssrfPolicy: this.ssrfPolicy,
          });
          const passed = result !== null && result !== undefined && result !== false && result !== 0 && result !== '';
          checks.push({
            rule: 'fn',
            passed,
            detail: passed ? 'function returned truthy' : `function returned ${JSON.stringify(result)}`,
          });
        } catch (err) {
          checks.push({
            rule: 'fn',
            passed: false,
            detail: `function threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    return {
      authenticated: checks.length > 0 && checks.every((c) => c.passed),
      checks,
    };
  }

  // ── Playwright Escape Hatches ─────────────────────────────────

  /**
   * Get the underlying Playwright `Page` object for this tab.
   *
   * Use this when browserclaw's API doesn't cover your use case and you need
   * direct access to Playwright's full API (custom locator strategies,
   * frame manipulation, request interception, etc.).
   *
   * **Warning:** Modifications made via the raw Playwright page may conflict
   * with browserclaw's internal state (e.g. ref tracking). Use with care.
   *
   * @returns The Playwright `Page` instance
   *
   * @example
   * ```ts
   * const pwPage = await page.playwrightPage();
   *
   * // Use Playwright's full API directly
   * await pwPage.locator('.my-component').waitFor({ state: 'visible' });
   * await pwPage.route('**\/api/**', route => route.fulfill({ body: '{}' }));
   *
   * // Access frames
   * const frame = pwPage.frameLocator('#my-iframe');
   * ```
   */
  async playwrightPage(): Promise<Page> {
    return getRestoredPageForTarget({ cdpUrl: this.cdpUrl, targetId: this._targetId });
  }

  /**
   * Create a Playwright `Locator` for a CSS selector on this page.
   *
   * Convenience method that returns a Playwright locator without needing
   * to first obtain the Page object. Useful for one-off Playwright operations.
   *
   * @param selector - CSS selector or Playwright selector string
   * @returns A Playwright `Locator` instance
   *
   * @example
   * ```ts
   * const loc = await page.locator('.modal-dialog button.confirm');
   * await loc.waitFor({ state: 'visible' });
   * await loc.click();
   *
   * // Use Playwright selectors
   * const input = await page.locator('input[name="email"]');
   * await input.fill('test@acme.test');
   * ```
   */
  async locator(selector: string): Promise<Locator> {
    const pwPage = await getRestoredPageForTarget({ cdpUrl: this.cdpUrl, targetId: this._targetId });
    return pwPage.locator(selector);
  }
}

/**
 * Main entry point for browserclaw.
 *
 * Launch or connect to a browser, then open pages and automate them
 * using the snapshot + ref pattern.
 *
 * @example
 * ```ts
 * import { BrowserClaw } from 'browserclaw';
 *
 * const browser = await BrowserClaw.launch({ url: 'https://demo.playwright.dev/todomvc' });
 * const page = await browser.currentPage();
 *
 * const { snapshot, refs } = await page.snapshot();
 * console.log(snapshot); // AI-readable page tree
 * console.log(refs);     // { "e1": { role: "textbox", name: "What needs to be done?" }, ... }
 *
 * await page.click('e1');
 * await browser.stop();
 * ```
 */
export class BrowserClaw {
  private readonly cdpUrl: string;
  private readonly ssrfPolicy: SsrfPolicy | undefined;
  private readonly recordVideo: { dir: string; size?: { width: number; height: number } } | undefined;
  private chrome: RunningChrome | null;
  private readonly _telemetry: RunTelemetry;

  private constructor(
    cdpUrl: string,
    chrome: RunningChrome | null,
    telemetry: RunTelemetry,
    ssrfPolicy?: SsrfPolicy,
    recordVideo?: { dir: string; size?: { width: number; height: number } },
  ) {
    this.cdpUrl = cdpUrl;
    this.chrome = chrome;
    this._telemetry = telemetry;
    this.ssrfPolicy = ssrfPolicy;
    this.recordVideo = recordVideo;
  }

  /**
   * Launch a new Chrome instance and connect to it.
   *
   * Automatically detects Chrome, Brave, Edge, or Chromium on the system.
   * Creates a dedicated browser profile to avoid conflicts with your daily browser.
   *
   * @param opts - Launch options (headless, executablePath, cdpPort, etc.)
   * @returns A connected BrowserClaw instance
   *
   * @example
   * ```ts
   * // Launch and navigate to a URL
   * const browser = await BrowserClaw.launch({ url: 'https://demo.playwright.dev/todomvc' });
   *
   * // Headless mode
   * const browser = await BrowserClaw.launch({ url: 'https://demo.playwright.dev/todomvc', headless: true });
   *
   * // Specific browser
   * const browser = await BrowserClaw.launch({
   *   url: 'https://demo.playwright.dev/todomvc',
   *   executablePath: '/usr/bin/google-chrome',
   * });
   * ```
   */
  static async launch(opts: LaunchOptions = {}): Promise<BrowserClaw> {
    const startedAt = new Date().toISOString();
    const chrome = await launchChrome(opts);
    try {
      const cdpUrl = `http://127.0.0.1:${String(chrome.cdpPort)}`;
      /* eslint-disable @typescript-eslint/no-deprecated -- backward-compat bridge for allowInternal */
      const ssrfPolicy =
        opts.allowInternal === true ? { ...opts.ssrfPolicy, dangerouslyAllowPrivateNetwork: true } : opts.ssrfPolicy;
      /* eslint-enable @typescript-eslint/no-deprecated */
      // Bootstrap connect to our own freshly-spawned loopback Chrome — no policy check.
      await connectBrowser(cdpUrl, undefined);
      const telemetry: RunTelemetry = {
        launchMs: chrome.launchMs,
        timestamps: { startedAt, launchedAt: new Date().toISOString() },
      };
      const browser = new BrowserClaw(cdpUrl, chrome, telemetry, ssrfPolicy, opts.recordVideo);
      if (opts.url !== undefined && opts.url !== '') {
        const page = await browser.currentPage();
        const navT0 = Date.now();
        await page.goto(opts.url);
        telemetry.navMs = Date.now() - navT0;
        telemetry.timestamps.navigatedAt = new Date().toISOString();
      }
      return browser;
    } catch (err) {
      await stopChrome(chrome).catch(() => {
        /* noop — best-effort cleanup */
      });
      throw err;
    }
  }

  /**
   * Connect to an already-running Chrome instance via its CDP endpoint.
   *
   * The Chrome instance must have been started with `--remote-debugging-port`.
   *
   * @param cdpUrl - CDP endpoint URL (e.g. `'http://localhost:9222'`)
   * @returns A connected BrowserClaw instance
   *
   * @example
   * ```ts
   * // Chrome started with: chrome --remote-debugging-port=9222
   * const browser = await BrowserClaw.connect('http://localhost:9222');
   * ```
   */
  static async connect(cdpUrl?: string, opts?: ConnectOptions): Promise<BrowserClaw> {
    const startedAt = new Date().toISOString();
    const connectT0 = Date.now();
    let resolvedUrl = cdpUrl;
    if (resolvedUrl === undefined || resolvedUrl === '') {
      const discovered = await discoverChromeCdpUrl();
      if (discovered === null) {
        throw new Error(
          'No Chrome instance found on common CDP ports (9222-9226, 9229). Start Chrome with --remote-debugging-port=9222, or pass a CDP URL.',
        );
      }
      resolvedUrl = discovered;
    }
    /* eslint-disable @typescript-eslint/no-deprecated -- backward-compat bridge for allowInternal */
    const ssrfPolicy =
      opts?.allowInternal === true ? { ...opts.ssrfPolicy, dangerouslyAllowPrivateNetwork: true } : opts?.ssrfPolicy;
    /* eslint-enable @typescript-eslint/no-deprecated */
    // Surface SSRF policy errors with the right error type rather than letting
    // isChromeReachable swallow them and report the generic "Cannot connect".
    await assertCdpEndpointAllowed(resolvedUrl, ssrfPolicy);
    if (!(await isChromeReachable(resolvedUrl, 3000, opts?.authToken, ssrfPolicy))) {
      throw new Error(`Cannot connect to Chrome at ${resolvedUrl}. Is Chrome running with --remote-debugging-port?`);
    }
    await connectBrowser(resolvedUrl, opts?.authToken, ssrfPolicy);
    const telemetry: RunTelemetry = {
      connectMs: Date.now() - connectT0,
      timestamps: { startedAt, connectedAt: new Date().toISOString() },
    };
    return new BrowserClaw(resolvedUrl, null, telemetry, ssrfPolicy, opts?.recordVideo);
  }

  /**
   * Open a URL in a new tab and return the page handle.
   *
   * @param url - URL to navigate to
   * @returns A CrawlPage for the new tab
   *
   * @example
   * ```ts
   * const page = await browser.open('https://demo.playwright.dev/todomvc');
   * const { snapshot, refs } = await page.snapshot();
   * ```
   */
  async open(url: string): Promise<CrawlPage> {
    const tab = await createPageViaPlaywright({
      cdpUrl: this.cdpUrl,
      url,
      ssrfPolicy: this.ssrfPolicy,
      recordVideo: this.recordVideo,
    });
    return new CrawlPage(this.cdpUrl, tab.targetId, this.ssrfPolicy);
  }

  /**
   * Get a CrawlPage handle for the first usable tab.
   *
   * This is a best-effort heuristic — it prefers non-blank tabs over
   * `about:blank` placeholders but does NOT query Chrome's real
   * focused-tab state. In a multi-tab session with several real tabs,
   * `currentPage()` may return a tab other than the one the user is
   * looking at. Track `targetId` explicitly (via `browser.open()` or
   * `browser.waitForTab()`) when you need deterministic tab selection.
   *
   * @returns CrawlPage for the first usable (non-blank, if possible) page
   */
  async currentPage(): Promise<CrawlPage> {
    const connectT0 = Date.now();
    await connectBrowser(this.cdpUrl);
    if (this._telemetry.connectMs === undefined) {
      this._telemetry.connectMs = Date.now() - connectT0;
      this._telemetry.timestamps.connectedAt = new Date().toISOString();
    }
    const tid = await resolveActiveTargetId(this.cdpUrl, { ssrfPolicy: this.ssrfPolicy });
    if (tid === null) throw new BrowserTabNotFoundError('No pages available. Use browser.open(url) to create a tab.');
    return new CrawlPage(this.cdpUrl, tid, this.ssrfPolicy);
  }

  /**
   * List all open tabs.
   *
   * @returns Array of tab information objects
   */
  async tabs(): Promise<BrowserTab[]> {
    return listPagesViaPlaywright({ cdpUrl: this.cdpUrl });
  }

  /**
   * Wait for a tab matching the given criteria and return a page handle.
   *
   * Polls open tabs until one matches, then focuses it and returns a CrawlPage.
   *
   * @param opts - Match criteria (urlContains, titleContains) and timeout
   * @returns A CrawlPage for the matched tab
   *
   * @example
   * ```ts
   * await page.click('e5'); // opens a new tab
   * const appPage = await browser.waitForTab({ urlContains: 'app-web' });
   * const { snapshot } = await appPage.snapshot();
   * ```
   */
  async waitForTab(opts: { urlContains?: string; titleContains?: string; timeoutMs?: number }): Promise<CrawlPage> {
    const tab = await waitForTabViaPlaywright({
      cdpUrl: this.cdpUrl,
      urlContains: opts.urlContains,
      titleContains: opts.titleContains,
      timeoutMs: opts.timeoutMs,
    });
    await focusPageByTargetIdViaPlaywright({ cdpUrl: this.cdpUrl, targetId: tab.targetId });
    return new CrawlPage(this.cdpUrl, tab.targetId, this.ssrfPolicy);
  }

  /**
   * Bring a tab to the foreground.
   *
   * @param targetId - CDP target ID of the tab (from `tabs()` or `page.id`)
   */
  async focus(targetId: string): Promise<void> {
    return focusPageByTargetIdViaPlaywright({ cdpUrl: this.cdpUrl, targetId });
  }

  /**
   * Close a tab.
   *
   * @param targetId - CDP target ID of the tab to close
   */
  async close(targetId: string): Promise<void> {
    return closePageByTargetIdViaPlaywright({ cdpUrl: this.cdpUrl, targetId });
  }

  /**
   * Get a CrawlPage handle for a specific tab by its target ID.
   *
   * Unlike `open()`, this doesn't create a new tab — it wraps an existing one.
   *
   * @param targetId - CDP target ID of the tab
   * @returns CrawlPage for the specified tab
   */
  page(targetId: string): CrawlPage {
    return new CrawlPage(this.cdpUrl, targetId, this.ssrfPolicy);
  }

  /** The CDP endpoint URL for this browser connection. */
  get url(): string {
    return this.cdpUrl;
  }

  /**
   * Stop the browser and clean up all resources.
   *
   * If the browser was launched by `BrowserClaw.launch()`, the Chrome process
   * will be terminated. If connected via `BrowserClaw.connect()`, only the
   * Playwright connection is closed.
   *
   * @param exitReason - Optional structured reason for stopping. One of: `'success'`, `'auth_failed'`, `'timeout'`, `'error'`, `'manual'`, `'nav_failed'`, `'crash'`, `'disconnected'`
   */
  async stop(exitReason?: ExitReason | (string & {})): Promise<void> {
    this._telemetry.timestamps.stoppedAt = new Date().toISOString();
    if (exitReason !== undefined) this._telemetry.exitReason = exitReason;
    try {
      clearRecordingContext(this.cdpUrl);
      await closePlaywrightBrowserConnection({ cdpUrl: this.cdpUrl });
      if (this.chrome) {
        await stopChrome(this.chrome);
        this.chrome = null;
      }
      this._telemetry.cleanupOk = true;
    } catch (err) {
      this._telemetry.cleanupOk = false;
      throw err;
    }
  }

  /**
   * Get structured telemetry for this browser session.
   *
   * Returns timing data, timestamps, and exit information collected
   * throughout the session lifecycle. Useful for diagnosing startup
   * latency, auth failures, and cleanup issues in cron/unattended runs.
   *
   * @returns Telemetry envelope with launch/connect/nav timings and exit info
   *
   * @example
   * ```ts
   * const browser = await BrowserClaw.launch({ url: 'https://example.com' });
   * const page = await browser.currentPage();
   *
   * // ... do work ...
   *
   * const auth = await page.isAuthenticated([{ cookie: 'session' }]);
   * browser.recordAuthResult(auth.authenticated);
   *
   * await browser.stop(auth.authenticated ? 'success' : 'auth_failed');
   * console.log(browser.telemetry());
   * // { launchMs: 1823, connectMs: 45, navMs: 620, authOk: true,
   * //   exitReason: 'success', cleanupOk: true, timestamps: { ... } }
   * ```
   */
  telemetry(): Readonly<RunTelemetry> {
    return this._telemetry;
  }

  /**
   * Record the result of an authentication check in the telemetry envelope.
   *
   * @param ok - Whether authentication was successful
   */
  recordAuthResult(ok: boolean): void {
    this._telemetry.authOk = ok;
  }
}
