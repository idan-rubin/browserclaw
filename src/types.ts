// ── Chrome Launcher ──

/** Supported browser types that can be detected and launched. */
export type ChromeKind = 'chrome' | 'brave' | 'edge' | 'chromium' | 'canary' | 'custom';

/** A detected browser executable on the system. */
export interface ChromeExecutable {
  /** The type of browser (chrome, brave, edge, etc.) */
  kind: ChromeKind;
  /** Absolute path to the browser executable */
  path: string;
}

/** A running Chrome instance managed by browserclaw. */
export interface RunningChrome {
  /** Process ID of the Chrome process */
  pid: number;
  /** The browser executable that was launched */
  exe: ChromeExecutable;
  /** Path to the Chrome user data directory */
  userDataDir: string;
  /** CDP (Chrome DevTools Protocol) port number */
  cdpPort: number;
  /** Unix timestamp (ms) when the browser was started */
  startedAt: number;
  /** The child process handle */
  proc: import('node:child_process').ChildProcess;
}

/** Options for launching a new browser instance. */
export interface LaunchOptions {
  /** Run in headless mode (no visible window). Default: `false` */
  headless?: boolean;
  /** Path to a specific browser executable. Auto-detected if omitted. */
  executablePath?: string;
  /** CDP port to use. Default: `9222` */
  cdpPort?: number;
  /** Disable Chrome's sandbox (needed in some Docker/CI environments). Default: `false` */
  noSandbox?: boolean;
  /** Custom user data directory. Auto-generated if omitted. */
  userDataDir?: string;
  /** Profile name shown in the Chrome title bar. Default: `'browserclaw'` */
  profileName?: string;
  /** Profile accent color as a hex string (e.g. `'#FF4500'`). Default: `'#FF4500'` */
  profileColor?: string;
  /** Additional Chrome command-line arguments (e.g. `['--start-maximized']`). */
  chromeArgs?: string[];
}

/** Options for connecting to an existing browser instance. */
export interface ConnectOptions {
  /** CDP endpoint URL (e.g. `'http://localhost:9222'`) */
  cdpUrl: string;
}

// ── Snapshot ──

/**
 * Describes a single interactive element found during a snapshot.
 * Used to resolve refs (e.g. `e1`) back to Playwright locators.
 */
export interface RoleRefInfo {
  /** ARIA role of the element (e.g. `'button'`, `'textbox'`, `'link'`) */
  role: string;
  /** Accessible name of the element */
  name?: string;
  /** Disambiguation index when multiple elements share the same role + name */
  nth?: number;
}

/** Map of ref IDs (e.g. `'e1'`, `'e2'`) to their element information. */
export type RoleRefs = Record<string, RoleRefInfo>;

/** Result of taking a page snapshot. */
export interface SnapshotResult {
  /** AI-readable text representation of the page with numbered refs */
  snapshot: string;
  /** Map of ref IDs to element information for targeting actions */
  refs: RoleRefs;
  /** Statistics about the snapshot */
  stats?: SnapshotStats;
}

/** Statistics about a snapshot's content. */
export interface SnapshotStats {
  /** Number of lines in the snapshot text */
  lines: number;
  /** Number of characters in the snapshot text */
  chars: number;
  /** Total number of refs assigned */
  refs: number;
  /** Number of interactive element refs (buttons, links, inputs, etc.) */
  interactive: number;
}

/** Options for controlling snapshot output. */
export interface SnapshotOptions {
  /** Only include interactive elements (buttons, links, inputs, etc.) */
  interactive?: boolean;
  /** Remove structural containers that don't contain interactive elements */
  compact?: boolean;
  /** Maximum tree depth to include */
  maxDepth?: number;
  /** Maximum character count before truncation (aria mode only) */
  maxChars?: number;
  /** CSS selector to scope the snapshot to a specific element */
  selector?: string;
  /** Frame selector for snapshotting inside iframes (role mode only) */
  frameSelector?: string;
  /**
   * Snapshot strategy:
   * - `'aria'` (default) — uses Playwright's `_snapshotForAI()`, produces refs like `e1`
   * - `'role'` — uses Playwright's `ariaSnapshot()` + `getByRole()` resolution
   */
  mode?: 'role' | 'aria';
}

/** A node in the raw ARIA accessibility tree. */
export interface AriaNode {
  /** Ref ID for this node (e.g. `'ax1'`) */
  ref: string;
  /** ARIA role (e.g. `'button'`, `'heading'`, `'generic'`) */
  role: string;
  /** Accessible name */
  name: string;
  /** Current value (for inputs, sliders, etc.) */
  value?: string;
  /** Accessible description */
  description?: string;
  /** Backend DOM node ID (for CDP operations) */
  backendDOMNodeId?: number;
  /** Depth in the accessibility tree (0 = root) */
  depth: number;
}

