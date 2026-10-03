import type { Locator, Page } from 'playwright-core';

import {
  getPageForTargetId,
  ensurePageState,
  refLocator,
  toAIFriendlyError,
  normalizeTimeoutMs,
  bumpUploadArmId,
  bumpDialogArmId,
  requireRef,
  requireRefOrSelector,
  resolveInteractionTimeoutMs,
  resolveBoundedDelayMs,
  getRestoredPageForTarget,
  parseRoleRef,
  withPageScopedCdpClient,
} from '../connection.js';
import { NavigationRaceError } from '../errors.js';
import type { FormField, SsrfPolicy } from '../types.js';

import { runGuardedInput } from './guarded-input.js';
import { assertInteractionNavigationCompletedSafely, didCrossDocumentUrlChange } from './navigation.js';
import { awaitUploadWithAbort, resolveUploadFiles, type UploadOptions } from './upload-files.js';
import { armPageUpload } from './upload-lifecycle.js';

type MouseButton = 'left' | 'right' | 'middle';
type KeyModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';

const MAX_CLICK_DELAY_MS = 5000;
const DEFAULT_SCROLL_TIMEOUT_MS = 20_000;
const CHECKABLE_ROLES = new Set(['menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch']);

function interactionError(error: unknown, label: string, signal?: AbortSignal): Error {
  if (
    signal?.aborted === true &&
    error instanceof Error &&
    error.name === 'AbortError' &&
    error.cause === signal.reason
  ) {
    signal.throwIfAborted();
  }
  return toAIFriendlyError(error, label);
}

export async function awaitActionWithAbort<T>(actionPromise: Promise<T>, abortPromise?: Promise<never>): Promise<T> {
  if (!abortPromise) return await actionPromise;
  try {
    return await Promise.race([actionPromise, abortPromise]);
  } catch (err) {
    actionPromise.catch(() => {
      /* swallow — surface the abort cause */
    });
    throw err;
  }
}

/**
 * Fallback for setChecked on hidden styled inputs (opacity:0, position:absolute).
 * Sets the checked property directly via the native setter and dispatches events.
 */
async function setCheckedViaEvaluate(locator: Locator, checked: boolean): Promise<void> {
  await locator.evaluate((el: Element, desired: boolean) => {
    const input = el as HTMLInputElement;
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (desc?.set) desc.set.call(input, desired);
    else input.checked = desired;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, checked);
}

function resolveLocator(page: Page, resolved: { ref?: string; selector?: string }) {
  if (resolved.ref !== undefined && resolved.ref !== '') return refLocator(page, resolved.ref);
  const sel = resolved.selector ?? '';
  return page.locator(sel);
}

export async function mouseClickViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  x: number;
  y: number;
  button?: MouseButton;
  clickCount?: number;
  delayMs?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  opts.signal?.throwIfAborted();
  const page = await getRestoredPageForTarget(opts);
  await runGuardedInput(page, opts, async () => {
    await page.mouse.click(opts.x, opts.y, {
      button: opts.button,
      clickCount: opts.clickCount,
      delay: opts.delayMs,
    });
  });
}

// Note: pressAndHold is not cancellable once the mousePressed event is dispatched.
// The holdMs sleep runs to completion — there is no AbortSignal support because
// interrupting mid-hold would leave the mouse button in a pressed state.
export async function pressAndHoldViaCdp(opts: {
  cdpUrl: string;
  targetId?: string;
  x: number;
  y: number;
  delay?: number;
  holdMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);

  const { x, y } = opts;
  const previousUrl = page.url();

  await assertInteractionNavigationCompletedSafely({
    action: async () => {
      await withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
          if (opts.delay !== undefined && opts.delay !== 0) await new Promise((r) => setTimeout(r, opts.delay));
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          if (opts.holdMs !== undefined && opts.holdMs !== 0) await new Promise((r) => setTimeout(r, opts.holdMs));
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        },
      });
    },
    cdpUrl: opts.cdpUrl,
    page,
    previousUrl,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
  });
}

export async function clickByTextViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  text: string;
  exact?: boolean;
  button?: MouseButton;
  modifiers?: KeyModifier[];
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const locator = page
    .getByText(opts.text, { exact: opts.exact })
    .or(page.getByTitle(opts.text, { exact: opts.exact }))
    .and(page.locator(':visible'))
    .first();
  const previousUrl = page.url();
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await locator.click({ timeout, button: opts.button, modifiers: opts.modifiers });
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toAIFriendlyError(err, `text="${opts.text}"`);
  }
}

