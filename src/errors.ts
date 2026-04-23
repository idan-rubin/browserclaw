/**
 * Structured error types raised by BrowserClaw's low-level primitives.
 *
 * Workflow code can `instanceof`-check these to distinguish recoverable
 * cases (stale ref, empty hydration) from harder failures (missing tab,
 * unexpected navigation).
 */

/**
 * Thrown when a targetId is not backed by any open tab on the browser.
 *
 * Typical causes: the tab was closed, the process was restarted, or a
 * stored targetId is being reused across sessions. Call `browser.tabs()`
 * to discover the currently open tabs.
 */
export class BrowserTabNotFoundError extends Error {
  constructor(message = 'Tab not found') {
    super(message);
    this.name = 'BrowserTabNotFoundError';
  }
}

/**
 * Thrown when a ref from a prior snapshot can no longer be resolved on the page.
 *
 * Typical causes: the page re-rendered (SPA route change, modal close, data
 * refresh), the element was removed, or the snapshot is too old. Recovery is
 * almost always to take a fresh snapshot and use the new refs.
 */
export class StaleRefError extends Error {
  /** The ref ID that could not be resolved. */
  readonly ref: string;
  constructor(ref: string, message?: string) {
    super(
      message ??
        `Unknown ref "${ref}". Run a new snapshot and use a ref from that snapshot (the page may have re-rendered).`,
    );
    this.name = 'StaleRefError';
    this.ref = ref;
  }
}

/**
 * Thrown when a snapshot comes back empty or without interactive refs after
 * hydration retries were exhausted.
 *
 * Typical causes: the page is still hydrating, an SPA has not yet rendered
 * its first interactive frame, or an anti-bot challenge is blocking content.
 */
export class SnapshotHydrationError extends Error {
  /** Number of snapshot attempts made before giving up. */
  readonly attempts: number;
  /** Milliseconds spent waiting for hydration. */
  readonly elapsedMs: number;
  constructor(opts: { attempts: number; elapsedMs: number; message?: string }) {
    super(
      opts.message ??
        `Snapshot returned no interactive elements after ${String(opts.attempts)} attempts (${String(opts.elapsedMs)}ms). The page may still be hydrating or blocked by a challenge.`,
    );
    this.name = 'SnapshotHydrationError';
    this.attempts = opts.attempts;
    this.elapsedMs = opts.elapsedMs;
  }
}

/**
 * Thrown when an operation detects that the page navigated away (or the
 * target URL changed unexpectedly) while the operation was in flight.
 *
 * Recovery: re-acquire the page, re-snapshot, and retry. For navigation
 * races caused by user interaction that deliberately triggers a new page,
 * catch this and re-run the action against the post-navigation page.
 */
export class NavigationRaceError extends Error {
  /** URL the operation started against. */
  readonly fromUrl: string;
  /** URL the page ended up on. */
  readonly toUrl: string;
  constructor(opts: { fromUrl: string; toUrl: string; message?: string }) {
    super(
      opts.message ??
        `Page navigated from "${opts.fromUrl}" to "${opts.toUrl}" during the operation. Re-snapshot before retrying.`,
    );
    this.name = 'NavigationRaceError';
    this.fromUrl = opts.fromUrl;
    this.toUrl = opts.toUrl;
  }
}
