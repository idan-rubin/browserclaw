import { getPageForTargetId, ensurePageState, normalizeTimeoutMs, truncateUtf16Safe } from '../connection.js';
import type { RequestResult, ResponseBodyResult, SsrfPolicy } from '../types.js';

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
  signal?: AbortSignal;
  ssrfPolicy?: SsrfPolicy;
}): Promise<ResponseBodyResult> {
  opts.signal?.throwIfAborted();
  const page = await getPageForTargetId(opts);
  opts.signal?.throwIfAborted();
  ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 30000, 120000);
  const pattern = opts.url.trim();
  if (!pattern) throw new Error('url is required');

  // The budget covers both response headers and body completion. A response
  // event alone does not mean a streaming body will ever finish.
  let matched = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClose = () => {
    /* installed synchronously below */
  };
  let onAbort = () => {
    /* installed synchronously below */
  };
  const interrupted = new Promise<never>((_, reject) => {
    onClose = () => {
      reject(new Error('Page closed before response body was available.'));
    };
    onAbort = () => {
      const reason: unknown = opts.signal?.reason;
      reject(reason instanceof Error ? reason : new Error('Response request aborted.', { cause: reason }));
    };
    timer = setTimeout(() => {
      reject(
        new Error(
          `${matched ? 'Response body' : 'Response'} timed out after ${String(timeout)}ms for url pattern "${pattern}".`,
        ),
      );
    }, timeout);
    page.on('close', onClose);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted === true) onAbort();
  });
  const read = async () => {
    const response = await page.waitForResponse((resp) => matchUrlPattern(pattern, resp.url()), { timeout });
    matched = true;
    try {
      return { response, buffer: await response.body() };
    } catch (err) {
      throw new Error(
        `Failed to read response body for "${pattern}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  };
  let captured: Awaited<ReturnType<typeof read>>;
  try {
    captured = await Promise.race([read(), interrupted]);
  } finally {
    clearTimeout(timer);
    page.off('close', onClose);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const { response, buffer } = captured;
  const maxChars = resolveMaxChars(opts.maxChars);
  // Decode at most maxBytes so an oversized body cannot force an unbounded string.
  const maxBytes = maxChars * 4;
  let body = new TextDecoder('utf-8').decode(buffer.subarray(0, maxBytes));
  const bodyByteLength = buffer.byteLength;
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
  ssrfPolicy?: SsrfPolicy;
}): Promise<RequestResult> {
  const page = await getPageForTargetId(opts);
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
