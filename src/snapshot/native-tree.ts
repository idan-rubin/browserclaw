import type { CDPSession } from 'playwright-core';

import type { RoleRefInfo, RoleRefs, SnapshotOptions } from '../types.js';

import { finalizeSnapshot } from './finalize.js';
import { CONTENT_ROLES, INTERACTIVE_ROLES, STRUCTURAL_ROLES } from './ref-map.js';

export interface AXNode {
  nodeId: string;
  childIds?: string[];
  ignored?: boolean;
  frameId?: string;
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
  description?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
}

export function axValue(value: { value?: unknown } | undefined): string {
  const raw = value?.value;
  return typeof raw === 'string' || typeof raw === 'boolean' || typeof raw === 'number' ? String(raw) : '';
}

/** queryAXTree omits ignored roots; recover only their descendants, never the surrounding document. */
export async function readScopedAXNodes(session: CDPSession, backendNodeId: number): Promise<AXNode[]> {
  const queried = await session.send('Accessibility.queryAXTree', { backendNodeId });
  if (queried.nodes.some((node) => node.backendDOMNodeId === backendNodeId)) return queried.nodes;
  const partial = await session.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: true });
  const root = partial.nodes.find((node) => node.backendDOMNodeId === backendNodeId);
  if (root?.ignored !== true) throw new Error('Snapshot root is no longer present in the accessibility tree; retry.');
  if ((root.childIds?.length ?? 0) === 0) return [root];
  const frameId = partial.nodes.find((node) => node.frameId !== undefined && node.frameId !== '')?.frameId;
  if (frameId === undefined || frameId === '') throw new Error('Snapshot frame identity is unavailable; retry.');
  const full = await session.send('Accessibility.getFullAXTree', { frameId });
  const byId = new Map(full.nodes.map((node) => [node.nodeId, node]));
  const nodes = [root];
  const included = new Set([root.nodeId]);
  for (const node of nodes) {
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child && !included.has(id)) {
        included.add(id);
        nodes.push(child);
      }
    }
  }
  return nodes;
}

function roleStateSuffix(node: AXNode): string {
  const properties = new Map(node.properties?.map(({ name, value }) => [name, value.value]));
  return ['checked', 'disabled', 'expanded', 'pressed', 'selected', 'level', 'invalid']
    .flatMap((name) => {
      const value = properties.get(name);
      if (value === true || value === 'true') return [` [${name}]`];
      if (
        value === 'mixed' ||
        (name === 'level' && typeof value === 'number') ||
        (name === 'invalid' && typeof value === 'string' && value !== 'false')
      ) {
        return [` [${name}=${String(value)}]`];
      }
      return [];
    })
    .join('');
}

interface RoleNode {
  raw: AXNode;
  role: string;
  name: string;
  depth: number;
  transparent: boolean;
  ref?: string;
  nth?: number;
}

export interface NativeRoleSnapshot {
  snapshot: string;
  refs: RoleRefs;
  backendRefs: { ref: string; backendDOMNodeId: number }[];
  truncated?: boolean;
}

