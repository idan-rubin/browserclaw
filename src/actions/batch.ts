import type { Frame, Page } from 'playwright-core';

import { BrowserTabNotFoundError, BlockedBrowserTargetError, getPageForTargetId } from '../connection.js';
import { InvalidBrowserNavigationUrlError } from '../security.js';
import type { SsrfPolicy } from '../types.js';

import { evaluateViaPlaywright } from './evaluate.js';
import {
  clickViaPlaywright,
  mouseClickViaPlaywright,
  hoverViaPlaywright,
  typeViaPlaywright,
  selectOptionViaPlaywright,
  dragViaPlaywright,
  fillFormViaPlaywright,
  scrollIntoViewViaPlaywright,
} from './interaction.js';
import { pressKeyViaPlaywright, insertTextViaPlaywright } from './keyboard.js';
import { resizeViewportViaPlaywright, closePageViaPlaywright } from './navigation.js';
import { waitForViaPlaywright } from './wait.js';

const MAX_BATCH_DEPTH = 5;
const MAX_BATCH_TIMEOUT_MS = 300_000;
const MAX_BATCH_ACTIONS = 100;

/** A single action within a batch. */
export type BatchAction =
  | {
      kind: 'mouseClick';
      x: number;
      y: number;
      button?: 'left' | 'right' | 'middle';
      clickCount?: number;
      delayMs?: number;
      targetId?: string;
      signal?: AbortSignal;
    }
  | {
      kind: 'click';
      ref?: string;
      selector?: string;
      targetId?: string;
      doubleClick?: boolean;
      button?: string;
      modifiers?: string[];
      delayMs?: number;
      timeoutMs?: number;
    }
  | {
      kind: 'type';
      ref?: string;
      selector?: string;
      text: string;
      targetId?: string;
      submit?: boolean;
      slowly?: boolean;
      timeoutMs?: number;
    }
  | { kind: 'press'; key: string; targetId?: string; delayMs?: number; signal?: AbortSignal }
  | { kind: 'insertText'; text: string; targetId?: string; signal?: AbortSignal }
  | { kind: 'hover'; ref?: string; selector?: string; targetId?: string; timeoutMs?: number }
  | { kind: 'scrollIntoView'; ref?: string; selector?: string; targetId?: string; timeoutMs?: number }
  | {
      kind: 'drag';
      startRef?: string;
      startSelector?: string;
      endRef?: string;
      endSelector?: string;
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: 'select'; ref?: string; selector?: string; values: string[]; targetId?: string; timeoutMs?: number }
  | {
      kind: 'fill';
      fields: { ref: string; type?: string; value?: string | number | boolean }[];
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: 'resize'; width: number; height: number; targetId?: string }
  | {
      kind: 'wait';
      timeMs?: number;
      text?: string;
      textGone?: string;
      selector?: string;
      url?: string;
      loadState?: 'load' | 'domcontentloaded' | 'networkidle';
      fn?: string;
      arg?: unknown;
      signal?: AbortSignal;
      targetId?: string;
      timeoutMs?: number;
    }
  | { kind: 'evaluate'; fn: string; ref?: string; targetId?: string; timeoutMs?: number }
  | { kind: 'close'; targetId?: string }
  | { kind: 'batch'; actions: BatchAction[]; targetId?: string; stopOnError?: boolean };

/** Result of a single action within a batch. */
export type BatchActionResult = { ok: true } | { ok: false; error: string };

/**
 * Execute a single batch action.
 */
