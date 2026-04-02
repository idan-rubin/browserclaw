/**
 * Browserclaw skill test: StreetEasy studio apartments in Chelsea under $4,500
 */

import { BrowserClaw } from './src/index.js';
import fs from 'fs';

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function waitForLoad(page: Page, label: string) {
  await page.waitFor({ loadState: 'networkidle', timeoutMs: 20000 }).catch(() => log(`load timeout (${label})`));
}

type Page = Awaited<ReturnType<BrowserClaw['currentPage']>>;

async function snapshotWithRetry(page: Page, label: string) {
  for (let i = 0; i < 5; i++) {
    const { snapshot, refs } = await page.snapshot({ interactive: true, compact: true });
    const lines = snapshot.split('\n').filter((l) => l.trim());
    if (lines.length > 3) {
      log(`Snapshot (${label}): ${lines.length} lines`);
      return { snapshot, refs };
    }
    await page.waitFor({ timeMs: 1500 });
  }
  return await page.snapshot({ interactive: true, compact: true });
}

// Ported from browserclaw-agent/src/Services/Browser/src/skills/press-and-hold.ts
// Key insight: click 60px BELOW the BOTTOM of the text element (not the center)
const BUTTON_Y_OFFSET = 60;
const PRESS_HOLD_PATTERN = /press.*hold|hold.*to.*confirm/i;

async function findPressHoldCoords(page: Page) {
  const result = await page.evaluate(`
    (function() {
      var PATTERN = /press.*hold|verify.*human|hold.*to.*confirm|not a bot/i;
      var BUTTON_Y_OFFSET = 60;

      function toCandidate(el, source, offsetX, offsetY) {
        var rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || '').trim().substring(0, 80),
          width: rect.width,
          height: rect.height,
          x: Math.round(rect.left + rect.width / 2 + offsetX),
          y: Math.round(rect.bottom + BUTTON_Y_OFFSET + offsetY),
          tag: el.tagName,
          source: source
        };
      }

      function matchingElements(root, source, offsetX, offsetY) {
        var results = [];
        var all = root.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          var el = all[i];
          if (PATTERN.test((el.innerText || '').trim())) {
            results.push(toCandidate(el, source, offsetX, offsetY));
          }
          if (el.shadowRoot) {
            var shadowAll = el.shadowRoot.querySelectorAll('*');
            for (var s = 0; s < shadowAll.length; s++) {
              if (PATTERN.test((shadowAll[s].innerText || '').trim())) {
                results.push(toCandidate(shadowAll[s], 'shadow', offsetX, offsetY));
              }
            }
          }
        }
        return results;
      }

      function searchIframes() {
        var results = [];
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) {
          try {
            var doc = iframes[i].contentDocument;
            if (doc && doc.body) {
              var rect = iframes[i].getBoundingClientRect();
              results = results.concat(matchingElements(doc, 'iframe', rect.left, rect.top));
            }
          } catch(e) {}
        }
        return results;
      }

      function pickBest(candidates) {
        var best = null;
        for (var i = 0; i < candidates.length; i++) {
          var c = candidates[i];
          if (c.width > 100 && c.height > 20 && c.height < 80) {
            if (!best || c.height < best.height) best = c;
          }
        }
        return best;
      }

      var candidates = matchingElements(document, 'dom', 0, 0).concat(searchIframes());
      var best = pickBest(candidates);
      return JSON.stringify({ found: !!best, best: best, candidates: candidates });
    })()
  `);

  if (!result) return null;
  const parsed = JSON.parse(result);
  log(`Press-hold search: found=${parsed.found}, candidates=${parsed.candidates.length}`);
  parsed.candidates.forEach((c) =>
    log(`  candidate: text="${c.text}" w=${c.width} h=${c.height} tag=${c.tag} source=${c.source} x=${c.x} y=${c.y}`),
  );
  if (!parsed.found || !parsed.best) return null;
  return parsed.best;
}

