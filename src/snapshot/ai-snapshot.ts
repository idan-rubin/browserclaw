import { assertPageNavigationCompletedSafely } from '../actions/navigation.js';
import {
  getPageForTargetId,
  ensurePageState,
  storeRoleRefsForTarget,
  normalizeTimeoutMs,
  takeAiSnapshotText,
} from '../connection.js';
import type { SnapshotResult, SnapshotOptions, SsrfPolicy } from '../types.js';

import { enrichSnapshotFromDom, mergeSnapshotWithEnrichment, nextRefCounter } from './dom-enrichment.js';
import { buildRoleSnapshotFromAiSnapshot, getRoleSnapshotStats } from './ref-map.js';

/**
 * Take an AI-readable snapshot using Playwright's AI-mode snapshot API.
 * This is the primary snapshot method — uses Playwright's built-in AI mode.
 */
export async function snapshotAi(opts: {
  cdpUrl: string;
  targetId?: string;
  maxChars?: number;
  timeoutMs?: number;
  options?: SnapshotOptions;
  ssrfPolicy?: SsrfPolicy;
}): Promise<SnapshotResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
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

  const sourceUrl = page.url();

  let snapshot = await takeAiSnapshotText(page, normalizeTimeoutMs(opts.timeoutMs, 5000, 60000));
  const maxChars = opts.maxChars;
  const limit =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : undefined;

  let truncated = false;
  if (limit !== undefined && snapshot.length > limit) {
    const lastNewline = snapshot.lastIndexOf('\n', limit);
    const cutoff = lastNewline > 0 ? lastNewline : limit;
    snapshot = `${snapshot.slice(0, cutoff)}\n\n[...TRUNCATED - page too large]`;
    truncated = true;
  }

  const built = buildRoleSnapshotFromAiSnapshot(snapshot, opts.options);

  const enriched = await enrichSnapshotFromDom(page, nextRefCounter(built.refs));
  const merged = mergeSnapshotWithEnrichment(built, enriched);

  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: merged.refs,
    mode: 'aria',
  });

  return {
    snapshot: merged.snapshot,
    refs: merged.refs,
    stats: getRoleSnapshotStats(merged.snapshot, merged.refs),
    ...(truncated ? { truncated } : {}),
    untrusted: true,
    contentMeta: {
      sourceUrl,
      contentType: 'browser-snapshot',
      capturedAt: new Date().toISOString(),
    },
  };
}
