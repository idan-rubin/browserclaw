/**
 * DOM enrichment layer for the accessibility snapshot.
 *
 * Playwright's accessibility tree captures elements with semantic ARIA roles and
 * accessible names. This is excellent coverage for well-structured pages, but it
 * silently omits interactive elements that lack accessible names — icon-only buttons,
 * custom components with only an `id`, elements identified by `data-testid` / `data-cy`,
 * and similar patterns common in real-world SPAs.
 *
 * This module performs a complementary DOM scan that finds those missed elements and
 * adds them to the ref map. The accessibility tree and the DOM scan are peers:
 * together they produce a richer snapshot than either alone.
 *
 * Inspired by Felix Mortas' email-cons-agent, which first demonstrated that a DOM-based
 * secondary scan can reliably surface elements the a11y tree silently drops.
 *
 * Known limitations:
 *  - Shadow DOM: querySelectorAll does not traverse shadow roots
 *  - Listener-only interactives (e.g. span[onclick]) without a role are not discovered
 *  - Only scans the main frame (not iframes)
 */

import type { Page } from 'playwright-core';

import type { RoleRefs } from '../types.js';

// ── Tunables ──

/** Upper bound on enriched elements per snapshot. Prevents runaway growth on huge SPAs. */
const MAX_ENRICHED_ELEMENTS = 200;

/** Upper bound on data-* attributes collected per element. */
const MAX_DATA_ATTRS_PER_ELEMENT = 5;

/** Upper bound on the length of any single attribute value included in the snapshot. */
const MAX_ATTR_VALUE_LEN = 120;

// ── Types ──

/**
 * An interactive DOM element found by the enrichment scan.
 * The `ref` is assigned (and written as `data-bc-ref`) inside the `page.evaluate`
 * call so that the attribute is set atomically with discovery.
 */
export interface DomEnrichedElement {
  ref: string;
  /** Lower-cased HTML tag name (e.g. `'button'`, `'input'`, `'a'`) */
  tagName: string;
  /** Explicit `role` attribute value, or `null` if absent */
  explicitRole: string | null;
  /** The element's `id` attribute, or `''` if absent */
  id: string;
  /** `type` attribute for `<input>` elements, otherwise `null` */
  inputType: string | null;
  /** Up to five `data-*` attributes, in source order */
  dataAttrs: { name: string; value: string }[];
}

// ── Role mapping ──

/**
 * Map a discovered DOM element to the ARIA role we'll report in the snapshot.
 * Explicit `role` attributes take precedence; otherwise we derive from the tag.
 */
