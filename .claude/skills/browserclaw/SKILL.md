---
name: browserclaw
description: Browse websites interactively using the browserclaw library — launch, navigate, snapshot, interact, extract
---

# Browserclaw Interactive Browsing

You are operating a real browser. You can see pages through `snapshot()` and act on them with `click()`, `type()`, `select()`, etc. Work step by step. Every action changes the page — re-snapshot to see what happened before acting again.

## Setup

```typescript
import { BrowserClaw } from 'browserclaw';

const browser = await BrowserClaw.launch({ url: 'https://demo.playwright.dev/todomvc' });
const page = await browser.currentPage();
// or connect to existing: await BrowserClaw.connect('http://localhost:9222')
```

When done: `await browser.stop()`

---

## The Core Loop

**Perceive → Reason → Act → Repeat**

```
snapshot() → read the tree → decide what to do → click/type/etc → snapshot() again
```

Never assume an action worked. Always re-snapshot to confirm the page changed as expected.

---

## Snapshot — Your Eyes

```typescript
const { snapshot, refs } = await page.snapshot({ interactive: true, compact: true });
```

Always use `{ interactive: true, compact: true }`. This filters to actionable elements only and strips structural noise.

**What snapshot returns:**

`snapshot` — a text tree of the page. Example:

```
- heading "Search Results" [level=2]
- link "Blue Widget - $24.99" [ref=e3]
- link "Red Widget - $19.99" [ref=e5]
- button "Next page" [ref=e8]
- combobox "Sort by" [ref=e11]
```

`refs` — a map of ref → element info:

```typescript
{
  "e3": { role: "link", name: "Blue Widget - $24.99" },
  "e8": { role: "button", name: "Next page" },
  "e11": { role: "combobox", name: "Sort by" }
}
```

**Reading a snapshot:** Look for elements by their role and name. Every `[ref=eN]` marker means you can interact with that element using its ref string (`"e3"`, `"e8"`, etc.).

**Refs are ephemeral.** After navigation or DOM changes, re-snapshot — old refs are invalid.

**If the snapshot looks empty or skeleton-like** (few elements, very little text), the page is still loading. Wait and try again:

```typescript
await page.waitFor({ timeMs: 1500 });
const { snapshot } = await page.snapshot({ interactive: true, compact: true });
```

---

## Core Actions

### Navigate

```typescript
await page.goto('https://demo.playwright.dev/todomvc');
// After navigation, always re-snapshot before acting
```

### Click

```typescript
await page.click('e8'); // ref from snapshot
```

### Type

```typescript
await page.type('e2', 'search query');
// type() clears the field first, then types
// Use { submit: true } to press Enter after:
await page.type('e2', 'search query', { submit: true });
// Use { slowly: true } for sites that need keystroke-by-keystroke input
```

**After typing in any field — check for autocomplete.** Re-snapshot immediately and look for `combobox`, `listbox`, or suggestion items. If a dropdown appeared, click the correct option — do NOT press Enter.

### Select (dropdowns)

```typescript
await page.select('e11', 'Price: Low to High');
// Pass the option's visible text or value
```

### Press a key

```typescript
await page.press('Enter');
await page.press('Tab');
await page.press('Escape');
```

### Scroll

```typescript
await page.evaluate('window.scrollBy(0, 500)'); // scroll down
await page.evaluate('window.scrollBy(0, -500)'); // scroll up
await page.scrollIntoView('e15'); // scroll element into view
```

### Screenshot (visual check)

```typescript
const buf = await page.screenshot();
// Returns a Buffer — write to file or display
```

### Evaluate arbitrary JS

```typescript
const text = await page.evaluate('document.title');
const count = await page.evaluate('document.querySelectorAll(".item").length');
```

---

## Common Patterns

### Fill a form

```typescript
// Snapshot first to get refs
const { snapshot } = await page.snapshot({ interactive: true, compact: true });
// Identify fields in the snapshot, note their refs

// Fill multiple fields at once
await page.fill([
  { ref: 'e2', value: 'Jane Doe' },
  { ref: 'e4', value: 'jane@acme.test' },
  { ref: 'e6', type: 'checkbox', value: true },
]);

// Then find and click the submit button
await page.click('e9'); // ref of submit button

// Re-snapshot to confirm submission
await page.waitFor({ timeMs: 1000 });
const { snapshot: after } = await page.snapshot({ interactive: true, compact: true });
```

### Navigate a multi-page flow

```typescript
// Page 1: add todos, then filter
await page.goto('https://demo.playwright.dev/todomvc');
let { snapshot } = await page.snapshot({ interactive: true, compact: true });
// ... add items, interact ...
await page.click('e12'); // click "Active" filter link

// Wait for view update
await page.waitFor({ loadState: 'networkidle', timeoutMs: 10000 });
({ snapshot } = await page.snapshot({ interactive: true, compact: true }));
// ... continue with filtered view ...
```