export async function executeSingleAction(
  action: BatchAction,
  cdpUrl: string,
  targetId: string | undefined,
  evaluateEnabled: boolean,
  depth = 0,
  ssrfPolicy?: SsrfPolicy,
  signal?: AbortSignal,
): Promise<void> {
  if (depth > MAX_BATCH_DEPTH) throw new Error(`Batch nesting depth exceeds maximum of ${String(MAX_BATCH_DEPTH)}`);
  const effectiveTargetId = action.targetId ?? targetId;
  const actionSignal = 'signal' in action ? action.signal : undefined;
  const effectiveSignal = signal && actionSignal ? AbortSignal.any([signal, actionSignal]) : (signal ?? actionSignal);
  effectiveSignal?.throwIfAborted();

  switch (action.kind) {
    case 'mouseClick':
      await mouseClickViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        x: action.x,
        y: action.y,
        button: action.button,
        clickCount: action.clickCount,
        delayMs: action.delayMs,
        signal: effectiveSignal,
        ssrfPolicy,
      });
      break;
    case 'click':
      await clickViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        doubleClick: action.doubleClick,
        button: action.button as 'left' | 'right' | 'middle' | undefined,
        modifiers: action.modifiers as ('Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift')[] | undefined,
        signal: effectiveSignal,
        delayMs: action.delayMs,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'type':
      await typeViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        text: action.text,
        submit: action.submit,
        slowly: action.slowly,
        signal: effectiveSignal,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'press':
      await pressKeyViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        key: action.key,
        delayMs: action.delayMs,
        signal: effectiveSignal,
        ssrfPolicy,
      });
      break;
    case 'hover':
      await hoverViaPlaywright({
        signal: effectiveSignal,
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'insertText':
      await insertTextViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        text: action.text,
        signal: effectiveSignal,
        ssrfPolicy,
      });
      break;
    case 'scrollIntoView':
      await scrollIntoViewViaPlaywright({
        signal: effectiveSignal,
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'drag':
      await dragViaPlaywright({
        signal: effectiveSignal,
        cdpUrl,
        targetId: effectiveTargetId,
        startRef: action.startRef,
        startSelector: action.startSelector,
        endRef: action.endRef,
        endSelector: action.endSelector,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'select':
      await selectOptionViaPlaywright({
        signal: effectiveSignal,
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        values: action.values,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'fill':
      await fillFormViaPlaywright({
        signal: effectiveSignal,
        cdpUrl,
        targetId: effectiveTargetId,
        fields: action.fields,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'resize':
      await resizeViewportViaPlaywright({
        signal: effectiveSignal,
        cdpUrl,
        targetId: effectiveTargetId,
        width: action.width,
        height: action.height,
        ssrfPolicy,
      });
      break;
    case 'wait':
      if (action.fn !== undefined && action.fn !== '' && !evaluateEnabled)
        throw new Error('wait --fn is disabled by config (browser.evaluateEnabled=false)');
      await waitForViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        timeMs: action.timeMs,
        text: action.text,
        textGone: action.textGone,
        selector: action.selector,
        url: action.url,
        loadState: action.loadState,
        fn: action.fn,
        arg: action.arg,
        signal: effectiveSignal,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'evaluate':
      if (!evaluateEnabled) throw new Error('act:evaluate is disabled by config (browser.evaluateEnabled=false)');
      await evaluateViaPlaywright({
        signal: effectiveSignal,
        cdpUrl,
        targetId: effectiveTargetId,
        fn: action.fn,
        ref: action.ref,
        timeoutMs: action.timeoutMs,
        ssrfPolicy,
      });
      break;
    case 'close':
      await closePageViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ssrfPolicy,
      });
      break;
    case 'batch': {
      const nested = await batchViaPlaywright({
        signal: effectiveSignal,
        cdpUrl,
        targetId: effectiveTargetId,
        actions: action.actions,
        stopOnError: action.stopOnError,
        evaluateEnabled,
        depth: depth + 1,
        ssrfPolicy,
      });
      const failure = nested.results.find((result) => !result.ok);
      if (failure?.ok === false) throw new Error(failure.error);
      break;
    }
    default:
      throw new Error(`Unsupported batch action kind: ${String((action as Record<string, unknown>).kind)}`);
  }
}

/**
 * Execute multiple browser actions in sequence.
 * Stops after a target navigates or closes; the first skipped action receives an error result.
 *
 * @param opts.actions - Array of actions to execute
 * @param opts.stopOnError - Stop on first error (default: true)
 * @param opts.evaluateEnabled - Whether evaluate/wait:fn actions are permitted
 * @param opts.depth - Internal recursion depth (do not set manually)
 */
export async function batchViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  actions: BatchAction[];
  stopOnError?: boolean;
  evaluateEnabled?: boolean;
  depth?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<{ results: BatchActionResult[] }> {
  const depth = opts.depth ?? 0;
  if (depth > MAX_BATCH_DEPTH) throw new Error(`Batch nesting depth exceeds maximum of ${String(MAX_BATCH_DEPTH)}`);
  if (opts.actions.length > MAX_BATCH_ACTIONS)
    throw new Error(`Batch exceeds maximum of ${String(MAX_BATCH_ACTIONS)} actions`);

  const results: BatchActionResult[] = [];
  const evaluateEnabled = opts.evaluateEnabled !== false;
  const deadline = Date.now() + MAX_BATCH_TIMEOUT_MS;
  const observed = new Map<Page, (frame: Frame) => void>();
  const boundary = { navigated: false };
  const hasClosedPage = () => [...observed.keys()].some((page) => page.isClosed());
  const crossedBoundary = () => {
    if (!boundary.navigated && !hasClosedPage()) return false;
    results.push({ ok: false, error: 'Batch stopped before this action because a target navigated or closed.' });
    return true;
  };
  const observeTarget = async (targetId: string | undefined) => {
    const page = await getPageForTargetId({ ...opts, targetId });
    if (observed.has(page)) return;
    const onNavigated = (frame: Frame) => {
      if (frame === page.mainFrame()) boundary.navigated = true;
    };
    observed.set(page, onNavigated);
    page.on('framenavigated', onNavigated);
  };

  try {
    for (const action of opts.actions) {
      opts.signal?.throwIfAborted();
      if (crossedBoundary()) break;
      if (Date.now() > deadline) {
        results.push({ ok: false, error: 'Batch timeout exceeded' });
        break;
      }
      try {
        try {
          await observeTarget(action.targetId ?? opts.targetId);
        } catch (error) {
          // Closing an already missing explicit target remains idempotent.
          if (action.kind !== 'close' || !(error instanceof BrowserTabNotFoundError)) throw error;
        }
        if (crossedBoundary()) break;
        await executeSingleAction(
          action,
          opts.cdpUrl,
          opts.targetId,
          evaluateEnabled,
          depth,
          opts.ssrfPolicy,
          opts.signal,
        );
        results.push({ ok: true });
      } catch (err) {
        if (err instanceof InvalidBrowserNavigationUrlError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        results.push({ ok: false, error: message });
        // Always stop on page-destroying errors regardless of stopOnError setting
        if (err instanceof BrowserTabNotFoundError || err instanceof BlockedBrowserTargetError) break;
        if (opts.stopOnError !== false) break;
      }
    }
    return { results };
  } finally {
    for (const [page, onNavigated] of observed) page.off('framenavigated', onNavigated);
  }
}
