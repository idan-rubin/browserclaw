import {
  getPageForTargetId,
  ensurePageState,
  restoreRoleRefsForTarget,
  refLocator,
  toAIFriendlyError,
  normalizeTimeoutMs,
} from '../connection.js';
import type { FormField } from '../types.js';

export async function clickViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  doubleClick?: boolean;
  button?: string;
  modifiers?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });

  const locator = refLocator(page, opts.ref);
  const timeout = Math.max(500, Math.min(60000, Math.floor(opts.timeoutMs ?? 8000)));

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
      timeout: Math.max(500, Math.min(60000, opts.timeoutMs ?? 8000)),
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
  const timeout = Math.max(500, Math.min(60000, opts.timeoutMs ?? 8000));

  try {
    if (opts.slowly) {
      await locator.click({ timeout });
      await locator.type(text, { timeout, delay: 75 });
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
      timeout: Math.max(500, Math.min(60000, opts.timeoutMs ?? 8000)),
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
      timeout: Math.max(500, Math.min(60000, opts.timeoutMs ?? 8000)),
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

  const timeout = Math.max(500, Math.min(60000, opts.timeoutMs ?? 8000));

  for (const field of opts.fields) {
    const ref = field.ref.trim();
    const type = field.type.trim();
    const rawValue = field.value;
    const value = typeof rawValue === 'string' ? rawValue :
      (typeof rawValue === 'number' || typeof rawValue === 'boolean') ? String(rawValue) : '';

    if (!ref || !type) continue;
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
