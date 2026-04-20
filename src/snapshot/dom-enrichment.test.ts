import { describe, it, expect } from 'vitest';

import { buildDomEnrichedLines, nextRefCounter } from './dom-enrichment.js';
import type { DomEnrichedElement } from './dom-enrichment.js';

// ─────────────────────────────────────────────────────────────────────────────
// buildDomEnrichedLines
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDomEnrichedLines', () => {
  describe('empty input', () => {
    it('returns empty lines and refs for an empty element list', () => {
      const { lines, refs } = buildDomEnrichedLines([]);
      expect(lines).toHaveLength(0);
      expect(Object.keys(refs)).toHaveLength(0);
    });
  });

  describe('snapshot line format', () => {
    it('produces a correctly formatted line for a named button', () => {
      const el: DomEnrichedElement = {
        ref: 'e100',
        tagName: 'button',
        explicitRole: null,
        id: 'submit-btn',
        inputType: null,
        dataAttrs: [],
      };
      const { lines } = buildDomEnrichedLines([el]);
      expect(lines[0]).toBe('- button [ref=e100] [id="submit-btn"]');
    });

    it('includes data-* attributes after id', () => {
      const el: DomEnrichedElement = {
        ref: 'e101',
        tagName: 'button',
        explicitRole: null,
        id: 'save-btn',
        inputType: null,
        dataAttrs: [
          { name: 'data-testid', value: 'save' },
          { name: 'data-action', value: 'submit' },
        ],
      };
      const { lines } = buildDomEnrichedLines([el]);
      expect(lines[0]).toBe('- button [ref=e101] [id="save-btn"] [data-testid="save"] [data-action="submit"]');
    });

    it('includes type attribute for input elements', () => {
      const el: DomEnrichedElement = {
        ref: 'e102',
        tagName: 'input',
        explicitRole: null,
        id: 'email-field',
        inputType: 'email',
        dataAttrs: [],
      };
      const { lines } = buildDomEnrichedLines([el]);
      expect(lines[0]).toBe('- textbox [ref=e102] [id="email-field"] [type="email"]');
    });

    it('does not include type attribute for non-input elements', () => {
      // A <button type="submit"> should not emit [type="submit"] — type is not
      // meaningful context for a button's role from the AI's perspective
      const el: DomEnrichedElement = {
        ref: 'e103',
        tagName: 'button',
        explicitRole: null,
        id: 'go',
        inputType: 'submit',
        dataAttrs: [],
      };
      const { lines } = buildDomEnrichedLines([el]);
      expect(lines[0]).toBe('- button [ref=e103] [id="go"]');
    });

    it('omits id segment when id is empty', () => {
      const el: DomEnrichedElement = {
        ref: 'e104',
        tagName: 'button',
        explicitRole: null,
        id: '',
        inputType: null,
        dataAttrs: [{ name: 'data-cy', value: 'close-modal' }],
      };
      const { lines } = buildDomEnrichedLines([el]);
      expect(lines[0]).toBe('- button [ref=e104] [data-cy="close-modal"]');
    });
  });

  describe('role resolution', () => {
    it('maps <a href> tagName to link role', () => {
      const el: DomEnrichedElement = {
        ref: 'e110',
        tagName: 'a',
        explicitRole: null,
        id: 'nav-home',
        inputType: null,
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e110.role).toBe('link');
    });

    it('maps <textarea> to textbox role', () => {
      const el: DomEnrichedElement = {
        ref: 'e111',
        tagName: 'textarea',
        explicitRole: null,
        id: 'notes',
        inputType: null,
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e111.role).toBe('textbox');
    });

    it('maps <select> to combobox role', () => {
      const el: DomEnrichedElement = {
        ref: 'e112',
        tagName: 'select',
        explicitRole: null,
        id: 'country',
        inputType: null,
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e112.role).toBe('combobox');
    });

    it('maps input[type=checkbox] to checkbox role', () => {
      const el: DomEnrichedElement = {
        ref: 'e113',
        tagName: 'input',
        explicitRole: null,
        id: 'agree',
        inputType: 'checkbox',
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e113.role).toBe('checkbox');
    });

    it('maps input[type=radio] to radio role', () => {
      const el: DomEnrichedElement = {
        ref: 'e114',
        tagName: 'input',
        explicitRole: null,
        id: 'opt-a',
        inputType: 'radio',
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e114.role).toBe('radio');
    });

    it('maps input[type=submit] to button role', () => {
      const el: DomEnrichedElement = {
        ref: 'e115',
        tagName: 'input',
        explicitRole: null,
        id: 'submit',
        inputType: 'submit',
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e115.role).toBe('button');
    });

    it('maps input[type=image] to button role', () => {
      const el: DomEnrichedElement = {
        ref: 'e116',
        tagName: 'input',
        explicitRole: null,
        id: 'icon-submit',
        inputType: 'image',
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e116.role).toBe('button');
    });

    it('maps input with no type to textbox role', () => {
      const el: DomEnrichedElement = {
        ref: 'e117',
        tagName: 'input',
        explicitRole: null,
        id: 'username',
        inputType: null,
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e117.role).toBe('textbox');
    });

    it('explicit role attribute overrides tag-derived role', () => {
      // A <div role="button"> should report role=button, not role=div
      const el: DomEnrichedElement = {
        ref: 'e118',
        tagName: 'div',
        explicitRole: 'button',
        id: 'custom-btn',
        inputType: null,
        dataAttrs: [],
      };
      const { refs, lines } = buildDomEnrichedLines([el]);
      expect(refs.e118.role).toBe('button');
      expect(lines[0]).toContain('- button');
    });
  });

  describe('ref map entries', () => {
    it('stores the data-bc-ref selector for every enriched element', () => {
      const el: DomEnrichedElement = {
        ref: 'e200',
        tagName: 'button',
        explicitRole: null,
        id: 'my-btn',
        inputType: null,
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e200.selector).toBe('[data-bc-ref="e200"]');
    });

    it('does not set a name on enriched refs (they have no accessible name)', () => {
      const el: DomEnrichedElement = {
        ref: 'e201',
        tagName: 'button',
        explicitRole: null,
        id: 'icon-btn',
        inputType: null,
        dataAttrs: [],
      };
      const { refs } = buildDomEnrichedLines([el]);
      expect(refs.e201.name).toBeUndefined();
    });

    it('produces one ref entry per element, keyed by ref ID', () => {
      const elements: DomEnrichedElement[] = [
        { ref: 'e300', tagName: 'button', explicitRole: null, id: 'a', inputType: null, dataAttrs: [] },
        { ref: 'e301', tagName: 'button', explicitRole: null, id: 'b', inputType: null, dataAttrs: [] },
        { ref: 'e302', tagName: 'input', explicitRole: null, id: 'c', inputType: 'text', dataAttrs: [] },
      ];
      const { refs } = buildDomEnrichedLines(elements);
      expect(Object.keys(refs)).toHaveLength(3);
      expect(refs.e300).toBeDefined();
      expect(refs.e301).toBeDefined();
      expect(refs.e302).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nextRefCounter
// ─────────────────────────────────────────────────────────────────────────────

describe('nextRefCounter', () => {
  it('returns 1 for an empty ref map', () => {
    expect(nextRefCounter({})).toBe(1);
  });

  it('returns max ref number + 1', () => {
    const refs = {
      e1: { role: 'button' },
      e5: { role: 'link' },
      e12: { role: 'textbox' },
    };
    expect(nextRefCounter(refs)).toBe(13);
  });

  it('handles a ref map with a single entry', () => {
    expect(nextRefCounter({ e7: { role: 'button' } })).toBe(8);
  });

  it('is not confused by non-numeric suffixes', () => {
    // Keys that don't match eN are ignored; only valid eN keys count
    const refs = {
      e3: { role: 'button' },
      ax1: { role: 'generic' }, // aria snapshot ref — different namespace
    } as Record<string, { role: string }>;
    // ax1 → parseInt('x1') = NaN → skipped; max is 3
    expect(nextRefCounter(refs)).toBe(4);
  });
});
