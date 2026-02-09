/**
 * Example: AI Agent Loop with browserclaw
 *
 * Shows how to build an AI agent that:
 * 1. Takes a snapshot of a page
 * 2. Sends the snapshot to an LLM (placeholder)
 * 3. Executes the LLM's chosen action via refs
 * 4. Repeats
 *
 * Replace the `askAI` function with your actual LLM integration.
 */
import { BrowserClaw, type SnapshotResult } from '../src/index.js';

// Placeholder for your AI/LLM integration
async function askAI(snapshot: string, refs: Record<string, any>, task: string): Promise<{
  action: 'click' | 'type' | 'done';
  ref?: string;
  text?: string;
  reasoning: string;
}> {
  // In production, you'd send the snapshot + task to Claude/GPT/etc.
  // The AI reads the snapshot text and picks a ref to act on.
  //
  // Example prompt:
  // "You are browsing a web page. Here is the current page state:
  //  {snapshot}
  //  Available refs: {refs}
  //  Task: {task}
  //  What action should I take? Return JSON: {action, ref?, text?, reasoning}"
  //
  console.log(`[AI] Would analyze snapshot (${snapshot.length} chars) with ${Object.keys(refs).length} refs`);
  console.log(`[AI] Task: ${task}`);
  return { action: 'done', reasoning: 'Demo complete — replace askAI with real LLM call' };
}

async function main() {
  const browser = await BrowserClaw.launch({ headless: false });

  try {
    const page = await browser.open('https://example.com');
    const task = 'Find and click the "More information" link';

    let done = false;
    let step = 0;

    while (!done && step < 10) {
      step++;
      console.log(`\n--- Step ${step} ---`);

      // 1. Take snapshot
      const { snapshot, refs } = await page.snapshot();
      console.log(`Snapshot: ${snapshot.split('\n').length} lines, ${Object.keys(refs).length} refs`);

      // 2. Ask AI what to do
      const decision = await askAI(snapshot, refs, task);
      console.log(`AI decided: ${decision.action} — ${decision.reasoning}`);

      // 3. Execute the action
      switch (decision.action) {
        case 'click':
          if (decision.ref) await page.click(decision.ref);
          break;
        case 'type':
          if (decision.ref && decision.text) await page.type(decision.ref, decision.text);
          break;
        case 'done':
          done = true;
          break;
      }
    }

    console.log('\nAgent loop complete.');
  } finally {
    await browser.stop();
  }
}

main().catch(console.error);
