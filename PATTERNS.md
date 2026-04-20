# browserclaw — Agent Patterns

Recurring patterns for building reliable agents on top of browserclaw.

---

## Credential Indirection

_Inspired by [Felix Mortas](https://github.com/felixmortas)' [email-cons-agent](https://github.com/felixmortas/email-cons-agent), which demonstrated that keeping secrets out of the LLM message history is both straightforward and essential for production deployments._

### The problem

The most natural way to log into a service with an AI agent looks something like this:

```typescript
const { snapshot } = await page.snapshot();
const reply = await llm.complete(`Log in with username "jane@example.com" and password "hunter2".\n\n${snapshot}`);
```

This works, but it has a serious flaw: **the credentials are now in your LLM message history**. They will be sent to the LLM provider on every subsequent call in that conversation, logged in your observability stack, and potentially included in fine-tuning datasets. If you ever export or inspect a conversation, the secrets are plaintext in the transcript.

### The solution: identifier tokens

Instead of embedding actual values, put **opaque identifier tokens** in the agent prompt and resolve them to real values in a custom action handler — after the LLM has already decided what to type and into which field.

```typescript
// ── 1. The agent prompt uses tokens, never real values ───────────────────────

const SYSTEM_PROMPT = `
You are a login automation agent.
When you need to fill in credentials, use these exact tokens:
  - email field    → EMAIL
  - password field → PASSWORD
`;

// ── 2. Resolve tokens to real values at execution time ───────────────────────

function loadCredentials(): Record<string, string> {
  const required = ['USER_EMAIL', 'USER_PASSWORD'] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required credentials: ${missing.join(', ')}`);
  }
  return {
    EMAIL: process.env.USER_EMAIL!,
    PASSWORD: process.env.USER_PASSWORD!,
  };
}

const CREDENTIALS = loadCredentials();

function resolveToken(value: string): string {
  const key = value.trim();
  return CREDENTIALS[key] ?? value;
}

// ── 3. Custom fill handler resolves before the browser sees the value ────────

async function handleFill(ref: string, rawValue: string): Promise<void> {
  await page.type(ref, resolveToken(rawValue));
}
```

Because `resolveToken` runs in your application code — not inside the LLM call — the actual credential value never appears in any message sent to or received from the model.

### Runnable example

```typescript
import { BrowserClaw } from 'browserclaw';
import Anthropic from '@anthropic-ai/sdk';

function loadCredentials(): Record<string, string> {
  const required = ['USER_EMAIL', 'USER_PASSWORD'] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required credentials: ${missing.join(', ')}`);
  }
  return {
    EMAIL: process.env.USER_EMAIL!,
    PASSWORD: process.env.USER_PASSWORD!,
  };
}

const CREDENTIALS = loadCredentials();

function resolveToken(value: string): string {
  const key = value.trim();
  return CREDENTIALS[key] ?? value;
}

// Tool definitions the model is allowed to call. Values are tokens, not secrets.
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'fill',
    description: 'Type text into a form field. For credentials use the token names EMAIL or PASSWORD.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref from the snapshot, e.g. "e3"' },
        value: { type: 'string', description: 'Text or credential token to type' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'click',
    description: 'Click the element with the given ref.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
      },
      required: ['ref'],
    },
  },
];

const SYSTEM = `
You are a browser automation agent. Fill in credentials using these tokens exactly:
  email    → EMAIL
  password → PASSWORD
Never use real values; always use the token names above.
`.trim();

const browser = await BrowserClaw.launch({ url: 'https://example.com/login' });
const page = await browser.currentPage();
const client = new Anthropic();

async function agentStep(history: Anthropic.MessageParam[]): Promise<void> {
  const { snapshot } = await page.snapshot();

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    system: SYSTEM,
    tools: TOOLS,
    messages: [...history, { role: 'user', content: `Current page:\n\n${snapshot}\n\nLog in.` }],
  });

  for (const block of response.content) {
    if (block.type !== 'tool_use') continue;

    if (block.name === 'fill') {
      const { ref, value } = block.input as { ref: string; value: string };
      // Resolution happens here — the model only ever sees the token name.
      // Do NOT log `resolved`; log `value` (the token) instead.
      await page.type(ref, resolveToken(value));
    } else if (block.name === 'click') {
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

### Places the pattern can still leak

Token indirection covers the LLM round-trip. It does **not** cover these channels — plug them explicitly:

- **Your own logs.** Any `console.log(resolvedValue)` in the fill handler defeats the whole pattern. Log the token (pre-resolve), never the resolved value.
- **Snapshots.** If the page renders a credential in plaintext (profile pages, confirmation screens, error messages like `"invalid password: hunter2"`), the next `page.snapshot()` captures it and ships it to the LLM. Redact or avoid snapshotting pages that display credentials.
- **Screenshots.** Same issue as snapshots, worse — image OCR in observability tools will surface the value. Don't capture screenshots of authenticated profile pages without a redaction pass.
- **Error messages.** Playwright errors that include the typed text will leak on exception. Wrap `page.type(ref, resolved)` in a handler that scrubs the resolved value from any re-thrown message.

### Design notes

- **Token names should be obvious but not guessable values.** `EMAIL` and `PASSWORD` work well. Avoid tokens that look like real values (e.g. `USER@EXAMPLE.COM` as a token would confuse the model into thinking it is a real address).
- **Resolve in the narrowest possible scope.** Resolve immediately before the browser call, not earlier. This minimises the window during which the plaintext value exists in your process.
- **Fail loudly on missing credentials.** `loadCredentials()` throws at startup rather than letting an unset env var silently resolve to an empty string — an agent that types nothing into a password field produces a confusing login failure, not a loud configuration error.
- **The pattern generalises.** API keys, OTP codes, credit card numbers, SSNs — any secret an agent types into a form can be handled this way. The token is just a name; the real value lives in a secrets manager, environment variable, or vault and is fetched at the last possible moment.

### Beyond env vars: secrets managers

`process.env` is the simplest source of truth, but it's not the only one. `loadCredentials()` is a seam — swap the body to fetch from your secrets provider of choice:

```typescript
// AWS Secrets Manager
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

async function loadCredentials(): Promise<Record<string, string>> {
  const sm = new SecretsManagerClient({});
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: 'agent/login-creds' }));
  const parsed = JSON.parse(SecretString ?? '{}') as { email?: string; password?: string };
  if (!parsed.email || !parsed.password) throw new Error('agent/login-creds is missing email or password');
  return { EMAIL: parsed.email, PASSWORD: parsed.password };
}
```

The same seam works for HashiCorp Vault, 1Password Connect, Doppler, GCP Secret Manager, or a sealed Kubernetes secret mount. The agent code above this function doesn't change.

### Rotating credentials mid-session

Long-running agents outlive any one credential value — an OTP expires in 30 seconds, an access token after an hour. Rotation fits the same pattern: resolve tokens through a function instead of a static map.

```typescript
async function resolveToken(value: string): Promise<string> {
  const key = value.trim();
  if (key === 'OTP') return await otpProvider.current(); // always fetch fresh
  return CREDENTIALS[key] ?? value;
}
```

The agent prompt is unchanged (`Use OTP for the one-time code field`) and the model still never sees a real OTP — the value is fetched at the moment of `page.type()` and thrown away immediately after.

---

_`PATTERNS.md` is meant to grow. If you've built an agent pattern worth generalising — handling navigation races, disambiguating ambiguous clicks, structuring memory across sessions — open a PR. New entries and improvements to existing ones are both welcome._
