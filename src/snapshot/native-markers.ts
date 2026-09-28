import { randomUUID } from 'node:crypto';

import type { CDPSession, Locator } from 'playwright-core';

import { BROWSER_REF_MARKER_ATTRIBUTE } from '../ref-resolver.js';

type SnapshotRoot = NonNullable<Awaited<ReturnType<Locator['elementHandle']>>>;

/** Resolve the exact Playwright element in the owned CDP session, including shadow DOM. */
export async function withNativeSnapshotRoot<T>(opts: {
  root: SnapshotRoot;
  session: CDPSession;
  assertCurrent: () => void;
  run: (backendNodeId: number) => Promise<T>;
}): Promise<T> {
  const attribute = `data-browserclaw-capture-${randomUUID()}`;
  let searchId: string | undefined;
  try {
    opts.assertCurrent();
    await opts.root.evaluate((element, name) => {
      element.setAttribute(name, '');
    }, attribute);
    await opts.session.send('DOM.getDocument', { depth: 0 });
    const search = await opts.session.send('DOM.performSearch', {
      query: `[${attribute}]`,
      includeUserAgentShadowDOM: true,
    });
    searchId = search.searchId;
    opts.assertCurrent();
    if (search.resultCount !== 1) throw new Error('Snapshot root changed before native capture; retry.');
    const { nodeIds } = await opts.session.send('DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 });
    const { node } = await opts.session.send('DOM.describeNode', { nodeId: nodeIds[0] });
    opts.assertCurrent();
    return await opts.run(node.backendNodeId);
  } finally {
    if (searchId !== undefined)
      await opts.session.send('DOM.discardSearchResults', { searchId }).catch(() => undefined);
    await opts.root
      .evaluate((element, name) => {
        element.removeAttribute(name);
      }, attribute)
      .catch(() => undefined);
  }
}

/** Initialize and mutate DOM identities only through the session that owns the capture. */
export async function markNativeRefs(opts: {
  session: CDPSession;
  rootBackendNodeId?: number;
  refs: { ref: string; backendDOMNodeId: number }[];
  assertCurrent: () => void;
}): Promise<Set<string>> {
  const { session, assertCurrent } = opts;
  const marked = new Set<string>();
  assertCurrent();
  const { root } = await session.send('DOM.getDocument', { depth: 0 });
  assertCurrent();
  const { object } = await session.send('DOM.resolveNode', {
    backendNodeId: opts.rootBackendNodeId ?? root.backendNodeId,
  });
  try {
    assertCurrent();
    if (object.objectId === undefined || object.objectId === '')
      throw new Error('Snapshot document changed before refs were bound; retry.');
    const cleared = await session.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(attribute) {
        const roots = [this.ownerDocument || this];
        for (const root of roots) {
          for (const element of root.querySelectorAll('*')) {
            element.removeAttribute(attribute);
            if (element.shadowRoot) roots.push(element.shadowRoot);
          }
        }
      }`,
      arguments: [{ value: BROWSER_REF_MARKER_ATTRIBUTE }],
    });
    assertCurrent();
    if (cleared.exceptionDetails) throw new Error('Snapshot markers could not be cleared; retry.');
  } finally {
    if (object.objectId !== undefined && object.objectId !== '')
      await session.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => undefined);
  }
  assertCurrent();
  if (!opts.refs.length) return marked;
  const backendNodeIds = [...new Set(opts.refs.map(({ backendDOMNodeId }) => backendDOMNodeId))];
  const { nodeIds } = await session.send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds });
  assertCurrent();
  const frontendIds = new Map(backendNodeIds.map((id, index) => [id, nodeIds[index]]));
  for (const { ref, backendDOMNodeId } of opts.refs) {
    const nodeId = frontendIds.get(backendDOMNodeId);
    if (nodeId === undefined || nodeId <= 0) continue;
    assertCurrent();
    try {
      await session.send('DOM.setAttributeValue', { nodeId, name: BROWSER_REF_MARKER_ATTRIBUTE, value: ref });
      marked.add(ref);
    } catch {
      // Raw AX trees include text/document nodes that cannot carry attributes.
      // Native role capture separately requires every actionable ref to bind.
    }
    assertCurrent();
  }
  return marked;
}
