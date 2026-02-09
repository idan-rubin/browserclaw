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

## Comparison with Other Tools

The AI browser automation space is moving fast. Here's how browserclaw's **snapshot + ref** approach compares to the major alternatives:

| | **browserclaw** | **[browser-use](https://github.com/browser-use/browser-use)** | **[Stagehand](https://github.com/browserbase/stagehand)** | **[Skyvern](https://github.com/Skyvern-AI/skyvern)** | **[Playwright MCP](https://github.com/microsoft/playwright-mcp)** |
|---|---|---|---|---|---|
| **Approach** | Accessibility snapshot with numbered refs | DOM element indexing + screenshots via raw CDP | Accessibility tree with natural language primitives | Vision-first: screenshots + DOM hybrid | Accessibility snapshots via MCP protocol |
| **How AI targets elements** | Ref ID → Playwright `getByRole()` locator | Element index → CDP node interaction | Natural language → AI resolves to element | Screenshot → Vision LLM → coordinates | Ref ID → Playwright locator |
| **Targeting** | **Deterministic** — exact locator match | Semi-deterministic — index-based, but indexes change | AI-interpreted — LLM picks the element each time | **Probabilistic** — vision model guesses coordinates | **Deterministic** — exact locator match |
| **Vision model required** | No | Optional (screenshots as supporting signal) | No | **Yes** — core to how it works | No |
| **Tokens per step** | ~500-1500 (text only) | ~2000-5000+ (DOM index + optional screenshot) | ~1000-3000 (accessibility tree chunks) | ~5000-10000+ (screenshot + DOM text) | ~500-1500 (text only) |
| **Speed per step** | ~50ms snapshot + action | Faster raw CDP ops, but vision calls add seconds | ~100ms + LLM interpretation overhead | Slow — screenshot + vision API per step | ~50ms snapshot + action |
| **Repeated run consistency** | Same page → same refs → **reproducible** | Indexes can shift between runs | LLM re-interprets each time — **variable** | Vision model re-interprets each time — **variable** | Same page → same refs → **reproducible** |
| **Resilience to UI changes** | Immune to visual changes — snapshots are semantic | Partially resilient — index-based, but layout changes shift indexes | Good — accessibility tree is semantic | Breaks on visual changes — new pixels, new guesses | Immune to visual changes |
| **Form filling** | `page.fill([...])` — batch multiple fields in one call | Sequential — one field at a time | `page.act("fill the form")` — AI figures it out | Sequential with vision per field | One field at a time via MCP tools |
| **Cross-origin iframes** | Full CDP access (Stripe, payment forms) | Full CDP access | Limited | Limited | Limited |
| **Browser engine** | **Playwright** — battle-tested, auto-wait, retry logic | Raw CDP — fast but reinvents Playwright's abstractions | Playwright (moving to own engine) | Playwright | Playwright |
| **Type** | Library (embed in your code) | Framework (agent loop built-in) | SDK (primitives + agent mode) | Platform (hosted + self-hosted) | MCP Server (protocol-based) |
| **Language** | TypeScript/JS | Python | TypeScript/JS | Python | TypeScript/JS |

### Also worth knowing

- **[LaVague](https://github.com/lavague-ai/LaVague)** — Python framework that uses a World Model + Action Engine architecture. Generates Selenium code via RAG on HTML. Interesting approach, but code generation adds latency and failure modes.
- **[AgentQL](https://github.com/tinyfish-io/agentql)** — Semantic query language for the web. AI-powered selectors that find elements by meaning rather than position. Complementary to browserclaw rather than competing.
- **[Vercel agent-browser](https://github.com/vercel-labs/agent-browser)** — Uses element refs (`@e1`, `@e2`) very similar to browserclaw. Good validation of the ref-based paradigm.

### Why snapshot + refs wins for repeated complex UI tasks

All these tools are impressive engineering — but they make different tradeoffs. When you're running the same multi-step workflow hundreds of times (filling forms, navigating dashboards, processing queues), the differences compound:

**Cost.** Vision calls on every step add up fast. browserclaw's text-only approach uses **~4x fewer tokens per run** than vision-based tools, and the gap widens with task complexity. A 20-step task repeated 100 times: ~3M tokens with browserclaw vs ~12M+ with vision-based tools.

**Speed.** No vision API round-trips means each step completes in milliseconds, not seconds. A 20-step workflow finishes in **seconds, not minutes**.

**Reliability.** Coordinate-based clicking is the #1 failure mode in vision-based automation. One element shifts by 10 pixels and the whole run fails. Natural-language targeting ("click the submit button") re-interprets every time — sometimes it picks the wrong one. Ref-based targeting is **deterministic**: same page state → same refs → same result.

**Playwright.** browser-use [dropped Playwright for raw CDP](https://browser-use.com/posts/playwright-to-cdp) to go "closer to the metal." That's a bold bet — but it means reinventing auto-wait, retry logic, cross-browser support, and thousands of edge cases that Playwright has spent years solving. browserclaw gets all of that for free.

**Simplicity.** No framework opinions, no agent loop, no hosted platform. Just `snapshot()` → read refs → act. Compose it into whatever agent architecture you want.

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
