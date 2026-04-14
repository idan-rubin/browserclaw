---
name: browserclaw
description: Browse websites interactively using the browserclaw library — launch, navigate, snapshot, interact, extract
---

# Browserclaw Interactive Browsing

You are operating a real browser. You see pages through `snapshot()` and act on them with `click()`, `type()`, `select()`, etc. Every action may change the page — re-snapshot before deciding what to do next. Refs (`"e3"`, `"e8"`, ...) are only valid for the snapshot that produced them.

## Quick start — a full session

```typescript
import { BrowserClaw } from 'browserclaw';

const browser = await BrowserClaw.launch({ url: 'https://demo.playwright.dev/todomvc' });
const page = await browser.currentPage();

try {
  const { snapshot, refs } = await page.snapshot({ interactive: true, compact: true });
  // Read `snapshot` text, pick a ref from `refs`, e.g. the textbox is "e1"
  await page.type('e1', 'Buy milk', { submit: true });

  // Re-snapshot after an action that mutates the page
  const after = await page.snapshot({ interactive: true, compact: true });
  // ...read, act, repeat
} finally {
  await browser.stop(); // always stop the browser; close(tabId) closes a single tab instead
}
```

**The core loop: Perceive → Reason → Act → Repeat.** Never assume an action worked — re-snapshot and confirm.

## When *not* to use browserclaw

If the data is in the initial HTML response and the site doesn't require login, JS rendering, or interactive state, use a plain `fetch()` / `curl`. Browserclaw is for pages that need real browser behavior (SPAs, auth flows, forms, JS-rendered content, multi-step interaction).

## Snapshot — your eyes

```typescript
const { snapshot, refs } = await page.snapshot({ interactive: true, compact: true });
```

**Always pass `{ interactive: true, compact: true }`** — filters to actionable elements and strips structural noise.

`snapshot` is a text tree:

```
- heading "Search Results" [level=2]
- link "Blue Widget - $24.99" [ref=e3]
- button "Next page" [ref=e8]
- combobox "Sort by" [ref=e11]
```

`refs` maps ref → element info:

```typescript
{ "e3": { role: "link", name: "Blue Widget - $24.99" }, ... }
```

**If the snapshot looks empty or skeleton-like** (few elements, thin text), the page is still loading. Wait and retry:

```typescript
await page.waitFor({ loadState: 'networkidle', timeoutMs: 15000 });
// or poll until content appears:
for (let i = 0; i < 5; i++) {
  const { snapshot } = await page.snapshot({ interactive: true, compact: true });
  if (snapshot.split('\n').filter((l) => l.trim()).length > 10) break;
  await page.waitFor({ timeMs: 1500 });
}
```

## Core actions

### Navigate

```typescript
await page.goto('https://demo.playwright.dev/todomvc');
```

### Click

```typescript
await page.click('e8'); // ref from snapshot
```

### Type

```typescript
await page.type('e2', 'search query');                       // clears first, then types
await page.type('e2', 'search query', { submit: true });     // then press Enter
await page.type('e2', 'search query', { slowly: true });     // keystroke-by-keystroke
```

**After typing — check for autocomplete before pressing Enter.** Re-snapshot and look for `combobox`, `listbox`, or suggestion items. If a dropdown appeared, click the right option; pressing Enter usually submits without selecting.

**React and other frameworks: prefer `type()` over `fill()`.** `fill()` sets the DOM value directly and does *not* trigger React's `onChange`. `type()` simulates keystrokes which do. Use `fill()` only for batch form filling (below) and for non-framework sites.

### Select (dropdowns)

```typescript
await page.select('e11', 'Price: Low to High'); // visible text or value
```

### Press a key

```typescript
await page.press('Enter');
await page.press('Tab');
await page.press('Escape');
```

### Scroll

```typescript
await page.scrollIntoView('e15');                // preferred — scroll an element into view
await page.evaluate('window.scrollBy(0, 500)');  // page-level scroll
```

### Screenshot

```typescript
const buf = await page.screenshot(); // Buffer
```

### Drag / Hover

```typescript
await page.drag('e3', 'e8');  // drag e3 onto e8 (use iframe refs for elements inside iframes)
await page.hover('e2');       // trigger hover menus / tooltips
```

### Actions without a ref

```typescript
await page.clickByText('Submit');                         // visible text
await page.clickByText('Save', { exact: true });
await page.clickByRole('button', 'Create', { index: 1 }); // second match
await page.clickBySelector('#submit-btn');
await page.mouseClick(400, 300);                          // coordinates
```

### `evaluate` — use it for *reading*, not *acting*

```typescript
const title = await page.evaluate('document.title');
const count = await page.evaluate('document.querySelectorAll(".item").length');
```

Use `evaluate` to read DOM state (detection, extraction, queries) that native APIs don't expose. **Do not use it to click or type** — framework event handlers (React, Angular, Vue) won't fire. For actions, always use `page.click()`, `page.type()`, `page.press()`.

## Iframes

Elements inside iframes get frame-prefixed refs like `f1e23` (frame 1, element 23). The same element may also have a main-page ref, and both appear on the same snapshot line:

```
- button "Submit Payment" [ref=e63] [ref=f1e82]
```

**For actions inside iframes — especially drag — use the iframe ref (`f1e82`), not the main-page ref (`e63`).** Using the main-page ref will timeout.

