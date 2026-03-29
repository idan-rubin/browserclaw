import type { RoleRefs } from '../types.js';

export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
]);

export const CONTENT_ROLES = new Set([
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'listitem',
  'article',
  'region',
  'main',
  'navigation',
]);

export const STRUCTURAL_ROLES = new Set([
  'generic',
  'group',
  'ignored',
  'list',
  'table',
  'row',
  'rowgroup',
  'grid',
  'treegrid',
  'menu',
  'menubar',
  'toolbar',
  'tablist',
  'tree',
  'directory',
  'document',
  'application',
  'presentation',
  'none',
]);

function getIndentLevel(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? Math.floor(match[1].length / 2) : 0;
}

interface ParsedSnapshotLine {
  roleRaw: string;
  role: string;
  name?: string;
  suffix: string;
}

function matchInteractiveSnapshotLine(line: string, options: SnapshotBuildOptions): ParsedSnapshotLine | null {
  const depth = getIndentLevel(line);
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return null;
  }
  const match = /^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/.exec(line);
  if (!match) {
    return null;
  }
  const [, , roleRaw, name, suffix] = match;
  if (roleRaw.startsWith('/')) {
    return null;
  }
  const role = roleRaw.toLowerCase();
  return {
    roleRaw: roleRaw,
    role,
    ...(name ? { name } : {}),
    suffix: suffix,
  };
}

function createRoleNameTracker() {
  const counts = new Map<string, number>();
  const refsByKey = new Map<string, string[]>();

  return {
    counts,
    refsByKey,
    getKey(role: string, name?: string): string {
      return `${role}:${name ?? ''}`;
    },
    getNextIndex(role: string, name?: string): number {
      const key = this.getKey(role, name);
      const current = counts.get(key) ?? 0;
      counts.set(key, current + 1);
      return current;
    },
    trackRef(role: string, name: string | undefined, ref: string): void {
      const key = this.getKey(role, name);
      const list = refsByKey.get(key) ?? [];
      list.push(ref);
      refsByKey.set(key, list);
    },
    getDuplicateKeys(): Set<string> {
      const out = new Set<string>();
      for (const [key, refs] of refsByKey) if (refs.length > 1) out.add(key);
      return out;
    },
  };
}

function removeNthFromNonDuplicates(refs: RoleRefs, tracker: ReturnType<typeof createRoleNameTracker>): void {
  const duplicates = tracker.getDuplicateKeys();
  for (const [ref, data] of Object.entries(refs)) {
    const key = tracker.getKey(data.role, data.name);
    if (!duplicates.has(key)) delete refs[ref].nth;
  }
}

function compactTree(tree: string): string {
  const lines = tree.split('\n');
  const result: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('[ref=')) {
      result.push(line);
      continue;
    }
    if (line.includes(':') && !line.trimEnd().endsWith(':')) {
      result.push(line);
      continue;
    }
    const currentIndent = getIndentLevel(line);
    let hasRelevantChildren = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (getIndentLevel(lines[j]) <= currentIndent) break;
      if (lines[j]?.includes('[ref=')) {
        hasRelevantChildren = true;
        break;
      }
    }
    if (hasRelevantChildren) result.push(line);
  }
  return result.join('\n');
}

export interface SnapshotBuildOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
}

/**
 * Build a role snapshot from Playwright's ariaSnapshot() output.
 * Assigns ref IDs (e1, e2, ...) to interactive/content elements.
 */
export function buildRoleSnapshotFromAriaSnapshot(
  ariaSnapshot: string,
  options: SnapshotBuildOptions = {},
): { snapshot: string; refs: RoleRefs } {
  const lines = ariaSnapshot.split('\n');
  const refs: RoleRefs = {};
  const tracker = createRoleNameTracker();
  let counter = 0;
  const nextRef = () => {
    counter++;
    return `e${String(counter)}`;
  };

  if (options.interactive === true) {
    const result: string[] = [];
    for (const line of lines) {
      const parsed = matchInteractiveSnapshotLine(line, options);
      if (!parsed) continue;
      const { roleRaw, role, name, suffix } = parsed;
      if (!INTERACTIVE_ROLES.has(role)) continue;
      const prefix = /^(\s*-\s*)/.exec(line)?.[1] ?? '';
      const ref = nextRef();
      const nth = tracker.getNextIndex(role, name);
      tracker.trackRef(role, name, ref);
      refs[ref] = { role, name, nth };
      let enhanced = `${prefix}${roleRaw}`;
      if (name !== undefined && name !== '') enhanced += ` "${name}"`;
      enhanced += ` [ref=${ref}]`;
      if (nth > 0) enhanced += ` [nth=${String(nth)}]`;
      if (suffix.includes('[')) enhanced += suffix;
      result.push(enhanced);
    }
    removeNthFromNonDuplicates(refs, tracker);
    return { snapshot: result.join('\n') || '(no interactive elements)', refs };
  }

  const result: string[] = [];
  for (const line of lines) {
    const depth = getIndentLevel(line);
    if (options.maxDepth !== undefined && depth > options.maxDepth) continue;
    const match = /^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/.exec(line);
    if (!match) {
      result.push(line);
      continue;
    }
    const [, prefix, roleRaw, name, suffix] = match;
    if (roleRaw.startsWith('/')) {
      result.push(line);
      continue;
    }
    const role = roleRaw.toLowerCase();
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContent = CONTENT_ROLES.has(role);
    const isStructural = STRUCTURAL_ROLES.has(role);
    if (options.compact === true && isStructural && name === '') continue;
    if (!(isInteractive || (isContent && name !== ''))) {
      result.push(line);
      continue;
    }

    const ref = nextRef();
    const nth = tracker.getNextIndex(role, name);
    tracker.trackRef(role, name, ref);
    refs[ref] = { role, name, nth };

    let enhanced = `${prefix}${roleRaw}`;
    if (name !== '') enhanced += ` "${name}"`;
    enhanced += ` [ref=${ref}]`;
    if (nth > 0) enhanced += ` [nth=${String(nth)}]`;
    if (suffix !== '') enhanced += suffix;
    result.push(enhanced);
  }
  removeNthFromNonDuplicates(refs, tracker);
  const tree = result.join('\n') || '(empty)';
  return { snapshot: options.compact === true ? compactTree(tree) : tree, refs };
}