/** Format a scoped native AX tree while keeping each actionable ref's DOM identity. */
export function buildNativeRoleSnapshot(
  nodes: AXNode[],
  rootBackendNodeId: number,
  options: Pick<SnapshotOptions, 'interactive' | 'compact' | 'maxDepth'> = {},
): NativeRoleSnapshot {
  const root = nodes.find((node) => node.backendDOMNodeId === rootBackendNodeId);
  if (!root) throw new Error('Snapshot root is no longer present in the accessibility tree; retry.');
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const pending = [{ raw: root, depth: 0 }];
  const seen = new Set<string>();
  const tree: RoleNode[] = [];
  let depthTruncated = false;
  while (pending.length) {
    const next = pending.pop();
    if (!next || seen.has(next.raw.nodeId)) continue;
    seen.add(next.raw.nodeId);
    if (next.depth > 100) {
      if (!(options.maxDepth !== undefined && next.depth > options.maxDepth)) depthTruncated = true;
      continue;
    }
    const role = axValue(next.raw.role) || 'unknown';
    const name = axValue(next.raw.name);
    const normalized = role.toLowerCase();
    const transparent =
      next.raw.ignored === true ||
      ['none', 'presentation', 'fragment'].includes(normalized) ||
      (normalized === 'generic' && !name);
    tree.push({ ...next, role, name, transparent });
    for (const childId of [...(next.raw.childIds ?? [])].reverse()) {
      const child = byId.get(childId);
      if (child) pending.push({ raw: child, depth: next.depth + (transparent ? 0 : 1) });
    }
  }

  const counts = new Map<string, number>();
  const refs: RoleRefs = {};
  let nextRef = 1;
  const backendRefs: NativeRoleSnapshot['backendRefs'] = [];
  for (const node of tree) {
    const role = node.role.toLowerCase();
    if (
      node.transparent ||
      !(INTERACTIVE_ROLES.has(role) || (CONTENT_ROLES.has(role) && node.name) || role === 'iframe')
    ) {
      continue;
    }
    const key = `${role}:${node.name}`;
    node.nth = counts.get(key) ?? 0;
    counts.set(key, node.nth + 1);
    node.ref = `e${String(nextRef++)}`;
    const properties = new Map(node.raw.properties?.map(({ name, value }) => [name, value.value]));
    const info: RoleRefInfo = { role, ...(node.name ? { name: node.name } : {}), nth: node.nth, domMarker: true };
    if (properties.get('disabled') === true) info.disabled = true;
    const checked = properties.get('checked');
    if (checked === true || checked === 'true') info.checked = true;
    else if (checked === 'mixed') info.checked = 'mixed';
    refs[node.ref] = info;
    if (node.raw.backendDOMNodeId !== undefined && node.raw.backendDOMNodeId > 0)
      backendRefs.push({ ref: node.ref, backendDOMNodeId: node.raw.backendDOMNodeId });
  }
  const lines: string[] = [];
  for (const node of tree) {
    const role = node.role.toLowerCase();
    if (node.ref !== undefined && counts.get(`${role}:${node.name}`) === 1) delete refs[node.ref].nth;
    if (node.transparent || (options.maxDepth !== undefined && node.depth > options.maxDepth)) continue;
    if (options.interactive === true && !INTERACTIVE_ROLES.has(role) && role !== 'iframe') continue;
    if (options.compact === true && STRUCTURAL_ROLES.has(role) && !node.name && node.ref === undefined) continue;
    const indent = '  '.repeat(options.interactive === true ? 0 : node.depth);
    const name = node.name ? ` ${JSON.stringify(node.name)}` : '';
    const ref = node.ref !== undefined ? ` [ref=${node.ref}]` : '';
    const nth = node.nth !== undefined && node.nth > 0 ? ` [nth=${String(node.nth)}]` : '';
    const value = axValue(node.raw.value);
    lines.push(
      `${indent}- ${node.role}${name}${ref}${nth}${roleStateSuffix(node.raw)}${value ? ` value=${JSON.stringify(value)}` : ''}`,
    );
  }
  let snapshot = lines.join('\n') || (options.interactive === true ? '(no interactive elements)' : '(empty)');
  if (depthTruncated) snapshot += '\n\n[...TRUNCATED - accessibility tree too deep]';
  const finalized = finalizeSnapshot(snapshot, refs);
  const visibleBackendRefs = backendRefs.filter(({ ref }) => Object.hasOwn(finalized.refs, ref));
  if (visibleBackendRefs.length !== Object.keys(finalized.refs).length) {
    throw new Error('Snapshot control has no DOM identity; retry.');
  }
  return { ...finalized, backendRefs: visibleBackendRefs, ...(depthTruncated ? { truncated: true } : {}) };
}
