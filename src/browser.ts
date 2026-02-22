import { launchChrome, stopChrome, isChromeReachable } from './chrome-launcher.js';
import { connectBrowser, disconnectBrowser, getPageForTargetId, ensurePageState, restoreRoleRefsForTarget, refLocator, pageTargetId, getAllPages, normalizeTimeoutMs } from './connection.js';
import { snapshotAi } from './snapshot/ai-snapshot.js';
import { snapshotRole, snapshotAria } from './snapshot/aria-snapshot.js';
import { clickViaPlaywright, hoverViaPlaywright, typeViaPlaywright, selectOptionViaPlaywright, dragViaPlaywright, fillFormViaPlaywright, scrollIntoViewViaPlaywright, highlightViaPlaywright, setInputFilesViaPlaywright, armDialogViaPlaywright, armFileUploadViaPlaywright } from './actions/interaction.js';
import { pressKeyViaPlaywright } from './actions/keyboard.js';
import { navigateViaPlaywright, listPagesViaPlaywright, createPageViaPlaywright, closePageByTargetIdViaPlaywright, focusPageByTargetIdViaPlaywright, resizeViewportViaPlaywright } from './actions/navigation.js';
import { waitForViaPlaywright } from './actions/wait.js';
import { evaluateViaPlaywright, evaluateInAllFramesViaPlaywright, type FrameEvalResult } from './actions/evaluate.js';
import { downloadViaPlaywright, waitForDownloadViaPlaywright } from './actions/download.js';
import { emulateMediaViaPlaywright, setDeviceViaPlaywright, setExtraHTTPHeadersViaPlaywright, setGeolocationViaPlaywright, setHttpCredentialsViaPlaywright, setLocaleViaPlaywright, setOfflineViaPlaywright, setTimezoneViaPlaywright } from './actions/emulation.js';
import { takeScreenshotViaPlaywright, screenshotWithLabelsViaPlaywright } from './capture/screenshot.js';
import { pdfViaPlaywright } from './capture/pdf.js';
import { traceStartViaPlaywright, traceStopViaPlaywright } from './capture/trace.js';
import { responseBodyViaPlaywright } from './capture/response.js';
import { getConsoleMessagesViaPlaywright, getPageErrorsViaPlaywright, getNetworkRequestsViaPlaywright } from './capture/activity.js';
import { cookiesGetViaPlaywright, cookiesSetViaPlaywright, cookiesClearViaPlaywright, storageGetViaPlaywright, storageSetViaPlaywright, storageClearViaPlaywright } from './storage/index.js';
import type {
  LaunchOptions, ConnectOptions, SnapshotResult, SnapshotOptions, AriaSnapshotResult,
  BrowserTab, FormField, ClickOptions, TypeOptions, WaitOptions,
  ScreenshotOptions, ConsoleMessage, PageError, NetworkRequest,
  CookieData, StorageKind, RunningChrome, SsrfPolicy,
  DownloadResult, DialogOptions, ResponseBodyResult, TraceStartOptions,
  ColorScheme, GeolocationOptions, HttpCredentials,
} from './types.js';

/**
 * Represents a single browser page/tab with ref-based automation.
 *
 * The workflow is: **snapshot → read refs → act on refs**.
 *
 * @example
 * ```ts
 * const page = await browser.open('https://example.com');
 *
 * // 1. Take a snapshot to get refs
 * const { snapshot, refs } = await page.snapshot();
 * // snapshot: AI-readable text tree
 * // refs: { "e1": { role: "link", name: "More info" }, ... }
 *
 * // 2. Act on refs
 * await page.click('e1');
 * await page.type('e3', 'hello');
 * ```
 */
export class CrawlPage {
  private readonly cdpUrl: string;
  private readonly targetId: string;
  private readonly ssrfPolicy: SsrfPolicy | undefined;

  /** @internal */
  constructor(cdpUrl: string, targetId: string, ssrfPolicy?: SsrfPolicy) {
    this.cdpUrl = cdpUrl;
    this.targetId = targetId;
    this.ssrfPolicy = ssrfPolicy;
  }