export async function clickByRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  role: string;
  name?: string;
  index?: number;
  button?: MouseButton;
  modifiers?: KeyModifier[];
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const label = `role=${opts.role}${opts.name !== undefined && opts.name !== '' ? ` name="${opts.name}"` : ''}`;
  const locator = page
    .getByRole(opts.role as Parameters<typeof page.getByRole>[0], { name: opts.name })
    .nth(opts.index ?? 0);
  const previousUrl = page.url();
  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await locator.click({ timeout, button: opts.button, modifiers: opts.modifiers });
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toAIFriendlyError(err, label);
  }
}

export async function clickViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  doubleClick?: boolean;
  button?: MouseButton;
  modifiers?: KeyModifier[];
  delayMs?: number;
  timeoutMs?: number;
  force?: boolean;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
  /** @internal Keeps atomic chooser clicks on the page that owns their listener. */
  resolvedPage?: Page;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = opts.resolvedPage ?? (await getRestoredPageForTarget(opts));
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const previousUrl = page.url();

  const signal = opts.signal;
  let abortListener: (() => void) | undefined;
  let abortReject: ((reason: unknown) => void) | undefined;
  let abortPromise: Promise<never> | undefined;
  if (signal) {
    abortPromise = new Promise<never>((_, reject) => {
      abortReject = reject;
    });
    abortPromise.catch(() => {
      /* consumed via awaitActionWithAbort */
    });
    signal.throwIfAborted();
    // Native locator cancellation leaves unrelated tabs connected. The race
    // also interrupts BC's checked-state polling and delayed-click waits.
    abortListener = () => {
      abortReject?.(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  }

  // Determine if this is a checkable role element so we can verify the click worked.
  let checkableRole = false;
  if (resolved.ref !== undefined && resolved.ref !== '') {
    const refId = parseRoleRef(resolved.ref);
    if (refId !== null) {
      const state = ensurePageState(page);
      const info = state.roleRefs?.[refId];
      if (info && CHECKABLE_ROLES.has(info.role)) checkableRole = true;
    }
  }

  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        signal?.throwIfAborted();
        const delayMs = resolveBoundedDelayMs(opts.delayMs, 'click delayMs', MAX_CLICK_DELAY_MS);
        if (delayMs > 0) {
          await locator.hover({ timeout, force: opts.force, signal });
          await awaitActionWithAbort(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), abortPromise);
        }
        signal?.throwIfAborted();

        // Native <input> checkbox/radio expose no aria-checked attr — read .checked.
        const readCheckedState = (readTimeout: number): Promise<string | null | undefined> =>
          awaitActionWithAbort(
            locator
              .evaluate(
                (el: Element) => {
                  const input = el as HTMLInputElement;
                  if (input.tagName === 'INPUT' && (input.type === 'checkbox' || input.type === 'radio')) {
                    return input.checked ? 'true' : 'false';
                  }
                  return el.getAttribute('aria-checked');
                },
                undefined,
                { timeout: readTimeout },
              )
              .catch(() => undefined),
            abortPromise,
          );
        let checkedBefore: string | null | undefined;
        if (checkableRole && opts.doubleClick !== true) {
          checkedBefore = await readCheckedState(timeout);
        }
        signal?.throwIfAborted();

        if (opts.doubleClick === true) {
          await locator.dblclick({
            timeout,
            button: opts.button,
            modifiers: opts.modifiers,
            force: opts.force,
            signal,
          });
        } else {
          await locator.click({ timeout, button: opts.button, modifiers: opts.modifiers, force: opts.force, signal });
        }

        // If this is a checkable role and the checked state didn't change, fall back to JS click.
        // Poll briefly to give async frameworks time to update the DOM before concluding
        // the click didn't work — otherwise we'd fire a second click that un-toggles it.
        if (checkableRole && opts.doubleClick !== true && checkedBefore !== undefined) {
          const POLL_INTERVAL_MS = 50;
          const POLL_TIMEOUT_MS = 500;
          const ATTR_TIMEOUT_MS = Math.min(timeout, POLL_TIMEOUT_MS);
          let changed = false;
          for (let elapsed = 0; elapsed < POLL_TIMEOUT_MS; elapsed += POLL_INTERVAL_MS) {
            signal?.throwIfAborted();
            const current = await readCheckedState(ATTR_TIMEOUT_MS);
            if (current === undefined || current !== checkedBefore) {
              changed = true;
              break;
            }
            await awaitActionWithAbort(
              new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS)),
              abortPromise,
            );
          }
          if (!changed) {
            signal?.throwIfAborted();
            await locator
              .evaluate((el: Element) => {
                (el as HTMLElement).click();
              })
              .catch(() => {
                /* intentional no-op */
              });
          }
        }
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
    signal?.throwIfAborted();
  } catch (err) {
    throw interactionError(err, label, signal);
  } finally {
    if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    abortReject = undefined;
    abortListener = undefined;
  }
}

