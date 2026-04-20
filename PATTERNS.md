# browserclaw — Agent Patterns

Recurring patterns for building reliable agents on top of browserclaw.

---

## Credential Indirection

_Inspired by [Felix Mortas](https://github.com/felixmortas)' email-cons-agent, which demonstrated
that keeping secrets out of the LLM message history is both straightforward and essential for
production deployments._

### The problem

The most natural way to log into a service with an AI agent looks something like this:

```typescript
const { snapshot } = await page.snapshot();
const reply = await llm.complete(`Log in with username "jane@example.com" and password "hunter2".\n\n${snapshot}`);
```

This works, but it has a serious flaw: **the credentials are now in your LLM message history**.
They will be sent to the LLM provider on every subsequent call in that conversation, logged in
your observability stack, and potentially included in fine-tuning datasets. If you ever export
or inspect a conversation, the secrets are plaintext in the transcript.

### The solution: identifier tokens

Instead of embedding actual values, put **opaque identifier tokens** in the agent prompt and
resolve them to real values in a custom action handler — after the LLM has already decided what
to type and into which field.

```typescript
// ── 1. The agent prompt uses tokens, never real values ───────────────────────

const SYSTEM_PROMPT = `
You are a login automation agent.
When you need to fill in credentials, use these exact tokens:
  - email field    → EMAIL
  - password field → PASSWORD
`;

// ── 2. Resolve tokens to real values at execution time ───────────────────────

const CREDENTIALS: Record<string, string> = {
  EMAIL: process.env.USER_EMAIL ?? '',
  PASSWORD: process.env.USER_PASSWORD ?? '',
};

function resolveToken(value: string): string {
  return CREDENTIALS[value] ?? value;
}

// ── 3. Custom fill handler intercepts and resolves before the browser sees it ─

async function handleFill(ref: string, rawValue: string): Promise<void> {
  const resolved = resolveToken(rawValue);
  await page.type(ref, resolved);
}
```

Because `resolveToken` runs in your application code — not inside the LLM call — the actual
credential value never appears in any message sent to or received from the model.

### Full example

```typescript
import { BrowserClaw } from 'browserclaw';
import Anthropic from '@anthropic-ai/sdk';

const CREDENTIALS: Record<string, string> = {
  EMAIL: process.env.USER_EMAIL ?? '',
  PASSWORD: process.env.USER_PASSWORD ?? '',
};

function resolveToken(value: string): string {
  return CREDENTIALS[value] ?? value;
}

const browser = await BrowserClaw.launch({ url: 'https://example.com/login' });
const page = await browser.currentPage();
const client = new Anthropic();

// The system prompt tells the model which tokens to use — no actual secrets here
const SYSTEM = `
You are a browser automation agent. Fill in credentials using these tokens exactly:
  email    → EMAIL
  password → PASSWORD
Never use the real values; always use the token names listed above.
`.trim();

async function agentStep(conversationHistory: Anthropic.MessageParam[]): Promise<void> {
  const { snapshot } = await page.snapshot();

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    system: SYSTEM,
    messages: [...conversationHistory, { role: 'user', content: `Current page:\n\n${snapshot}\n\nLog in.` }],
  });

  // In a real agent you would use tool_use or structured output.
  // This simplified example shows where credential resolution happens.
  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;

    if (block.name === 'fill') {
      const { ref, value: rawValue } = block.input as { ref: string; value: string };
      // Resolution happens here — the model only ever sees the token name
      await page.type(ref, resolveToken(rawValue));
    }

    if (block.name === 'click') {
      const { ref } = block.input as { ref: string };
      await page.click(ref);
    }
  }
}
```

### Why this works

| Concern                  | What happens                                                |
| ------------------------ | ----------------------------------------------------------- |
| LLM receives credentials | Never — the prompt contains only token names                |
| LLM returns credentials  | Never — the model echoes back the token name, not the value |
| Observability logs       | Contain token names (`EMAIL`, `PASSWORD`), not secrets      |
| Credential rotation      | Change the environment variable; no prompt changes needed   |
| Multiple environments    | Swap `CREDENTIALS` map; agent prompt stays identical        |

### Design notes

- **Token names should be obvious but not guessable values.** `EMAIL` and `PASSWORD` work well.
  Avoid tokens that look like real values (e.g. `USER@EXAMPLE.COM` as a token would confuse the
  model into thinking it is a real address).

- **Resolve in the narrowest possible scope.** Resolve immediately before the browser call, not
  earlier. This minimises the window during which the plaintext value exists in your process.

- **The same pattern generalises.** API keys, OTP codes, credit card numbers, SSNs — any secret
  that an agent needs to type into a form can be handled this way. The token is just a name; the
  real value lives in a secrets manager, environment variable, or vault and is fetched at the
  last possible moment.

- **Credit:** This pattern was first demonstrated by Felix Mortas in the email-cons-agent project,
  which used it to automate email workflows without leaking credentials into the conversation
  transcript. The generalised form described here follows the same core principle.
