import { BrowserClaw } from '../src/index.js';

async function main() {
  // Launch Chrome and navigate
  const browser = await BrowserClaw.launch({ url: 'https://demo.playwright.dev/todomvc' });

  try {
    const page = await browser.currentPage();

    // Take a snapshot — get AI-readable text with numbered refs
    const { snapshot, refs } = await page.snapshot();
    console.log('=== Page Snapshot ===');
    console.log(snapshot);
    console.log('\n=== Refs ===');
    console.log(refs);

    // Find the todo input field and add a todo
    const inputRef = Object.entries(refs).find(
      ([, info]) => info.role === 'textbox' && info.name?.includes('What needs to be done?'),
    );
    if (inputRef) {
      console.log(`\nTyping in ref ${inputRef[0]}: ${inputRef[1].name}`);
      await page.type(inputRef[0], 'Buy groceries', { submit: true });

      // Take another snapshot to see the new todo
      const after = await page.snapshot();
      console.log('\n=== After Adding Todo ===');
      console.log(after.snapshot.slice(0, 500));
    }
  } finally {
    await browser.stop();
  }
}

main().catch(console.error);
