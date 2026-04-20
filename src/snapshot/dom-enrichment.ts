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
 */

import type { Page } from 'playwright-core';

import type { RoleRefs } from '../types.js';

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
  dataAttrs: Array<{ name: string; value: string }>;
}

// ── Role mapping ──

/**
 * Map a discovered DOM element to the ARIA role we'll report in the snapshot.
 * Explicit `role` attributes take precedence; otherwise we derive from the tag.
 */
function resolveDisplayRole(el: DomEnrichedElement): string {
  // Explicit role attribute always wins
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
      return el.tagName; // 'button' → 'button', custom tag → tag name
  }
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
 *
 * The selector stored in each `RoleRefInfo` targets the `data-bc-ref` attribute
 * that was set on the element during discovery — this is stable for the lifetime
 * of the current DOM, same as Playwright's own `aria-ref` mechanism.
 */
export function buildDomEnrichedLines(elements: DomEnrichedElement[]): { lines: string[]; refs: RoleRefs } {
  const lines: string[] = [];
  const refs: RoleRefs = {};

  for (const el of elements) {
    const role = resolveDisplayRole(el);

    // Build attribute annotations for the snapshot text
    const attrs: string[] = [];
    if (el.id) attrs.push(`[id="${el.id}"]`);
    if (el.tagName === 'input' && el.inputType) attrs.push(`[type="${el.inputType}"]`);
    for (const { name, value } of el.dataAttrs) attrs.push(`[${name}="${value}"]`);

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
 * or `data-*`) are skipped — without at least one stable identifier the AI has
 * nothing useful to say about the element.
 *
 * **What it does:** Stamps `data-bc-ref=eN` on each found element so that
 * `refLocator()` can later resolve the ref via `page.locator('[data-bc-ref="eN"]')`.
 *
 * @param page       - Playwright page (must have completed its AI snapshot first)
 * @param startRef   - The next unused ref counter (continue from the a11y snapshot's max)
 */
export async function enrichSnapshotFromDom(
  page: Page,
  startRef: number,
): Promise<{ lines: string[]; refs: RoleRefs }> {
  const elements = await page.evaluate(
    (args: { selector: string; counter: number }): DomEnrichedElement[] => {
      const results: DomEnrichedElement[] = [];
      let counter = args.counter;

      // Use querySelectorAll().forEach() rather than for-of to avoid the need
      // for DOM.Iterable in the host project's tsconfig lib.
      document.querySelectorAll(args.selector).forEach((el) => {
        // Already captured by Playwright's AI snapshot — skip it
        if (el.hasAttribute('aria-ref')) return;

        const id = (el as HTMLElement).id ?? '';

        // Collect data-* attributes without Array.from(NamedNodeMap) which also
        // requires DOM.Iterable. A counted loop works at every tsconfig target.
        const dataAttrs: Array<{ name: string; value: string }> = [];
        for (let i = 0; i < el.attributes.length && dataAttrs.length < 5; i++) {
          const attr = el.attributes.item(i);
          if (attr && attr.name.startsWith('data-')) {
            dataAttrs.push({ name: attr.name, value: attr.value });
          }
        }

        // No stable identifier — the AI can't target it meaningfully
        if (id === '' && dataAttrs.length === 0) return;

        // Skip visually hidden elements
        const style = window.getComputedStyle(el as HTMLElement);
        if (style.display === 'none' || style.visibility === 'hidden') return;

        const ref = `e${String(counter++)}`;
        // Stamp the ref so refLocator() can find it
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
    { selector: INTERACTIVE_SELECTOR, counter: startRef },
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
    const n = Number.parseInt(key.slice(1), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return max + 1;
}
