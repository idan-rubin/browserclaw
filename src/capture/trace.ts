import { dirname } from 'node:path';

import { getPageForTargetId, ensurePageState, ensureContextState } from '../connection.js';
import { assertSafeOutputPath, writeViaSiblingTempPath } from '../security.js';

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
  const ctxState = ensureContextState(context);

  if (ctxState.traceActive) {
    throw new Error('Trace already running. Stop the current trace before starting a new one.');
  }

  await context.tracing.start({
    screenshots: opts.screenshots ?? true,
    snapshots: opts.snapshots ?? true,
    sources: opts.sources ?? false,
  });
  ctxState.traceActive = true;
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
  const ctxState = ensureContextState(context);

  if (!ctxState.traceActive) {
    throw new Error('No active trace. Start a trace before stopping it.');
  }

  // Mark traceActive = false BEFORE stopping, since context.tracing.stop() consumes the
  // trace regardless of whether the file write/rename succeeds. A failed write should not
  // leave traceActive = true (which would block starting a new trace).
  ctxState.traceActive = false;
  await writeViaSiblingTempPath({
    rootDir: dirname(opts.path),
    targetPath: opts.path,
    writeTemp: async (tempPath) => {
      await context.tracing.stop({ path: tempPath });
    },
  });
}
