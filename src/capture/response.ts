import { getPageForTargetId, ensurePageState, normalizeTimeoutMs, truncateUtf16Safe } from '../connection.js';
import type { RequestResult, ResponseBodyResult } from '../types.js';

function resolveMaxChars(maxChars: number | undefined): number {
  return typeof maxChars === 'number' && Number.isFinite(maxChars)
    ? Math.max(1, Math.min(5_000_000, Math.floor(maxChars)))
    : 200000;
}

function matchUrlPattern(pattern: string, url: string): boolean {
  if (!pattern || !url) return false;
  if (pattern === url) return true;
  if (pattern.includes('*')) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
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
  const pattern = opts.url.trim();
  if (!pattern) throw new Error('url is required');

  const response = await page.waitForResponse((resp) => matchUrlPattern(pattern, resp.url()), { timeout });
  const maxChars = resolveMaxChars(opts.maxChars);
  // Decode at most maxBytes so an oversized body cannot force an unbounded string.
  const maxBytes = maxChars * 4;
  let body: string;
  let bodyByteLength = 0;
  try {
    const buf = await response.body();
    bodyByteLength = buf.byteLength;
    body = new TextDecoder('utf-8').decode(buf.subarray(0, maxBytes));
  } catch (err) {
    throw new Error(
      `Failed to read response body for "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let truncated = bodyByteLength > maxBytes;
  if (body.length > maxChars) {
    body = truncateUtf16Safe(body, maxChars);
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

export async function waitForRequestViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  method?: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<RequestResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 30000, 120000);
  const pattern = opts.url.trim();
  if (!pattern) throw new Error('url is required');
  const upperMethod = opts.method !== undefined ? opts.method.toUpperCase() : undefined;

  const response = await page.waitForResponse(
    (resp) =>
      matchUrlPattern(pattern, resp.url()) && (upperMethod === undefined || resp.request().method() === upperMethod),
    { timeout },
  );

  const request = response.request();
  let responseBody: string | undefined;
  let truncated = false;

  try {
    const maxChars = resolveMaxChars(opts.maxChars);
    const maxBytes = maxChars * 4;
    const buf = await response.body();
    responseBody = new TextDecoder('utf-8').decode(buf.subarray(0, maxBytes));
    if (buf.byteLength > maxBytes) truncated = true;
    if (responseBody.length > maxChars) {
      responseBody = truncateUtf16Safe(responseBody, maxChars);
      truncated = true;
    }
  } catch (err) {
    console.warn('[browserclaw] response body unavailable:', err instanceof Error ? err.message : String(err));
  }

  return {
    url: response.url(),
    method: request.method(),
    postData: request.postData() ?? undefined,
    status: response.status(),
    ok: response.ok(),
    responseBody,
    truncated,
  };
}
