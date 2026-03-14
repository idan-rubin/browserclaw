import type { Page } from 'playwright-core';
import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
  toAIFriendlyError,
  normalizeTimeoutMs,
  bumpUploadArmId,
  bumpDialogArmId,
} from '../connection.js';
import { assertSafeUploadPaths } from '../security.js';
import type { FormField } from '../types.js';

type MouseButton = 'left' | 'right' | 'middle';
type KeyModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';

const MAX_CLICK_DELAY_MS = 5000;

function resolveBoundedDelayMs(value: number | undefined, label: string, maxMs: number): number {
  const normalized = Math.floor(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error(`${label} must be >= 0`);
  if (normalized > maxMs) throw new Error(`${label} exceeds maximum of ${maxMs}ms`);
  return normalized;
}

function resolveInteractionTimeoutMs(timeoutMs?: number): number {
  return Math.max(500, Math.min(60000, Math.floor(timeoutMs ?? 8000)));
}

function requireRefOrSelector(ref?: string, selector?: string): { ref?: string; selector?: string } {
  const trimmedRef = typeof ref === 'string' ? ref.trim() : '';
  const trimmedSelector = typeof selector === 'string' ? selector.trim() : '';
  if (!trimmedRef && !trimmedSelector) throw new Error('ref or selector is required');
  return { ref: trimmedRef || undefined, selector: trimmedSelector || undefined };
}

function resolveLocator(page: Page, resolved: { ref?: string; selector?: string }) {
  return resolved.ref ? refLocator(page, resolved.ref) : page.locator(resolved.selector!);
}

async function getRestoredPageForTarget(opts: { cdpUrl: string; targetId?: string }): Promise<Page> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  return page;
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
}): Promise<void> {
  const resolved = requireRefOrSelector(opts.ref, opts.selector);
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolveLocator(page, resolved);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);

  try {
    const delayMs = resolveBoundedDelayMs(opts.delayMs, 'click delayMs', MAX_CLICK_DELAY_MS);
    if (delayMs > 0) {
      await locator.hover({ timeout });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (opts.doubleClick) {
      await locator.dblclick({ timeout, button: opts.button, modifiers: opts.modifiers });
    } else {
      await locator.click({ timeout, button: opts.button, modifiers: opts.modifiers });
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
  const label = resolved.ref ?? resolved.selector!;
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
  const text = String(opts.text ?? '');
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolveLocator(page, resolved);
  const timeout = resolveInteractionTimeoutMs(opts.timeoutMs);

  try {
    if (opts.slowly) {
      await locator.click({ timeout });
      await locator.pressSequentially(text, { timeout, delay: 75 });
    } else {
      await locator.fill(text, { timeout });
    }
    if (opts.submit) await locator.press('Enter', { timeout });
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
  if (!opts.values?.length) throw new Error('values are required');
  const page = await getRestoredPageForTarget(opts);
  const label = resolved.ref ?? resolved.selector!;
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
  const startLabel = resolvedStart.ref ?? resolvedStart.selector!;
  const endLabel = resolvedEnd.ref ?? resolvedEnd.selector!;

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
    const value = typeof rawValue === 'string' ? rawValue
      : typeof rawValue === 'number' || typeof rawValue === 'boolean' ? String(rawValue)
      : '';

    if (!ref) continue;
    const locator = refLocator(page, ref);

    if (type === 'checkbox' || type === 'radio') {
      const checked = rawValue === true || rawValue === 1 || rawValue === '1' || rawValue === 'true';
      try {
        await locator.setChecked(checked, { timeout });
      } catch (err) {
        throw toAIFriendlyError(err, ref);
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
  const label = resolved.ref ?? resolved.selector!;
  const locator = resolveLocator(page, resolved);

  try {
    await locator.scrollIntoViewIfNeeded({ timeout: normalizeTimeoutMs(opts.timeoutMs, 20000) });
  } catch (err) {
    throw toAIFriendlyError(err, label);
  }
}

export async function highlightViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
}): Promise<void> {
  const page = await getRestoredPageForTarget(opts);

  try {
    await refLocator(page, opts.ref).highlight();
  } catch (err) {
    throw toAIFriendlyError(err, opts.ref);
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

  const locator = inputRef
    ? refLocator(page, inputRef)
    : page.locator(element).first();

  await assertSafeUploadPaths(opts.paths);

  try {
    await locator.setInputFiles(opts.paths);
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
  } catch {}
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
  state.armIdDialog = bumpDialogArmId();
  const armId = state.armIdDialog;

  page.waitForEvent('dialog', { timeout }).then(async (dialog) => {
    if (state.armIdDialog !== armId) return;
    if (opts.accept) await dialog.accept(opts.promptText);
    else await dialog.dismiss();
  }).catch(() => {});
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
  state.armIdUpload = bumpUploadArmId();
  const armId = state.armIdUpload;

  page.waitForEvent('filechooser', { timeout }).then(async (fileChooser) => {
    if (state.armIdUpload !== armId) return;

    if (!opts.paths?.length) {
      try { await page.keyboard.press('Escape'); } catch {}
      return;
    }

    try {
      await assertSafeUploadPaths(opts.paths);
    } catch {
      try { await page.keyboard.press('Escape'); } catch {}
      return;
    }
    await fileChooser.setFiles(opts.paths);

    try {
      const input = typeof fileChooser.element === 'function' ? await Promise.resolve(fileChooser.element()) : null;
      if (input) {
        await (input as any).evaluate((el: Element) => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
      }
    } catch {}
  }).catch(() => {});
}
