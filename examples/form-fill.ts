import { BrowserClaw } from '../src/index.js';

async function main() {
  const browser = await BrowserClaw.launch({ headless: false });

  try {
    // Open a page with a form
    const page = await browser.open('https://httpbin.org/forms/post');

    // Take a snapshot to see form fields
    const { snapshot, refs } = await page.snapshot();
    console.log('=== Form Snapshot ===');
    console.log(snapshot);
    console.log('\n=== Refs ===');
    console.log(JSON.stringify(refs, null, 2));

    // Find form fields by role
    const textboxes = Object.entries(refs).filter(([, info]) => info.role === 'textbox');
    console.log(`\nFound ${textboxes.length} text fields`);

    // Fill all fields at once using page.fill()
    const fields = textboxes.map(([ref, info]) => ({
      ref,
      type: 'text' as const,
      value: info.name === 'Customer name' ? 'Jane Doe'
        : info.name === 'Telephone' ? '555-1234'
          : info.name === 'E-mail address' ? 'jane@example.com'
            : 'test',
    }));

    console.log('\nBatch filling fields:');
    for (const f of fields) console.log(`  ${f.ref}: ${f.value}`);
    await page.fill(fields);

    // Take screenshot to verify
    const screenshot = await page.screenshot();
    console.log(`\nScreenshot taken: ${screenshot.length} bytes`);
  } finally {
    await browser.stop();
  }
}

main().catch(console.error);
