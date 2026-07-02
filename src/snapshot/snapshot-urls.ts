import type { Page } from 'playwright-core';

export interface SnapshotUrlEntry {
  text: string;
  url: string;
}

export function appendSnapshotUrls(snapshot: string, urls: SnapshotUrlEntry[]): string {
  if (urls.length === 0) return snapshot;
  const lines = urls.map((e, i) => `${String(i + 1)}. ${e.text} -> ${e.url}`).join('\n');
  return `${snapshot}\n\nLinks:\n${lines}`;
}

export async function collectSnapshotUrls(page: Page): Promise<SnapshotUrlEntry[]> {
  try {
    const raw = await page.evaluate(() => {
      const out: { text: string; url: string }[] = [];
      const seen = new Set<string>();
      for (const a of Array.from(document.querySelectorAll('a[href]'))) {
        const url = (a as HTMLAnchorElement).href;
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const cleaned = (a.textContent || (a.getAttribute('aria-label') ?? '')).replace(/\s+/g, ' ').trim();
        const text = (cleaned || url).slice(0, 120);
        out.push({ text, url });
        if (out.length >= 100) break;
      }
      return out;
    });
    if (!Array.isArray(raw)) return [];
    // Strip control chars so page-controlled link text/urls cannot inject lines into the untrusted snapshot.
    return raw.map((e) => ({
      text: e.text.replace(/[\r\n\t]+/g, ' ').slice(0, 120),
      url: e.url.replace(/[\r\n\t]+/g, ' ').trim(),
    }));
  } catch {
    return [];
  }
}
