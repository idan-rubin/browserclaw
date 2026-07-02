import { getPageForTargetId, ensurePageState, normalizeTimeoutMs } from './connection.js';
import type { ChallengeInfo, ChallengeWaitResult } from './types.js';

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
}): Promise<ChallengeInfo | null> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
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
}): Promise<ChallengeWaitResult> {
  const page = await getPageForTargetId({ cdpUrl: opts.cdpUrl, targetId: opts.targetId });
  ensurePageState(page);

  const timeout = normalizeTimeoutMs(opts.timeoutMs, 15000);
  const poll = Math.max(250, Math.min(5000, opts.pollMs ?? 500));

  const isNavigationRaceError = (err: unknown): boolean =>
    err instanceof Error &&
    /execution context was destroyed|because of a navigation|frame was detached/i.test(err.message);

  const detect = async (): Promise<ChallengeInfo | null> => {
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
        return parseChallengeResult(await page.evaluate(DETECT_CHALLENGE_SCRIPT));
      } catch (retryErr) {
        if (isNavigationRaceError(retryErr)) return null;
        throw retryErr;
      }
    }
  };

  // Check if there's actually a challenge present
  const initial = await detect();
  if (initial === null) return { resolved: true, challenge: null };

  // For Cloudflare JS challenges, wait for the title to change (it navigates on success)
  if (initial.kind === 'cloudflare-js') {
    try {
      await page.waitForFunction(
        "document.title.toLowerCase() !== 'just a moment...' && !document.querySelector('#challenge-running')",
        undefined,
        { timeout },
      );
      // Cloudflare redirects after the challenge — let the page settle
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {
        /* page may have already settled */
      });
      const after = await detect();
      return { resolved: after === null, challenge: after };
    } catch {
      const after = await detect();
      return { resolved: after === null, challenge: after };
    }
  }

  // For everything else, poll until challenge disappears or timeout
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await page.waitForTimeout(poll);
    const current = await detect();
    if (current === null) return { resolved: true, challenge: null };
  }

  const final = await detect();
  return { resolved: final === null, challenge: final };
}
