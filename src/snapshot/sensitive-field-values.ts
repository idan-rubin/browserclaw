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
  await Promise.all(
    nodes
      .filter((node) => axValue(node.value) !== '' && VALUE_FIELD_ROLES.has(axValue(node.role).toLowerCase()))
      .map(async (node) => {
        const field =
          node.backendDOMNodeId !== undefined && node.backendDOMNodeId > 0
            ? await describeFieldViaCdp(session, node.backendDOMNodeId)
            : null;
        if (!field || isSensitiveFieldDescriptor(field)) redact(node);
      }),
  );
}

const SNAPSHOT_LINE_NAME = /^(\s*-\s+'?\w+\s+)"(?:\\.|[^"\\])*"/;

function snapshotLineText(line: string): { rest: string; inline: boolean; named: boolean } | null {
  const parsed = parseSnapshotLine(line);
  if (!parsed) return null;
  const attributes = /^(?:\s+\[[^\][]*\])*/.exec(parsed.suffix)?.[0] ?? '';
  const rest = parsed.suffix.slice(attributes.length);
  return {
    rest,
    inline: /^: \S/.test(rest) && line.endsWith(rest),
    // An option's name is a choice the page offers, not what the user entered.
    named: parsed.role !== 'option' && SNAPSHOT_LINE_NAME.test(line),
  };
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
      // An editable field prints its content as descendants of any role, at any depth.
      const childDepth = getIndentLevel(line) + 1;
      for (let i = index + 1; i < lines.length && getIndentLevel(lines[i]) >= childDepth; i += 1) {
        const child = snapshotLineText(lines[i]);
        if (child?.inline === true || child?.named === true) nested.push(i);
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
    let line = lines[index];
    const text = snapshotLineText(line);
    if (text?.inline === true) line = `${line.slice(0, line.length - text.rest.length + 2)}${REDACTED_FIELD_VALUE}`;
    if (names.has(index)) line = line.replace(SNAPSHOT_LINE_NAME, `$1"${REDACTED_FIELD_VALUE}"`);
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
