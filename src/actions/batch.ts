import { BrowserTabNotFoundError, BlockedBrowserTargetError } from '../connection.js';
import type { SsrfPolicy } from '../types.js';

import { evaluateViaPlaywright } from './evaluate.js';
import {
  clickViaPlaywright,
  hoverViaPlaywright,
  typeViaPlaywright,
  selectOptionViaPlaywright,
  dragViaPlaywright,
  fillFormViaPlaywright,
  scrollIntoViewViaPlaywright,
} from './interaction.js';
import { pressKeyViaPlaywright } from './keyboard.js';
import { resizeViewportViaPlaywright, closePageViaPlaywright } from './navigation.js';
import { waitForViaPlaywright } from './wait.js';

const MAX_BATCH_DEPTH = 5;
const MAX_BATCH_TIMEOUT_MS = 300_000;
const MAX_BATCH_ACTIONS = 100;

/** A single action within a batch. */
export type BatchAction =
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
  | { kind: 'press'; key: string; targetId?: string; delayMs?: number }
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
): Promise<void> {
  if (depth > MAX_BATCH_DEPTH) throw new Error(`Batch nesting depth exceeds maximum of ${String(MAX_BATCH_DEPTH)}`);
  const effectiveTargetId = action.targetId ?? targetId;

  switch (action.kind) {
    case 'click':
      await clickViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        doubleClick: action.doubleClick,
        button: action.button as 'left' | 'right' | 'middle' | undefined,
        modifiers: action.modifiers as ('Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift')[] | undefined,
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
        ssrfPolicy,
      });
      break;
    case 'hover':
      await hoverViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
      });
      break;
    case 'scrollIntoView':
      await scrollIntoViewViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        ref: action.ref,
        selector: action.selector,
        timeoutMs: action.timeoutMs,
      });
      break;
    case 'drag':
      await dragViaPlaywright({
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
        cdpUrl,
        targetId: effectiveTargetId,
        fields: action.fields,
        timeoutMs: action.timeoutMs,
      });
      break;
    case 'resize':
      await resizeViewportViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        width: action.width,
        height: action.height,
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
        timeoutMs: action.timeoutMs,
      });
      break;
    case 'evaluate':
      if (!evaluateEnabled) throw new Error('act:evaluate is disabled by config (browser.evaluateEnabled=false)');
      await evaluateViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        fn: action.fn,
        ref: action.ref,
        timeoutMs: action.timeoutMs,
      });
      break;
    case 'close':
      await closePageViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
      });
      break;
    case 'batch':
      await batchViaPlaywright({
        cdpUrl,
        targetId: effectiveTargetId,
        actions: action.actions,
        stopOnError: action.stopOnError,
        evaluateEnabled,
        depth: depth + 1,
        ssrfPolicy,
      });
      break;
    default:
      throw new Error(`Unsupported batch action kind: ${String((action as Record<string, unknown>).kind)}`);
  }
}

/**
 * Execute multiple browser actions in sequence.
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
}): Promise<{ results: BatchActionResult[] }> {
  const depth = opts.depth ?? 0;
  if (depth > MAX_BATCH_DEPTH) throw new Error(`Batch nesting depth exceeds maximum of ${String(MAX_BATCH_DEPTH)}`);
  if (opts.actions.length > MAX_BATCH_ACTIONS)
    throw new Error(`Batch exceeds maximum of ${String(MAX_BATCH_ACTIONS)} actions`);

  const results: BatchActionResult[] = [];
  const evaluateEnabled = opts.evaluateEnabled !== false;
  const deadline = Date.now() + MAX_BATCH_TIMEOUT_MS;

  for (const action of opts.actions) {
    if (Date.now() > deadline) {
      results.push({ ok: false, error: 'Batch timeout exceeded' });
      break;
    }
    try {
      await executeSingleAction(action, opts.cdpUrl, opts.targetId, evaluateEnabled, depth, opts.ssrfPolicy);
      results.push({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ ok: false, error: message });
      // Always stop on page-destroying errors regardless of stopOnError setting
      if (err instanceof BrowserTabNotFoundError || err instanceof BlockedBrowserTargetError) break;
      if (opts.stopOnError !== false) break;
    }
  }

  return { results };
}