async function handlePressAndHold(page: Page) {
  const coords = await findPressHoldCoords(page);
  if (!coords) {
    log('Press & Hold button not found');
    return false;
  }

  log(`Best candidate: text="${coords.text}" at (${coords.x}, ${coords.y})`);

  const bufBefore = await page.screenshot();
  fs.writeFileSync('/tmp/se-before-hold.png', bufBefore);
  log('Screenshot before hold: /tmp/se-before-hold.png');

  // Apply jitter (human-like) + humanHoldMs (4-10s)
  const jitterX = coords.x + Math.floor(Math.random() * 20) - 10;
  const jitterY = coords.y + Math.floor(Math.random() * 10) - 5;
  const holdMs = 4000 + Math.floor(Math.random() * 6000);
  const delay = 100 + Math.floor(Math.random() * 200);

  log(`pressAndHold at (${jitterX}, ${jitterY}), delay=${delay}ms, holdMs=${holdMs}ms`);
  const urlBefore = await page.url();
  await page.pressAndHold(jitterX, jitterY, { delay, holdMs });
  log('pressAndHold released');

  await page.waitFor({ timeMs: 2000 });

  // Check if still blocked
  const bodyText = await page.evaluate(`document.body ? (document.body.innerText || '') : ''`);
  const stillBlocked = PRESS_HOLD_PATTERN.test(bodyText);

  const bufAfter = await page.screenshot();
  fs.writeFileSync('/tmp/se-after-hold.png', bufAfter);
  log('Screenshot after hold: /tmp/se-after-hold.png');

  if (stillBlocked) {
    log('Still blocked — refreshing and retrying...');
    await page.goto(urlBefore);
    await page.waitFor({ timeMs: 3000 });
    const bodyText2 = await page.evaluate(`document.body ? (document.body.innerText || '') : ''`);
    const blockedAfterRefresh = PRESS_HOLD_PATTERN.test(bodyText2);
    log(`After refresh: still blocked = ${blockedAfterRefresh}`);
    return !blockedAfterRefresh;
  }

  log('Press & Hold resolved');
  return true;
}

