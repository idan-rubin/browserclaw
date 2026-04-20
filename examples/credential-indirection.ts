/**
 * Example: Credential Indirection
 *
 * Runs a login agent against a self-contained HTML page and demonstrates that
 * the real credentials NEVER appear in the message history sent to the LLM.
 *
 * Two run modes:
 *
 *   MOCK  — default; no API key required. A scripted "LLM" returns the tokens
 *           the real model would return. Everything else (resolution, browser
 *           interaction, transcript capture) runs for real.
 *
 *   LIVE  — set ANTHROPIC_API_KEY and BROWSERCLAW_EXAMPLE_MODE=live. The
 *           Anthropic SDK drives the agent.
 *
 * Required env (LIVE): USER_EMAIL, USER_PASSWORD, ANTHROPIC_API_KEY
 * Required env (MOCK): USER_EMAIL, USER_PASSWORD
 *
 * See PATTERNS.md § Credential Indirection for the full explanation.
 */

import { BrowserClaw } from '../src/index.js';

function loadCredentials(): Record<string, string> {
  const required = ['USER_EMAIL', 'USER_PASSWORD'] as const;
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing credentials: ${missing.join(', ')}. Set them before running this example.`);
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

const LOGIN_FORM_HTML = [
  '<!doctype html>',
  '<html><head><title>Demo Login</title></head>',
  '<body style="font-family:sans-serif;max-width:420px;margin:48px auto;">',
  '  <h1>Sign in</h1>',
  '  <form id="login">',
  '    <label>Email<br><input id="email" name="email" required style="width:100%;padding:8px;"/></label><br><br>',
  '    <label>Password<br><input id="password" name="password" type="password" required style="width:100%;padding:8px;"/></label><br><br>',
  '    <button id="submit" type="submit" style="padding:8px 16px;">Sign in</button>',
  '  </form>',
  '  <p id="result" style="margin-top:24px;color:#0a7;"></p>',
  '  <script>',
  "    document.getElementById('login').addEventListener('submit', (ev) => {",
  '      ev.preventDefault();',
  "      const e = document.getElementById('email').value;",
  "      const p = document.getElementById('password').value;",
  "      document.getElementById('result').textContent = e && p",
  "        ? 'Signed in as ' + e + ' (password length ' + p.length + ')'",
  "        : 'Missing input';",
  '    });',
  '  </script>',
  '</body></html>',
].join('\n');

const LOGIN_PAGE = `data:text/html;base64,${Buffer.from(LOGIN_FORM_HTML).toString('base64')}`;

type AgentAction = { tool: 'fill'; ref: string; value: string } | { tool: 'click'; ref: string } | { tool: 'done' };

interface Driver {
  nextAction(snapshot: string): Promise<AgentAction>;
}

class MockDriver implements Driver {
  private step = 0;
  private emailRef = '';
  private passwordRef = '';
  private submitRef = '';

  async nextAction(snapshot: string): Promise<AgentAction> {
    const idRef = (id: string) => {
      const m = new RegExp(`\\[ref=(e\\d+)\\][^\\n]*\\[id="${id}"\\]`).exec(snapshot);
      return m?.[1] ?? '';
    };
    if (this.step === 0) {
      this.emailRef = idRef('email');
      this.passwordRef = idRef('password');
      this.submitRef = idRef('submit');
    }
    this.step++;
    if (this.step === 1) return { tool: 'fill', ref: this.emailRef, value: 'EMAIL' };
    if (this.step === 2) return { tool: 'fill', ref: this.passwordRef, value: 'PASSWORD' };
    if (this.step === 3) return { tool: 'click', ref: this.submitRef };
    return { tool: 'done' };
  }
}

async function makeLiveDriver(): Promise<Driver> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('LIVE mode requires ANTHROPIC_API_KEY');
  }
  let Anthropic: typeof import('@anthropic-ai/sdk').default;
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new Error('LIVE mode requires @anthropic-ai/sdk. Install it with: npm i @anthropic-ai/sdk');
  }
  const client = new Anthropic();

  const SYSTEM = [
    'You are a browser automation agent. Fill in credentials using these tokens exactly:',
    '  email    → EMAIL',
    '  password → PASSWORD',
    'Never use real values; always use the token names above.',
    'When finished, call the "done" tool.',
  ].join('\n');

  const TOOLS: Anthropic.Tool[] = [
    {
      name: 'fill',
      description: 'Type text into a form field. For credentials use EMAIL or PASSWORD.',
      input_schema: {
        type: 'object',
        properties: {
          ref: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['ref', 'value'],
      },
    },
    {
      name: 'click',
      description: 'Click the element with the given ref.',
      input_schema: {
        type: 'object',
        properties: { ref: { type: 'string' } },
        required: ['ref'],
      },
    },
    {
      name: 'done',
      description: 'Signal that the task is complete.',
      input_schema: { type: 'object', properties: {} },
    },
  ];

  const history: Anthropic.MessageParam[] = [];

  return {
    async nextAction(snapshot) {
      const userMessage = `Current page:\n\n${snapshot}\n\nLog in, then call "done".`;
      history.push({ role: 'user', content: userMessage });
      const response = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS,
        messages: history,
      });
      history.push({ role: 'assistant', content: response.content });

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        if (block.name === 'fill') {
          const { ref, value } = block.input as { ref: string; value: string };
          return { tool: 'fill', ref, value };
        }
        if (block.name === 'click') {
          const { ref } = block.input as { ref: string };
          return { tool: 'click', ref };
        }
        if (block.name === 'done') return { tool: 'done' };
      }
      return { tool: 'done' };
    },
  };
}

class Transcript {
  readonly entries: string[] = [];
  record(kind: string, payload: unknown): void {
    this.entries.push(`[${kind}] ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }
  assertCredentialsNeverAppeared(): void {
    const body = this.entries.join('\n');
    const email = CREDENTIALS.EMAIL;
    const pass = CREDENTIALS.PASSWORD;
    if (body.includes(email)) throw new Error('LEAK: real EMAIL found in LLM-facing transcript');
    if (body.includes(pass)) throw new Error('LEAK: real PASSWORD found in LLM-facing transcript');
  }
}

async function main() {
  const mode = process.env.BROWSERCLAW_EXAMPLE_MODE === 'live' ? 'live' : 'mock';
  console.log(`[credential-indirection] mode=${mode}`);

  const transcript = new Transcript();
  const driver: Driver = mode === 'live' ? await makeLiveDriver() : new MockDriver();

  const browser = await BrowserClaw.launch({ url: LOGIN_PAGE });
  try {
    const page = await browser.currentPage();

    for (let step = 1; step <= 6; step++) {
      const { snapshot } = await page.snapshot();
      transcript.record('snapshot', snapshot);

      const action = await driver.nextAction(snapshot);
      transcript.record('action', action);

      if (action.tool === 'done') {
        console.log(`[step ${step}] done`);
        break;
      }
      if (action.tool === 'fill') {
        console.log(`[step ${step}] fill`);
        await page.type(action.ref, resolveToken(action.value));
        continue;
      }
      if (action.tool === 'click') {
        console.log(`[step ${step}] click`);
        await page.click(action.ref);
      }
    }

    transcript.assertCredentialsNeverAppeared();
    console.log('\n✓ Credentials never appeared in any message sent to or received from the model.');
  } finally {
    await browser.stop();
  }
}

main().catch(() => {
  console.error('Example failed.');
  process.exit(1);
});
