import {
  getPageForTargetId,
  ensurePageState,
  normalizeTimeoutMs,
} from '../connection.js';
import type { ResponseBodyResult } from '../types.js';

function matchBrowserUrlPattern(pattern: string, url: string): boolean {
  if (!pattern || !url) return false;
  if (pattern === url) return true;
  if (pattern.includes('*')) {
    // Convert glob pattern to regex
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
  const pattern = String(opts.url ?? '').trim();
  if (!pattern) throw new Error('url is required');

  const maxChars = typeof opts.maxChars === 'number' && Number.isFinite(opts.maxChars)
    ? Math.max(1, Math.min(5_000_000, Math.floor(opts.maxChars))) : 200000;

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 20000);
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const resp = await new Promise<import('playwright-core').Response>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let handler: ((r: import('playwright-core').Response) => void) | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (handler) page.off('response', handler);
    };

    handler = (r) => {
      if (done) return;
      if (!matchBrowserUrlPattern(pattern, r.url?.() || '')) return;
      done = true;
      cleanup();
      resolve(r);
    };
    page.on('response', handler);
    timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error(`Response not found for url pattern "${pattern}". Use browser.networkRequests() to inspect recent network activity.`));
    }, timeout);
  });

  const url = resp.url?.() || '';
  const status = resp.status?.();
  const headers = resp.headers?.();

  let bodyText = '';
  try {
    if (typeof resp.text === 'function') {
      bodyText = await resp.text();
    } else if (typeof (resp as any).body === 'function') {
      const buf = await (resp as any).body();
      bodyText = new TextDecoder('utf-8').decode(buf);
    }
  } catch (err) {
    throw new Error(`Failed to read response body for "${url}": ${String(err)}`, { cause: err });
  }

  return {
    url,
    status,
    headers,
    body: bodyText.length > maxChars ? bodyText.slice(0, maxChars) : bodyText,
    truncated: bodyText.length > maxChars ? true : undefined,
  };
}
