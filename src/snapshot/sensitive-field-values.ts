// Ported from OpenClaw 2026.11.6: sensitive-field-values.ts, pw-role-snapshot.ts redactAiSnapshotFieldValues.
import type { CDPSession, Page } from 'playwright-core';

import { takeAiSnapshotText } from '../connection.js';

import { axValue, type AXNode } from './native-tree.js';
import { getIndentLevel, parseAiSnapshotRef, parseSnapshotLine } from './ref-map.js';

export const REDACTED_FIELD_VALUE = '[redacted]';

const VALUE_FIELD_ROLES = new Set(['combobox', 'searchbox', 'spinbutton', 'textbox']);

const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
  'cc-csc',
  'cc-number',
  'current-password',
  'new-password',
  'one-time-code',
]);

interface FieldDescriptor {
  tagName: string;
  type?: string | null;
  autocomplete?: string | null;
}

export function isSensitiveFieldDescriptor(field: FieldDescriptor): boolean {
  if (field.tagName.toLowerCase() === 'input' && field.type?.toLowerCase() === 'password') return true;
  return (field.autocomplete ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token));
}

async function describeFieldViaCdp(session: CDPSession, backendNodeId: number): Promise<FieldDescriptor | null> {
  const described = await session.send('DOM.describeNode', { backendNodeId }).catch(() => null);
  if (described === null || described.node.nodeName === '') return null;
  const attributes = described.node.attributes ?? [];
  const attribute = (name: string): string | undefined => {
    for (let i = 0; i + 1 < attributes.length; i += 2)
      if (attributes[i].toLowerCase() === name) return attributes[i + 1];
    return undefined;
  };
  return { tagName: described.node.nodeName, type: attribute('type'), autocomplete: attribute('autocomplete') };
}

export async function redactSensitiveAXNodeValues(session: CDPSession, nodes: AXNode[]): Promise<void> {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const redact = (field: AXNode): void => {
    const pending = [field];
    const seen = new Set<AXNode>();
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (seen.has(node)) continue;
      seen.add(node);
      if (axValue(node.value)) node.value = { value: REDACTED_FIELD_VALUE };
      if (node !== field && axValue(node.name)) node.name = { value: REDACTED_FIELD_VALUE };
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) pending.push(child);
      }
    }
  };
  // A select with nothing selected has no value and still prints its options.
  const printsContent = (field: AXNode): boolean => {
    const pending = [...(field.childIds ?? [])];
    const seen = new Set<string>();
    for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
      const node = seen.has(id) ? undefined : byId.get(id);
      seen.add(id);
      if (!node) continue;
      if (axValue(node.name) !== '' || axValue(node.value) !== '') return true;
      pending.push(...(node.childIds ?? []));
    }
    return false;
  };
  await Promise.all(
    nodes
      .filter(
        (node) =>
          VALUE_FIELD_ROLES.has(axValue(node.role).toLowerCase()) &&
          (axValue(node.value) !== '' || printsContent(node)),
      )
      .map(async (node) => {
        const field =
          node.backendDOMNodeId !== undefined && node.backendDOMNodeId > 0
            ? await describeFieldViaCdp(session, node.backendDOMNodeId)
            : null;
        if (!field || isSensitiveFieldDescriptor(field)) redact(node);
      }),
  );
}

// A capture scoped to an element inside a field does not contain the field, so it is looked for above the root.
export async function redactAXNodesInsideSensitiveField(
  session: CDPSession,
  nodes: AXNode[],
  rootBackendNodeId: number,
): Promise<void> {
  const chain = await session.send('Accessibility.getAXNodeAndAncestors', { backendNodeId: rootBackendNodeId });
  const enclosing = chain.nodes.filter(
    (node) => node.backendDOMNodeId !== rootBackendNodeId && VALUE_FIELD_ROLES.has(axValue(node.role).toLowerCase()),
  );
  const sensitive = await Promise.all(
    enclosing.map(async (node) => {
      const field =
        node.backendDOMNodeId !== undefined && node.backendDOMNodeId > 0
          ? await describeFieldViaCdp(session, node.backendDOMNodeId)
          : null;
      return !field || isSensitiveFieldDescriptor(field);
    }),
  );
  if (!sensitive.includes(true)) return;
  for (const node of nodes) {
    if (axValue(node.value)) node.value = { value: REDACTED_FIELD_VALUE };
    if (axValue(node.name)) node.name = { value: REDACTED_FIELD_VALUE };
  }
}