function resolveDisplayRole(el: DomEnrichedElement): string {
  if (el.explicitRole !== null && el.explicitRole !== '') return el.explicitRole;

  switch (el.tagName) {
    case 'a':
      return 'link';
    case 'textarea':
      return 'textbox';
    case 'select':
      return 'combobox';
    case 'input': {
      const t = (el.inputType ?? 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
      return 'textbox';
    }
    default:
      return el.tagName;
  }
}

// ── Attribute-value sanitization ──

/**
 * Sanitize a raw attribute value before interpolating it into the snapshot text.
 * Strips characters that could break out of the `[name="value"]` annotation or
 * smuggle new lines into the snapshot — a prompt-injection surface for LLM
 * consumers. Also caps the length so page-controlled data can't balloon the
 * snapshot beyond its budget.
 */
function sanitizeAttrValue(value: string): string {
  let v = value;
  if (v.length > MAX_ATTR_VALUE_LEN) v = `${v.slice(0, MAX_ATTR_VALUE_LEN)}…`;
  return v
    .replace(/["[\]\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Pure snapshot builder ──

/**
 * Convert a list of DOM-enriched elements into snapshot lines and ref entries.
 *
 * This function is pure (no I/O) so it can be unit-tested independently of
 * `page.evaluate`. The caller is responsible for supplying elements that have
 * already had `data-bc-ref` written to them in the browser.
 *
 * Output line format:
 *   `- <role> [ref=eN] [id="..."] [type="..."] [data-*="..."]`
 */
export function buildDomEnrichedLines(elements: DomEnrichedElement[]): { lines: string[]; refs: RoleRefs } {
  const lines: string[] = [];
  const refs: RoleRefs = {};

  for (const el of elements) {
    const role = resolveDisplayRole(el);

    const attrs: string[] = [];
    const safeId = sanitizeAttrValue(el.id);
    if (safeId) attrs.push(`[id="${safeId}"]`);
    if (el.tagName === 'input' && el.inputType !== null && el.inputType !== '') {
      attrs.push(`[type="${sanitizeAttrValue(el.inputType)}"]`);
    }
    for (const { name, value } of el.dataAttrs) {
      const safeName = name.replace(/[^a-z0-9-]/gi, '');
      if (!safeName.startsWith('data-')) continue;
      attrs.push(`[${safeName}="${sanitizeAttrValue(value)}"]`);
    }

    const attrStr = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
    lines.push(`- ${role} [ref=${el.ref}]${attrStr}`);

    refs[el.ref] = {
      role,
      // Resolve via the data-bc-ref we stamped on the element during discovery
      selector: `[data-bc-ref="${el.ref}"]`,
    };
  }

  return { lines, refs };
}

// ── DOM scan ──

/** CSS selectors for elements that browserclaw considers interactive. */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="menuitem"]',
].join(',');

/**
 * Scan the live DOM for interactive elements that the accessibility snapshot missed.
 *
 * **What it finds:** Elements matching standard interactive selectors that do *not*
 * already have an `aria-ref` attribute (Playwright sets `aria-ref` on every element
 * it includes in `_snapshotForAI()`). Elements with no identifying attributes (`id`
 * or `data-*`) are skipped.
 *
 * **What it does:** Stamps `data-bc-ref=eN` on each found element so that
 * `refLocator()` can later resolve the ref via `page.locator('[data-bc-ref="eN"]')`.
 * Any `data-bc-ref` attributes left over from a previous enrichment pass are
 * cleared at the start of the scan so stale stamps cannot collide with new refs.
 *
 * @param page       - Playwright page (must have completed its AI snapshot first)
 * @param startRef   - The next unused ref counter (continue from the a11y snapshot's max)
 */
export async function enrichSnapshotFromDom(
  page: Page,
  startRef: number,
): Promise<{ lines: string[]; refs: RoleRefs }> {
  const elements = await page.evaluate(
    (args: { selector: string; counter: number; maxElements: number; maxDataAttrs: number }): DomEnrichedElement[] => {
      // Clear stale stamps from prior enrichment passes so a re-used ref number
      // cannot match two elements in the DOM at once.
      document.querySelectorAll('[data-bc-ref]').forEach((prev) => {
        prev.removeAttribute('data-bc-ref');
      });

      const results: DomEnrichedElement[] = [];
      let counter = args.counter;

      // forEach (not for-of) — tsconfig lib omits DOM.Iterable.
      document.querySelectorAll(args.selector).forEach((el) => {
        if (results.length >= args.maxElements) return;
        if (el.hasAttribute('aria-ref')) return;

        const id = (el as HTMLElement).id;

        const dataAttrs: { name: string; value: string }[] = [];
        for (let i = 0; i < el.attributes.length && dataAttrs.length < args.maxDataAttrs; i++) {
          const attr = el.attributes.item(i);
          if (attr && attr.name.startsWith('data-') && attr.name !== 'data-bc-ref') {
            dataAttrs.push({ name: attr.name, value: attr.value });
          }
        }

        if (id === '' && dataAttrs.length === 0) return;

        if (el.getAttribute('aria-hidden') === 'true') return;
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') return;
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;

        const ref = `e${String(counter++)}`;
        el.setAttribute('data-bc-ref', ref);

        results.push({
          ref,
          tagName: el.tagName.toLowerCase(),
          explicitRole: el.getAttribute('role'),
          id,
          inputType: el.getAttribute('type'),
          dataAttrs,
        });
      });

      return results;
    },
    {
      selector: INTERACTIVE_SELECTOR,
      counter: startRef,
      maxElements: MAX_ENRICHED_ELEMENTS,
      maxDataAttrs: MAX_DATA_ATTRS_PER_ELEMENT,
    },
  );

  return buildDomEnrichedLines(elements);
}

// ── Counter helper ──

/**
 * Return the next available ref counter given an existing ref map.
 * Enriched refs continue the sequence seamlessly (e.g. if the a11y snapshot
 * used e1–e12, enriched refs start at e13).
 */
export function nextRefCounter(refs: RoleRefs): number {
  let max = 0;
  for (const key of Object.keys(refs)) {
    // Only consider keys of the form `e<digits>` — ignore aria namespace etc.
    if (!/^e\d+$/.test(key)) continue;
    const n = Number.parseInt(key.slice(1), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}

// ── Merge helper ──

/**
 * Merge the baseline a11y snapshot with the DOM-enriched addendum.
 * No-op when the enrichment produced no new elements.
 */
export function mergeSnapshotWithEnrichment(
  built: { snapshot: string; refs: RoleRefs },
  enriched: { lines: string[]; refs: RoleRefs },
): { snapshot: string; refs: RoleRefs } {
  if (enriched.lines.length === 0) return built;
  return {
    snapshot: `${built.snapshot}\n${enriched.lines.join('\n')}`,
    refs: { ...built.refs, ...enriched.refs },
  };
}
