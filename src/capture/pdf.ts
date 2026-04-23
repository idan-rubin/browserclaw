import { assertPageNavigationCompletedSafely } from '../actions/navigation.js';
import { getPageForTargetId, ensurePageState } from '../connection.js';
import type { SsrfPolicy } from '../types.js';

export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    ssrfPolicy: opts.ssrfPolicy,
  });
  ensurePageState(page);

  if (opts.ssrfPolicy) {
    await assertPageNavigationCompletedSafely({
      cdpUrl: opts.cdpUrl,
      page,
      response: null,
      ssrfPolicy: opts.ssrfPolicy,
      targetId: opts.targetId,
    });
  }

  return { buffer: await page.pdf({ printBackground: true }) };
}
