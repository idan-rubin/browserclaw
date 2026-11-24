import { existsSync } from 'node:fs';

import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';
import { takeAiSnapshotText } from '../connection.js';
import { getPageState } from '../page-utils.js';
import { refLocator } from '../ref-resolver.js';

const mocks = vi.hoisted(() => ({ page: vi.fn<() => Promise<Page>>() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: mocks.page,
}));

import { snapshotAi } from './ai-snapshot.js';
import { snapshotRole, snapshotAria } from './aria-snapshot.js';
import { takeRedactedAiSnapshotText } from './sensitive-field-values.js';

const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  existsSync,
);

describe.skipIf(executablePath === undefined)('native snapshot capture (real Chromium)', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath });
  });
  beforeEach(async () => {
    page = await browser.newPage();
    mocks.page.mockResolvedValue(page);
  });
  afterAll(async () => {
    await browser.close();
  });
  afterEach(async () => {
    await page.close();
  });

  it('scopes duplicate controls and resolves exact native refs through real DOM markers', async () => {
    await page.setContent(
      '<button>Save</button><section id="scope"><button onclick="this.textContent=\'Clicked\'">Save</button></section>',
    );
    const result = await snapshotRole({ cdpUrl: 'test', selector: '#scope' });
    const entry = Object.entries(result.refs).find(([, info]) => info.name === 'Save');
    expect(entry).toBeDefined();
    expect(Object.values(result.refs).filter((info) => info.name === 'Save')).toHaveLength(1);
    expect(entry?.[1].domMarker).toBe(true);
    await refLocator(page, entry?.[0] ?? '').click();
    expect(await page.locator('#scope button').innerText()).toBe('Clicked');
    expect(await page.locator('body > button').innerText()).toBe('Save');
  });

  it('keeps an iframe snapshot bound to its actual Frame and invalidates a replacement', async () => {
    await page.setContent('<iframe id="frame" srcdoc="<button>Inside</button>"></iframe><button>Outside</button>');
    await page.frameLocator('#frame').getByRole('button').waitFor();
    const result = await snapshotRole({ cdpUrl: 'test', frameSelector: '#frame' });
    const entry = Object.entries(result.refs).find(([, info]) => info.name === 'Inside');
    expect(entry).toBeDefined();
    expect(getPageState(page)?.roleRefsFrame).toBe(page.frames()[1]);
    expect(await refLocator(page, entry?.[0] ?? '').innerText()).toBe('Inside');
    await page.locator('#frame').evaluate((element) => {
      element.outerHTML = '<iframe id="frame" srcdoc="<button>Replacement</button>"></iframe>';
    });
    expect(() => refLocator(page, entry?.[0] ?? '')).toThrow('Unknown ref');
  });

  it('returns a selector no-match promptly and does not capture unrelated controls', async () => {
    await page.setContent('<button>Outside</button>');
    const start = Date.now();
    const result = await snapshotRole({ cdpUrl: 'test', selector: '#missing', timeoutMs: 5000 });
    expect(result.snapshot).toBe('(empty)');
    expect(result.refs).toEqual({});
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('resolves raw ARIA refs and invalidates them on same-URL document replacement', async () => {
    await page.goto('data:text/html,<button>Native</button>');
    const result = await snapshotAria({ cdpUrl: 'test' });
    const node = result.nodes.find((entry) => entry.name === 'Native' && entry.role === 'button');
    expect(node).toBeDefined();
    expect(await refLocator(page, node?.ref ?? '').innerText()).toBe('Native');
    await page.reload();
    expect(() => refLocator(page, node?.ref ?? '')).toThrow('Unknown ref');
  });

  it('preserves enrichment and applies the final budget to both native and AI output', async () => {
    await page.setContent(
      '<button>Primary</button>' +
        Array.from({ length: 12 }, (_, i) => `<input type="color" data-testid="custom-${String(i)}">`).join(''),
    );
    const native = await snapshotRole({ cdpUrl: 'test' });
    expect(native.snapshot).toContain('custom-');
    expect(Object.values(native.refs).some((info) => info.selector !== undefined)).toBe(true);
    const boundedNative = await snapshotRole({ cdpUrl: 'test', maxChars: 90 });
    expect(boundedNative.snapshot.length).toBeLessThanOrEqual(90);
    expect(boundedNative.truncated).toBe(true);
    const boundedAi = await snapshotAi({ cdpUrl: 'test', maxChars: 90 });
    expect(boundedAi.snapshot.length).toBeLessThanOrEqual(90);
    expect(boundedAi.truncated).toBe(true);
    for (const ref of Object.keys(boundedAi.refs)) expect(boundedAi.snapshot).toContain(`[ref=${ref}]`);
  });

  describe('sensitive field values', () => {
    const form =
      '<input aria-label="Password" type="password" value="hunter2-secret">' +
      '<input aria-label="Code" autocomplete="one-time-code" value="246810-otp">' +
      '<input aria-label="Card" placeholder="Card number" autocomplete="section-pay cc-number" value="4111-card">' +
      '<input aria-label="City" value="Lisbon-visible">';
    const captures = {
      ai: async () => (await snapshotAi({ cdpUrl: 'test' })).snapshot,
      'aria refs': async () => (await snapshotRole({ cdpUrl: 'test', refsMode: 'aria' })).snapshot,
      role: async () => (await snapshotRole({ cdpUrl: 'test' })).snapshot,
      'aria tree': async () => JSON.stringify((await snapshotAria({ cdpUrl: 'test' })).nodes),
    };

    it.each(Object.keys(captures) as (keyof typeof captures)[])(
      'masks them in a %s snapshot and keeps ordinary values',
      async (mode) => {
        await page.setContent(form);
        const captured = await captures[mode]();
        for (const secret of ['hunter2-secret', '246810-otp', '4111-card']) expect(captured).not.toContain(secret);
        expect(captured).toContain('[redacted]');
        expect(captured).toContain('Lisbon-visible');
      },
    );

    it.each(Object.keys(captures) as (keyof typeof captures)[])(
      'masks text nested inside a sensitive editable field in a %s snapshot',
      async (mode) => {
        const editable = 'role="textbox" contenteditable="true"';
        await page.setContent(
          `<div ${editable} aria-label="Code" autocomplete="one-time-code"><p>246810-otp</p>` +
            '<ul><li>again <a href="https://example.test/">246810-link</a></li></ul></div>' +
            `<div ${editable} aria-label="Notes"><p>Lisbon-visible</p></div>`,
        );
        const captured = await captures[mode]();
        expect(captured).not.toContain('246810');
        expect(captured).toContain('Lisbon-visible');
      },
    );

    it.each(Object.keys(captures) as (keyof typeof captures)[])(
      'masks the options of a select marked as a sensitive field in a %s snapshot',
      async (mode) => {
        await page.setContent(
          '<select aria-label="Card" autocomplete="cc-number"><option>1111-first</option>' +
            '<option selected>4242-chosen</option></select>' +
            '<select aria-label="Plan"><option selected>Monthly-visible</option><option>Yearly-visible</option></select>',
        );
        const captured = await captures[mode]();
        for (const secret of ['1111-first', '4242-chosen']) expect(captured).not.toContain(secret);
        for (const shown of ['Monthly-visible', 'Yearly-visible']) expect(captured).toContain(shown);
      },
    );

    it.each(Object.keys(captures) as (keyof typeof captures)[])(
      'masks what a sensitive field with no value of its own prints beneath it in a %s snapshot',
      async (mode) => {
        const pixel = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        await page.setContent(
          '<select id="none" aria-label="Card" autocomplete="cc-number"><option>1111-first</option>' +
            '<option>4242-second</option></select>' +
            '<select aria-label="Saved" autocomplete="cc-number"><option value="" selected></option>' +
            '<option>5555-saved</option></select>' +
            '<div role="textbox" contenteditable="true" aria-label="Code" autocomplete="one-time-code">' +
            `<img alt="246810-alt" src="${pixel}"></div>` +
            '<select aria-label="Listed" size="2" autocomplete="cc-number"><option>6666-listed</option>' +
            '<option selected>7777-picked</option></select>' +
            '<select aria-label="Many" multiple autocomplete="cc-number"><optgroup label="8888-group">' +
            '<option selected>9999-many</option></optgroup></select>' +
            '<select id="plain" aria-label="Plan"><option>Monthly-visible</option></select>' +
            '<select aria-label="Sizes" size="2"><option selected>Large-visible</option><option>Small</option></select>' +
            "<script>for (const id of ['none', 'plain']) document.getElementById(id).selectedIndex = -1;</script>",
        );
        const captured = await captures[mode]();
        for (const secret of ['1111-first', '4242-second', '5555-saved', '246810-alt', '6666', '7777', '8888', '9999'])
          expect(captured).not.toContain(secret);
        for (const shown of ['Monthly-visible', 'Large-visible']) expect(captured).toContain(shown);
      },
    );

    it.each(Object.keys(captures) as (keyof typeof captures)[])(
      'masks names printed between slashes and link addresses inside a sensitive field in a %s snapshot',
      async (mode) => {
        const editable = 'role="textbox" contenteditable="true"';
        await page.setContent(
          '<select aria-label="Card" autocomplete="cc-number"><option>/1111-first/</option>' +
            '<option selected>4242-chosen</option></select>' +
            `<div ${editable} aria-label="Code" autocomplete="one-time-code"><h2>/246810-otp/</h2>` +
            '<a href="https://example.test/reset?token=246810-link">/246810-name/</a></div>' +
            '<select aria-label="Folder"><option selected>/Public-visible/</option></select>',
        );
        const captured = await captures[mode]();
        for (const secret of ['1111-first', '4242-chosen', '246810']) expect(captured).not.toContain(secret);
        expect(captured).toContain('Public-visible');
      },
    );

    it("masks the descriptions beneath a sensitive field in an aria tree snapshot and keeps the field's own", async () => {
      await page.setContent(
        '<select aria-label="Card" title="Card-hint" autocomplete="cc-number"><option title="1111-tip">Visa</option>' +
          '<option selected aria-description="4242-described">Amex</option></select>' +
          '<select aria-label="Saved" autocomplete="cc-number"><option aria-description="5555-only"></option></select>' +
          '<select aria-label="Listed" size="2" autocomplete="cc-number"><option title="6666-tip">Listed</option></select>' +
          '<div role="textbox" contenteditable="true" aria-label="Code" autocomplete="one-time-code">' +
          '<a href="#" title="246810-tip">resend</a></div>' +
          '<select aria-label="Plan"><option title="Monthly-visible" selected>Monthly</option></select>',
      );
      const captured = await captures['aria tree']();
      expect(captured).not.toMatch(/1111|4242|5555|6666|246810/);
      expect(captured).toContain('Card-hint');
      expect(captured).toContain('Monthly-visible');
    });

    it('masks a snapshot scoped to an element inside a sensitive field', async () => {
      const editable = 'role="textbox" contenteditable="true"';
      await page.setContent(
        `<div ${editable} aria-label="Code" autocomplete="one-time-code">` +
          '<p id="code">246810-otp <b id="deep">246810-deep</b></p></div>' +
          '<select aria-label="Card" autocomplete="cc-number"><option id="chosen" selected>4242-chosen</option></select>' +
          '<select aria-label="Saved" autocomplete="cc-number"><option value="" selected></option>' +
          '<option id="unchosen">5555-saved</option></select>' +
          '<select aria-label="Listed" size="2" autocomplete="cc-number"><option id="listed">6666-listed</option></select>' +
          `<div ${editable} aria-label="Notes"><p id="note">Lisbon-visible</p></div>`,
      );
      for (const selector of ['#code', '#deep', '#chosen', '#unchosen', '#listed']) {
        const captured = (await snapshotRole({ cdpUrl: 'test', selector })).snapshot;
        expect(captured).not.toMatch(/246810|4242|5555|6666/);
        expect(captured).toContain('[redacted]');
      }
      expect((await snapshotRole({ cdpUrl: 'test', selector: '#note' })).snapshot).toContain('Lisbon-visible');
    });

    it('classifies each field against its own element, not the whole document', async () => {
      await page.setContent(
        Array.from(
          { length: 200 },
          (_, i) => `<input aria-label="Field ${String(i)}" value="value-${String(i)}">`,
        ).join('') +
          '<input aria-label="Password" type="password" value="hunter2-secret">' +
          `<table>${Array.from({ length: 2000 }, (_, i) => `<tr><td>row ${String(i)}</td><td>cell</td></tr>`).join('')}</table>`,
      );
      const timed = async (run: () => Promise<string>): Promise<{ text: string; ms: number }> => {
        const start = performance.now();
        const text = await run();
        return { text, ms: performance.now() - start };
      };
      const plain = await timed(() => takeAiSnapshotText(page, 30_000));
      const redacted = await timed(() => takeRedactedAiSnapshotText(page, 30_000));
      expect(redacted.text).not.toContain('hunter2-secret');
      expect(redacted.text).toContain('value-150');
      expect(redacted.ms).toBeLessThan(plain.ms * 5 + 250);
    });

    it.each(Object.keys(captures) as (keyof typeof captures)[])(
      'masks them in a %s snapshot when the page overrides its own attribute reads',
      async (mode) => {
        await page.setContent(
          `${form}<script>for (const el of document.querySelectorAll('input')) { el.id = el.ariaLabel; el.dataset.typed = el.value; } Element.prototype.getAttribute = () => null; Object.defineProperty(Element.prototype, 'tagName', { get: () => 'DIV' });</script>`,
        );
        const captured = await captures[mode]();
        for (const secret of ['hunter2-secret', '246810-otp', '4111-card']) expect(captured).not.toContain(secret);
        expect(captured).toContain('[redacted]');
        expect(captured).toContain('Lisbon-visible');
      },
    );
  });
});
