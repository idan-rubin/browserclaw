import type { Frame, Page } from 'playwright-core';

import { assertPageNavigationCompletedSafely } from '../actions/navigation.js';
import {
  getPageForTargetId,
  ensurePageState,
  storeRoleRefsForTarget,
  withPlaywrightPageCdpSession,
  takeAiSnapshotText,
} from '../connection.js';
import type { SnapshotResult, AriaSnapshotResult, AriaNode, RoleRefs, SnapshotOptions, SsrfPolicy } from '../types.js';

import { withSnapshotFrameGuard } from './capture-guard.js';
import { enrichSnapshotFromDom, mergeSnapshotWithEnrichment, nextRefCounter } from './dom-enrichment.js';
import { finalizeSnapshot } from './finalize.js';
import { captureNativeRoleSnapshot } from './native-capture.js';
import { markNativeRefs } from './native-markers.js';
import { axValue, type AXNode } from './native-tree.js';
import { buildRoleSnapshotFromAiSnapshot } from './ref-map.js';

interface SnapshotPageOptions {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrfPolicy;
  signal?: AbortSignal;
}

function snapshotTimeout(timeoutMs?: number): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
    ? Math.max(500, Math.min(60000, Math.floor(timeoutMs)))
    : 5000;
}

async function prepareSnapshotPage(opts: SnapshotPageOptions): Promise<Page> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: opts.ssrfPolicy });
  ensurePageState(page);
  opts.signal?.throwIfAborted();
  if (opts.ssrfPolicy) await assertPageNavigationCompletedSafely({ ...opts, page, response: null });
  return page;
}

async function resolveSnapshotFrame(page: Page, selector: string, timeout: number): Promise<Frame | undefined> {
  if (!selector) return undefined;
  const element = await page.locator(selector).elementHandle({ timeout });
  const frame = await element.contentFrame().finally(() => element.dispose());
  if (!frame) throw new Error('Frame was unavailable while its browser snapshot was being captured.');
  return frame;
}

