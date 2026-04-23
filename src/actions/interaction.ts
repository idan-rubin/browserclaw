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
  forceDisconnectPlaywrightConnection,
} from '../connection.js';
import { resolveStrictExistingPathsWithinRoot, DEFAULT_UPLOAD_DIR } from '../security.js';
import type { FormField, SsrfPolicy } from '../types.js';

import { assertInteractionNavigationCompletedSafely } from './navigation.js';

type MouseButton = 'left' | 'right' | 'middle';
type KeyModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';

const MAX_CLICK_DELAY_MS = 5000;
const DEFAULT_SCROLL_TIMEOUT_MS = 20_000;
const CHECKABLE_ROLES = new Set(['menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch']);

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
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const previousUrl = page.url();
  await assertInteractionNavigationCompletedSafely({
    action: async () => {
      await page.mouse.click(opts.x, opts.y, {
        button: opts.button,
        clickCount: opts.clickCount,
        delay: opts.delayMs,
      });
    },
    cdpUrl: opts.cdpUrl,
    page,
    previousUrl,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
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
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
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
    const disconnect = () => {
      forceDisconnectPlaywrightConnection({
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        reason: 'click aborted',
      }).catch(() => {
        /* best-effort disconnect */
      });
    };
    if (signal.aborted) {
      disconnect();
      throw signal.reason ?? new Error('aborted');
    }
    abortListener = () => {
      disconnect();
      abortReject?.(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
      throw signal.reason ?? new Error('aborted');
    }
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
        const delayMs = resolveBoundedDelayMs(opts.delayMs, 'click delayMs', MAX_CLICK_DELAY_MS);
        if (delayMs > 0) {
          await awaitActionWithAbort(locator.hover({ timeout, force: opts.force }), abortPromise);
          await awaitActionWithAbort(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), abortPromise);
        }

        // For checkable roles, capture aria-checked before the click.
        let ariaCheckedBefore: string | null | undefined;
        if (checkableRole && opts.doubleClick !== true) {
          ariaCheckedBefore = await locator.getAttribute('aria-checked', { timeout }).catch(() => undefined);
        }

        if (opts.doubleClick === true) {
          await awaitActionWithAbort(
            locator.dblclick({ timeout, button: opts.button, modifiers: opts.modifiers, force: opts.force }),
            abortPromise,
          );
        } else {
          await awaitActionWithAbort(
            locator.click({ timeout, button: opts.button, modifiers: opts.modifiers, force: opts.force }),
            abortPromise,
          );
        }

        // If this is a checkable role and aria-checked didn't change, fall back to JS click.
        // Poll briefly to give async frameworks time to update the DOM before concluding
        // the click didn't work — otherwise we'd fire a second click that un-toggles it.
        if (checkableRole && opts.doubleClick !== true && ariaCheckedBefore !== undefined) {
          const POLL_INTERVAL_MS = 50;
          const POLL_TIMEOUT_MS = 500;
          const ATTR_TIMEOUT_MS = Math.min(timeout, POLL_TIMEOUT_MS);
          let changed = false;
          for (let elapsed = 0; elapsed < POLL_TIMEOUT_MS; elapsed += POLL_INTERVAL_MS) {
            const current = await locator
              .getAttribute('aria-checked', { timeout: ATTR_TIMEOUT_MS })
              .catch(() => undefined);
            if (current === undefined || current !== ariaCheckedBefore) {
              changed = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
          }
          if (!changed) {
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
  } catch (err) {
    throw toAIFriendlyError(err, label);
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
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);

  try {
    await locator.hover({ timeout: resolveInteractionTimeoutMs(opts.timeoutMs) });
  } catch (err) {
    throw toAIFriendlyError(err, label);
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
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const text = opts.text;
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);

  try {
    if (opts.slowly === true) {
      await locator.click({ timeout });
      await locator.pressSequentially(text, { timeout, delay: 75 });
    } else {
      await locator.fill(text, { timeout });
    }
    if (opts.submit === true) {
      const previousUrl = page.url();
      await assertInteractionNavigationCompletedSafely({
        action: async () => {
          await locator.press('Enter', { timeout });
        },
        cdpUrl: opts.cdpUrl,
        page,
        previousUrl,
        ssrfPolicy: opts.ssrfPolicy,
        targetId: opts.targetId,
      });
    }
  } catch (err) {
    throw toAIFriendlyError(err, label);
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
        await locator.selectOption(opts.values, { timeout: resolveInteractionTimeoutMs(opts.timeoutMs) });
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

export async function dragViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  startRef?: string;
  startSelector?: string;
  endRef?: string;
  endSelector?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
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
        await startLocator.dragTo(endLocator, { timeout: resolveInteractionTimeoutMs(opts.timeoutMs) });
      },
      cdpUrl: opts.cdpUrl,
      page,
      previousUrl,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  } catch (err) {
    throw toAIFriendlyError(err, `${startLabel} -> ${endLabel}`);
  }
}

export async function fillFormViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fields: FormField[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);

  let filledCount = 0;
  for (const field of opts.fields) {
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
        await locator.setChecked(checked, { timeout, force: true });
      } catch (setCheckedErr) {
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
      await locator.fill(value, { timeout });
    } catch (err) {
      const friendly = toAIFriendlyError(err, ref);
      throw new Error(
        `Failed at field "${ref}" (${String(filledCount)}/${String(opts.fields.length)} filled): ${friendly.message}`,
      );
    }
    filledCount += 1;
  }
}

