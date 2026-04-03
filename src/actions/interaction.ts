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
import { resolveStrictExistingPathsWithinRoot, DEFAULT_UPLOAD_DIR } from '../security.js';
import type { FormField } from '../types.js';

type MouseButton = 'left' | 'right' | 'middle';
type KeyModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';

const MAX_CLICK_DELAY_MS = 5000;
const DEFAULT_SCROLL_TIMEOUT_MS = 20_000;
const CHECKABLE_ROLES = new Set(['menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch']);

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
    input.click();
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
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  await page.mouse.click(opts.x, opts.y, {
    button: opts.button,
    clickCount: opts.clickCount,
    delay: opts.delayMs,
  });
}

export async function pressAndHoldViaCdp(opts: {
  cdpUrl: string;
  targetId?: string;
  x: number;
  y: number;
  delay?: number;
  holdMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const { x, y } = opts;

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
}

export async function clickByTextViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  text: string;
  exact?: boolean;
  button?: MouseButton;
  modifiers?: KeyModifier[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const locator = page
    .getByText(opts.text, { exact: opts.exact })
    .or(page.getByTitle(opts.text, { exact: opts.exact }))
    .and(page.locator(':visible'))
    .first();
  try {
    await locator.click({ timeout, button: opts.button, modifiers: opts.modifiers });
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
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);
  const label = `role=${opts.role}${opts.name !== undefined && opts.name !== '' ? ` name="${opts.name}"` : ''}`;
  const locator = page
    .getByRole(opts.role as Parameters<typeof page.getByRole>[0], { name: opts.name })
    .nth(opts.index ?? 0);
  try {
    await locator.click({ timeout, button: opts.button, modifiers: opts.modifiers });
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
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);

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
    const delayMs = resolveBoundedDelayMs(opts.delayMs, 'click delayMs', MAX_CLICK_DELAY_MS);
    if (delayMs > 0) {
      await locator.hover({ timeout, force: opts.force });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    // For checkable roles, capture aria-checked before the click.
    let ariaCheckedBefore: string | null | undefined;
    if (checkableRole && opts.doubleClick !== true) {
      ariaCheckedBefore = await locator.getAttribute('aria-checked', { timeout }).catch(() => undefined);
    }

    if (opts.doubleClick === true) {
      await locator.dblclick({ timeout, button: opts.button, modifiers: opts.modifiers, force: opts.force });
    } else {
      await locator.click({ timeout, button: opts.button, modifiers: opts.modifiers, force: opts.force });
    }

    // If this is a checkable role and aria-checked didn't change, fall back to JS click.
    // Poll briefly to give async frameworks time to update the DOM before concluding
    // the click didn't work — otherwise we'd fire a second click that un-toggles it.
    if (checkableRole && opts.doubleClick !== true && ariaCheckedBefore !== undefined) {
      const POLL_INTERVAL_MS = 50;
      const POLL_TIMEOUT_MS = 500;
      let changed = false;
      for (let elapsed = 0; elapsed < POLL_TIMEOUT_MS; elapsed += POLL_INTERVAL_MS) {
        const current = await locator.getAttribute('aria-checked', { timeout }).catch(() => undefined);
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
  } catch (err) {
    throw toAIFriendlyError(err, label);
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
    if (opts.submit === true) await locator.press('Enter', { timeout });
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
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  if (opts.values.length === 0) throw new Error('values are required');
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector ?? '';
  const locator = resolveLocator(page, resolved);

  try {
    await locator.selectOption(opts.values, { timeout: resolveInteractionTimeoutMs(opts.timeoutMs) });
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
}): Promise<void> {
  const resolvedStart = requireRefOrSelector(opts.startRef, opts.startSelector);
  const resolvedEnd = requireRefOrSelector(opts.endRef, opts.endSelector);
  const page = await getRestoredPageForTarget(opts);
  const startLocator = resolveLocator(page, resolvedStart);
  const endLocator = resolveLocator(page, resolvedEnd);
  const startLabel = resolvedStart.ref ?? resolvedStart.selector ?? '';
  const endLabel = resolvedEnd.ref ?? resolvedEnd.selector ?? '';

  try {
    await startLocator.dragTo(endLocator, { timeout: resolveInteractionTimeoutMs(opts.timeoutMs) });
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
      } catch {
        try {
          await setCheckedViaEvaluate(locator, checked);
        } catch (err) {
          throw toAIFriendlyError(err, ref);
        }
      }
      continue;
    }

    try {
      await locator.fill(value, { timeout });
    } catch (err) {
      throw toAIFriendlyError(err, ref);
    }
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
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  const state = ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
  state.armIdDialog = bumpDialogArmId(state);
  const armId = state.armIdDialog;

  return page
    .waitForEvent('dialog', { timeout })
    .then(async (dialog) => {
      if (state.armIdDialog !== armId) return;
      try {
        if (opts.accept) await dialog.accept(opts.promptText);
        else await dialog.dismiss();
      } finally {
        if (state.armIdDialog === armId) state.armIdDialog = 0;
      }
    })
    .catch(() => {
      if (state.armIdDialog === armId) state.armIdDialog = 0;
    });
}

export async function armFileUploadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  paths?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  const state = ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120000);
  state.armIdUpload = bumpUploadArmId(state);
  const armId = state.armIdUpload;

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
      } catch {
        /* intentional no-op */
      }
    })
    .catch(() => {
      /* intentional no-op */
    });
}