### Extract data from a listing

```typescript
await page.goto('https://demo.playwright.dev/todomvc');
const { snapshot } = await page.snapshot({ interactive: true, compact: true });

// Read all items from the snapshot text
// The snapshot shows todo labels, checkboxes — parse or pass to an LLM
// For structured extraction from raw DOM:
const items = await page.evaluate(`
  Array.from(document.querySelectorAll('.todo-list li')).map(el => ({
    text: el.querySelector('label')?.textContent?.trim(),
    completed: el.classList.contains('completed'),
  }))
`);
```

### Handle a dialog (alert/confirm/prompt)

```typescript
// Arm before the action that triggers the dialog
const dialogDone = page.armDialog({ accept: true });
await page.click('e7'); // triggers confirm()
await dialogDone; // resolves when dialog is handled
```

### Wait for something specific

```typescript
await page.waitFor({ text: 'Order confirmed' }); // wait for text to appear
await page.waitFor({ selector: '.results-list' }); // wait for element
await page.waitFor({ url: 'checkout/success' }); // wait for URL
await page.waitFor({ loadState: 'networkidle' }); // wait for network quiet
await page.waitFor({ timeMs: 2000 }); // fixed delay (last resort)
```

### Multi-tab browsing

```typescript
const tabs = await browser.tabs(); // list all tabs: [{ targetId, title, url }]

// Open a new tab explicitly (only when you actually want a second tab)
const page2 = await browser.open('https://demo.playwright.dev/svgtodo');
// ... work on page2 ...

await browser.focus(page.id); // switch back to first tab
await browser.close(page2.id); // close a tab
```

