import { BrowserClaw } from '../src/index.js';

async function main() {
  // Launch Chrome
  const browser = await BrowserClaw.launch({ headless: false });

  try {
    // Open a page
    const page = await browser.open('https://example.com');

    // Take a snapshot — get AI-readable text with numbered refs
    const { snapshot, refs } = await page.snapshot();
    console.log('=== Page Snapshot ===');
    console.log(snapshot);
    console.log('\n=== Refs ===');
    console.log(refs);

    // Click the "More information..." link (will be one of the refs)
    const linkRef = Object.entries(refs).find(
      ([, info]) => info.role === 'link' && info.name?.includes('More information'),
    );
    if (linkRef) {
      console.log(`\nClicking ref ${linkRef[0]}: ${linkRef[1].name}`);
      await page.click(linkRef[0]);

      // Wait for navigation
      await page.waitFor({ loadState: 'domcontentloaded' });

      // Take another snapshot
      const after = await page.snapshot();
      console.log('\n=== After Click ===');
      console.log(after.snapshot.slice(0, 500));
    }
  } finally {
    await browser.stop();
  }
}

main().catch(console.error);
