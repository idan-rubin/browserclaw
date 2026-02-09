# browserclaw

[![npm version](https://img.shields.io/npm/v/browserclaw.svg)](https://www.npmjs.com/package/browserclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A standalone, typed wrapper around [OpenClaw](https://github.com/openclaw/openclaw)'s browser automation module. Provides AI-friendly browser control with **snapshot + ref targeting** — no CSS selectors, no XPath, no vision, just numbered refs that map to interactive elements.

```typescript
import { BrowserClaw } from 'browserclaw';

const browser = await BrowserClaw.launch({ headless: false });
const page = await browser.open('https://example.com');

// Snapshot — the core feature
const { snapshot, refs } = await page.snapshot();
// snapshot: AI-readable text tree
// refs: { "e1": { role: "link", name: "More info" }, "e2": { role: "button", name: "Submit" } }

await page.click('e1');         // Click by ref
await page.type('e3', 'hello'); // Type by ref
await browser.stop();
```

## Why browserclaw?

Most browser automation tools were built for humans writing test scripts. AI agents need something different:

- **Vision-based tools** (screenshot → click coordinates) are slow, expensive, and probabilistic
- **Selector-based tools** (CSS/XPath) are brittle and meaningless to an LLM
- **browserclaw** gives the AI a **text snapshot** with numbered refs — the AI reads text (what it's best at) and returns a ref ID (deterministic targeting)

The snapshot + ref pattern means:
1. **Deterministic** — refs resolve to exact elements via Playwright's `getByRole()`, no guessing
2. **Fast** — text snapshots are tiny compared to screenshots
3. **Cheap** — no vision API calls, just text in/text out
4. **Reliable** — built on Playwright, the most robust browser automation engine

## Install

```bash
npm install browserclaw
```

Requires a Chromium-based browser installed on the system (Chrome, Brave, Edge, or Chromium). browserclaw auto-detects your installed browser — no need to install Playwright browsers separately.

## How It Works

```
┌─────────────┐     snapshot()     ┌─────────────────────────────────┐
│  Web Page   │ ──────────────►    │  AI-readable text tree          │
│             │                    │                                 │
│  [buttons]  │                    │  - heading "Example Domain"     │
│  [links]    │                    │  - paragraph "This domain..."   │
│  [inputs]   │                    │  - link "More information" [e1] │
└─────────────┘                    └──────────────┬──────────────────┘
                                                  │
                                          AI reads snapshot,
                                          decides: click e1
                                                  │
┌─────────────┐     click('e1')    ┌──────────────▼──────────────────┐
│  Web Page   │ ◄──────────────    │  Ref "e1" resolves to:          │
│  (navigated)│                    │  getByRole('link',              │
│             │                    │    { name: 'More information' })│
└─────────────┘                    └─────────────────────────────────┘
```

1. **Snapshot** a page → get an AI-readable text tree with numbered refs (`e1`, `e2`, `e3`...)
2. **AI reads** the snapshot text and picks a ref to act on
3. **Actions target refs** → browserclaw resolves each ref to a Playwright locator and executes the action

> **Note:** Refs are not stable across navigations or page changes. Always take a fresh snapshot before acting — if an action fails, re-snapshot and use the new refs.

## API

### Launch & Connect

```typescript
// Launch a new Chrome instance (auto-detects Chrome/Brave/Edge/Chromium)
const browser = await BrowserClaw.launch({
  headless: false,       // default: false (visible window)
  executablePath: '...', // optional: specific browser path
  cdpPort: 9222,         // default: 9222
  noSandbox: false,      // default: false (set true for Docker/CI)
  chromeArgs: ['--start-maximized'], // additional Chrome flags
});

// Or connect to an already-running Chrome instance
// (started with: chrome --remote-debugging-port=9222)
const browser = await BrowserClaw.connect('http://localhost:9222');
```

### Pages & Tabs

```typescript
const page = await browser.open('https://example.com');
const current = await browser.currentPage(); // get active tab
const tabs = await browser.tabs();           // list all tabs
await browser.focus(tabId);                  // bring tab to front
await browser.close(tabId);                  // close a tab
await browser.stop();                        // stop browser + cleanup
```

### Snapshot (Core Feature)

```typescript
const { snapshot, refs, stats } = await page.snapshot();

// snapshot: human/AI-readable text tree with [ref=eN] markers
// refs: { "e1": { role: "link", name: "More info" }, ... }
// stats: { lines: 42, chars: 1200, refs: 8, interactive: 5 }

// Options
const result = await page.snapshot({
  interactive: true,  // Only interactive elements (buttons, links, inputs)
  compact: true,      // Remove structural containers without refs
  maxDepth: 6,        // Limit tree depth
  maxChars: 80000,    // Truncate if snapshot exceeds this size
  mode: 'aria',       // 'aria' (default) or 'role'
});

// Raw ARIA accessibility tree (structured data, not text)
const { nodes } = await page.ariaSnapshot({ limit: 500 });
```

**Snapshot modes:**
- `'aria'` (default) — Uses Playwright's `_snapshotForAI()`. Refs are resolved via `aria-ref` locators. Best for most use cases. Requires `playwright-core` >= 1.50.
- `'role'` — Uses Playwright's `ariaSnapshot()` + `getByRole()`. Supports `selector` and `frameSelector` for scoped snapshots.

### Actions

All actions target elements by ref ID from the most recent snapshot.

```typescript
// Click
await page.click('e1');
await page.click('e1', { doubleClick: true });
await page.click('e1', { button: 'right' });
await page.click('e1', { modifiers: ['Control'] });

// Type
await page.type('e3', 'hello world');                    // instant fill
await page.type('e3', 'slow typing', { slowly: true });  // keystroke by keystroke
await page.type('e3', 'search', { submit: true });       // type + press Enter

// Other interactions
await page.hover('e2');
await page.select('e5', 'Option A', 'Option B');
await page.drag('e1', 'e4');
await page.scrollIntoView('e7');

// Keyboard
await page.press('Enter');
await page.press('Control+a');
await page.press('Meta+Shift+p');

// Fill multiple form fields at once
await page.fill([
  { ref: 'e2', type: 'text', value: 'Jane Doe' },
  { ref: 'e4', type: 'text', value: 'jane@example.com' },
  { ref: 'e6', type: 'checkbox', value: true },
]);
```

### Navigation & Waiting

```typescript
await page.goto('https://example.com');
await page.waitFor({ loadState: 'networkidle' });
await page.waitFor({ text: 'Welcome' });
await page.waitFor({ textGone: 'Loading...' });
await page.waitFor({ url: '**/dashboard' });
await page.waitFor({ timeMs: 1000 }); // sleep
```

### Capture

```typescript
const screenshot = await page.screenshot();                   // viewport PNG
const fullPage = await page.screenshot({ fullPage: true });   // full scrollable page
const element = await page.screenshot({ ref: 'e1' });         // specific element
const jpeg = await page.screenshot({ type: 'jpeg' });         // JPEG format
const pdf = await page.pdf();                                  // PDF export (headless only)
```

### Activity Monitoring

Console messages, errors, and network requests are buffered automatically.

```typescript
const logs = await page.consoleLogs();                          // all messages
const errors = await page.consoleLogs({ level: 'error' });     // errors only
const pageErrors = await page.pageErrors();                     // uncaught exceptions
const requests = await page.networkRequests({ filter: '/api' });// filter by URL
const fresh = await page.networkRequests({ clear: true });      // read and clear buffer
```

### Storage

```typescript
// Cookies
const cookies = await page.cookies();
await page.setCookie({ name: 'token', value: 'abc', url: 'https://example.com' });
await page.clearCookies();

// localStorage / sessionStorage
const values = await page.storageGet('local');
const token = await page.storageGet('local', 'authToken');
await page.storageSet('local', 'key', 'value');
await page.storageClear('session');
```

### Evaluate

Run JavaScript directly in the browser page context.

```typescript
const title = await page.evaluate('() => document.title');
const text = await page.evaluate('(el) => el.textContent', { ref: 'e1' });
const count = await page.evaluate('() => document.querySelectorAll("img").length');
```

#### `evaluateInAllFrames(fn)`

Run JavaScript in ALL frames on the page, including cross-origin iframes. Playwright bypasses the same-origin policy via CDP, making this essential for interacting with embedded payment forms (Stripe, etc.).

```typescript
const results = await page.evaluateInAllFrames(`() => {
  const el = document.querySelector('input[name="cardnumber"]');
  return el ? 'found' : null;
}`);
// Returns: [{ frameUrl: '...', frameName: '...', result: 'found' }, ...]
```

### Viewport

```typescript
await page.resize(1280, 720);
```

## Examples

See the [`examples/`](./examples) directory for runnable demos:

- **[basic.ts](./examples/basic.ts)** — Navigate, snapshot, click a ref
- **[form-fill.ts](./examples/form-fill.ts)** — Fill a multi-field form using refs
- **[ai-agent.ts](./examples/ai-agent.ts)** — AI agent loop pattern with Claude/GPT

Run from the source tree:

```bash
npx tsx examples/basic.ts
```

## Requirements

- **Node.js** >= 18
- **Chromium-based browser** installed (Chrome, Brave, Edge, or Chromium)
- **playwright-core** >= 1.50 (installed automatically as a dependency)

No need to install Playwright browsers — browserclaw uses your system's existing Chrome installation via CDP.

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Run `npm run typecheck && npm run build` to verify
5. Submit a pull request

## Acknowledgments

browserclaw extracts and wraps the browser automation module from [OpenClaw](https://github.com/openclaw/openclaw) by [Peter Steinberger](https://github.com/steipete). The snapshot + ref system, CDP connection management, and Playwright integration originate from that project.

## License

[MIT](./LICENSE)
