import { getPageForTargetId, ensurePageState, storeRoleRefsForTarget } from '../connection.js';
import { buildRoleSnapshotFromAiSnapshot, getRoleSnapshotStats } from './ref-map.js';
import type { SnapshotResult, SnapshotOptions } from '../types.js';

/**
 * Take an AI-readable snapshot using Playwright's _snapshotForAI.
 * This is the primary snapshot method — uses Playwright's built-in AI mode.
 */
export async function snapshotAi(opts: {
  cdpUrl: string;
  targetId?: string;
  maxChars?: number;
  timeoutMs?: number;
  options?: SnapshotOptions;
}): Promise<SnapshotResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const maybe = page as any;
  if (!maybe._snapshotForAI) {
    throw new Error('Playwright _snapshotForAI is not available. Upgrade playwright-core to >= 1.50.');
  }

  const result = await maybe._snapshotForAI({
    timeout: Math.max(500, Math.min(60000, Math.floor(opts.timeoutMs ?? 5000))),
    track: 'response',
  });

  let snapshot = String(result?.full ?? '');
  const maxChars = opts.maxChars;
  const limit = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
    ? Math.floor(maxChars) : undefined;

  let truncated = false;
  if (limit && snapshot.length > limit) {
    snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
    truncated = true;
  }

  const built = buildRoleSnapshotFromAiSnapshot(snapshot, opts.options);
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: built.refs,
    mode: 'aria',
  });

  return {
    snapshot: built.snapshot,
    refs: built.refs,
    stats: getRoleSnapshotStats(built.snapshot, built.refs),
  };
}