**The frame number can change between page loads** (`f1` one time, `f2` the next). Match with regex `/f\d+e\d+/`, don't hardcode `f1`.

For JS that reads across frames:

```typescript
// Runs the function in every frame; returns an array of results, non-null first.
const results = await page.evaluateInAllFrames(`() => {
  const el = document.querySelector('input[name="cardnumber"]');
  return el ? el.name : null;
}`);
// results: ['cardnumber', null, null] — one entry per frame
```

## Inspecting page state

```typescript
await page.url();
await page.title();
await page.pageErrors();      // JS errors
await page.consoleLogs();     // console.* output
await page.networkRequests(); // XHR/fetch
```

## Common patterns

### Fill a form

```typescript
await page.fill([
  { ref: 'e2', value: 'Jane Doe' },
  { ref: 'e4', value: 'jane@acme.test' },
  { ref: 'e6', type: 'checkbox', value: true },
]);
await page.click('e9'); // submit
await page.waitFor({ loadState: 'networkidle' });
const { snapshot } = await page.snapshot({ interactive: true, compact: true });
```

(Remember: for React-controlled inputs that ignore `fill()`, fall back to `type()`.)

### Handle a native dialog

```typescript
const dialogDone = page.armDialog({ accept: true });
await page.click('e7'); // triggers confirm()
await dialogDone;
```

### Wait for something specific

```typescript
await page.waitFor({ text: 'Order confirmed' });
await page.waitFor({ selector: '.results-list' });
await page.waitFor({ url: 'checkout/success' });
await page.waitFor({ loadState: 'networkidle' });
await page.waitFor({ timeMs: 2000 });               // last resort
```

`waitFor({ timeMs })` caps at 30 seconds. For longer waits, loop.

### Multi-tab

```typescript
const tabs = await browser.tabs();                                   // list all tabs
const page2 = await browser.open('https://demo.playwright.dev/svgtodo'); // open a second tab
await browser.focus(page.id);                                        // switch back
await browser.close(page2.id);                                       // close a single tab
```

For tabs opened by a click (not by explicit `open()`), see the tab-manager entry in [Agentic skills](#agentic-skills-browserclaw-agent) below.

### Extract data from a listing

```typescript
const items = await page.evaluate(`
  Array.from(document.querySelectorAll('.todo-list li')).map(el => ({
    text: el.querySelector('label')?.textContent?.trim(),
    completed: el.classList.contains('completed'),
  }))
`);
```

## Launch options

```typescript
const browser = await BrowserClaw.launch({
  url: 'https://example.com',
  headless: false,            // default is environment-dependent; set explicitly if it matters
  ignoreHTTPSErrors: true,    // local dev servers with self-signed certs
  chromeArgs: [               // extra Chrome flags
    '--disable-web-security', // cross-origin iframes loading scripts from localhost
    '--start-maximized',
  ],
});
```

To attach to an already-running Chrome: `await BrowserClaw.connect('http://localhost:9222')`.

## Recovery

**Click didn't work / ref not found** — re-snapshot (ref is stale), try a different ref, `scrollIntoView(ref)` then click, or fall back to `clickByText(...)` / `clickByRole(...)`.

**Repeated action isn't making progress** — you may be stuck in a loop. Check `page.url()` / `page.title()`, try a different element or navigate away and back.

**Form submitted but nothing happened** — check the next snapshot for errors, check `page.consoleLogs()` / `page.pageErrors()`, then `waitFor({ loadState: 'networkidle' })` and re-snapshot.

## Agentic skills (browserclaw-agent)

browserclaw ships only the library primitives: snapshots, clicks, types, `pressAndHold`, etc. Higher-level orchestration — anti-bot solvers, popup dismissal, tab lifecycle, loop detection — lives in a separate project, **[browserclaw-agent](https://github.com/idan-rubin/browserclaw-agent/tree/main/src/Services/Browser/src/skills)**, as a set of composable agentic skills.

**Reach for these any time you hit a scenario below. They are the authoritative implementation — don't re-derive them inline.** The files aren't importable across the library/agent boundary, so copy the pattern into your own agent rather than trying to `import` from node_modules.

| Scenario                                        | Skill file                                                                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare / PerimeterX / "verify you're human" | [`press-and-hold.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/press-and-hold.ts) (dispatch hub) |
| Cloudflare checkbox specifically                | [`cloudflare-checkbox.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/cloudflare-checkbox.ts) |
| Cookie banners and generic popups               | [`dismiss-popup.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/dismiss-popup.ts)             |
| Tab opened by a click (not explicit `open()`)   | [`tab-manager.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/tab-manager.ts)                 |
| Raw CDP access (mouse events, target switching) | [`cdp-utils.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/cdp-utils.ts)                     |
| Agent stuck repeating the same action           | [`loop-detection.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/loop-detection.ts)           |

## Key rules

1. **Never guess the API.** When unsure whether a method exists or what it takes, check `node_modules/browserclaw/dist/index.d.ts` or `node_modules/browserclaw/README.md`. Don't invent alternatives.
2. **Refs are ephemeral.** After navigation or a DOM-changing action, re-snapshot.
3. **Every snapshot uses `{ interactive: true, compact: true }`.**
4. **Every extracted value must appear verbatim in a snapshot you actually saw.** No fabrication.
5. **After typing, check for autocomplete before pressing Enter.**
6. **Use native actions (`click`, `type`, `press`) for interaction; use `evaluate` only for reading DOM state.**