export async function hoverViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);

  try {
    await assertInteractionNavigationCompletedSafely({
      ...opts,
      page,
      previousUrl: page.url(),
      action: () => locator.hover({ timeout: resolveInteractionTimeoutMs(opts.timeoutMs), signal: opts.signal }),
    });
    opts.signal?.throwIfAborted();
  } catch (err) {
    throw interactionError(err, label, opts.signal);
  }
}

export async function typeViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const text = opts.text;
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);

  try {
    // Guard the entire fill/type sequence, not just submit — an input/change
    // handler can trigger a JS navigation on fill alone.
    const previousUrl = page.url();
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        opts.signal?.throwIfAborted();
        if (opts.slowly === true) {
          await locator.click({ timeout, signal: opts.signal });
          opts.signal?.throwIfAborted();
          await locator.pressSequentially(text, { timeout, delay: 75, signal: opts.signal });
        } else {
          await locator.fill(text, { timeout, signal: opts.signal });
        }
        opts.signal?.throwIfAborted();
        if (opts.submit === true) await locator.press('Enter', { timeout, signal: opts.signal });
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
    opts.signal?.throwIfAborted();
  } catch (err) {
    throw interactionError(err, label, opts.signal);
  }
}

export async function selectOptionViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  values: string[];
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  if (opts.values.length === 0) throw new Error('values are required');
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);
  const previousUrl = page.url();

  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await locator.selectOption(opts.values, {
          timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          signal: opts.signal,
        });
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
    opts.signal?.throwIfAborted();
  } catch (err) {
    throw interactionError(err, label, opts.signal);
  }
}

export async function dragViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  startRef?: string;
  startSelector?: string;
  endRef?: string;
  endSelector?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const resolvedStart = requireRefOrSelector(opts.startRef, opts.startSelector);
  const resolvedEnd = requireRefOrSelector(opts.endRef, opts.endSelector);
  const page = await getRestoredPageForTarget(opts);
  const startLocator = resolveLocator(page, resolvedStart);
  const endLocator = resolveLocator(page, resolvedEnd);
  const startLabel = resolvedStart.ref ?? resolvedStart.selector ?? '';
  const endLabel = resolvedEnd.ref ?? resolvedEnd.selector ?? '';
  const previousUrl = page.url();

  try {
    await assertInteractionNavigationCompletedSafely({
      action: async () => {
        await startLocator.dragTo(endLocator, {
          timeout: resolveInteractionTimeoutMs(opts.timeoutMs),
          signal: opts.signal,
        });
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
    opts.signal?.throwIfAborted();
  } catch (err) {
    throw interactionError(err, `${startLabel} -> ${endLabel}`, opts.signal);
  }
}

export async function fillFormViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fields: FormField[];
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const previousUrl = page.url();

  await assertInteractionNavigationCompletedSafely({
    action: async () => {
      let filledCount = 0;
      let navigated = false;
      for (const field of opts.fields) {
        opts.signal?.throwIfAborted();
        if (didCrossDocumentUrlChange(page, previousUrl)) {
          navigated = true;
          break;
        }
        const ref = field.ref.trim();
        const type = (typeof field.type === 'string' ? field.type.trim() : '') || 'text';
        const rawValue = field.value;
        const value =
          typeof rawValue === 'string'
            ? rawValue
            : typeof rawValue === 'number' || typeof rawValue === 'boolean'
              ? String(rawValue)
              : '';

        if (!ref) continue;
        const locator = refLocator(page, ref);

        if (type === 'checkbox' || type === 'radio') {
          const checked = rawValue === true || rawValue === 1 || rawValue === '1' || rawValue === 'true';
          try {
            await locator.setChecked(checked, { timeout, force: true, signal: opts.signal });
          } catch (setCheckedErr) {
            opts.signal?.throwIfAborted();
            console.warn(
              `[browserclaw] setChecked fallback for ref "${ref}": ${setCheckedErr instanceof Error ? setCheckedErr.message : String(setCheckedErr)}`,
            );
            try {
              await setCheckedViaEvaluate(locator, checked);
            } catch (err) {
              const friendly = toAIFriendlyError(err, ref);
              throw new Error(
                `Failed at field "${ref}" (${String(filledCount)}/${String(opts.fields.length)} filled): ${friendly.message}`,
              );
            }
          }
          filledCount += 1;
          continue;
        }

        try {
          await locator.fill(value, { timeout, signal: opts.signal });
        } catch (err) {
          const friendly = interactionError(err, ref, opts.signal);
          throw new Error(
            `Failed at field "${ref}" (${String(filledCount)}/${String(opts.fields.length)} filled): ${friendly.message}`,
          );
        }
        filledCount += 1;
      }
      if (navigated) throw new NavigationRaceError({ fromUrl: previousUrl, toUrl: page.url() });
      opts.signal?.throwIfAborted();
    },
    cdpUrl: opts.cdpUrl,
    page,
    previousUrl,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
  });
}

export async function scrollIntoViewViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);

  try {
    await assertInteractionNavigationCompletedSafely({
      ...opts,
      page,
      previousUrl: page.url(),
      action: async () => {
        await locator.waitFor({
          state: 'attached',
          timeout: normalizeTimeoutMs(opts.timeoutMs, DEFAULT_SCROLL_TIMEOUT_MS),
          signal: opts.signal,
        });
        opts.signal?.throwIfAborted();
        await locator.evaluate((el: Element) => {
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
        });
      },
    });
    opts.signal?.throwIfAborted();
  } catch (err) {
    throw interactionError(err, label, opts.signal);
  }
}

