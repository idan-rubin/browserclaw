<!-- GitHub Discussion — Category: Ideas -->
<!-- Repository: OpenClaw -->
<!-- Title: browserclaw: a standalone browser automation library built on OpenClaw's snapshot pattern -->

### What is browserclaw?

[browserclaw](https://github.com/anthropics/browserclaw) is a standalone browser automation library built on the snapshot + ref pattern from OpenClaw. It tracks OpenClaw's latest browser layer changes and packages them as a focused, dependency-light library any project can use.

### Why separate the browser layer?

The snapshot + ref pattern gives LLMs a fast, cheap, and reliable way to see and act on web pages — no screenshots, no fragile selectors. But today it lives inside a full agent framework. That means if you're building an MCP server, a CI pipeline, an accessibility tool, or a different agent framework, you can't use the pattern without taking on the whole stack.

A standalone library fixes that:

- **Broader adoption** — An MCP server shouldn't need an agent framework to automate a browser. A CI pipeline running accessibility checks shouldn't either. Separating the browser layer lets any project use snapshot + ref on its own terms.
- **Faster iteration** — Browser automation is a moving target. Playwright updates, Chrome changes, evolving bot detection — a dedicated library can ship fixes without waiting on a framework release cycle.
- **Lower barrier to contribute** — A focused codebase means more eyes on the hardest part of the stack, the part that breaks when Chrome ships an update.
- **Stronger together** — Improvements to a shared foundation flow to every project using it, including OpenClaw. A lighter core with a battle-tested browser dependency is a win for everyone.

### What has been added since the extraction?

- Dual snapshot modes (aria + role) for different use cases
- Batch form filling and cross-origin iframe support
- Stealth mode for bot-detection bypass
- Labeled screenshots for visual debugging
- Network, console, and error monitoring
- Platform-native Chrome detection (macOS/Linux/Windows)

All of this can flow upstream — that's the whole point of a shared foundation.

### What's next?

We'd rather build this together than apart. If there's interest from the OpenClaw team in converging on a shared browser layer, we're ready for that conversation. And if you've been building browser automation into your own projects, we want to hear what's missing.
