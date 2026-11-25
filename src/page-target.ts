import type { Page } from 'playwright-core';

import { withPlaywrightPageCdpSession } from './connection.js';

interface PageTargetInfo {
  targetId: string;
  title: string;
}

const targetIds = new WeakMap<Page, string>();
const pendingReads = new WeakMap<Page, Promise<PageTargetInfo | null>>();
const TARGET_INFO_TIMEOUT_MS = 2000;

/** Browser-owned metadata stays readable even when the renderer cannot evaluate JS. */
export function pageTargetInfo(page: Page): Promise<PageTargetInfo | null> {
  const existing = pendingReads.get(page);
  if (existing) return existing;
  const pending = withPlaywrightPageCdpSession(
    page,
    async (session) => {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      const identity = targetInfo as { targetId?: string; title?: string } | undefined;
      const targetId = identity?.targetId?.trim();
      if (targetId === undefined || targetId === '') return null;
      targetIds.set(page, targetId);
      return { targetId, title: identity?.title ?? '' };
    },
    TARGET_INFO_TIMEOUT_MS,
  );
  pendingReads.set(page, pending);
  const release = () => {
    if (pendingReads.get(page) === pending) pendingReads.delete(page);
  };
  // Coalesce concurrent reads only: titles can change while target IDs remain stable.
  void pending.then(release, release);
  return pending;
}

/** A Page's native target ID remains stable across document changes. */
export async function pageTargetId(page: Page): Promise<string | null> {
  return targetIds.get(page) ?? (await pageTargetInfo(page))?.targetId ?? null;
}
