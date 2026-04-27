import type { Page } from 'playwright-core';

import { assertPageNavigationCompletedSafely } from '../actions/navigation.js';
import {
  getPageForTargetId,
  ensurePageState,
  storeRoleRefsForTarget,
  normalizeTimeoutMs,
  withPlaywrightPageCdpSession,
  takeAiSnapshotText,
} from '../connection.js';
import { BROWSER_REF_MARKER_ATTRIBUTE } from '../ref-resolver.js';
import type { SnapshotResult, AriaSnapshotResult, AriaNode, RoleRefs, SsrfPolicy } from '../types.js';

import { enrichSnapshotFromDom, mergeSnapshotWithEnrichment, nextRefCounter } from './dom-enrichment.js';
import { buildRoleSnapshotFromAriaSnapshot, buildRoleSnapshotFromAiSnapshot, getRoleSnapshotStats } from './ref-map.js';

/**
 * Take a role-based snapshot using Playwright's ariaSnapshot().
 * This produces a tree with ref IDs that can be targeted by actions.
 *
 * When `refsMode === 'aria'`, uses Playwright's AI-mode snapshot API instead
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

  const sourceUrl = page.url();

  // refs=aria sub-path: use the AI-mode snapshot instead of role-based ariaSnapshot
  if (opts.refsMode === 'aria') {
    if (
      (opts.selector !== undefined && opts.selector.trim() !== '') ||
      (opts.frameSelector !== undefined && opts.frameSelector.trim() !== '')
    ) {
      throw new Error('refs=aria does not support selector/frame snapshots yet.');
    }
    const snapshotText = await takeAiSnapshotText(page, normalizeTimeoutMs(opts.timeoutMs, 5000));
    const built = buildRoleSnapshotFromAiSnapshot(snapshotText, opts.options);

    const enriched = await enrichSnapshotFromDom(page, nextRefCounter(built.refs));
    const merged = mergeSnapshotWithEnrichment(built, enriched);

    storeRoleRefsForTarget({
      page,
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      refs: merged.refs,
      mode: 'aria',
    });

    return {
      snapshot: merged.snapshot,
      refs: merged.refs,
      stats: getRoleSnapshotStats(merged.snapshot, merged.refs),
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

  const enriched = await enrichSnapshotFromDom(page, nextRefCounter(built.refs), {
    rootSelector: selector,
    frameSelector,
  });
  const merged = mergeSnapshotWithEnrichment(built, enriched);

  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: merged.refs,
    frameSelector: frameSelector !== '' ? frameSelector : undefined,
    mode: 'role',
  });

  return {
    snapshot: merged.snapshot,
    refs: merged.refs,
    stats: getRoleSnapshotStats(merged.snapshot, merged.refs),
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
  ssrfPolicy?: SsrfPolicy;
}): Promise<AriaSnapshotResult> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
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

  const sourceUrl = page.url();

  const res = await withPlaywrightPageCdpSession(page, async (session) => {
    await session.send('Accessibility.enable' as unknown as Parameters<typeof session.send>[0]).catch(() => {
      /* intentional no-op */
    });
    return (await session.send('Accessibility.getFullAXTree' as unknown as Parameters<typeof session.send>[0])) as {
      nodes?: CdpAXNode[];
    };
  });

  const formatted = formatAriaNodes(Array.isArray(res.nodes) ? res.nodes : [], limit);
  const markedRefs = await markBackendDomRefsOnPage(page, formatted);
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: buildAriaSnapshotRefs(formatted, markedRefs),
    mode: 'role',
  });

  return {
    nodes: formatted,
    untrusted: true,
    contentMeta: {
      sourceUrl,
      contentType: 'browser-aria-tree',
      capturedAt: new Date().toISOString(),
    },
  };
}

async function markBackendDomRefsOnPage(page: Page, nodes: AriaNode[]): Promise<Set<string>> {
  await page
    .locator(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`)
    .evaluateAll((elements, attr) => {
      for (const element of elements) if (element instanceof Element) element.removeAttribute(attr);
    }, BROWSER_REF_MARKER_ATTRIBUTE)
    .catch(() => {
      /* best-effort cleanup of stale markers */
    });
  const targetable = nodes.filter(
    (n) => typeof n.backendDOMNodeId === 'number' && Number.isFinite(n.backendDOMNodeId) && n.backendDOMNodeId > 0,
  );
  const marked = new Set<string>();
  if (!targetable.length) return marked;
  return await withPlaywrightPageCdpSession(page, async (session) => {
    type Send = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    const send: Send = (method, params) =>
      session.send(method as Parameters<typeof session.send>[0], params as Parameters<typeof session.send>[1]);
    await send('DOM.enable').catch(() => {
      /* best-effort */
    });
    const backendNodeIds = [...new Set(targetable.map((n) => Math.floor(n.backendDOMNodeId ?? 0)))];
    const pushed = (await send('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds }).catch(() => ({}))) as {
      nodeIds?: unknown;
    };
    const nodeIds = Array.isArray(pushed.nodeIds) ? (pushed.nodeIds as number[]) : [];
    const nodeIdByBackendId = new Map<number, number>();
    for (let i = 0; i < backendNodeIds.length; i++) {
      const backendNodeId = backendNodeIds[i];
      const nodeId = nodeIds[i];
      if (backendNodeId && typeof nodeId === 'number' && nodeId > 0) nodeIdByBackendId.set(backendNodeId, nodeId);
    }
    for (const node of targetable) {
      const nodeId = nodeIdByBackendId.get(Math.floor(node.backendDOMNodeId ?? 0));
      if (nodeId === undefined || nodeId <= 0) continue;
      try {
        await send('DOM.setAttributeValue', { nodeId, name: BROWSER_REF_MARKER_ATTRIBUTE, value: node.ref });
        marked.add(node.ref);
      } catch {
        /* node may have been detached between push and set; skip */
      }
    }
    return marked;
  });
}

function buildAriaSnapshotRefs(nodes: AriaNode[], markedRefs: Set<string>): RoleRefs {
  const refs: RoleRefs = {};
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();
  for (const node of nodes) {
    const role = (node.role || 'unknown').toLowerCase();
    const name = node.name.trim() || undefined;
    const key = `${role}:${name ?? ''}`;
    const nth = counts.get(key) ?? 0;
    counts.set(key, nth + 1);
    refsByKey.set(key, [...(refsByKey.get(key) ?? []), node.ref]);
    refs[node.ref] = {
      role,
      ...(name !== undefined ? { name } : {}),
      nth,
      ...(markedRefs.has(node.ref) ? { domMarker: true } : {}),
    };
  }
  for (const refsForKey of refsByKey.values()) {
    if (refsForKey.length > 1) continue;
    const ref = refsForKey[0];
    delete refs[ref].nth;
  }
  return refs;
}

function axValue(v: { value?: string | number | boolean } | undefined): string {
  if (!v || typeof v !== 'object') return '';
  const value = v.value;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function formatAriaNodes(nodes: CdpAXNode[], limit: number): AriaNode[] {
  if (nodes.length === 0) return [];

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