const SNAPSHOT_PROPERTY_LINE = /^(\s*-\s+\/\w+:)\s+\S.*$/s;

function snapshotLineText(line: string): { rest: string; inline: boolean; named: boolean } | null {
  const parsed = parseSnapshotLine(line);
  if (!parsed) return null;
  const attributes = /^(?:\s+\[[^\][]*\])*/.exec(parsed.suffix)?.[0] ?? '';
  const rest = parsed.suffix.slice(attributes.length);
  return { rest, inline: /^: \S/.test(rest) && line.endsWith(rest), named: parsed.name !== undefined };
}

// The parser owns the name's boundaries: Playwright prints some names between slashes instead of quotes.
function withRedactedName(line: string): string {
  const parsed = parseSnapshotLine(line);
  return parsed?.name === undefined
    ? line
    : `${parsed.prefix}${parsed.roleRaw} "${REDACTED_FIELD_VALUE}"${parsed.suffix}`;
}

export async function redactAiSnapshotFieldValues(
  aiSnapshot: string,
  isSensitive: (ref: string) => Promise<boolean>,
): Promise<string> {
  const lines = aiSnapshot.split('\n');
  const fields: { ref: string | null; own: number[]; nested: number[] }[] = [];
  for (const [index, line] of lines.entries()) {
    const parsed = parseSnapshotLine(line);
    if (!parsed || !VALUE_FIELD_ROLES.has(parsed.role)) continue;
    const text = snapshotLineText(line);
    const own = text?.inline === true ? [index] : [];
    const nested: number[] = [];
    if (text?.rest === ':') {
      // A field prints its content as descendants of any role: an editable box its text, a select its options.
      const childDepth = getIndentLevel(line) + 1;
      for (let i = index + 1; i < lines.length && getIndentLevel(lines[i]) >= childDepth; i += 1) {
        const child = snapshotLineText(lines[i]);
        // A property one level down is the field's own (its placeholder); deeper ones belong to its content.
        const property = getIndentLevel(lines[i]) > childDepth && SNAPSHOT_PROPERTY_LINE.test(lines[i]);
        if (child?.inline === true || child?.named === true || property) nested.push(i);
      }
    }
    if (own.length + nested.length > 0) fields.push({ ref: parseAiSnapshotRef(parsed.ref), own, nested });
  }
  const values = new Set<number>();
  const names = new Set<number>();
  await Promise.all(
    fields.map(async ({ ref, own, nested }) => {
      if (ref !== null && !(await isSensitive(ref))) return;
      for (const index of [...own, ...nested]) values.add(index);
      for (const index of nested) names.add(index);
    }),
  );
  for (const index of values) {
    let line = names.has(index) ? withRedactedName(lines[index]) : lines[index];
    const text = snapshotLineText(line);
    if (text?.inline === true) line = `${line.slice(0, line.length - text.rest.length + 2)}${REDACTED_FIELD_VALUE}`;
    else if (text === null) line = line.replace(SNAPSHOT_PROPERTY_LINE, `$1 ${REDACTED_FIELD_VALUE}`);
    lines[index] = line;
  }
  return lines.join('\n');
}

// Selectors are matched outside the page's JavaScript world, so page code cannot change the answer.
export const ORDINARY_FIELD_SELECTOR = `:not(${[
  'input[type="password" i]',
  ...[...SENSITIVE_AUTOCOMPLETE_TOKENS].map((token) => `[autocomplete~="${token}" i]`),
].join(', ')})`;

export async function takeRedactedAiSnapshotText(page: Page, timeoutMs: number): Promise<string> {
  const deadline = performance.now() + timeoutMs;
  let warned = false;
  return await redactAiSnapshotFieldValues(await takeAiSnapshotText(page, timeoutMs), async (ref) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ordinary = await Promise.race([
        // Scoped to the referenced element; intersecting with a page-wide locator rescans the document per field.
        page.locator(`aria-ref=${ref}`).locator(`:scope${ORDINARY_FIELD_SELECTOR}`).count(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              reject(new Error('Sensitive field check timed out'));
            },
            Math.max(1, Math.ceil(deadline - performance.now())),
          );
        }),
      ]);
      return ordinary !== 1;
    } catch (error) {
      if (!warned)
        console.warn(
          `[browserclaw] masked a field value that could not be checked (${error instanceof Error ? error.message.split('\n', 1)[0] : 'error'})`,
        );
      warned = true;
      return true;
    } finally {
      clearTimeout(timer);
    }
  });
}
