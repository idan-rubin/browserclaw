import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
  toAIFriendlyError,
  normalizeTimeoutMs,
} from '../connection.js';
import type { FormField } from '../types.js';

type MouseButton = 'left' | 'right' | 'middle';
type KeyModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';

export async function clickViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  doubleClick?: boolean;
  button?: MouseButton;
  modifiers?: KeyModifier[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const locator = refLocator(page, opts.ref);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 8000, 60000);

  try {
    if (opts.doubleClick) {
      await locator.dblclick({ timeout, button: opts.button, modifiers: opts.modifiers });
    } else {
      await locator.click({ timeout, button: opts.button, modifiers: opts.modifiers });
    }
  } catch (err) {
    throw toAIFriendlyError(err, opts.ref);
  }
}

export async function hoverViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  try {
    await refLocator(page, opts.ref).hover({
      timeout: normalizeTimeoutMs(opts.timeoutMs, 8000, 60000),
    });
  } catch (err) {
    throw toAIFriendlyError(err, opts.ref);
  }
}

export async function typeViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const text = String(opts.text ?? '');
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const locator = refLocator(page, opts.ref);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 8000, 60000);

  try {
    if (opts.slowly) {
      await locator.click({ timeout });
      await locator.pressSequentially(text, { timeout, delay: 75 });
    } else {
      await locator.fill(text, { timeout });
    }
    if (opts.submit) await locator.press('Enter', { timeout });
  } catch (err) {
    throw toAIFriendlyError(err, opts.ref);
  }
}

export async function selectOptionViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  values: string[];
  timeoutMs?: number;
}): Promise<void> {
  if (!opts.values?.length) throw new Error('values are required');
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  try {
    await refLocator(page, opts.ref).selectOption(opts.values, {
      timeout: normalizeTimeoutMs(opts.timeoutMs, 8000, 60000),
    });
  } catch (err) {
    throw toAIFriendlyError(err, opts.ref);
  }
}

export async function dragViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  startRef: string;
  endRef: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  try {
    await refLocator(page, opts.startRef).dragTo(refLocator(page, opts.endRef), {
      timeout: normalizeTimeoutMs(opts.timeoutMs, 8000, 60000),
    });
  } catch (err) {
    throw toAIFriendlyError(err, `${opts.startRef} -> ${opts.endRef}`);
  }
}

export async function fillFormViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fields: FormField[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 8000, 60000);

  for (let i = 0; i < opts.fields.length; i++) {
    const field = opts.fields[i]!;
    const ref = field.ref.trim();
    const type = field.type.trim();
    const rawValue = field.value;
    const value = rawValue == null ? '' : String(rawValue);

    if (!ref) throw new Error(`fill(): field at index ${i} has empty ref`);
    if (!type) throw new Error(`fill(): field "${ref}" has empty type`);
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
  ref: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  try {
    await refLocator(page, opts.ref).scrollIntoViewIfNeeded({
      timeout: normalizeTimeoutMs(opts.timeoutMs, 20000),
    });
  } catch (err) {
    throw toAIFriendlyError(err, opts.ref);
  }
}

export async function highlightViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

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
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const locator = opts.ref
    ? refLocator(page, opts.ref)
    : opts.element
      ? page.locator(opts.element).first()
      : null;
  if (!locator) throw new Error('Either ref or element is required for setInputFiles');

  try {
    await locator.setInputFiles(opts.paths);
  } catch (err) {
    throw toAIFriendlyError(err, opts.ref ?? opts.element ?? 'unknown');
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
  ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 30000, 120000);

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      page.removeListener('dialog', handler);
      reject(new Error(`No dialog appeared within ${timeout}ms`));
    }, timeout);

    const handler = async (dialog: { accept: (text?: string) => Promise<void>; dismiss: () => Promise<void> }) => {
      clearTimeout(timer);
      try {
        if (opts.accept) {
          await dialog.accept(opts.promptText);
        } else {
          await dialog.dismiss();
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    page.once('dialog', handler);
  });
}

export async function armFileUploadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  paths?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 30000, 120000);

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      page.removeListener('filechooser', handler);
      reject(new Error(`No file chooser appeared within ${timeout}ms`));
    }, timeout);

    const handler = async (fc: { setFiles: (files: string[]) => Promise<void> }) => {
      clearTimeout(timer);
      try {
        await fc.setFiles(opts.paths ?? []);
        resolve();
      } catch (err) {
        reject(err);
      }
    };

    page.once('filechooser', handler);
  });
}