async function main() {
  log('=== STEP 1: Launch browser ===');
  const browser = await BrowserClaw.launch({ headless: false });

  log('=== STEP 2: Navigate to StreetEasy ===');
  const page = await browser.open('https://streeteasy.com');
  await page.waitFor({ timeMs: 4000 });

  let title = await page.title();
  log(`Title: "${title}"`);

  // Take initial screenshot
  const buf0 = await page.screenshot();
  fs.writeFileSync('/tmp/se-initial.png', buf0);
  log('Initial screenshot: /tmp/se-initial.png');

  if (title.includes('denied')) {
    log('Got access denied — attempting press & hold bypass...');
    const resolved = await handlePressAndHold(page);
    if (!resolved) {
      log('Press & hold failed. Page still blocked.');
      await browser.stop();
      return;
    }
    await waitForLoad(page, 'post-challenge');
    title = await page.title();
    log(`Title after challenge resolution: "${title}"`);
  }

  log('=== STEP 3: Verify we have a working page ===');
  const { snapshot: snap0, refs: refs0 } = await snapshotWithRetry(page, 'homepage');
  log(`Snapshot lines: ${snap0.split('\n').filter((l) => l.trim()).length}`);

  if (snap0.includes('no interactive elements')) {
    log('Still no interactive elements. Exiting.');
    await browser.stop();
    return;
  }

  console.log('--- HOMEPAGE SNAPSHOT ---');
  console.log(snap0.substring(0, 2000));
  console.log('--- END ---');

  log('=== STEP 4: Search for Chelsea rentals ===');
  // The homepage already has "Chelsea" selected and "Rent" checked.
  // The main Search button (e79) will take us to Chelsea rentals.
  // The nav search (e42/e43) goes to a generic search — avoid it.

  // Find the main Search button (the one near the Rent/Buy radio and Chelsea chip)
  const mainSearchBtn =
    Object.entries(refs0).find(
      ([, el]) => el.role === 'button' && el.name?.toLowerCase() === 'search' && el.ref !== 'e43',
    ) ||
    Object.entries(refs0)
      .filter(([, el]) => el.role === 'button' && el.name?.toLowerCase() === 'search')
      .pop(); // take last "Search" button (e79 is after the form)

  if (mainSearchBtn) {
    log(`Clicking main Search button: ref=${mainSearchBtn[0]}`);
    await page.click(mainSearchBtn[0]);
    await page.waitFor({ timeMs: 3000 });
    await waitForLoad(page, 'after search');
  } else {
    log('No Search button found — navigating directly to Chelsea for-rent');
    await page.goto('https://streeteasy.com/for-rent/chelsea');
    await page.waitFor({ timeMs: 3000 });
    await waitForLoad(page, 'direct nav');
  }

  // Handle press-and-hold on results page if blocked
  const titleCheck = await page.title();
  if (titleCheck.includes('denied')) {
    log('Results page blocked — applying press-and-hold...');
    const resolved = await handlePressAndHold(page);
    if (!resolved) {
      log('Press & Hold failed on results page — retrying navigation');
      await page.goto('https://streeteasy.com/for-rent/chelsea');
      await page.waitFor({ timeMs: 4000 });
    }
  }

  log('=== STEP 5: Results page ===');
  const url2 = await page.url();
  const title2 = await page.title();
  log(`URL: ${url2}`);
  log(`Title: "${title2}"`);

  const buf2 = await page.screenshot();
  fs.writeFileSync('/tmp/se-results.png', buf2);
  log('Results screenshot: /tmp/se-results.png');

  const { snapshot: snap2, refs: refs2 } = await snapshotWithRetry(page, 'results');
  console.log('--- RESULTS SNAPSHOT ---');
  console.log(snap2.substring(0, 5000));
  console.log('--- END ---');

  log('=== STEP 6: Apply Bedrooms=Studio filter ===');
  // Bedrooms filter is usually a dropdown/button with "Beds" label
  const bedsBtn = Object.entries(refs2).find(
    ([, el]) =>
      el.role === 'button' &&
      (/^beds?$/i.test(el.name || '') || /^bedrooms?$/i.test(el.name || '') || /^studio/i.test(el.name || '')),
  );

  if (bedsBtn) {
    log(`Beds filter button: ref=${bedsBtn[0]}, name="${bedsBtn[1].name}"`);
    await page.click(bedsBtn[0]);
    await page.waitFor({ timeMs: 1000 });

    const { refs: refsBeds } = await page.snapshot({ interactive: true, compact: true });
    const studio = Object.entries(refsBeds).find(([, el]) => /studio/i.test(el.name || ''));
    if (studio) {
      log(`Studio option: ref=${studio[0]}, name="${studio[1].name}"`);
      await page.click(studio[0]);
      await page.waitFor({ timeMs: 1000 });
    }
  } else {
    log('No beds filter button found (may already be in URL)');
  }

  log('=== STEP 7: Apply Price filter ===');
  const { refs: refs3 } = await page.snapshot({ interactive: true, compact: true });

  const priceBtn = Object.entries(refs3).find(([, el]) => el.role === 'button' && /price/i.test(el.name || ''));

  if (priceBtn) {
    log(`Price filter: ref=${priceBtn[0]}, name="${priceBtn[1].name}"`);
    await page.click(priceBtn[0]);
    await page.waitFor({ timeMs: 800 });

    const { refs: refsP } = await page.snapshot({ interactive: true, compact: true });
    const maxInput = Object.entries(refsP).find(
      ([, el]) => /max/i.test(el.name || '') && ['textbox', 'spinbutton', 'combobox'].includes(el.role),
    );
    if (maxInput) {
      log(`Max price: ref=${maxInput[0]}, name="${maxInput[1].name}"`);
      await page.type(maxInput[0], '4500');
    }
  }

  log('=== STEP 8: Final results ===');
  const urlFinal = await page.url();
  log(`Final URL: ${urlFinal}`);

  const { snapshot: snapFinal } = await snapshotWithRetry(page, 'final');
  console.log('--- FINAL SNAPSHOT ---');
  console.log(snapFinal.substring(0, 6000));
  console.log('--- END ---');

  const bufFinal = await page.screenshot();
  fs.writeFileSync('/tmp/se-final.png', bufFinal);
  log('Final screenshot: /tmp/se-final.png');

  // Extract listings from DOM
  const items = await page.evaluate(`
    (() => {
      const sels = [
        '[data-testid*="listing"]', '[class*="ListingCard"]', '[class*="listing-card"]',
        '.searchResultItem', '[class*="SearchResult"]', 'article',
      ];
      let cards = [];
      for (const s of sels) {
        const f = document.querySelectorAll(s);
        if (f.length > 2) { cards = f; break; }
      }
      return Array.from(cards).slice(0, 15).map(el => ({
        price: el.querySelector('[class*="price"],[class*="Price"]')?.textContent?.trim(),
        address: el.querySelector('[class*="address"],[class*="Address"],h2,h3')?.textContent?.trim(),
        href: el.querySelector('a')?.href,
      })).filter(i => i.price || i.address);
    })()
  `);

  log(`Extracted ${items.length} listings:`);
  console.log(JSON.stringify(items, null, 2));

  await browser.stop();
  log('=== DONE ===');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
