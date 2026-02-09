import {
  getPageForTargetId,
  ensurePageState,
  normalizeTimeoutMs,
} from '../connection.js';
import type { ResponseBodyResult } from '../types.js';

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

  const response = await page.waitForResponse(opts.url, { timeout });
  let body = await response.text();
  let truncated = false;

  if (opts.maxChars && body.length > opts.maxChars) {
    body = body.slice(0, opts.maxChars);
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
