import { getPageForTargetId, ensurePageState, normalizeTimeoutMs, assertSelectedPageAllowed } from './connection.js';
import type { ChallengeInfo, ChallengeWaitResult, SsrfPolicy } from './types.js';

// ── Detection script (runs in browser context) ──

const DETECT_CHALLENGE_SCRIPT = `(function() {
  var title = (document.title || '').toLowerCase();

  // Cloudflare JS challenge
  if (title === 'just a moment...'
      || document.querySelector('#challenge-running, #cf-please-wait, #challenge-form')
      || title.indexOf('checking your browser') !== -1) {
    return { kind: 'cloudflare-js', message: 'Cloudflare JS challenge' };
  }

  // Cloudflare block page (needs body text — read lazily)
  var body = null;
  function getBody() { if (body === null) body = (document.body && document.body.textContent) || ''; return body; }

  if (title.indexOf('attention required') !== -1
      || (document.querySelector('.cf-error-details') && getBody().indexOf('blocked') !== -1)) {
    return { kind: 'cloudflare-block', message: 'Cloudflare block page' };
  }

  // Widget-only challenges count only when they dominate a sparse page (interstitial), not embedded in a usable one
  if (document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') && getBody().length < 2000) {
    return { kind: 'cloudflare-turnstile', message: 'Cloudflare Turnstile challenge' };
  }

  if (document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]') && getBody().length < 2000) {
    return { kind: 'hcaptcha', message: 'hCaptcha challenge' };
  }

  if (document.querySelector('.g-recaptcha, iframe[src*="google.com/recaptcha"]') && getBody().length < 2000) {
    return { kind: 'recaptcha', message: 'reCAPTCHA challenge' };
  }

  // Generic access-denied / rate-limit pages (only read body for short pages)
  var b = getBody();
  if (b.length < 5000) {
    if (/access denied|403 forbidden/i.test(title) || /access denied/i.test(b)) {
      return { kind: 'blocked', message: 'Access denied' };
    }
    if (/\\b429\\b/i.test(title) || /too many requests|rate limit/i.test(b)) {
      return { kind: 'rate-limited', message: 'Rate limited' };
    }
  }

  return null;
})()`;

function parseChallengeResult(raw: unknown): ChallengeInfo | null {
  if (raw !== null && typeof raw === 'object' && 'kind' in (raw as Record<string, unknown>)) {
    return raw as ChallengeInfo;
  }
  return null;
}

/**
 * Detect whether the current page is showing an anti-bot challenge.
 * Returns `null` if no challenge is detected.
 */
export async function detectChallengeViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ssrfPolicy?: SsrfPolicy;
}): Promise<ChallengeInfo | null> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: opts.ssrfPolicy });
  ensurePageState(page);
  return parseChallengeResult(await page.evaluate(DETECT_CHALLENGE_SCRIPT));
}

/**
 * Wait for an anti-bot challenge to resolve on its own (e.g. Cloudflare JS challenge).
 *
 * Returns `{ resolved: true }` if the challenge cleared within the timeout,
 * or `{ resolved: false, challenge }` with the still-present challenge info.
 *
 * For challenges that require human interaction (CAPTCHA), this will time out
 * unless the user solves the challenge in the visible browser window.
 */
export async function waitForChallengeViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  pollMs?: number;
  ssrfPolicy?: SsrfPolicy;
}): Promise<ChallengeWaitResult> {
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 15000);
  const deadline = Date.now() + timeout;
  const controller = new AbortController();
  const withinDeadline = async <T>(task: () => Promise<T>): Promise<T> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new ChallengeWaitTimeoutError(timeout);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const error = new ChallengeWaitTimeoutError(timeout);
            controller.abort(error);
            reject(error);
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const page = await withinDeadline(() =>
    getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, ssrfPolicy: opts.ssrfPolicy }),
  );
  ensurePageState(page);
  const poll = Math.max(250, Math.min(5000, opts.pollMs ?? 500));

  const isNavigationRaceError = (err: unknown): boolean =>
    err instanceof Error &&
    /execution context was destroyed|because of a navigation|frame was detached/i.test(err.message);

  const detect = async (): Promise<ChallengeInfo | null> => {
    await assertSelectedPageAllowed({
      cdpUrl: opts.cdpUrl,
      page,
      targetId: opts.targetId,
      ssrfPolicy: opts.ssrfPolicy,
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    try {
      return parseChallengeResult(await page.evaluate(DETECT_CHALLENGE_SCRIPT));
    } catch (err) {
      // Only a navigation race (context destroyed by a redirect) is treated as
      // "re-check"; a closed tab, crash, or CDP disconnect must propagate.
      if (!isNavigationRaceError(err)) throw err;
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {
        /* best-effort settle */
      });
      try {
        await assertSelectedPageAllowed({
          cdpUrl: opts.cdpUrl,
          page,
          targetId: opts.targetId,
          ssrfPolicy: opts.ssrfPolicy,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        return parseChallengeResult(await page.evaluate(DETECT_CHALLENGE_SCRIPT));
      } catch (retryErr) {
        if (isNavigationRaceError(retryErr)) return null;
        throw retryErr;
      }
    }
  };

  // Check if there's actually a challenge present
  const initial = await withinDeadline(detect);
  if (initial === null) return { resolved: true, challenge: null };

  // Poll every challenge through the same policy-checked read path, including redirects.
  let current: ChallengeInfo | null = initial;
  while (Date.now() < deadline) {
    try {
      await withinDeadline(() => page.waitForTimeout(Math.min(poll, deadline - Date.now())));
      current = await withinDeadline(detect);
    } catch (error) {
      if (error instanceof ChallengeWaitTimeoutError) break;
      throw error;
    }
    if (current === null) return { resolved: true, challenge: null };
  }

  return { resolved: false, challenge: current };
}

class ChallengeWaitTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Challenge wait timed out after ${String(timeoutMs)}ms`);
    this.name = 'ChallengeWaitTimeoutError';
  }
}
