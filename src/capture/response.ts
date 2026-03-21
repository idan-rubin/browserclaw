import {
  getPageForTargetId,
  ensurePageState,
  normalizeTimeoutMs,
} from '../connection.js';
import type { ResponseBodyResult } from '../types.js';

function matchUrlPattern(pattern: string, url: string): boolean {
  if (!pattern || !url) return false;
  if (pattern === url) return true;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
      return new RegExp(`^${escaped}$`).test(url);
    } catch {
      return false;
    }
  }
  return url.includes(pattern);
}

export async function responseBodyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<ResponseBodyResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 30000, 120000);
  const pattern = String(opts.url ?? '').trim();
  if (!pattern) throw new Error('url is required');

  const response = await page.waitForResponse(
    (resp) => matchUrlPattern(pattern, resp.url()),
    { timeout },
  );
  let body = await response.text();
  let truncated = false;

  const maxChars = typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars)
    ? Math.max(1, Math.min(5_000_000, Math.floor(opts.maxChars))) : 200000;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    truncated = true;
  }

  const headers: Record<string, string> = {};
  const allHeaders = response.headers();
  for (const [key, value] of Object.entries(allHeaders)) {
    headers[key] = value;
  }

  return {
    url: response.url(),
    status: response.status(),
    headers,
    body,
    truncated,
  };
}
