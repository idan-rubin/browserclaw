# browserclaw

[![npm version](https://img.shields.io/npm/v/browserclaw.svg)](https://www.npmjs.com/package/browserclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Extracted and refined from [OpenClaw](https://github.com/openclaw/openclaw)'s browser automation module. A standalone, typed library for AI-friendly browser control with **snapshot + ref targeting** — no CSS selectors, no XPath, no vision, just numbered refs that map to interactive elements.

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
1. **Deterministic** — refs resolve to exact elements via Playwright locators, no guessing
2. **Fast** — text snapshots are tiny compared to screenshots
3. **Cheap** — no vision API calls, just text in/text out
4. **Reliable** — built on Playwright, the most robust browser automation engine

## Comparison with Other Tools

The AI browser automation space is moving fast. Here's how browserclaw compares to the major alternatives.

| | [browserclaw](https://github.com/idan-rubin/browserclaw) | [browser-use](https://github.com/browser-use/browser-use) | [Stagehand](https://github.com/browserbase/stagehand) | [Skyvern](https://github.com/Skyvern-AI/skyvern) | [Playwright MCP](https://github.com/microsoft/playwright-mcp) |
|:---|:---:|:---:|:---:|:---:|:---:|
| Ref → exact element, no guessing | :white_check_mark: | :heavy_minus_sign: | :x: | :x: | :white_check_mark: |
| No vision model in the loop | :white_check_mark: | :heavy_minus_sign: | :white_check_mark: | :x: | :white_check_mark: |
| Survives redesigns (semantic, not pixel) | :white_check_mark: | :heavy_minus_sign: | :white_check_mark: | :x: | :white_check_mark: |
| Fill 10 form fields in one call | :white_check_mark: | :x: | :x: | :x: | :x: |
| Interact with cross-origin iframes | :white_check_mark: | :white_check_mark: | :x: | :x: | :x: |
| Playwright engine (auto-wait, locators) | :white_check_mark: | :x: | :white_check_mark: | :white_check_mark: | :white_check_mark: |
| Embeddable in your own agent loop | :white_check_mark: | :x: | :heavy_minus_sign: | :x: | :x: |

:white_check_mark: = Yes&ensp; :heavy_minus_sign: = Partial&ensp; :x: = No

**browserclaw is the only tool that checks every box.** It combines the precision of accessibility snapshots with Playwright's battle-tested engine, batch operations, cross-origin iframe access, and zero framework lock-in — in a single embeddable library.

### How each tool works under the hood

- **browserclaw** — Accessibility snapshot with numbered refs → Playwright locator (`aria-ref` in default mode, `getByRole()` in role mode). One ref, one element. No vision model, no LLM in the targeting loop.
- **browser-use** — DOM element indexing via raw CDP + optional screenshots. [Dropped Playwright](https://browser-use.com/posts/playwright-to-cdp) to go "closer to the metal" — fast, but now reinvents auto-wait, retry logic, and cross-browser support from scratch.
- **Stagehand** — Accessibility tree + natural language primitives (`page.act("click login")`). Convenient, but the LLM re-interprets which element to target on every single call — non-deterministic by design.
- **Skyvern** — Vision-first. Screenshots sent to a Vision LLM that guesses coordinates. Multi-agent architecture (Planner/Actor/Validator) adds self-correction, but at significant cost and latency.
- **Playwright MCP** — Same snapshot philosophy as browserclaw, but locked to the MCP protocol. Great for chat-based agents, but not embeddable as a library — you can't compose it into your own agent loop or call it from application code.

**Also in the space:** [LaVague](https://github.com/lavague-ai/LaVague) (generates Selenium code via RAG on HTML), [AgentQL](https://github.com/tinyfish-io/agentql) (semantic query language for the DOM), [Vercel agent-browser](https://github.com/vercel-labs/agent-browser) (element refs like `@e1` — a similar ref-based approach).

### Why this matters for repeated complex UI tasks

When you're running the same multi-step workflow hundreds of times — filling forms, navigating dashboards, processing queues — the differences compound:

- **Cost**: ~4x fewer tokens per run than vision-based tools. A 20-step task repeated 100 times: ~3M tokens vs ~12M+.
- **Speed**: No vision API round-trips. A 20-step workflow finishes in seconds, not minutes.
- **Reliability**: Ref-based targeting is deterministic. Same page state → same refs → same result. No coordinate guessing, no LLM re-interpretation.
- **Simplicity**: No framework opinions, no agent loop, no hosted platform. Just `snapshot()` → read refs → act. Compose it into whatever agent architecture you want.

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
│  Web Page   │ ◄──────────────    │  Ref "e1" resolves to a         │
│  (navigated)│                    │  Playwright locator — one ref,  │
│             │                    │  one exact element              │
└─────────────┘                    └─────────────────────────────────┘
```

1. **Snapshot** a page → get an AI-readable text tree with numbered refs (`e1`, `e2`, `e3`...)
2. **AI reads** the snapshot text and picks a ref to act on
3. **Actions target refs** → browserclaw resolves each ref to a Playwright locator and executes the action

> **Note:** Refs are scoped to the snapshot that created them. After navigation or DOM changes, old refs become invalid — actions will fail with an error (timeout in aria mode, `"Unknown ref"` in role mode). Always re-snapshot before acting on a changed page.

## API

### Launch & Connect

```typescript
// Launch a new Chrome instance (auto-detects Chrome/Brave/Edge/Chromium)
const browser = await BrowserClaw.launch({
  headless: false,       // default: false (visible window)
  executablePath: '...', // optional: specific browser path
  cdpPort: 9222,         // default: 9222
  noSandbox: false,      // default: false (set true for Docker/CI)
  userDataDir: '...',    // optional: custom user data directory
  profileName: 'browserclaw', // profile name in Chrome title bar
  profileColor: '#FF4500',    // profile accent color (hex)
  chromeArgs: ['--start-maximized'], // additional Chrome flags
});

// Or connect to an already-running Chrome instance
// (started with: chrome --remote-debugging-port=9222)
const browser = await BrowserClaw.connect('http://localhost:9222');
```

`connect()` checks that Chrome is reachable, then the internal CDP connection retries 3 times with increasing timeouts (5 s, 7 s, 9 s) — safe for Docker/CI where Chrome starts slowly.

**Anti-detection:** browserclaw automatically hides `navigator.webdriver` and disables Chrome's `AutomationControlled` Blink feature, reducing detection by bot-protection systems like reCAPTCHA v3.

### Pages & Tabs

```typescript
const page = await browser.open('https://example.com');
const current = await browser.currentPage(); // get active tab
const tabs = await browser.tabs();           // list all tabs
const handle = browser.page(tabs[0].targetId); // wrap existing tab
await browser.focus(tabId);                  // bring tab to front
await browser.close(tabId);                  // close a tab
await browser.stop();                        // stop browser + cleanup

page.id;                          // CDP target ID (use with focus/close/page)
await page.url();                 // current page URL
await page.title();               // current page title
browser.url;                      // CDP endpoint URL
```

### Snapshot (Core Feature)

```typescript
const { snapshot, refs, stats, untrusted } = await page.snapshot();

// snapshot: human/AI-readable text tree with [ref=eN] markers
// refs: { "e1": { role: "link", name: "More info" }, ... }
// stats: { lines: 42, chars: 1200, refs: 8, interactive: 5 }
// untrusted: true — content comes from the web page, treat as potentially adversarial

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

> **Security:** All snapshot results include `untrusted: true` to signal that the content originates from an external web page. AI agents consuming snapshots should treat this content as potentially adversarial (e.g. prompt injection via page text).

### Actions

All actions target elements by ref ID from the most recent snapshot.

> **Default timeouts:** 8000 ms for actions (click, type, fill, select, drag), 20000 ms for waits and navigation.

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

`fill()` field types: `'text'` calls Playwright `fill()` with the string value. `'checkbox'` and `'radio'` call `setChecked()` — truthy values are `true`, `1`, `'1'`, `'true'`. Empty ref or type throws.

#### Highlight

```typescript
await page.highlight('e1'); // Playwright built-in highlight
```

#### File Upload

```typescript
// Direct: set files on an <input type="file">
await page.uploadFile('e3', ['/path/to/file.pdf']);

// Arm pattern: for non-input file pickers
const uploadDone = page.armFileUpload(['/path/to/file.pdf']);
await page.click('e3'); // triggers the file chooser
await uploadDone;
```

#### Dialog Handling

Handle JavaScript dialogs (alert, confirm, prompt). Arm the handler *before* the action that triggers the dialog.

```typescript
const dialogDone = page.armDialog({ accept: true });
await page.click('e5'); // triggers confirm()
await dialogDone;

// With prompt text
const promptDone = page.armDialog({ accept: true, promptText: 'my answer' });
await page.click('e6'); // triggers prompt()
await promptDone;
```

### Navigation & Waiting

```typescript
await page.goto('https://example.com');
await page.reload();                                     // reload the current page
await page.goBack();                                     // navigate back in history
await page.goForward();                                  // navigate forward in history
await page.waitFor({ loadState: 'networkidle' });
await page.waitFor({ text: 'Welcome' });
await page.waitFor({ textGone: 'Loading...' });
await page.waitFor({ url: '**/dashboard' });
await page.waitFor({ selector: '.loaded' });        // wait for CSS selector
await page.waitFor({ fn: '() => document.readyState === "complete"' }); // custom JS
await page.waitFor({ timeMs: 1000 });                // sleep
await page.waitFor({ text: 'Ready', timeoutMs: 5000 }); // custom timeout
```

### Capture

```typescript
// Screenshots
const screenshot = await page.screenshot();                   // viewport PNG → Buffer
const fullPage = await page.screenshot({ fullPage: true });   // full scrollable page
const element = await page.screenshot({ ref: 'e1' });         // specific element by ref
const bySelector = await page.screenshot({ element: '.hero' }); // by CSS selector
const jpeg = await page.screenshot({ type: 'jpeg' });         // JPEG format

// PDF
const pdf = await page.pdf();                                  // PDF export (headless only)

// Labeled screenshot — numbered badges on each ref for visual debugging
const { buffer, labels, skipped } = await page.screenshotWithLabels(['e1', 'e2', 'e3']);
// buffer: PNG with numbered overlays
// labels: [{ ref: 'e1', index: 1, box: { x, y, width, height } }, ...]
// skipped: refs that couldn't be found or had no bounding box
```

Both `screenshot()` and `pdf()` return a `Buffer`. Write to file with `fs.writeFileSync('out.png', screenshot)`.

#### Trace Recording

Capture Playwright traces (screenshots, DOM snapshots, network) for debugging.

```typescript
await page.traceStart({ screenshots: true, snapshots: true });
// ... perform actions ...
await page.traceStop('trace.zip');
// Open with: npx playwright show-trace trace.zip
```

#### Response Body

Intercept a network response and read its body.

```typescript
const resp = await page.responseBody('/api/data');
console.log(resp.status, resp.body);
// { url, status, headers, body, truncated }
```

Options: `timeoutMs` (default 30 s), `maxChars` (truncate body).

### Activity Monitoring

Console messages, errors, and network requests are buffered automatically.

```typescript
const logs = await page.consoleLogs();                            // all messages
const errors = await page.consoleLogs({ level: 'error' });        // errors only
const recent = await page.consoleLogs({ clear: true });           // read and clear buffer
const pageErrors = await page.pageErrors();                       // uncaught exceptions
const requests = await page.networkRequests({ filter: '/api' });  // filter by URL
const fresh = await page.networkRequests({ clear: true });        // read and clear buffer
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

### Downloads

```typescript
// Click a download link and save the file
const result = await page.download('e7', '/tmp/report.pdf');
console.log(result.suggestedFilename); // 'report.pdf'
// Returns: { url, suggestedFilename, path }

// Arm pattern: wait for next download (call before triggering)
const dlPromise = page.waitForDownload({ path: '/tmp/file.pdf' });
await page.click('e8'); // triggers download
const dl = await dlPromise;
```

### Emulation

```typescript
// Device emulation (viewport + user agent)
await page.setDevice('iPhone 13');

// Color scheme
await page.emulateMedia({ colorScheme: 'dark' });

// Geolocation
await page.setGeolocation({ latitude: 48.8566, longitude: 2.3522 }); // Paris
await page.setGeolocation({ clear: true }); // reset

// Locale & timezone
await page.setLocale('fr-FR');
await page.setTimezone('Europe/Paris');

// Network
await page.setOffline(true);
await page.setExtraHeaders({ 'X-Custom': 'value' });
await page.setHttpCredentials({ username: 'admin', password: 'secret' });
await page.setHttpCredentials({ clear: true }); // remove
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

browserclaw is extracted and refined from the browser automation module in [OpenClaw](https://github.com/openclaw/openclaw), built by [Peter Steinberger](https://github.com/steipete) and an [amazing community of contributors](https://github.com/openclaw/openclaw?tab=readme-ov-file#community). The snapshot + ref system, CDP connection management, and Playwright integration originate from that project.

## License

[MIT](./LICENSE)