export async function highlightViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const ref = requireRef(opts.ref);

  try {
    await refLocator(page, ref).highlight();
  } catch (err) {
    throw toAIFriendlyError(err, ref);
  }
}

export async function setInputFilesViaPlaywright(
  opts: UploadOptions & {
    cdpUrl: string;
    targetId?: string;
    ref?: string;
    element?: string;
    paths: string[];
    ssrfPolicy?: SsrfPolicy;
  },
): Promise<void> {
  opts.signal?.throwIfAborted();
  const page = await awaitUploadWithAbort(getRestoredPageForTarget(opts), opts.signal);

  if (!opts.paths.length) throw new Error('paths are required');

  const inputRef = typeof opts.ref === 'string' ? opts.ref.trim() : '';
  const element = typeof opts.element === 'string' ? opts.element.trim() : '';
  if (inputRef && element) throw new Error('ref and element are mutually exclusive');
  if (!inputRef && !element) throw new Error('Either ref or element is required for setInputFiles');

  const locator = inputRef ? refLocator(page, inputRef) : page.locator(element).first();

  const resolvedFiles = await resolveUploadFiles(opts);

  await assertInteractionNavigationCompletedSafely({
    ...opts,
    page,
    previousUrl: page.url(),
    action: async () => {
      try {
        await locator.setInputFiles(resolvedFiles, {
          timeout: normalizeTimeoutMs(opts.timeoutMs, 120000),
          signal: opts.signal,
        });
      } catch (err) {
        throw interactionError(err, inputRef || element, opts.signal);
      }

      try {
        opts.signal?.throwIfAborted();
        const handle = await locator.elementHandle();
        opts.signal?.throwIfAborted();
        await handle.evaluate((el: Element) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      } catch {
        opts.signal?.throwIfAborted();
        /* intentional no-op */
      }
    },
  });
}

export async function armDialogViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  const state = ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
  state.armIdDialog = bumpDialogArmId(state);
  const armId = state.armIdDialog;

  // Fire-and-forget: returns immediately once the arm is registered.
  // The waitForEvent chain runs in the background and handles the dialog when it fires.
  const resetArm = () => {
    if (state.armIdDialog === armId) state.armIdDialog = 0;
  };
  page.once('close', resetArm);
  page
    .waitForEvent('dialog', { timeout })
    .then(async (dialog) => {
      if (state.armIdDialog !== armId) return;
      try {
        if (opts.accept) await dialog.accept(opts.promptText);
        else await dialog.dismiss();
      } finally {
        resetArm();
        page.off('close', resetArm);
      }
    })
    .catch(() => {
      resetArm();
      page.off('close', resetArm);
    });
}

interface FileChooserUploadOptions extends UploadOptions {
  cdpUrl: string;
  targetId?: string;
  paths?: string[];
  ssrfPolicy?: SsrfPolicy;
}

