import type { Page } from 'playwright-core';

import { withPlaywrightPageCdpSession } from './connection.js';

interface PageTargetInfo {
  targetId: string;
  title: string;
}

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
      return targetId !== undefined && targetId !== '' ? { targetId, title: identity?.title ?? '' } : null;
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