  /** The CDP target ID for this page. Use this to identify the page in multi-tab scenarios. */
  get id(): string {
    return this.targetId;
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
        targetId: this.targetId,
        selector: opts.selector,
        frameSelector: opts.frameSelector,
        refsMode: opts.refsMode,
        options: {
          interactive: opts.interactive,
          compact: opts.compact,
          maxDepth: opts.maxDepth,
        },
      });
    }
    if (opts?.selector || opts?.frameSelector) {
      throw new Error('selector and frameSelector are only supported in role mode. Use { mode: "role" } or omit these options.');
    }
    return snapshotAi({
      cdpUrl: this.cdpUrl,
      targetId: this.targetId,
      maxChars: opts?.maxChars,
      options: {
        interactive: opts?.interactive,
        compact: opts?.compact,
        maxDepth: opts?.maxDepth,
      },
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
    return snapshotAria({ cdpUrl: this.cdpUrl, targetId: this.targetId, limit: opts?.limit });
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
      targetId: this.targetId,
      ref,
      doubleClick: opts?.doubleClick,
      button: opts?.button,
      modifiers: opts?.modifiers,
      timeoutMs: opts?.timeoutMs,
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
      targetId: this.targetId,
      ref,
      text,
      submit: opts?.submit,
      slowly: opts?.slowly,
      timeoutMs: opts?.timeoutMs,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
      ref,
      values,
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
      targetId: this.targetId,
      startRef,
      endRef,
      timeoutMs: opts?.timeoutMs,
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
   *   { ref: 'e4', type: 'text', value: 'jane@example.com' },
   *   { ref: 'e6', type: 'checkbox', value: true },
   * ]);
   * ```
   */
  async fill(fields: FormField[]): Promise<void> {
    return fillFormViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
      ref,
      paths,
    });
  }

  /**
   * Arm a one-shot dialog handler (alert, confirm, prompt).
   *
   * Returns a promise — store it (don't await), trigger the dialog, then await it.
   *
   * @param opts - Dialog options (accept/dismiss, prompt text, timeout)
   *
   * @example
   * ```ts
   * const dialogDone = page.armDialog({ accept: true }); // don't await here
   * await page.click('e5'); // triggers confirm()
   * await dialogDone;       // wait for dialog to be handled
   * ```
   */
  async armDialog(opts: DialogOptions): Promise<void> {
    return armDialogViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this.targetId,
      accept: opts.accept,
      promptText: opts.promptText,
      timeoutMs: opts.timeoutMs,
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
      targetId: this.targetId,
      paths,
      timeoutMs: opts?.timeoutMs,
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
      targetId: this.targetId,
      key,
      delayMs: opts?.delayMs,
    });
  }

  // ── Navigation ───────────────────────────────────────────────

  /**
   * Get the current URL of the page.
   */
  async url(): Promise<string> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this.targetId });
    return page.url();
  }

  /**
   * Get the page title.
   */
  async title(): Promise<string> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this.targetId });
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
      targetId: this.targetId,
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
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this.targetId });
    ensurePageState(page);
    await page.reload({ timeout: normalizeTimeoutMs(opts?.timeoutMs, 20000) });
  }

  /**
   * Navigate back in browser history.
   *
   * @param opts - Timeout options
   */
  async goBack(opts?: { timeoutMs?: number }): Promise<void> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this.targetId });
    ensurePageState(page);
    await page.goBack({ timeout: normalizeTimeoutMs(opts?.timeoutMs, 20000) });
  }

  /**
   * Navigate forward in browser history.
   *
   * @param opts - Timeout options
   */
  async goForward(opts?: { timeoutMs?: number }): Promise<void> {
    const page = await getPageForTargetId({ cdpUrl: this.cdpUrl, targetId: this.targetId });
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
      targetId: this.targetId,
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
      targetId: this.targetId,
      fn,
      ref: opts?.ref,
      timeoutMs: opts?.timeoutMs,
      signal: opts?.signal,
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
      targetId: this.targetId,
      fn,
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
      targetId: this.targetId,
      fullPage: opts?.fullPage,
      ref: opts?.ref,
      element: opts?.element,
      type: opts?.type,
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
    const result = await pdfViaPlaywright({ cdpUrl: this.cdpUrl, targetId: this.targetId });
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
  async screenshotWithLabels(refs: string[], opts?: { maxLabels?: number; type?: 'png' | 'jpeg' }): Promise<{
    buffer: Buffer;
    labels: Array<{ ref: string; index: number; box: { x: number; y: number; width: number; height: number } }>;
    skipped: string[];
  }> {
    return screenshotWithLabelsViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this.targetId,
      refs,
      maxLabels: opts?.maxLabels,
      type: opts?.type,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
      url,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
  async cookies(): Promise<Awaited<ReturnType<import('playwright-core').BrowserContext['cookies']>>> {
    const result = await cookiesGetViaPlaywright({ cdpUrl: this.cdpUrl, targetId: this.targetId });
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
   *   url: 'https://example.com',
   * });
   * ```
   */
  async setCookie(cookie: CookieData): Promise<void> {
    return cookiesSetViaPlaywright({ cdpUrl: this.cdpUrl, targetId: this.targetId, cookie });
  }

  /** Clear all cookies in the browser context. */
  async clearCookies(): Promise<void> {
    return cookiesClearViaPlaywright({ cdpUrl: this.cdpUrl, targetId: this.targetId });
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
      cdpUrl: this.cdpUrl, targetId: this.targetId, kind, key,
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
      cdpUrl: this.cdpUrl, targetId: this.targetId, kind, key, value,
    });
  }

  /**
   * Clear all entries in localStorage or sessionStorage.
   *
   * @param kind - `'local'` for localStorage, `'session'` for sessionStorage
   */
  async storageClear(kind: StorageKind): Promise<void> {
    return storageClearViaPlaywright({
      cdpUrl: this.cdpUrl, targetId: this.targetId, kind,
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
  async download(ref: string, path: string, opts?: { timeoutMs?: number; allowedOutputRoots?: string[] }): Promise<DownloadResult> {
    return downloadViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this.targetId,
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
  async waitForDownload(opts?: { path?: string; timeoutMs?: number; allowedOutputRoots?: string[] }): Promise<DownloadResult> {
    return waitForDownloadViaPlaywright({
      cdpUrl: this.cdpUrl,
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
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
      targetId: this.targetId,
      name,
    });
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
 * const browser = await BrowserClaw.launch({ headless: false });
 * const page = await browser.open('https://example.com');
 *
 * const { snapshot, refs } = await page.snapshot();
 * console.log(snapshot); // AI-readable page tree
 * console.log(refs);     // { "e1": { role: "link", name: "More info" }, ... }
 *
 * await page.click('e1');
 * await browser.stop();
 * ```
 */
export class BrowserClaw {
  private readonly cdpUrl: string;
  private readonly ssrfPolicy: SsrfPolicy | undefined;
  private chrome: RunningChrome | null;

  private constructor(cdpUrl: string, chrome: RunningChrome | null, ssrfPolicy?: SsrfPolicy) {
    this.cdpUrl = cdpUrl;
    this.chrome = chrome;
    this.ssrfPolicy = ssrfPolicy;
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
   * // Default: visible Chrome window
   * const browser = await BrowserClaw.launch();
   *
   * // Headless mode
   * const browser = await BrowserClaw.launch({ headless: true });
   *
   * // Specific browser
   * const browser = await BrowserClaw.launch({
   *   executablePath: '/usr/bin/google-chrome',
   * });
   * ```
   */
  static async launch(opts: LaunchOptions = {}): Promise<BrowserClaw> {
    const chrome = await launchChrome(opts);
    const cdpUrl = `http://127.0.0.1:${chrome.cdpPort}`;
    const ssrfPolicy = opts.allowInternal ? { ...opts.ssrfPolicy, allowPrivateNetwork: true } : opts.ssrfPolicy;
    return new BrowserClaw(cdpUrl, chrome, ssrfPolicy);
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
  static async connect(cdpUrl: string, opts?: ConnectOptions): Promise<BrowserClaw> {
    if (!await isChromeReachable(cdpUrl, 3000, opts?.authToken)) {
      throw new Error(`Cannot connect to Chrome at ${cdpUrl}. Is Chrome running with --remote-debugging-port?`);
    }
    await connectBrowser(cdpUrl, opts?.authToken);
    const ssrfPolicy = opts?.allowInternal ? { ...opts.ssrfPolicy, allowPrivateNetwork: true } : opts?.ssrfPolicy;
    return new BrowserClaw(cdpUrl, null, ssrfPolicy);
  }

  /**
   * Open a URL in a new tab and return the page handle.
   *
   * @param url - URL to navigate to
   * @returns A CrawlPage for the new tab
   *
   * @example
   * ```ts
   * const page = await browser.open('https://example.com');
   * const { snapshot, refs } = await page.snapshot();
   * ```
   */
  async open(url: string): Promise<CrawlPage> {
    const tab = await createPageViaPlaywright({ cdpUrl: this.cdpUrl, url, ssrfPolicy: this.ssrfPolicy });
    return new CrawlPage(this.cdpUrl, tab.targetId, this.ssrfPolicy);
  }

  /**
   * Get a CrawlPage handle for the currently active tab.
   *
   * @returns CrawlPage for the first/active page
   */
  async currentPage(): Promise<CrawlPage> {
    const { browser } = await connectBrowser(this.cdpUrl);
    const pages = await getAllPages(browser);
    if (!pages.length) throw new Error('No pages available. Use browser.open(url) to create a tab.');
    const tid = await pageTargetId(pages[0]!).catch(() => null);
    if (!tid) throw new Error('Failed to get targetId for the current page.');
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
   */
  async stop(): Promise<void> {
    await disconnectBrowser();
    if (this.chrome) {
      await stopChrome(this.chrome);
      this.chrome = null;
    }
  }
}
