import {
  getPageForTargetId,
  ensurePageState,
  storeRoleRefsForTarget,
  normalizeTimeoutMs,
  withPlaywrightPageCdpSession,
} from '../connection.js';
import type { PageWithAI } from '../connection.js';
import type { SnapshotResult, AriaSnapshotResult, AriaNode } from '../types.js';

import { buildRoleSnapshotFromAriaSnapshot, buildRoleSnapshotFromAiSnapshot, getRoleSnapshotStats } from './ref-map.js';

/**
 * Take a role-based snapshot using Playwright's ariaSnapshot().
 * This produces a tree with ref IDs that can be targeted by actions.
 *
 * When `refsMode === 'aria'`, uses Playwright's `_snapshotForAI()` instead
 * and stores refs in aria mode (resolved via aria-ref locators).
 */
export async function snapshotRole(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: 'role' | 'aria';
  timeoutMs?: number;
  options?: {
    interactive?: boolean;
    compact?: boolean;
    maxDepth?: number;
  };
}): Promise<SnapshotResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const sourceUrl = page.url();

  // refs=aria sub-path: use _snapshotForAI instead of ariaSnapshot
  if (opts.refsMode === 'aria') {
    if (
      (opts.selector !== undefined && opts.selector.trim() !== '') ||
      (opts.frameSelector !== undefined && opts.frameSelector.trim() !== '')
    ) {
      throw new Error('refs=aria does not support selector/frame snapshots yet.');
    }
    const maybe = page as PageWithAI;
    if (!maybe._snapshotForAI) {
      throw new Error('refs=aria requires Playwright _snapshotForAI support.');
    }
    const result = await maybe._snapshotForAI({ timeout: 5000, track: 'response' });
    const built = buildRoleSnapshotFromAiSnapshot(String(result.full), opts.options);

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
      untrusted: true,
      contentMeta: {
        sourceUrl,
        contentType: 'browser-snapshot',
        capturedAt: new Date().toISOString(),
      },
    };
  }

  const frameSelector = opts.frameSelector?.trim() ?? '';
  const selector = opts.selector?.trim() ?? '';
  const locator = frameSelector
    ? selector
      ? page.frameLocator(frameSelector).locator(selector)
      : page.frameLocator(frameSelector).locator(':root')
    : selector
      ? page.locator(selector)
      : page.locator(':root');

  const ariaSnapshot = await locator.ariaSnapshot({ timeout: normalizeTimeoutMs(opts.timeoutMs, 5000) });
  const built = buildRoleSnapshotFromAriaSnapshot(ariaSnapshot, opts.options);

  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: built.refs,
    frameSelector: frameSelector !== '' ? frameSelector : undefined,
    mode: 'role',
  });

  return {
    snapshot: built.snapshot,
    refs: built.refs,
    stats: getRoleSnapshotStats(built.snapshot, built.refs),
    untrusted: true,
    contentMeta: {
      sourceUrl,
      contentType: 'browser-snapshot',
      capturedAt: new Date().toISOString(),
    },
  };
}

/** CDP accessibility tree node from Accessibility.getFullAXTree. */
interface CdpAXNode {
  nodeId: string;
  childIds?: string[];
  role?: { value?: string | number | boolean };
  name?: { value?: string | number | boolean };
  value?: { value?: string | number | boolean };
  description?: { value?: string | number | boolean };
  backendDOMNodeId?: number;
}

/**
 * Take a raw ARIA accessibility tree snapshot via CDP.
 */
export async function snapshotAria(opts: {
  cdpUrl: string;
  targetId?: string;
  limit?: number;
}): Promise<AriaSnapshotResult> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const sourceUrl = page.url();

  const res = await withPlaywrightPageCdpSession(page, async (session) => {
    await session.send('Accessibility.enable' as unknown as Parameters<typeof session.send>[0]).catch(() => {
      /* intentional no-op */
    });
    return (await session.send('Accessibility.getFullAXTree' as unknown as Parameters<typeof session.send>[0])) as {
      nodes?: CdpAXNode[];
    };
  });

  return {
    nodes: formatAriaNodes(Array.isArray(res.nodes) ? res.nodes : [], limit),
    untrusted: true,
    contentMeta: {
      sourceUrl,
      contentType: 'browser-aria-tree',
      capturedAt: new Date().toISOString(),
    },
  };
}

function axValue(v: { value?: string | number | boolean } | undefined): string {
  if (!v || typeof v !== 'object') return '';
  const value = v.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function formatAriaNodes(nodes: CdpAXNode[], limit: number): AriaNode[] {
  const byId = new Map<string, CdpAXNode>();
  for (const n of nodes) if (n.nodeId) byId.set(n.nodeId, n);

  const referenced = new Set<string>();
  for (const n of nodes) for (const c of n.childIds ?? []) referenced.add(c);

  const root = nodes.find((n) => n.nodeId !== '' && !referenced.has(n.nodeId)) ?? nodes[0];
  if (root.nodeId === '') return [];

  const out: AriaNode[] = [];
  const stack: { id: string; depth: number }[] = [{ id: root.nodeId, depth: 0 }];

  while (stack.length && out.length < limit) {
    const popped = stack.pop();
    if (!popped) break;
    const { id, depth } = popped;
    const n = byId.get(id);
    if (!n) continue;

    const role = axValue(n.role);
    const name = axValue(n.name);
    const value = axValue(n.value);
    const description = axValue(n.description);
    const ref = `ax${String(out.length + 1)}`;

    out.push({
      ref,
      role: role || 'unknown',
      name: name || '',
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(typeof n.backendDOMNodeId === 'number' ? { backendDOMNodeId: n.backendDOMNodeId } : {}),
      depth,
    });

    const children = (n.childIds ?? []).filter((c: string) => byId.has(c));
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i]) stack.push({ id: children[i], depth: depth + 1 });
    }
  }

  return out;
}