// Invocation order must survive asynchronous page lookup and completed uploads.
// The public arm counters remain Page-local; this sequence only orders admission.
let nextUploadRequestSequence = 0;
const lastUploadRequestByPage = new WeakMap<Page, number>();

export async function armFileUploadViaPlaywright(opts: FileChooserUploadOptions): Promise<{ done: Promise<void> }> {
  // Resolve only after the chooser listener is armed; callers trigger the chooser,
  // then await `done` for file-setting completion or failure.
  return armFileChooserUpload(opts);
}

/** Click a ref and complete its file chooser without a listener-registration race. */
export async function uploadViaPlaywright(
  opts: FileChooserUploadOptions & { ref: string; paths: string[] },
): Promise<void> {
  if (opts.paths.length === 0) throw new Error('paths are required');
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timeout ${String(timeout)}ms exceeded while completing file upload`));
  }, timeout);
  try {
    const { done } = await armFileChooserUpload({ ...opts, signal }, requireRef(opts.ref));
    await done;
  } finally {
    clearTimeout(timer);
  }
}

async function armFileChooserUpload(
  opts: FileChooserUploadOptions,
  clickRef?: string,
): Promise<{ done: Promise<void> }> {
  opts.signal?.throwIfAborted();
  const requestSequence = ++nextUploadRequestSequence;
  const page = await awaitUploadWithAbort(
    getPageForTargetId({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
    }),
    opts.signal,
  );
  opts.signal?.throwIfAborted();
  if ((lastUploadRequestByPage.get(page) ?? 0) > requestSequence)
    throw new Error('File upload was superseded by another waiter');
  lastUploadRequestByPage.set(page, requestSequence);
  const state = ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
  state.armIdUpload = bumpUploadArmId(state);
  const armId = state.armIdUpload;

  return armPageUpload(
    page,
    { timeoutMs: timeout, signal: opts.signal, awaitStartedCompletion: clickRef !== undefined },
    async (lifetime, markArmed) => {
      const assertCurrent = () => {
        lifetime.assertCurrent();
        if (state.armIdUpload !== armId) throw new Error('File upload was superseded by another waiter');
      };
      const dismiss = async () => {
        assertCurrent();
        await lifetime.run(page.keyboard.press('Escape')).catch(() => {
          lifetime.assertCurrent();
          // Dismissal is best-effort, but aborts must still terminate the upload.
        });
      };
      try {
        assertCurrent();
        const fileChooserPromise = lifetime.run(
          page.waitForEvent('filechooser', {
            timeout: lifetime.remainingMs(),
            signal: lifetime.signal,
          }),
        );
        void fileChooserPromise.catch(() => undefined);
        markArmed();
        if (clickRef !== undefined) {
          await lifetime.run(
            clickViaPlaywright({
              ...opts,
              ref: clickRef,
              resolvedPage: page,
              timeoutMs: lifetime.remainingMs(),
              signal: lifetime.signal,
            }),
          );
        }
        const fileChooser = await fileChooserPromise;
        assertCurrent();

        if (opts.paths === undefined || opts.paths.length === 0) {
          await dismiss();
          return;
        }

        let resolvedFiles: Awaited<ReturnType<typeof resolveUploadFiles>>;
        try {
          resolvedFiles = await lifetime.wait(
            resolveUploadFiles({ ...opts, paths: opts.paths, signal: lifetime.signal }),
          );
        } catch (error) {
          assertCurrent();
          await dismiss();
          throw new Error(
            `armFileUpload: path validation failed: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
        assertCurrent();

        await lifetime.run(
          assertInteractionNavigationCompletedSafely({
            ...opts,
            page,
            previousUrl: page.url(),
            action: async () => {
              assertCurrent();
              await fileChooser.setFiles(resolvedFiles, {
                timeout: lifetime.remainingMs(),
                signal: lifetime.signal,
              });
              assertCurrent();

              try {
                const input =
                  typeof fileChooser.element === 'function' ? await Promise.resolve(fileChooser.element()) : null;
                assertCurrent();
                if (input !== null) {
                  await input.evaluate((el: Element) => {
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  });
                }
              } catch (e: unknown) {
                lifetime.assertCurrent();
                console.warn(
                  `[browserclaw] armFileUpload: dispatch events failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            },
          }),
        );
      } finally {
        if (state.armIdUpload === armId) state.armIdUpload = 0;
      }
    },
  );
}
