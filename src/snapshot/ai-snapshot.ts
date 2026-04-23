import { assertPageNavigationCompletedSafely } from '../actions/navigation.js';
import {
  getPageForTargetId,
  ensurePageState,
  storeRoleRefsForTarget,
  normalizeTimeoutMs,
  takeAiSnapshotText,
} from '../connection.js';
import { NavigationRaceError, SnapshotHydrationError } from '../errors.js';
import type { SnapshotResult, SnapshotOptions, SsrfPolicy } from '../types.js';

import { enrichSnapshotFromDom, mergeSnapshotWithEnrichment, nextRefCounter } from './dom-enrichment.js';
import { buildRoleSnapshotFromAiSnapshot, getRoleSnapshotStats } from './ref-map.js';

const DEFAULT_HYDRATION_BUDGET_MS = 5000;
const HYDRATION_POLL_INTERVAL_MS = 250;

function resolveHydrationBudgetMs(value: boolean | number | undefined): number {
  if (value === undefined || value === false) return 0;
  if (value === true) return DEFAULT_HYDRATION_BUDGET_MS;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(60_000, Math.floor(value));
}

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

  const initialUrl = page.url();
  const hydrationBudgetMs = resolveHydrationBudgetMs(opts.options?.waitForHydration);
  const minInteractive = Math.max(1, Math.floor(opts.options?.minInteractiveRefs ?? 1));
  const started = Date.now();
  let attempts = 0;
  let lastResult: SnapshotResult | undefined;

  const deadline = started + hydrationBudgetMs;
  const maxChars = opts.maxChars;
  const limit =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : undefined;

  for (;;) {
    attempts += 1;
    let snapshot = await takeAiSnapshotText(page, normalizeTimeoutMs(opts.timeoutMs, 5000, 60000));
    // Capture the URL the refs were built against. Used for contentMeta and
    // for race detection before we return.
    const snapshotUrl = page.url();

    let truncated = false;
    if (limit !== undefined && snapshot.length > limit) {
      const lastNewline = snapshot.lastIndexOf('\n', limit);
      const cutoff = lastNewline > 0 ? lastNewline : limit;
      snapshot = `${snapshot.slice(0, cutoff)}\n\n[...TRUNCATED - page too large]`;
      truncated = true;
    }

    // When the caller asked for hydration and the document changed between
    // the initial resolution and the snapshot we just took, the snapshot is
    // bound to a different document than the one they asked about. Surface
    // that as NavigationRaceError and do NOT stamp the per-target ref cache
    // — the caller's expected recovery is re-snapshot, and leaving refs
    // bound to the discarded document would poison a naive retry.
    if (hydrationBudgetMs > 0 && snapshotUrl !== initialUrl) {
      throw new NavigationRaceError({ fromUrl: initialUrl, toUrl: snapshotUrl });
    }

    const built = buildRoleSnapshotFromAiSnapshot(snapshot, opts.options);
    const enriched = await enrichSnapshotFromDom(page, nextRefCounter(built.refs));
    const merged = mergeSnapshotWithEnrichment(built, enriched);
    const stats = getRoleSnapshotStats(merged.snapshot, merged.refs);

    const result: SnapshotResult = {
      snapshot: merged.snapshot,
      refs: merged.refs,
      stats,
      ...(truncated ? { truncated } : {}),
      untrusted: true,
      contentMeta: {
        sourceUrl: snapshotUrl,
        contentType: 'browser-snapshot',
        capturedAt: new Date().toISOString(),
      },
    };
    lastResult = result;

    const ready = stats.interactive >= minInteractive;
    const finished = hydrationBudgetMs === 0 || ready;

    if (finished) {
      // Only stamp the per-target ref cache when we're actually returning
      // this result. On retry iterations we leave the previous cache in
      // place so a racing caller doesn't see intermediate empty snapshots.
      storeRoleRefsForTarget({
        page,
        cdpUrl: opts.cdpUrl,
        targetId: opts.targetId,
        refs: merged.refs,
        mode: 'aria',
      });
      return result;
    }

    if (Date.now() >= deadline) break;

    const remaining = deadline - Date.now();
    await new Promise((r) => setTimeout(r, Math.min(HYDRATION_POLL_INTERVAL_MS, Math.max(50, remaining))));

    // Catch races that happen during the hydration wait as well, so we don't
    // spin on the old URL waiting for refs that will never come.
    const waitUrl = page.url();
    if (waitUrl !== initialUrl) {
      throw new NavigationRaceError({ fromUrl: initialUrl, toUrl: waitUrl });
    }
  }

  throw Object.assign(new SnapshotHydrationError({ attempts, elapsedMs: Date.now() - started }), {
    cause: { snapshot: lastResult },
  });
}
