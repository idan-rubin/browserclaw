import { getPageForTargetId, ensurePageState } from '../connection.js';
import type { SsrfPolicy } from '../types.js';

import { assertInteractionNavigationCompletedSafely } from './navigation.js';

export async function pressKeyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  key: string;
  delayMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<void> {
  const key = opts.key.trim();
  if (!key) throw new Error('key is required');
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);
  const previousUrl = page.url();
  await assertInteractionNavigationCompletedSafely({
    action: async () => {
      await page.keyboard.press(key, { delay: Math.max(0, Math.floor(opts.delayMs ?? 0)) });
    },
    cdpUrl: opts.cdpUrl,
    page,
    previousUrl,
    ssrfPolicy: opts.ssrfPolicy,
    targetId: opts.targetId,
  });
}