/**
 * Build a role snapshot from Playwright's AI snapshot output.
 * Preserves Playwright's own aria-ref ids (e.g. ref=e13).
 */
export function buildRoleSnapshotFromAiSnapshot(
  aiSnapshot: string,
  options: SnapshotBuildOptions = {},
): { snapshot: string; refs: RoleRefs } {
  const lines = aiSnapshot.split('\n');
  const refs: RoleRefs = {};

  function parseAiSnapshotRef(suffix: string): string | null {
    const match = /\[ref=(e\d+)\]/i.exec(suffix);
    return match ? match[1] : null;
  }

  if (options.interactive === true) {
    let interactiveMaxRef = 0;
    for (const line of lines) {
      const refMatch = /\[ref=e(\d+)\]/.exec(line);
      if (refMatch) interactiveMaxRef = Math.max(interactiveMaxRef, Number.parseInt(refMatch[1], 10));
    }
    let interactiveCounter = interactiveMaxRef;
    const nextInteractiveRef = () => {
      interactiveCounter++;
      return `e${String(interactiveCounter)}`;
    };

    const out: string[] = [];
    for (const line of lines) {
      const parsed = matchInteractiveSnapshotLine(line, options);
      if (!parsed) continue;
      const { roleRaw, role, name, suffix } = parsed;
      if (!INTERACTIVE_ROLES.has(role)) continue;
      const ref = parseAiSnapshotRef(suffix);
      const prefix = /^(\s*-\s*)/.exec(line)?.[1] ?? '';
      if (ref !== null) {
        refs[ref] = { role, ...(name !== undefined && name !== '' ? { name } : {}) };
        out.push(`${prefix}${roleRaw}${name !== undefined && name !== '' ? ` "${name}"` : ''}${suffix}`);
      } else {
        const generatedRef = nextInteractiveRef();
        refs[generatedRef] = { role, ...(name !== undefined && name !== '' ? { name } : {}) };
        let enhanced = `${prefix}${roleRaw}`;
        if (name !== undefined && name !== '') enhanced += ` "${name}"`;
        enhanced += ` [ref=${generatedRef}]`;
        if (suffix.trim() !== '') enhanced += suffix;
        out.push(enhanced);
      }
    }
    return { snapshot: out.join('\n') || '(no interactive elements)', refs };
  }

  let maxRef = 0;
  for (const line of lines) {
    const refMatch = /\[ref=e(\d+)\]/.exec(line);
    if (refMatch) maxRef = Math.max(maxRef, Number.parseInt(refMatch[1], 10));
  }
  let generatedCounter = maxRef;
  const nextGeneratedRef = () => {
    generatedCounter++;
    return `e${String(generatedCounter)}`;
  };

  const out: string[] = [];
  for (const line of lines) {
    const depth = getIndentLevel(line);
    if (options.maxDepth !== undefined && depth > options.maxDepth) continue;
    const match = /^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/.exec(line);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, prefix, roleRaw, name, suffix] = match;
    if (roleRaw.startsWith('/')) {
      out.push(line);
      continue;
    }
    const role = roleRaw.toLowerCase();
    const isStructural = STRUCTURAL_ROLES.has(role);
    if (options.compact === true && isStructural && name === '') continue;
    const ref = parseAiSnapshotRef(suffix);
    if (ref !== null) {
      refs[ref] = { role, ...(name !== '' ? { name } : {}) };
      out.push(line);
    } else if (INTERACTIVE_ROLES.has(role)) {
      const generatedRef = nextGeneratedRef();
      refs[generatedRef] = { role, ...(name !== '' ? { name } : {}) };
      let enhanced = `${prefix}${roleRaw}`;
      if (name !== '') enhanced += ` "${name}"`;
      enhanced += ` [ref=${generatedRef}]`;
      if (suffix.trim() !== '') enhanced += suffix;
      out.push(enhanced);
    } else {
      out.push(line);
    }
  }
  const tree = out.join('\n') || '(empty)';
  return { snapshot: options.compact === true ? compactTree(tree) : tree, refs };
}

export function getRoleSnapshotStats(snapshot: string, refs: RoleRefs) {
  const interactive = Object.values(refs).filter((r) => INTERACTIVE_ROLES.has(r.role)).length;
  return {
    lines: snapshot.split('\n').length,
    chars: snapshot.length,
    refs: Object.keys(refs).length,
    interactive,
  };
}
