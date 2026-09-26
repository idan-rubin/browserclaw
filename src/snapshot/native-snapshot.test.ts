import { EventEmitter } from 'node:events';

import type { CDPSession, Frame, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import { NavigationRaceError, StaleRefError } from '../errors.js';
import { ensurePageState } from '../page-utils.js';
import { refLocator, storeRoleRefsForTarget } from '../ref-resolver.js';

import { withSnapshotFrameGuard } from './capture-guard.js';
import { finalizeSnapshot } from './finalize.js';
import { markNativeRefs } from './native-markers.js';
import { buildNativeRoleSnapshot, readScopedAXNodes, type AXNode } from './native-tree.js';

const tree: AXNode[] = [
  { nodeId: 'root', role: { value: 'generic' }, backendDOMNodeId: 1, childIds: ['first', 'second'] },
  { nodeId: 'first', role: { value: 'button' }, name: { value: 'Save "draft" / new' }, backendDOMNodeId: 2 },
  {
    nodeId: 'second',
    role: { value: 'button' },
    name: { value: 'Save "draft" / new' },
    backendDOMNodeId: 3,
    properties: [{ name: 'disabled', value: { value: true } }],
  },
];

describe('native snapshot formatting and finalization', () => {
  it('keeps duplicate controls bound to distinct backend identities and preserves state', () => {
    const result = buildNativeRoleSnapshot(tree, 1);
    expect(result.backendRefs).toEqual([
      { ref: 'e1', backendDOMNodeId: 2 },
      { ref: 'e2', backendDOMNodeId: 3 },
    ]);
    expect(result.refs.e1.nth).toBe(0);
    expect(result.refs.e2).toMatchObject({ nth: 1, disabled: true, domMarker: true });
    expect(result.snapshot).toContain('Save \\"draft\\" / new');
  });

  it('budgets after enrichment, excludes cut refs and ignores fake refs inside quoted names', () => {
    const snapshot = '- button "Keep [ref=e99]" [ref=e1]\n- textbox "Enriched element is intentionally long" [ref=e2]';
    const refs = { e1: { role: 'button' }, e2: { role: 'textbox' }, e99: { role: 'link' } };
    const result = finalizeSnapshot(snapshot, refs, 70);
    expect(result.snapshot.length).toBeLessThanOrEqual(70);
    expect(Object.keys(result.refs)).toEqual(['e1']);
    expect(result.truncated).toBe(true);
    expect(finalizeSnapshot(snapshot, refs, 200).refs).toEqual({ e1: refs.e1, e2: refs.e2 });
    expect(finalizeSnapshot(snapshot, refs, 1)).toMatchObject({ snapshot: '…', refs: {}, truncated: true });
  });

  it('filters max-depth refs and protects against malformed cyclic AX trees', () => {
    const cyclic = tree.map((node) => (node.nodeId === 'first' ? { ...node, childIds: ['root'] } : node));
    expect(buildNativeRoleSnapshot(cyclic, 1).backendRefs).toHaveLength(2);
    const nested = [{ ...tree[0], role: { value: 'region' }, name: { value: 'Root' } }, ...tree.slice(1)];
    const result = buildNativeRoleSnapshot(nested, 1, { maxDepth: 0 });
    expect(Object.values(result.refs).map((ref) => ref.name)).toEqual(['Root']);
  });

  it('reports safety-depth truncation only when requested depth reaches the safety limit', () => {
    const deep: AXNode[] = Array.from({ length: 103 }, (_, index) => ({
      nodeId: String(index),
      backendDOMNodeId: index + 1,
      role: { value: 'region' },
      name: { value: `Level ${String(index)}` },
      childIds: index < 102 ? [String(index + 1)] : [],
    }));
    deep[0].childIds?.push('sibling');
    deep.push({ nodeId: 'sibling', backendDOMNodeId: 104, role: { value: 'button' }, name: { value: 'Sibling' } });
    for (const maxDepth of [2, 100]) {
      const result = buildNativeRoleSnapshot(deep, 1, { maxDepth });
      expect(result.truncated).toBeUndefined();
      expect(result.snapshot).not.toContain('TRUNCATED');
      expect(result.refs.e102).toMatchObject({ role: 'button', name: 'Sibling' });
      expect(result.backendRefs).toContainEqual({ ref: 'e102', backendDOMNodeId: 104 });
      expect(Object.keys(result.refs)).toHaveLength(maxDepth + 2);
    }
    for (const maxDepth of [undefined, 101]) {
      const result = buildNativeRoleSnapshot(deep, 1, { maxDepth });
      expect(result.truncated).toBe(true);
      expect(result.snapshot).toContain('[...TRUNCATED - accessibility tree too deep]');
      expect(Object.keys(result.refs)).toHaveLength(102);
    }
  });

  it('recovers ignored roots without including nodes outside their subtree', async () => {
    const ignored = { ...tree[0], ignored: true, frameId: 'frame' };
    const send = vi.fn((method: string) => {
      if (method === 'Accessibility.queryAXTree') return Promise.resolve({ nodes: tree.slice(1) });
      if (method === 'Accessibility.getPartialAXTree') return Promise.resolve({ nodes: [ignored] });
      return Promise.resolve({
        nodes: [...tree, { nodeId: 'outside', role: { value: 'button' }, backendDOMNodeId: 4 }],
      });
    });
    const nodes = await readScopedAXNodes({ send } as unknown as CDPSession, 1);
    expect(nodes.map((node) => node.nodeId)).toEqual(['root', 'first', 'second']);
    expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', { frameId: 'frame' });
  });
});

describe('native markers and document ownership', () => {
  it('initializes the owned session DOM before resolving/pushing nodes and stamps the BC attribute', async () => {
    const send = vi.fn((method: string) => {
      if (method === 'DOM.getDocument') return Promise.resolve({ root: { backendNodeId: 1 } });
      if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'owned-document' } });
      if (method === 'DOM.pushNodesByBackendIdsToFrontend') return Promise.resolve({ nodeIds: [22] });
      return Promise.resolve({});
    });
    await markNativeRefs({
      session: { send } as unknown as CDPSession,
      refs: [{ ref: 'e1', backendDOMNodeId: 2 }],
      assertCurrent: () => undefined,
    });
    expect(send.mock.calls.map(([method]) => method)).toEqual([
      'DOM.getDocument',
      'DOM.resolveNode',
      'Runtime.callFunctionOn',
      'Runtime.releaseObject',
      'DOM.pushNodesByBackendIdsToFrontend',
      'DOM.setAttributeValue',
    ]);
    expect(send).toHaveBeenLastCalledWith('DOM.setAttributeValue', {
      nodeId: 22,
      name: 'data-browserclaw-ref',
      value: 'e1',
    });
  });

  it('stops binding if the document changes after DOM initialization', async () => {
    let current = true;
    const send = vi.fn(() => {
      current = false;
      return Promise.resolve({ root: { backendNodeId: 1 } });
    });
    await expect(
      markNativeRefs({
        session: { send } as unknown as CDPSession,
        refs: [],
        assertCurrent: () => {
          if (!current) throw new Error('document changed');
        },
      }),
    ).rejects.toThrow('document changed');
    expect(send).toHaveBeenCalledOnce();
  });

  it('invalidates captures and stored refs on same-URL navigation and iframe replacement', async () => {
    const main = { isDetached: () => false } as Frame;
    const frame = { isDetached: () => false } as Frame;
    const emitter = Object.assign(new EventEmitter(), { url: () => 'https://same.test/', mainFrame: () => main });
    const page = emitter as unknown as Page;
    storeRoleRefsForTarget({
      page,
      cdpUrl: 'test',
      frame,
      frameSelector: '#frame',
      refs: { e1: { role: 'button', domMarker: true } },
      mode: 'role',
    });
    await expect(
      withSnapshotFrameGuard({
        page,
        frame,
        run: (assertCurrent) => {
          emitter.emit('framedetached', frame);
          assertCurrent();
          return Promise.resolve();
        },
      }),
    ).rejects.toBeInstanceOf(NavigationRaceError);
    expect(() => refLocator(page, 'e1')).toThrow(StaleRefError);
    storeRoleRefsForTarget({ page, cdpUrl: 'test', refs: { e2: { role: 'button' } }, mode: 'aria' });
    await expect(
      withSnapshotFrameGuard({
        page,
        run: (assertCurrent) => {
          emitter.emit('framenavigated', main);
          assertCurrent();
          return Promise.resolve();
        },
      }),
    ).rejects.toBeInstanceOf(NavigationRaceError);
    expect(ensurePageState(page).roleRefs).toBeUndefined();
  });
});
