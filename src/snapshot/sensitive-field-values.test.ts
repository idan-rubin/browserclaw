import type { CDPSession, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import type { AXNode } from './native-tree.js';
import {
  isSensitiveFieldDescriptor,
  redactAiSnapshotFieldValues,
  redactAXNodesInsideSensitiveField,
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

  it('masks the text and names a sensitive field prints as descendants, at any depth', async () => {
    const rich = [
      '- textbox "Code" [ref=e2]:',
      '  - paragraph [ref=e3]: 246810',
      '  - list [ref=e4]:',
      '    - listitem [ref=e5]:',
      '      - text: 246',
      '      - link "810" [ref=e6]:',
      '        - /url: https://example.test/',
      '  - \'paragraph [ref=e7]\': "code: 246810"',
      '- textbox "Notes" [ref=e8]:',
      '  - paragraph [ref=e9]: Lisbon',
      '- combobox "Plan" [ref=e10]:',
      '  - option "Monthly" [selected]',
      '- combobox "Card" [ref=e13]:',
      '  - option "1111" [ref=e14]',
      '  - option "4242" [ref=e15] [selected]',
      '- combobox "Unbound":',
      '  - option "Visa" [selected]',
      '- textbox "Unbound":',
      '  - paragraph: orphan',
      '  - link "orphan" [ref=e12]',
      '- button "246810" [ref=e11]',
    ].join('\n');
    const isSensitive = vi.fn((ref: string) => Promise.resolve(ref === 'e2' || ref === 'e13'));
    expect((await redactAiSnapshotFieldValues(rich, isSensitive)).split('\n')).toEqual([
      '- textbox "Code" [ref=e2]:',
      '  - paragraph [ref=e3]: [redacted]',
      '  - list [ref=e4]:',
      '    - listitem [ref=e5]:',
      '      - text: [redacted]',
      '      - link "[redacted]" [ref=e6]:',
      '        - /url: [redacted]',
      "  - 'paragraph [ref=e7]': [redacted]",
      '- textbox "Notes" [ref=e8]:',
      '  - paragraph [ref=e9]: Lisbon',
      '- combobox "Plan" [ref=e10]:',
      '  - option "Monthly" [selected]',
      '- combobox "Card" [ref=e13]:',
      '  - option "[redacted]" [ref=e14]',
      '  - option "[redacted]" [ref=e15] [selected]',
      '- combobox "Unbound":',
      '  - option "[redacted]" [selected]',
      '- textbox "Unbound":',
      '  - paragraph: [redacted]',
      '  - link "[redacted]" [ref=e12]',
      '- button "246810" [ref=e11]',
    ]);
    expect(isSensitive.mock.calls.map(([ref]) => ref)).toEqual(['e2', 'e8', 'e10', 'e13']);
  });

  it('masks a name printed between slashes and the address of a link inside a sensitive field', async () => {
    const printed = [
      '- combobox "Card" [ref=e1]:',
      '  - option /Documents/ [ref=e2]',
      "  - 'option /a: b/ [ref=e3] [selected]'",
      '- textbox "Code" [ref=e4]:',
      '  - /placeholder: 6 digits',
      '  - heading /246810/ [level=2] [ref=e5]',
      '  - link /246810/ [ref=e6]:',
      '    - /url: https://example.test/reset?token=246810',
      '- combobox "Folder" [ref=e7]:',
      '  - option /Public/ [ref=e8]',
      '- textbox "Site" [ref=e9]:',
      '  - link "docs" [ref=e10]:',
      '    - /url: https://example.test/docs',
    ].join('\n');
    const isSensitive = vi.fn((ref: string) => Promise.resolve(ref === 'e1' || ref === 'e4'));
    expect((await redactAiSnapshotFieldValues(printed, isSensitive)).split('\n')).toEqual([
      '- combobox "Card" [ref=e1]:',
      '  - option "[redacted]" [ref=e2]',
      '  - option "[redacted]" [ref=e3] [selected]',
      '- textbox "Code" [ref=e4]:',
      '  - /placeholder: 6 digits',
      '  - heading "[redacted]" [level=2] [ref=e5]',
      '  - link "[redacted]" [ref=e6]:',
      '    - /url: [redacted]',
      '- combobox "Folder" [ref=e7]:',
      '  - option /Public/ [ref=e8]',
      '- textbox "Site" [ref=e9]:',
      '  - link "docs" [ref=e10]:',
      '    - /url: https://example.test/docs',
    ]);
    expect(isSensitive.mock.calls.map(([ref]) => ref)).toEqual(['e1', 'e4', 'e7', 'e9']);
  });

  it('masks the options of a sensitive select shown as a list', async () => {
    const printed = [
      '- listbox "Saved" [ref=e1]:',
      '  - group [ref=e2]:',
      '    - option "4242" [selected] [ref=e3]',
      '  - option "1111" [ref=e4]',
      '- listbox "Plans" [ref=e5]:',
      '  - option "Monthly" [selected] [ref=e6]',
    ].join('\n');
    const isSensitive = vi.fn((ref: string) => Promise.resolve(ref === 'e1'));
    expect((await redactAiSnapshotFieldValues(printed, isSensitive)).split('\n')).toEqual([
      '- listbox "Saved" [ref=e1]:',
      '  - group [ref=e2]:',
      '    - option "[redacted]" [selected] [ref=e3]',
      '  - option "[redacted]" [ref=e4]',
      '- listbox "Plans" [ref=e5]:',
      '  - option "Monthly" [selected] [ref=e6]',
    ]);
    expect(isSensitive.mock.calls.map(([ref]) => ref)).toEqual(['e1', 'e5']);
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
        locator: () => ({ count: () => ordinary(selector) }),
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
    ['resolves to no element', (): Promise<number> => Promise.resolve(0), []],
    [
      'fails',
      (): Promise<number> => Promise.reject(new Error('Execution context was destroyed\nCall log: aria-ref=e2')),
      ['[browserclaw] masked a field value that could not be checked (Execution context was destroyed)'],
    ],
    [
      'does not answer in time',
      (): Promise<number> => new Promise<number>(() => undefined),
      ['[browserclaw] masked a field value that could not be checked (Sensitive field check timed out)'],
    ],
  ])('masks every value when the check %s, and says why once', async (_name, count, warnings) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await takeRedactedAiSnapshotText(pageAnswering(count), 50)).toBe(
      '- textbox "Password" [ref=e2]: [redacted]\n- textbox "City" [ref=e4]: [redacted]',
    );
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual(warnings);
    warn.mockRestore();
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

  it('masks what a sensitive field with no value of its own prints beneath it', async () => {
    const select = (id: number, option: string, role = 'combobox'): AXNode[] => [
      { nodeId: String(id), childIds: [String(id + 1)], backendDOMNodeId: id, role: { value: role } },
      { nodeId: String(id + 1), childIds: [String(id + 2)], role: { value: 'MenuListPopup' } },
      { nodeId: String(id + 2), role: { value: 'option' }, name: { value: option } },
    ];
    const nodes: AXNode[] = [
      ...select(20, 'Visa 4242'),
      ...select(40, 'Monthly'),
      { nodeId: '60', childIds: ['61'], backendDOMNodeId: 60, role: { value: 'textbox' }, name: { value: 'Empty' } },
      { nodeId: '61', role: { value: 'generic' } },
      ...select(80, 'Saved 1111', 'listbox'),
    ];
    const described: number[] = [];
    await redactSensitiveAXNodeValues(
      session((backendNodeId) => {
        described.push(backendNodeId);
        return Promise.resolve({
          node: { nodeName: 'SELECT', attributes: backendNodeId === 40 ? [] : ['autocomplete', 'cc-number'] },
        });
      }),
      nodes,
    );
    expect(nodes.flatMap((node) => node.name?.value ?? [])).toEqual(['[redacted]', 'Monthly', 'Empty', '[redacted]']);
    expect(described.sort()).toEqual([20, 40, 80]);
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

describe('redactAXNodesInsideSensitiveField', () => {
  const captured = (): AXNode[] => [
    { nodeId: '3', childIds: ['4'], backendDOMNodeId: 30, role: { value: 'paragraph' } },
    { nodeId: '4', role: { value: 'StaticText' }, name: { value: '246810' } },
  ];
  const above = (root: AXNode): AXNode[] => [
    root,
    {
      nodeId: '2',
      backendDOMNodeId: 20,
      role: { value: 'textbox' },
      name: { value: 'Code' },
      value: { value: '246810' },
    },
    { nodeId: '1', backendDOMNodeId: 10, role: { value: 'RootWebArea' }, name: { value: 'Checkout' } },
  ];
  const session = (chain: AXNode[], describe: () => Promise<unknown>) =>
    ({
      send: vi.fn((method: string) =>
        method === 'Accessibility.getAXNodeAndAncestors' ? Promise.resolve({ nodes: chain }) : describe(),
      ),
    }) as unknown as CDPSession;
  const field = (autocomplete: string) => () =>
    Promise.resolve({ node: { nodeName: 'DIV', attributes: ['autocomplete', autocomplete] } });

  it.each([
    ['is sensitive', field('one-time-code')],
    ['cannot be described', () => Promise.reject(new Error('node is gone'))],
  ])('masks everything captured below a field that %s', async (_name, describe) => {
    const nodes = captured();
    await redactAXNodesInsideSensitiveField(session(above(nodes[0]), describe), nodes, 30);
    expect(nodes.map((node) => node.name?.value)).toEqual([undefined, '[redacted]']);
  });

  it.each(['combobox', 'listbox'])(
    'masks a capture below a sensitive %s that has no value of its own',
    async (role) => {
      const option: AXNode = {
        nodeId: '3',
        backendDOMNodeId: 30,
        role: { value: 'option' },
        name: { value: 'Visa 4242' },
      };
      const chain: AXNode[] = [option, { nodeId: '2', backendDOMNodeId: 20, role: { value: role } }];
      await redactAXNodesInsideSensitiveField(session(chain, field('cc-number')), [option], 30);
      expect(option.name?.value).toBe('[redacted]');
    },
  );

  it('control: leaves a capture below an ordinary field untouched', async () => {
    const nodes = captured();
    await redactAXNodesInsideSensitiveField(session(above(nodes[0]), field('off')), nodes, 30);
    expect(nodes).toEqual(captured());
  });

  it('control: does not treat the captured root as a field above itself', async () => {
    const root: AXNode = {
      nodeId: '2',
      backendDOMNodeId: 20,
      role: { value: 'textbox' },
      name: { value: 'Code' },
      value: { value: '246810' },
    };
    const describe = vi.fn(field('one-time-code'));
    await redactAXNodesInsideSensitiveField(session([root, above(root)[2]], describe), [root], 20);
    expect(describe).not.toHaveBeenCalled();
    expect(root.name?.value).toBe('Code');
  });
});
