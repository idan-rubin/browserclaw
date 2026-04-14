# Anti-bot challenges

Load this file only when a page appears blocked by an anti-bot challenge (Cloudflare "Verify you are human", PerimeterX "press and hold", or similar). For normal browsing use the main `SKILL.md`.

Implementations of everything referenced here live in [`press-and-hold.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/press-and-hold.ts), [`cloudflare-checkbox.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/cloudflare-checkbox.ts), and [`dismiss-popup.ts`](https://github.com/idan-rubin/browserclaw-agent/blob/main/src/Services/Browser/src/skills/dismiss-popup.ts) in browserclaw-agent. Those files are the authoritative implementation — treat the code snippets below as a guide for porting the same logic into your own agent.

## Dispatch on type, don't eyeball it

```typescript
type AntiBotType = 'press_and_hold' | 'cloudflare_checkbox' | null;
```

`detectAntiBot(domText)` returns one of these. Dispatch on the returned value — the two solvers are **incompatible**, so guessing wrong will fail.

Detection priority (important because a page can match multiple patterns):

1. Press-and-hold first: `/press.*hold|hold.*to.*confirm/i`
2. Cloudflare-specific: `/performing security verification|cloudflare|just a moment/i`
3. Generic anti-bot: `/verify.*human|not a bot|captcha/i` → treated as `cloudflare_checkbox`

## The full flow

```typescript
import { getPageText, detectAntiBot, enrichSnapshot, isStillBlocked, pressAndHold } from './skills/press-and-hold.js';
import { clickCloudflareCheckbox } from './skills/cloudflare-checkbox.js';
import { detectPopup, dismissPopup } from './skills/dismiss-popup.js';

// 1. Read full DOM text, including iframes (overlays are often inside iframes)
const domText = await getPageText(page);

// 2. Classify
const antiBotType = detectAntiBot(domText);

// 3. Enrich the snapshot so the agent has context about the blocker
const { snapshot } = await page.snapshot({ interactive: true, compact: true });
const enriched = enrichSnapshot(snapshot, domText, antiBotType);

// 4. Dispatch
if (antiBotType === 'press_and_hold') {
  await pressAndHold(page);
} else if (antiBotType === 'cloudflare_checkbox') {
  await clickCloudflareCheckbox(page);
} else if (await detectPopup(page)) {
  await dismissPopup(page);
}

// 5. Verify
if (await isStillBlocked(page, antiBotType)) {
  // escalate — don't loop indefinitely
}
```

`isStillBlocked(page, type)` uses type-specific regexes against `document.body.innerText`:

- `'press_and_hold'` → `/press.*hold|verify.*human|not a bot|access.*denied/i`
- `'cloudflare_checkbox'` → `/performing security verification|verify you are human|just a moment/i`
- `null` → `false`

Both `pressAndHold` and `clickCloudflareCheckbox` call it internally; call it yourself between your own retries.

## PerimeterX press-and-hold — manual implementation

If you can't use `pressAndHold()` from the reference file, here's the minimum viable version. Note this section uses `page.evaluate` heavily — DOM traversal for detection is a legitimate use of `evaluate`. Clicks and holds still go through native actions (`page.pressAndHold`).

### 1. Detect (DOM + all iframes)

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

### 2. Find the button coordinates

The button is positioned **bottom-center of the matching text, +60px below**. Search main DOM, shadow DOM, and iframes:

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
if (!found) { /* no button — log and skip */ }
```

### 3. Hold with jitter

```typescript
const urlBefore = await page.url();
const jitterX = best.x + Math.floor(Math.random() * 20) - 10; // ±10px
const jitterY = best.y + Math.floor(Math.random() * 10) - 5;  // ±5px
const holdMs = 4000 + Math.floor(Math.random() * 6000);       // 4–10s
const delay = 100 + Math.floor(Math.random() * 200);          // 100–300ms pre-delay

await page.pressAndHold(jitterX, jitterY, { delay, holdMs });
```

### 4. Verify and retry once

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
    // escalate to user — don't loop indefinitely
  }
}
```

**Key points:**

- Save `page.url()` before the hold — needed for the refresh retry.
- The "still blocked" check reads `document.body.innerText` only (not iframes).
- One refresh retry max. If it's still blocked, escalate.