/** Result of a raw ARIA tree snapshot. */
export interface AriaSnapshotResult {
  /** Flat list of accessibility tree nodes */
  nodes: AriaNode[];
}

// ── Actions ──

/** A form field to fill as part of a batch `fill()` operation. */
export interface FormField {
  /** Ref ID of the form field (e.g. `'e3'`) */
  ref: string;
  /** Field type: `'text'`, `'checkbox'`, `'radio'`, etc. */
  type: string;
  /** Value to set. Booleans for checkboxes, strings for text fields. */
  value?: string | number | boolean;
}

/** Options for click actions. */
export interface ClickOptions {
  /** Double-click instead of single click */
  doubleClick?: boolean;
  /** Mouse button to use */
  button?: 'left' | 'right' | 'middle';
  /** Modifier keys to hold during click */
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[];
  /** Timeout in milliseconds. Default: `8000` */
  timeoutMs?: number;
}

/** Options for type actions. */
export interface TypeOptions {
  /** Press Enter after typing */
  submit?: boolean;
  /** Type character-by-character with delay (75ms per key) instead of instant fill */
  slowly?: boolean;
  /** Timeout in milliseconds. Default: `8000` */
  timeoutMs?: number;
}

/**
 * Options for waiting on various conditions.
 * Multiple conditions can be combined — they are checked in order.
 */
export interface WaitOptions {
  /** Wait for a fixed duration (milliseconds) */
  timeMs?: number;
  /** Wait until text appears on the page */
  text?: string;
  /** Wait until text disappears from the page */
  textGone?: string;
  /** Wait until a CSS selector matches a visible element */
  selector?: string;
  /** Wait until the URL matches a pattern (supports `**` wildcards) */
  url?: string;
  /** Wait for a specific page load state */
  loadState?: 'load' | 'domcontentloaded' | 'networkidle';
  /** Wait until a JavaScript function returns truthy (evaluated in browser context) */
  fn?: string;
  /** Timeout for each condition in milliseconds. Default: `20000` */
  timeoutMs?: number;
}

/** Options for screenshot capture. */
export interface ScreenshotOptions {
  /** Capture the full scrollable page instead of just the viewport */
  fullPage?: boolean;
  /** Capture a specific element by ref ID */
  ref?: string;
  /** Capture a specific element by CSS selector */
  element?: string;
  /** Image format. Default: `'png'` */
  type?: 'png' | 'jpeg';
}

// ── Activity ──

/** A console message captured from the browser page. */
export interface ConsoleMessage {
  /** Message type: `'log'`, `'info'`, `'warning'`, `'error'`, `'debug'` */
  type: string;
  /** The message text */
  text: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Source location where the message was logged */
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
}

/** An uncaught error from the browser page. */
export interface PageError {
  /** Error message */
  message: string;
  /** Error name (e.g. `'TypeError'`) */
  name?: string;
  /** Stack trace */
  stack?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** A network request captured from the browser page. */
export interface NetworkRequest {
  /** Internal request ID (e.g. `'r1'`, `'r2'`) */
  id: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** HTTP method (e.g. `'GET'`, `'POST'`) */
  method: string;
  /** Request URL */
  url: string;
  /** Resource type (e.g. `'document'`, `'xhr'`, `'fetch'`, `'image'`) */
  resourceType: string;
  /** HTTP status code (set when response is received) */
  status?: number;
  /** Whether the response status was 2xx */
  ok?: boolean;
  /** Error text if the request failed */
  failureText?: string;
}

// ── Storage ──

/** Web storage type. */
export type StorageKind = 'local' | 'session';

/** Cookie data for setting a browser cookie. */
export interface CookieData {
  /** Cookie name */
  name: string;
  /** Cookie value */
  value: string;
  /** URL to associate the cookie with (alternative to domain+path) */
  url?: string;
  /** Cookie domain */
  domain?: string;
  /** Cookie path */
  path?: string;
  /** Expiration as Unix timestamp in seconds */
  expires?: number;
  /** HTTP-only flag */
  httpOnly?: boolean;
  /** Secure flag */
  secure?: boolean;
  /** SameSite attribute */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

// ── Tab ──

/** Information about an open browser tab. */
export interface BrowserTab {
  /** CDP target ID (used to identify this tab in API calls) */
  targetId: string;
  /** Page title */
  title: string;
  /** Current URL */
  url: string;
  /** Target type (usually `'page'`) */
  type: string;
}

// ── Page State (internal) ──

/** @internal */
export interface PageState {
  console: ConsoleMessage[];
  errors: PageError[];
  requests: NetworkRequest[];
  requestIds: WeakMap<any, string>;
  nextRequestId: number;
  roleRefs?: RoleRefs;
  roleRefsFrameSelector?: string;
  roleRefsMode?: 'role' | 'aria';
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
}

/** @internal */
export interface ContextState {
  traceActive: boolean;
}
