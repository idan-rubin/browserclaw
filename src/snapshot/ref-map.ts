import type { RoleRefInfo, RoleRefs } from '../types.js';

function parseStateFromSuffix(suffix: string): Pick<RoleRefInfo, 'disabled' | 'checked'> {
  const state: Pick<RoleRefInfo, 'disabled' | 'checked'> = {};
  if (/\[disabled\]/i.test(suffix)) state.disabled = true;
  if (/\[checked\s*=\s*"?mixed"?\]/i.test(suffix)) state.checked = 'mixed';
  else if (/\[checked\]/i.test(suffix)) state.checked = true;
  return state;
}

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
  prefix: string;
  roleRaw: string;
  role: string;
  name?: string;
  ref?: string;
  suffix: string;
}

// Only formatter-owned attributes immediately after the role/name contain refs.
// Page text, escaped names, and YAML-quoted entries must not manufacture refs.
export function parseSnapshotLine(line: string): ParsedSnapshotLine | null {
  const entry = /^(\s*-\s+)(.*)$/s.exec(line);
  if (!entry) return null;
  const prefix = entry[1];
  const content = entry[2];
  const quoted = /^'((?:[^']|'')*)'(.*)$/s.exec(content);
  const match = /^(\w+)(?:\s+("(?:\\.|[^"\\])*"))?(.*)$/s.exec(quoted ? quoted[1].replaceAll("''", "'") : content);
  if (!match) return null;
  const roleRaw = match[1];
  let nameToken = match[2] as string | undefined;
  let suffix = match[3];
  if (nameToken === undefined && suffix.startsWith(' /')) {
    const literal = /^ (\/(?:.*\/)?)/s.exec(quoted ? suffix : suffix.split(/:(?=\s|$)/, 1)[0]);
    if (literal) {
      nameToken = literal[1];
      suffix = suffix.slice(literal[0].length);
    }
  }
  const attributes = /^(?:\s+\[[^\][]*\])*/.exec(suffix)?.[0];
  const ref = attributes !== undefined && attributes !== '' ? /\[ref=([^\][]+)\]/.exec(attributes)?.[1] : undefined;
  const name = nameToken?.startsWith('"') === true ? (JSON.parse(nameToken) as string) : nameToken;
  return {
    prefix,
    roleRaw,
    role: roleRaw.toLowerCase(),
    ...(name !== undefined && name !== '' ? { name } : {}),
    ...(ref !== undefined && ref !== '' ? { ref } : {}),
    suffix: suffix + (quoted?.[2] ?? ''),
  };
}

function matchInteractiveSnapshotLine(line: string, options: SnapshotBuildOptions): ParsedSnapshotLine | null {
  if (options.maxDepth !== undefined && getIndentLevel(line) > options.maxDepth) return null;
  return parseSnapshotLine(line);
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

interface CompactTreeEntry {
  line: string;
  keep: boolean;
  hasRef: boolean;
  indent: number;
}

function compactTree(tree: string): string {
  const lines = tree.split('\n');
  const entries: CompactTreeEntry[] = [];
  const stack: { entry: CompactTreeEntry; indent: number }[] = [];
  const finishEntry = (): void => {
    const current = stack.pop();
    if (!current) return;
    current.entry.keep ||= current.entry.hasRef;
    if (current.entry.hasRef && stack.length > 0) stack[stack.length - 1].entry.hasRef = true;
  };
  for (const line of lines) {
    const indent = getIndentLevel(line);
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) finishEntry();
    const entry: CompactTreeEntry = {
      line,
      keep: Boolean(parseSnapshotLine(line)?.ref) || (line.includes(':') && !line.trimEnd().endsWith(':')),
      hasRef: Boolean(parseSnapshotLine(line)?.ref),
      indent,
    };
    entries.push(entry);
    stack.push({ entry, indent });
  }
  while (stack.length > 0) finishEntry();
  return (
    entries
      .filter((entry) => entry.keep)
      .map((entry) => entry.line)
      .join('\n') || '(empty)'
  );
}

export interface SnapshotBuildOptions {
  interactive?: boolean;
  compact?: boolean;
  maxDepth?: number;
}

