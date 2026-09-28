import { getPageForTargetId, ensurePageState } from '../connection.js';
import type { SsrfPolicy } from '../types.js';

import { runGuardedInput } from './guarded-input.js';

interface KeyboardOptions {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}

/** Paste text into the currently focused editable control. */
export async function insertTextViaPlaywright(
  opts: KeyboardOptions & {
    text: string;
  },
): Promise<void> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await runGuardedInput(page, opts, () => page.keyboard.insertText(opts.text));
}

export async function pressKeyViaPlaywright(
  opts: KeyboardOptions & {
    key: string;
    delayMs?: number;
  },
): Promise<void> {
  opts.signal?.throwIfAborted();
  const key = opts.key.trim();
  if (!key) throw new Error('key is required');
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);
  await runGuardedInput(page, opts, async () => {
    await page.keyboard.press(key, { delay: Math.max(0, Math.floor(opts.delayMs ?? 0)) });
  });
}
