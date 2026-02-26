import {
  getPageForTargetId,
  ensurePageState,
} from '../connection.js';
import { assertSafeOutputPath } from '../security.js';

export async function traceStartViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
}): Promise<void> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  const context = page.context();
  await context.tracing.start({
    screenshots: opts.screenshots ?? true,
    snapshots: opts.snapshots ?? true,
    sources: opts.sources,
  });
}

export async function traceStopViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path: string;
  allowedOutputRoots?: string[];
}): Promise<void> {
  await assertSafeOutputPath(opts.path, opts.allowedOutputRoots);
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);
  const context = page.context();
  await context.tracing.stop({ path: opts.path });
}
