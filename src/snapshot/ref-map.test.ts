import { describe, it, expect } from 'vitest';

import { buildRoleSnapshotFromAriaSnapshot, buildRoleSnapshotFromAiSnapshot } from './ref-map.js';

describe('formatter-owned snapshot refs and quoted names', () => {
  it.each([buildRoleSnapshotFromAriaSnapshot, buildRoleSnapshotFromAiSnapshot])(
    'keeps an explicit empty marker after compact filtering',
    (buildSnapshot) => {
      for (const source of ['', '- generic', '- text "No controls"']) {
        expect(buildSnapshot(source, { compact: true })).toEqual({ snapshot: '(empty)', refs: {} });
      }
      const control = buildSnapshot('- button "Save"', { compact: true });
      expect(control.snapshot).toBe('- button "Save" [ref=e1]');
      expect(control.refs.e1).toMatchObject({ role: 'button', name: 'Save' });
    },
  );

  it.each([false, true])('preserves escaped and YAML-quoted names (interactive=%s)', (interactive) => {
    const source = [
      '- button "Say \\"hi\\"" [ref=e1]',
      "- 'button \"It''s ready\" [ref=e2]':",
      '- button / [ref=e3]',
    ].join('\n');
    const result = buildRoleSnapshotFromAiSnapshot(source, { interactive });
    expect(result.refs.e1.name).toBe('Say "hi"');
    expect(result.refs.e2.name).toBe("It's ready");
    expect(result.refs.e3.name).toBe('/');
  });

  it('does not read ref-like page text or quoted names as formatter attributes', () => {
    const result = buildRoleSnapshotFromAiSnapshot(
      '- generic: "page text [ref=e999]"\n- button "[ref=e888]"\n- button "Real" [ref=e4]',
    );
    expect(result.refs.e999).toBeUndefined();
    expect(result.refs.e888).toBeUndefined();
    expect(result.refs.e4.name).toBe('Real');
    expect(result.refs.e5.name).toBe('[ref=e888]');
    expect(Object.keys(result.refs)).toEqual(['e5', 'e4']);
  });

  it('preserves native frame-prefixed and numeric refs instead of generating replacements', () => {
    const result = buildRoleSnapshotFromAiSnapshot('- button "Frame" [ref=f2e7]\n- link "Native" [ref=123]');
    expect(Object.keys(result.refs)).toEqual(['123', 'f2e7']);
    expect(result.snapshot).not.toContain('[ref=e1]');
  });

  it('decodes names before duplicate tracking in role snapshots', () => {
    const result = buildRoleSnapshotFromAriaSnapshot('- button "Say \\"hi\\""\n- button "Say \\"hi\\""');
    expect(result.refs.e1.name).toBe('Say "hi"');
    expect(result.refs.e2.nth).toBe(1);
    expect(result.snapshot).toContain('"Say \\"hi\\""');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRoleSnapshotFromAriaSnapshot
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRoleSnapshotFromAriaSnapshot', () => {
  describe('undefined name handling (regression: "undefined" text injection)', () => {
    it('does not emit "undefined" text for a nameless interactive element', () => {
      // A button with no quoted label — regex group 3 is undefined, not ''
      const input = '- button';
      const { snapshot } = buildRoleSnapshotFromAriaSnapshot(input);
      expect(snapshot).not.toContain('"undefined"');
      expect(snapshot).toContain('[ref=');
    });

    it('does not emit "undefined" text for a nameless content element', () => {
      const input = '- heading';
      const { snapshot } = buildRoleSnapshotFromAriaSnapshot(input);
      expect(snapshot).not.toContain('"undefined"');
    });

    it('correctly includes name when one is present', () => {
      const input = '- button "Submit"';
      const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(input);
      expect(snapshot).toContain('"Submit"');
      expect(Object.values(refs)[0].name).toBe('Submit');
    });

    it('stores undefined (not the string "undefined") in refs for nameless elements', () => {
      const input = '- button';
      const { refs } = buildRoleSnapshotFromAriaSnapshot(input);
      const ref = Object.values(refs)[0];
      expect(ref).toBeDefined();
      // name should be undefined (absent), not the string "undefined"
      expect(ref.name).toBeUndefined();
      expect(ref.name).not.toBe('undefined');
    });
  });

  describe('compact mode with undefined names', () => {
    it('filters structural elements with undefined names in compact mode', () => {
      // generic/group with no name should be dropped in compact mode
      const input = ['- generic', '  - button "Click"'].join('\n');
      const { snapshot } = buildRoleSnapshotFromAriaSnapshot(input, { compact: true });
      expect(snapshot).not.toContain('generic');
      expect(snapshot).toContain('"Click"');
    });

    it('keeps structural elements that have a name in compact mode', () => {
      const input = ['- region "Main content"', '  - button "Go"'].join('\n');
      const { snapshot } = buildRoleSnapshotFromAriaSnapshot(input, { compact: true });
      expect(snapshot).toContain('"Main content"');
    });
  });

  describe('basic ref generation', () => {
    it('assigns sequential refs to interactive elements', () => {
      const input = ['- button "A"', '- button "B"', '- link "C"'].join('\n');
      const { refs } = buildRoleSnapshotFromAriaSnapshot(input);
      expect(Object.keys(refs)).toHaveLength(3);
      expect(refs.e1.role).toBe('button');
      expect(refs.e2.role).toBe('button');
      expect(refs.e3.role).toBe('link');
    });

    it('assigns nth only to duplicate role+name combinations', () => {
      const input = ['- button "Save"', '- button "Save"', '- button "Cancel"'].join('\n');
      const { refs } = buildRoleSnapshotFromAriaSnapshot(input);
      // The two "Save" buttons should have nth; the unique "Cancel" should not
      expect(refs.e1.nth).toBe(0);
      expect(refs.e2.nth).toBe(1);
      expect(refs.e3.nth).toBeUndefined();
    });

    it('interactive-only mode returns only interactive elements', () => {
      const input = ['- heading "Title"', '- button "Go"', '- paragraph "Text"'].join('\n');
      const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot(input, { interactive: true });
      expect(Object.keys(refs)).toHaveLength(1);
      expect(refs.e1.role).toBe('button');
      expect(snapshot).not.toContain('heading');
      expect(snapshot).not.toContain('paragraph');
    });

    it('returns (empty) for empty input', () => {
      const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot('');
      expect(snapshot).toBe('(empty)');
      expect(Object.keys(refs)).toHaveLength(0);
    });

    it('returns (no interactive elements) for interactive mode with no matches', () => {
      const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot('- heading "Only"', {
        interactive: true,
      });
      expect(snapshot).toBe('(no interactive elements)');
      expect(Object.keys(refs)).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildRoleSnapshotFromAiSnapshot
// ─────────────────────────────────────────────────────────────────────────────

describe('buildRoleSnapshotFromAiSnapshot', () => {
  describe('undefined name handling (regression: "undefined" text injection)', () => {
    it('does not emit "undefined" text for a nameless interactive element without ref', () => {
      // No ref in suffix → falls into the generated-ref branch
      const input = '- button';
      const { snapshot } = buildRoleSnapshotFromAiSnapshot(input);
      expect(snapshot).not.toContain('"undefined"');
    });

    it('does not store name:"undefined" in refs for nameless generated-ref elements', () => {
      const input = '- button';
      const { refs } = buildRoleSnapshotFromAiSnapshot(input);
      const ref = Object.values(refs)[0];
      expect(ref).toBeDefined();
      expect(ref.name).toBeUndefined();
      expect(ref.name).not.toBe('undefined');
    });

    it('correctly includes name when present in generated-ref path', () => {
      const input = '- button "Submit"';
      const { snapshot, refs } = buildRoleSnapshotFromAiSnapshot(input);
      expect(snapshot).toContain('"Submit"');
      expect(Object.values(refs)[0].name).toBe('Submit');
    });

    it('preserves existing aria refs and does not emit "undefined" for nameless elements with ref', () => {
      const input = '- button [ref=e5]';
      const { snapshot, refs } = buildRoleSnapshotFromAiSnapshot(input);
      expect(snapshot).not.toContain('"undefined"');
      expect(refs.e5).toBeDefined();
      expect(refs.e5.name).toBeUndefined();
    });
  });

  describe('compact mode with undefined names', () => {
    it('filters structural elements with undefined names in compact mode', () => {
      const input = ['- group', '  - button "Click"'].join('\n');
      const { snapshot } = buildRoleSnapshotFromAiSnapshot(input, { compact: true });
      expect(snapshot).not.toMatch(/^- group$/m);
      expect(snapshot).toContain('"Click"');
    });
  });

  describe('ref preservation', () => {
    it('preserves existing ref IDs from the AI snapshot', () => {
      const input = '- button "Go" [ref=e42]';
      const { refs } = buildRoleSnapshotFromAiSnapshot(input);
      expect(refs.e42).toBeDefined();
      expect(refs.e42.role).toBe('button');
      expect(refs.e42.name).toBe('Go');
    });

    it('generates refs for interactive elements that lack one', () => {
      const input = ['- button "A" [ref=e10]', '- button "B"'].join('\n');
      const { refs } = buildRoleSnapshotFromAiSnapshot(input);
      expect(refs.e10).toBeDefined();
      // Generated ref should be e11 (max existing + 1)
      expect(refs.e11).toBeDefined();
      expect(refs.e11.name).toBe('B');
    });

    it('does not store an undefined name for a ref line with no accessible name', () => {
      const { refs } = buildRoleSnapshotFromAiSnapshot('- button [ref=e5]');
      expect(refs.e5).toBeDefined();
      expect('name' in refs.e5).toBe(false);
    });
  });
});

describe('unnamed content/landmark roles do not get refs', () => {
  it('assigns no ref to an unnamed landmark role', () => {
    const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot('- navigation');
    expect(snapshot).not.toContain('[ref=');
    expect(Object.keys(refs)).toHaveLength(0);
  });

  it('assigns a ref to a named landmark role', () => {
    const { refs } = buildRoleSnapshotFromAriaSnapshot('- navigation "Primary"');
    expect(Object.values(refs).some((r) => r.role === 'navigation' && r.name === 'Primary')).toBe(true);
  });
});