/** Capture a native, document-bound AX tree, or preserve Playwright AI refs in aria mode. */
export async function snapshotRole(
  opts: SnapshotPageOptions & {
    selector?: string;
    frameSelector?: string;
    refsMode?: 'role' | 'aria';
    maxChars?: number;
    options?: Pick<SnapshotOptions, 'interactive' | 'compact' | 'maxDepth'>;
  },
): Promise<SnapshotResult> {
  const page = await prepareSnapshotPage(opts);
  const timeoutMs = snapshotTimeout(opts.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  const frameSelector = opts.frameSelector?.trim() ?? '';
  const selector = opts.selector?.trim() ?? '';
  if (opts.refsMode === 'aria' && (selector || frameSelector))
    throw new Error('refs=aria does not support selector/frame snapshots yet.');
  const frame = await resolveSnapshotFrame(page, frameSelector, timeoutMs);
  return await withSnapshotFrameGuard({
    page,
    frame: opts.refsMode === 'aria' ? undefined : (frame ?? page.mainFrame()),
    signal: opts.signal,
    timeoutMs: Math.max(1, deadline - Date.now()),
    run: async (assertCurrent) => {
      const sourceUrl = page.url();
      const remaining = () => {
        assertCurrent();
        return Math.max(1, deadline - Date.now());
      };
      let built: { snapshot: string; refs: RoleRefs; truncated?: boolean };
      if (opts.refsMode === 'aria') {
        built = buildRoleSnapshotFromAiSnapshot(await takeAiSnapshotText(page, remaining()), opts.options);
      } else {
        const locator = (frame ?? page).locator(selector || ':root');
        if (selector && (await locator.count()) === 0) {
          assertCurrent();
          const empty = finalizeSnapshot(
            opts.options?.interactive === true ? '(no interactive elements)' : '(empty)',
            {},
            opts.maxChars,
          );
          storeRoleRefsForTarget({
            ...opts,
            page,
            frame,
            frameSelector: frameSelector || undefined,
            refs: {},
            mode: 'role',
          });
          return {
            ...empty,
            untrusted: true,
            contentMeta: { sourceUrl, contentType: 'browser-snapshot', capturedAt: new Date().toISOString() },
          };
        }
        built = await captureNativeRoleSnapshot({
          page,
          frame,
          locator,
          remaining,
          assertCurrent,
          options: opts.options,
        });
      }
      assertCurrent();
      const enriched = await enrichSnapshotFromDom(page, nextRefCounter(built.refs), {
        rootSelector: selector,
        frame,
        skipNativeMarkedElements: opts.refsMode !== 'aria',
      });
      assertCurrent();
      const merged = mergeSnapshotWithEnrichment(built, enriched);
      const finalized = finalizeSnapshot(merged.snapshot, merged.refs, opts.maxChars);
      assertCurrent();
      storeRoleRefsForTarget({
        ...opts,
        page,
        frame,
        frameSelector: frameSelector || undefined,
        refs: finalized.refs,
        mode: opts.refsMode ?? 'role',
      });
      return {
        ...finalized,
        ...(built.truncated === true ? { truncated: true } : {}),
        untrusted: true,
        contentMeta: { sourceUrl, contentType: 'browser-snapshot', capturedAt: new Date().toISOString() },
      };
    },
  });
}

/** Capture and bind a raw accessibility tree through one owned, bounded CDP session. */
export async function snapshotAria(opts: SnapshotPageOptions & { limit?: number }): Promise<AriaSnapshotResult> {
  const page = await prepareSnapshotPage(opts);
  const timeoutMs = snapshotTimeout(opts.timeoutMs);
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  return await withSnapshotFrameGuard({
    page,
    frame: page.mainFrame(),
    signal: opts.signal,
    timeoutMs,
    run: async (assertCurrent) => {
      const sourceUrl = page.url();
      const { nodes, refs } = await withPlaywrightPageCdpSession(
        page,
        async (session) => {
          await session.send('Accessibility.enable');
          const response = await session.send('Accessibility.getFullAXTree');
          assertCurrent();
          const nodes = formatAriaNodes(response.nodes, limit);
          const backendRefs = nodes.flatMap((node) =>
            node.backendDOMNodeId !== undefined && node.backendDOMNodeId > 0
              ? [{ ref: node.ref, backendDOMNodeId: node.backendDOMNodeId }]
              : [],
          );
          const marked = await markNativeRefs({ session, refs: backendRefs, assertCurrent });
          return { nodes, refs: buildAriaSnapshotRefs(nodes, marked) };
        },
        timeoutMs,
      );
      assertCurrent();
      storeRoleRefsForTarget({ ...opts, page, refs, mode: 'role' });
      return {
        nodes,
        untrusted: true,
        contentMeta: { sourceUrl, contentType: 'browser-aria-tree', capturedAt: new Date().toISOString() },
      };
    },
  });
}

function buildAriaSnapshotRefs(nodes: AriaNode[], marked: Set<string>): RoleRefs {
  const refs: RoleRefs = {};
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const role = (node.role || 'unknown').toLowerCase();
    const name = node.name.trim();
    const key = `${role}:${name}`;
    const group = groups.get(key) ?? [];
    refs[node.ref] = {
      role,
      name,
      nth: group.length,
      ...(marked.has(node.ref) ? { domMarker: true } : {}),
    };
    group.push(node.ref);
    groups.set(key, group);
  }
  for (const group of groups.values()) if (group.length === 1) delete refs[group[0]].nth;
  return refs;
}

function formatAriaNodes(nodes: AXNode[], limit: number): AriaNode[] {
  if (!nodes.length) return [];
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const referenced = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const root = nodes.find((node) => node.nodeId !== '' && !referenced.has(node.nodeId)) ?? nodes[0];
  const pending = [{ id: root.nodeId, depth: 0 }];
  const seen = new Set<string>();
  const out: AriaNode[] = [];
  while (pending.length && out.length < limit) {
    const next = pending.pop();
    if (!next || seen.has(next.id)) continue;
    const node = byId.get(next.id);
    if (!node) continue;
    seen.add(next.id);
    const value = axValue(node.value);
    const description = axValue(node.description);
    out.push({
      ref: `ax${String(out.length + 1)}`,
      role: axValue(node.role) || 'unknown',
      name: axValue(node.name),
      depth: next.depth,
      ...(value ? { value } : {}),
      ...(description ? { description } : {}),
      ...(node.backendDOMNodeId !== undefined && node.backendDOMNodeId > 0
        ? { backendDOMNodeId: node.backendDOMNodeId }
        : {}),
    });
    for (const id of [...(node.childIds ?? [])].reverse()) pending.push({ id, depth: next.depth + 1 });
  }
  return out;
}
