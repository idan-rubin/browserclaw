import type { Frame, Locator, Page } from 'playwright-core';

import { withPlaywrightPageCdpSession } from '../connection.js';
import type { SnapshotOptions } from '../types.js';

import { markNativeRefs, withNativeSnapshotRoot } from './native-markers.js';
import { buildNativeRoleSnapshot, readScopedAXNodes, type NativeRoleSnapshot } from './native-tree.js';

/** Keep root resolution, AX capture, and marker binding on one owned native session. */
export async function captureNativeRoleSnapshot(opts: {
  page: Page;
  frame?: Frame;
  locator: Locator;
  remaining: () => number;
  assertCurrent: () => void;
  options?: Pick<SnapshotOptions, 'interactive' | 'compact' | 'maxDepth'>;
}): Promise<NativeRoleSnapshot> {
  const root = await opts.locator.elementHandle({ timeout: opts.remaining() });
  let captureOwnsRoot = false;
  try {
    return await withPlaywrightPageCdpSession(
      opts.page,
      async (session) => {
        opts.assertCurrent();
        captureOwnsRoot = true;
        try {
          return await withNativeSnapshotRoot({
            root,
            session,
            assertCurrent: opts.assertCurrent,
            run: async (rootBackendNodeId) => {
              await session.send('Accessibility.enable');
              const nodes = await readScopedAXNodes(session, rootBackendNodeId);
              opts.assertCurrent();
              const captured = buildNativeRoleSnapshot(nodes, rootBackendNodeId, opts.options);
              const marked = await markNativeRefs({
                session,
                rootBackendNodeId,
                refs: captured.backendRefs,
                assertCurrent: opts.assertCurrent,
              });
              if (marked.size !== captured.backendRefs.length)
                throw new Error('Snapshot controls changed before refs were bound; retry.');
              return captured;
            },
          });
        } finally {
          root.dispose().catch(() => undefined);
        }
      },
      opts.remaining(),
      opts.frame,
    );
  } finally {
    // A timed-out CDP callback still needs the handle to remove its marker.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Ownership changes in the async callback.
    if (!captureOwnsRoot) root.dispose().catch(() => undefined);
  }
}