/**
 * Build a role snapshot from Playwright's ariaSnapshot() output.
 * Assigns ref IDs (e1, e2, ...) to interactive/content elements.
 *
 * Shadow DOM elements may produce duplicate role+name pairs because Playwright
 * flattens shadow trees into the aria snapshot. The `nth` index and duplicate
 * tracking ensure each element gets a unique locator even when names collide.
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
      const { prefix, roleRaw, role, name, suffix } = parsed;
      if (!INTERACTIVE_ROLES.has(role)) continue;
      const ref = nextRef();
      const nth = tracker.getNextIndex(role, name);
      tracker.trackRef(role, name, ref);
      const state = parseStateFromSuffix(suffix);
      refs[ref] = { role, name, nth, ...state };
      let enhanced = `${prefix}${roleRaw}`;
      if (name !== undefined && name !== '') enhanced += ` ${JSON.stringify(name)}`;
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
    const parsed = parseSnapshotLine(line);
    if (!parsed) {
      result.push(line);
      continue;
    }
    const { prefix, roleRaw, role, name, suffix } = parsed;
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const isContent = CONTENT_ROLES.has(role);
    const isStructural = STRUCTURAL_ROLES.has(role);
    if (options.compact === true && isStructural && (name === undefined || name === '')) continue;
    if (!(isInteractive || (isContent && name !== undefined && name !== ''))) {
      result.push(line);
      continue;
    }

    const ref = nextRef();
    const nth = tracker.getNextIndex(role, name);
    tracker.trackRef(role, name, ref);
    const state = parseStateFromSuffix(suffix);
    refs[ref] = { role, name, nth, ...state };

    let enhanced = `${prefix}${roleRaw}`;
    if (name !== undefined && name !== '') enhanced += ` ${JSON.stringify(name)}`;
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
 *
 * Does not parse the `selector` field used by DOM-enriched refs — enriched
 * refs must be merged in by the caller (see `mergeSnapshotWithEnrichment`).
 * Feeding an already-enriched snapshot string back through this parser will
 * silently drop those selectors.
 */
export function buildRoleSnapshotFromAiSnapshot(
  aiSnapshot: string,
  options: SnapshotBuildOptions = {},
): { snapshot: string; refs: RoleRefs } {
  const lines = aiSnapshot.split('\n');
  const refs: RoleRefs = {};

  function parseAiSnapshotRef(ref: string | undefined): string | null {
    return ref !== undefined && /^(?:f\d+)?e\d+$|^\d{1,9}$/i.test(ref) ? ref : null;
  }

  if (options.interactive === true) {
    let interactiveMaxRef = 0;
    for (const line of lines) {
      const refMatch = /^e(\d+)$/.exec(parseSnapshotLine(line)?.ref ?? '');
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
      const { prefix, roleRaw, role, name, suffix } = parsed;
      if (!INTERACTIVE_ROLES.has(role)) continue;
      const ref = parseAiSnapshotRef(parsed.ref);
      const state = parseStateFromSuffix(suffix);
      if (ref !== null) {
        refs[ref] = { role, ...(name !== undefined && name !== '' ? { name } : {}), ...state };
        out.push(`${prefix}${roleRaw}${name !== undefined && name !== '' ? ` ${JSON.stringify(name)}` : ''}${suffix}`);
      } else {
        const generatedRef = nextInteractiveRef();
        refs[generatedRef] = { role, ...(name !== undefined && name !== '' ? { name } : {}), ...state };
        let enhanced = `${prefix}${roleRaw}`;
        if (name !== undefined && name !== '') enhanced += ` ${JSON.stringify(name)}`;
        enhanced += ` [ref=${generatedRef}]`;
        if (suffix.trim() !== '') enhanced += suffix;
        out.push(enhanced);
      }
    }
    return { snapshot: out.join('\n') || '(no interactive elements)', refs };
  }

  let maxRef = 0;
  for (const line of lines) {
    const refMatch = /^e(\d+)$/.exec(parseSnapshotLine(line)?.ref ?? '');
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
    const parsed = parseSnapshotLine(line);
    if (!parsed) {
      out.push(line);
      continue;
    }
    const { prefix, roleRaw, role, name, suffix } = parsed;
    const isStructural = STRUCTURAL_ROLES.has(role);
    if (options.compact === true && isStructural && (name === undefined || name === '')) continue;
    const ref = parseAiSnapshotRef(parsed.ref);
    const state = parseStateFromSuffix(suffix);
    if (ref !== null) {
      refs[ref] = { role, ...(name !== undefined && name !== '' ? { name } : {}), ...state };
      out.push(line);
    } else if (INTERACTIVE_ROLES.has(role)) {
      const generatedRef = nextGeneratedRef();
      refs[generatedRef] = { role, ...(name !== undefined && name !== '' ? { name } : {}), ...state };
      let enhanced = `${prefix}${roleRaw}`;
      if (name !== undefined && name !== '') enhanced += ` ${JSON.stringify(name)}`;
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
