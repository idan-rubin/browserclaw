import type { CDPSession, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import type { AXNode } from './native-tree.js';
import {
  isSensitiveFieldDescriptor,
  redactAiSnapshotFieldValues,
  redactSensitiveAXNodeValues,
  takeRedactedAiSnapshotText,
} from './sensitive-field-values.js';

describe('isSensitiveFieldDescriptor', () => {
  it.each([
    [{ tagName: 'INPUT', type: 'PASSWORD', autocomplete: null }, true],
    [{ tagName: 'INPUT', type: 'text', autocomplete: 'section-pay CC-NUMBER' }, true],
    [{ tagName: 'TEXTAREA', type: null, autocomplete: 'one-time-code' }, true],
    [{ tagName: 'INPUT', type: 'text', autocomplete: 'cc-name' }, false],
    [{ tagName: 'DIV', type: 'password', autocomplete: null }, false],
  ])('%o -> %s', (field, sensitive) => {
    expect(isSensitiveFieldDescriptor(field)).toBe(sensitive);
  });
});

describe('redactAiSnapshotFieldValues', () => {
  const snapshot = [
    '- generic [ref=e1]:',
    '  - textbox "Password" [ref=e2]: hunter2',
    '  - textbox "Card" [ref=e3]:',
    '    - /placeholder: Card number',
    '    - text: 4111 1111',
    '  - textbox "City" [ref=e4]: Lisbon',
    '  - textbox "Unbound": orphan-value',
    '  - button "Save" [ref=e5]: Save: now',
  ].join('\n');

  it('masks inline and nested values of sensitive fields and of fields without a ref', async () => {
    const isSensitive = vi.fn((ref: string) => Promise.resolve(ref !== 'e4'));
    const redacted = await redactAiSnapshotFieldValues(snapshot, isSensitive);
    expect(redacted.split('\n')).toEqual([
      '- generic [ref=e1]:',
      '  - textbox "Password" [ref=e2]: [redacted]',
      '  - textbox "Card" [ref=e3]:',
      '    - /placeholder: Card number',
      '    - text: [redacted]',
      '  - textbox "City" [ref=e4]: Lisbon',
      '  - textbox "Unbound": [redacted]',
      '  - button "Save" [ref=e5]: Save: now',
    ]);
    expect(isSensitive.mock.calls.map(([ref]) => ref).sort()).toEqual(['e2', 'e3', 'e4']);
  });

  it('control: leaves every value in place when no field is sensitive', async () => {
    const redacted = await redactAiSnapshotFieldValues(snapshot, () => Promise.resolve(false));
    expect(redacted).toBe(snapshot.replace('orphan-value', '[redacted]'));
  });
});

describe('takeRedactedAiSnapshotText', () => {
  const snapshot = '- textbox "Password" [ref=e2]: hunter2\n- textbox "City" [ref=e4]: Lisbon';
  const pageAnswering = (ordinary: (selector: string) => Promise<number>, present = 1): Page =>
    ({
      ariaSnapshot: () => Promise.resolve(snapshot),
      locator: (selector: string) => ({
        count: () => Promise.resolve(present),
        and: () => ({ count: () => ordinary(selector) }),
      }),
    }) as unknown as Page;

  it('keeps only a field positively identified as ordinary', async () => {
    const page = pageAnswering((selector) => Promise.resolve(selector === 'aria-ref=e4' ? 1 : 0));
    expect(await takeRedactedAiSnapshotText(page, 1000)).toBe(
      '- textbox "Password" [ref=e2]: [redacted]\n- textbox "City" [ref=e4]: Lisbon',
    );
  });

  it('masks a field that was present a moment ago and is gone when it is classified', async () => {
    const page = pageAnswering(() => Promise.resolve(0), 1);
    expect(await takeRedactedAiSnapshotText(page, 1000)).toBe(
      '- textbox "Password" [ref=e2]: [redacted]\n- textbox "City" [ref=e4]: [redacted]',
    );
  });

  it.each([
    ['resolves to no element', (): Promise<number> => Promise.resolve(0)],
    ['fails', (): Promise<number> => Promise.reject(new Error('Execution context was destroyed'))],
    ['does not answer in time', (): Promise<number> => new Promise<number>(() => undefined)],
  ])('masks every value when the check %s', async (_name, count) => {
    expect(await takeRedactedAiSnapshotText(pageAnswering(count), 50)).toBe(
      '- textbox "Password" [ref=e2]: [redacted]\n- textbox "City" [ref=e4]: [redacted]',
    );
  });
});

describe('redactSensitiveAXNodeValues', () => {
  const tree = (): AXNode[] => [
    { nodeId: '1', childIds: ['2', '4', '6'], role: { value: 'RootWebArea' }, name: { value: 'Checkout' } },
    {
      nodeId: '2',
      childIds: ['3'],
      backendDOMNodeId: 20,
      role: { value: 'textbox' },
      name: { value: 'Code' },
      value: { value: '246810' },
    },
    { nodeId: '3', role: { value: 'StaticText' }, name: { value: '246810' } },
    {
      nodeId: '4',
      childIds: ['5'],
      backendDOMNodeId: 40,
      role: { value: 'textbox' },
      name: { value: 'City' },
      value: { value: 'Lisbon' },
    },
    { nodeId: '5', role: { value: 'StaticText' }, name: { value: 'Lisbon' } },
    {
      nodeId: '6',
      backendDOMNodeId: 60,
      role: { value: 'spinbutton' },
      name: { value: 'CVC' },
      value: { value: '737' },
    },
  ];
  const session = (describe: (backendNodeId: number) => Promise<unknown>) =>
    ({
      send: vi.fn((_method: string, params: { backendNodeId: number }) => describe(params.backendNodeId)),
    }) as unknown as CDPSession;

  it('masks a sensitive field with its text descendants, and a field that cannot be described', async () => {
    const nodes = tree();
    await redactSensitiveAXNodeValues(
      session((backendNodeId) => {
        if (backendNodeId === 60) return Promise.reject(new Error('node is gone'));
        return Promise.resolve({
          node: {
            nodeName: 'INPUT',
            attributes: ['type', 'text', 'AutoComplete', backendNodeId === 20 ? 'one-time-code' : 'address-level2'],
          },
        });
      }),
      nodes,
    );
    expect(nodes.map((node) => [node.name?.value, node.value?.value])).toEqual([
      ['Checkout', undefined],
      ['Code', '[redacted]'],
      ['[redacted]', undefined],
      ['City', 'Lisbon'],
      ['Lisbon', undefined],
      ['CVC', '[redacted]'],
    ]);
  });

  it('control: leaves ordinary described fields untouched', async () => {
    const nodes = tree();
    await redactSensitiveAXNodeValues(
      session(() => Promise.resolve({ node: { nodeName: 'INPUT', attributes: ['type', 'text'] } })),
      nodes,
    );
    expect(nodes).toEqual(tree());
  });
});