export async function scrollIntoViewViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  selector?: string;
  timeoutMs?: number;
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);

  try {
    await locator.waitFor({
      state: 'attached',
      timeout: normalizeTimeoutMs(opts.timeoutMs, DEFAULT_SCROLL_TIMEOUT_MS),
    });
    await locator.evaluate((el: Element) => {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
  } catch (err) {
    throw toAIFriendlyError(err, label);
  }
}

export async function highlightViaPlaywright(opts: { cdpUrl: string; targetId?: string; ref: string }): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const ref = requireRef(opts.ref);

  try {
    await refLocator(page, ref).highlight();
  } catch (err) {
    throw toAIFriendlyError(err, ref);
  }
}

export async function setInputFilesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  element?: string;
  paths: string[];
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);

  if (!opts.paths.length) throw new Error('paths are required');

  const inputRef = typeof opts.ref === 'string' ? opts.ref.trim() : '';
  const element = typeof opts.element === 'string' ? opts.element.trim() : '';
  if (inputRef && element) throw new Error('ref and element are mutually exclusive');
  if (!inputRef && !element) throw new Error('Either ref or element is required for setInputFiles');

  const locator = inputRef ? refLocator(page, inputRef) : page.locator(element).first();

  const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
    rootDir: DEFAULT_UPLOAD_DIR,
    requestedPaths: opts.paths,
    scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
  });
  if (!uploadPathsResult.ok) throw new Error(uploadPathsResult.error);
  const resolvedPaths = uploadPathsResult.paths;

  try {
    await locator.setInputFiles(resolvedPaths);
  } catch (err) {
    throw toAIFriendlyError(err, inputRef || element);
  }

  try {
    const handle = await locator.elementHandle();
    if (handle) {
      await handle.evaluate((el: Element) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  } catch {
    /* intentional no-op */
  }
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

export async function armFileUploadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  paths?: string[];
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
  state.armIdUpload = bumpUploadArmId(state);
  const armId = state.armIdUpload;

  const resetArm = () => {
    if (state.armIdUpload === armId) state.armIdUpload = 0;
  };
  page.once('close', resetArm);
  page
    .waitForEvent('filechooser', { timeout })
    .then(async (fileChooser) => {
      if (state.armIdUpload !== armId) return;

      if (opts.paths === undefined || opts.paths.length === 0) {
        try {
          await page.keyboard.press('Escape');
        } catch {
          /* intentional no-op */
        }
        return;
      }

      const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
        rootDir: DEFAULT_UPLOAD_DIR,
        requestedPaths: opts.paths,
        scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
      });
      if (!uploadPathsResult.ok) {
        console.warn(`[browserclaw] armFileUpload: path validation failed: ${uploadPathsResult.error}`);
        try {
          await page.keyboard.press('Escape');
        } catch {
          /* intentional no-op */
        }
        return;
      }

      await fileChooser.setFiles(uploadPathsResult.paths);

      try {
        const input = typeof fileChooser.element === 'function' ? await Promise.resolve(fileChooser.element()) : null;
        if (input !== null) {
          await input.evaluate((el: Element) => {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }
      } catch (e: unknown) {
        console.warn(
          `[browserclaw] armFileUpload: dispatch events failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    })
    .catch((e: unknown) => {
      console.warn(
        `[browserclaw] armFileUpload: filechooser wait failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    })
    .finally(() => {
      resetArm();
      page.off('close', resetArm);
    });
}
