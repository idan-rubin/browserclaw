import type { RoleRefs, SnapshotResult, SnapshotStats } from '../types.js';

import { getRoleSnapshotStats, parseSnapshotLine } from './ref-map.js';

const TRUNCATION_MARKER = '[...TRUNCATED - page too large]';

/** Budget the complete, enriched output and publish only refs on complete visible lines. */
export function finalizeSnapshot(
  snapshot: string,
  refs: RoleRefs,
  maxChars?: number,
): SnapshotResult & { stats: SnapshotStats } {
  const limit =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= 1 ? Math.floor(maxChars) : undefined;
  const lines = snapshot.split('\n');
  const truncated = limit !== undefined && snapshot.length > limit;
  let visibleLines = lines;
  if (truncated) {
    const marker = limit >= 31 ? TRUNCATION_MARKER : '…';
    visibleLines = [];
    let length = 0;
    for (const line of lines) {
      const added = line.length + (visibleLines.length ? 1 : 0);
      if (length + added + 2 + marker.length > limit) break;
      visibleLines.push(line);
      length += added;
    }
    snapshot = visibleLines.length ? `${visibleLines.join('\n')}\n\n${marker}` : marker;
  }
  const visibleRefs = new Set(visibleLines.map((line) => parseSnapshotLine(line)?.ref).filter(Boolean));
  const filtered = Object.fromEntries(Object.entries(refs).filter(([ref]) => visibleRefs.has(ref)));
  return {
    snapshot,
    refs: filtered,
    stats: getRoleSnapshotStats(snapshot, filtered),
    ...(truncated ? { truncated: true } : {}),
  };
}