For tab lifecycle management in production (detecting new tabs opened by clicks, switching automatically), see [`tab-manager.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/tab-manager.ts).

---

## Error Handling

**Click didn't work / element not found:**

1. Re-snapshot — the page may have changed, the ref is stale
2. Look for the element by a different ref
3. Try `page.scrollIntoView(ref)` then click again
4. Try `page.clickByText('Button Label')` as fallback

**Page loads slowly:**

```typescript
await page.waitFor({ loadState: 'networkidle', timeoutMs: 15000 });
// or poll with snapshot readiness check:
for (let i = 0; i < 5; i++) {
  const { snapshot } = await page.snapshot({ interactive: true, compact: true });
  const lines = snapshot.split('\n').filter((l) => l.trim());
  if (lines.length > 10) break; // page has content
  await page.waitFor({ timeMs: 1500 });
}
```

**Repeated action isn't making progress:**

- You may be stuck in a loop. Try a different element, a different approach, or navigate away and back.
- Check `await page.url()` and `await page.title()` to confirm you're on the expected page.

**Autocomplete / search suggestions appeared:**

- Do NOT press Enter — that usually submits without selecting
- Re-snapshot to see the suggestions
- Click the matching suggestion ref

**Form submission succeeded but then nothing happened:**

- Check for error messages in the next snapshot
- Check `await page.consoleLogs()` for JS errors
- Try `await page.waitFor({ loadState: 'networkidle' })` then re-snapshot

---

## Inspecting Page State

```typescript
const url = await page.url();
const title = await page.title();
const errors = await page.pageErrors(); // JS errors
const logs = await page.consoleLogs(); // console.log output
const requests = await page.networkRequests(); // XHR/fetch calls
```

---

## Production Skill Reference

**Reference implementations.** browserclaw is the vehicle; these files show how the browserclaw-agent project builds driver-level skills on top of browserclaw primitives. Read them when you need more depth than this skill provides, or to model your own implementation against a proven example — you can't directly import across the vehicle/driver boundary, so the goal is pattern learning, not code reuse.

All reference skills live at: https://github.com/idan-rubin/browserclaw-agent/tree/main/src/Services/Browser/src/skills

| Scenario                                        | File                                                                                                                                         | What it handles                                                                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Anti-bot detection + snapshot enrichment        | [`press-and-hold.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/press-and-hold.ts)           | `getPageText`, `detectAntiBot`, `enrichSnapshot`, `isStillBlocked`, `pressAndHold` — the orchestration hub                   |
| Cloudflare "Verify you are human" checkbox      | [`cloudflare-checkbox.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/cloudflare-checkbox.ts) | Locates the Cloudflare iframe checkbox and clicks it via CDP                                                                 |
| Cookie banners and generic popups               | [`dismiss-popup.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/dismiss-popup.ts)             | Detects and dismisses common cookie consent banners and modal overlays                                                       |
| Raw CDP access (mouse events, target switching) | [`cdp-utils.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/cdp-utils.ts)                     | `openCdpConnection`, `cdpClick`, `activateCdpTarget` — used by cloudflare-checkbox and tab-manager                           |
| Tab opened by a click                           | [`tab-manager.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/tab-manager.ts)                 | Tracks known tab IDs, detects new tabs after clicks, switches focus automatically                                            |
| Agent stuck repeating the same action           | [`loop-detection.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/loop-detection.ts)           | Counts repeated action+ref pairs over a sliding window; escalates nudge from gentle → warning → urgent at 5/8/12 repetitions |

**If you encounter an anti-bot challenge, popup, or tab management need: model your solution on the relevant reference above.** These are production implementations that handle edge cases you'll otherwise spend hours debugging.

---

## Anti-Bot Orchestration

When a page might be blocked, use this detection-first flow before attempting any solver. All the pieces live in `press-and-hold.ts` and connect together as follows.

### `AntiBotType` — the dispatch key

```typescript
type AntiBotType = 'press_and_hold' | 'cloudflare_checkbox' | null;
```

`detectAntiBot` returns one of these values. `null` means no anti-bot challenge detected. Everything downstream dispatches on this type.

### The full flow

```typescript
import { getPageText, detectAntiBot, enrichSnapshot, isStillBlocked, pressAndHold } from './skills/press-and-hold.js';
import { clickCloudflareCheckbox } from './skills/cloudflare-checkbox.js';
import { detectPopup, dismissPopup } from './skills/dismiss-popup.js';

// 1. Read full DOM text including iframes
const domText = await getPageText(page);

// 2. Classify the challenge
const antiBotType = detectAntiBot(domText);
// 'press_and_hold'      → PerimeterX "press and hold" overlay
// 'cloudflare_checkbox' → Cloudflare turnstile / "Verify you are human"
// null                  → no anti-bot challenge detected

// 3. Enrich the snapshot with anti-bot context for agent reasoning
const { snapshot } = await page.snapshot({ interactive: true, compact: true });
const enrichedSnapshot = enrichSnapshot(snapshot, domText, antiBotType);
// enrichSnapshot appends a [ANTI-BOT OVERLAY DETECTED] or [SECURITY VERIFICATION]
// note to the snapshot text so the agent knows what to do next

// 4. Dispatch to the right solver
if (antiBotType === 'press_and_hold') {
  await pressAndHold(page);
} else if (antiBotType === 'cloudflare_checkbox') {
  await clickCloudflareCheckbox(page);
} else {
  // No anti-bot — check for generic popups
  if (await detectPopup(page)) {
    await dismissPopup(page);
  }
}

// 5. Retry check — isStillBlocked knows which patterns to test per type
const blocked = await isStillBlocked(page, antiBotType);
if (blocked) {
  /* escalate to user — don't loop indefinitely */
}
```

### `isStillBlocked` — type-aware retry check

```typescript
const blocked = await isStillBlocked(page, antiBotType);
```

`isStillBlocked` takes the `AntiBotType` and tests type-specific patterns against `document.body.innerText`:

- `'press_and_hold'` → `/press.*hold|verify.*human|not a bot|access.*denied/i`
- `'cloudflare_checkbox'` → `/performing security verification|verify you are human|just a moment/i`
- `null` → always returns `false`

Both `pressAndHold` and `clickCloudflareCheckbox` use `isStillBlocked` internally for their post-action retry checks. Use it directly when you need to verify state between retries in your own logic.

### Detection priority

`detectAntiBot` checks in this order:

1. Press-and-hold pattern first (`/press.*hold|hold.*to.*confirm/i`)
2. Cloudflare-specific patterns (`/performing security verification|cloudflare|just a moment/i`)
3. Generic anti-bot (`/verify.*human|not a bot|captcha/i`) → treated as `cloudflare_checkbox`

Press-and-hold is checked first because a page can match both patterns and the solvers are incompatible — using the wrong one will fail.

---

## Handling PerimeterX Press-and-Hold Challenges

Some sites (via PerimeterX) show a "press and hold" verification overlay. This is distinct from Cloudflare — the DOM text will say something like "Press and hold to confirm you're human." Handle it as follows.

### 1. Detect the challenge

Read DOM text from the page **and all iframes** (the overlay is often in an iframe):

```typescript
const domText = (await page.evaluate(`
  (function() {
    var text = document.body.innerText || '';
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        if (iframes[i].contentDocument && iframes[i].contentDocument.body) {
          text += ' ' + iframes[i].contentDocument.body.innerText;
        }
      } catch(e) {}
    }
    return text;
  })()
`)) as string;

const isPressAndHold = /press.*hold|hold.*to.*confirm/i.test(domText);
```

If the pattern matches, it's a press-and-hold challenge. Do not treat it as a Cloudflare checkbox.

### 2. Find the button coordinates

The button is located by finding the element whose text matches the challenge pattern, then targeting **bottom-center + 60px below it**. Search main DOM, shadow DOM, and iframes:

```typescript
const result = (await page.evaluate(`
  (function() {
    var PATTERN = /press.*hold|verify.*human|hold.*to.*confirm|not a bot/i;
    var BUTTON_Y_OFFSET = 60;

    function toCandidate(el, offsetX, offsetY) {
      var rect = el.getBoundingClientRect();
      return {
        width: rect.width, height: rect.height,
        x: Math.round(rect.left + rect.width / 2 + offsetX),
        y: Math.round(rect.bottom + BUTTON_Y_OFFSET + offsetY),
      };
    }

    function search(root, offsetX, offsetY) {
      var results = [];
      var all = root.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (PATTERN.test((el.innerText || '').trim())) results.push(toCandidate(el, offsetX, offsetY));
        if (el.shadowRoot) {
          var sh = el.shadowRoot.querySelectorAll('*');
          for (var s = 0; s < sh.length; s++)
            if (PATTERN.test((sh[s].innerText || '').trim())) results.push(toCandidate(sh[s], offsetX, offsetY));
        }
      }
      return results;
    }

    var candidates = search(document, 0, 0);
    var iframes = document.querySelectorAll('iframe');
    for (var i = 0; i < iframes.length; i++) {
      try {
        var doc = iframes[i].contentDocument;
        if (doc && doc.body) {
          var r = iframes[i].getBoundingClientRect();
          candidates = candidates.concat(search(doc, r.left, r.top));
        }
      } catch(e) {}
    }

    // Pick: width > 100px, height 20-80px, prefer smallest height
    var best = null;
    for (var j = 0; j < candidates.length; j++) {
      var c = candidates[j];
      if (c.width > 100 && c.height > 20 && c.height < 80) {
        if (!best || c.height < best.height) best = c;
      }
    }
    return JSON.stringify({ found: !!best, best: best });
  })()
`)) as string;

const { found, best } = JSON.parse(result);
if (!found) {
  /* no button found — log and skip */
}
const { x, y } = best;
```

**Coordinate logic:** x = horizontal center of the matching element, y = element's bottom edge + 60px. The actual hold target is below the text label, not on it.

### 3. Execute the hold

Apply ±10px/±5px jitter and a randomized 4–10s hold with a 100–300ms pre-delay:

```typescript
const urlBefore = await page.url();
const jitterX = x + Math.floor(Math.random() * 20) - 10; // ±10px
const jitterY = y + Math.floor(Math.random() * 10) - 5; // ±5px
const holdMs = 4000 + Math.floor(Math.random() * 6000); // 4–10s
const delay = 100 + Math.floor(Math.random() * 200); // 100–300ms pre-delay

await page.pressAndHold(jitterX, jitterY, { delay, holdMs });
```

### 4. Verify and retry

After releasing, wait 2s and check if the challenge cleared. If still blocked, refresh and check again:

```typescript
await page.waitFor({ timeMs: 2000 });

const stillBlocked = (await page.evaluate(
  '!!(document.body && document.body.innerText && document.body.innerText.match(/press.*hold|verify.*human|not a bot|access.*denied/i))',
)) as boolean;

if (stillBlocked) {
  await page.goto(urlBefore);
  await page.waitFor({ timeMs: 3000 });
  const blockedAfterRefresh = (await page.evaluate(
    '!!(document.body && document.body.innerText && document.body.innerText.match(/press.*hold|verify.*human|not a bot|access.*denied/i))',
  )) as boolean;
  if (blockedAfterRefresh) {
    /* challenge failed — escalate */
  }
}

// Challenge cleared — re-snapshot and continue
const { snapshot } = await page.snapshot({ interactive: true, compact: true });
```

**Key points:**

- Always save `page.url()` before the hold — you need it for the refresh retry
- The "still blocked" check reads from `document.body.innerText` only (not iframes), matching `/press.*hold|verify.*human|not a bot|access.*denied/i`
- If blocked after refresh, escalate to the user — don't loop indefinitely

---

## Key Rules

1. **Always re-snapshot after navigation or significant actions.** Refs change.
2. **Use `{ interactive: true, compact: true }` for every snapshot.** Cleaner output, faster reasoning.
3. **Trust what you see in the snapshot.** Don't assume elements exist — verify in the snapshot.
4. **After typing, check for autocomplete before pressing Enter.**
5. **One navigation = one snapshot cycle.** Goto → waitFor → snapshot → act.
6. **Data grounding:** Every value you extract or report must appear verbatim in a snapshot you actually saw.
