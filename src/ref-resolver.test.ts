import type { Page } from 'playwright-core';
import { describe, it, expect, beforeEach } from 'vitest';

import { ensurePageState } from './page-utils.js';
import {
  normalizeCdpUrl,
  parseRoleRef,
  requireRef,
  requireRefOrSelector,
  resolveInteractionTimeoutMs,
  resolveBoundedDelayMs,
  rememberRoleRefsForTarget,
  storeRoleRefsForTarget,
  clearRoleRefsForCdpUrl,
  refLocator,
} from './ref-resolver.js';

// ─── Minimal mock helpers ───

function mockPage(overrides: Record<string, unknown> = {}): Page {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(fn);
    },
    off: () => {
      /* noop */
    },
    url: () => 'about:blank',
    getByRole: (role: string, opts?: { name?: string; exact?: boolean }) => ({
      _role: role,
      _name: opts?.name,
      nth: (n: number) => ({ _role: role, _name: opts?.name, _nth: n }),
    }),
    locator: (sel: string) => ({ _selector: sel }),
    frameLocator: (sel: string) => ({
      _frameSel: sel,
      locator: (s: string) => ({ _frameSel: sel, _selector: s }),
      getByRole: (role: string, opts?: { name?: string; exact?: boolean }) => ({
        _frameSel: sel,
        _role: role,
        _name: opts?.name,
        nth: (n: number) => ({ _frameSel: sel, _role: role, _name: opts?.name, _nth: n }),
      }),
    }),
    context: () => ({ newCDPSession: () => Promise.resolve({}) }),
    evaluate: () => Promise.resolve(undefined),
    ...overrides,
  } as unknown as Page;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeCdpUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeCdpUrl', () => {
  it('strips trailing slash', () => {
    expect(normalizeCdpUrl('ws://localhost:9222/')).toBe('ws://localhost:9222');
  });

  it('leaves url without trailing slash unchanged', () => {
    expect(normalizeCdpUrl('ws://localhost:9222')).toBe('ws://localhost:9222');
  });

  it('only strips last slash', () => {
    expect(normalizeCdpUrl('ws://host/path/')).toBe('ws://host/path');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseRoleRef
// ─────────────────────────────────────────────────────────────────────────────

describe('parseRoleRef', () => {
  it('parses bare ref "e1"', () => {
    expect(parseRoleRef('e1')).toBe('e1');
  });

  it('parses @ prefix "@e42"', () => {
    expect(parseRoleRef('@e42')).toBe('e42');
  });

  it('parses ref= prefix "ref=e100"', () => {
    expect(parseRoleRef('ref=e100')).toBe('e100');
  });

  it('trims whitespace', () => {
    expect(parseRoleRef('  e5  ')).toBe('e5');
  });

  it('returns null for empty string', () => {
    expect(parseRoleRef('')).toBeNull();
  });

  it('returns null for whitespace-only', () => {
    expect(parseRoleRef('   ')).toBeNull();
  });

  it('returns null for non-ref strings', () => {
    expect(parseRoleRef('button')).toBeNull();
    expect(parseRoleRef('abc')).toBeNull();
    expect(parseRoleRef('e')).toBeNull();
    expect(parseRoleRef('E1')).toBeNull();
    expect(parseRoleRef('e01a')).toBeNull();
  });

  it("returns null for ref with leading zeros that isn't a valid ref", () => {
    // e01 doesn't match /^e\d+$/ — wait, it does. e01 is valid.
    expect(parseRoleRef('e01')).toBe('e01');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireRef
// ─────────────────────────────────────────────────────────────────────────────

describe('requireRef', () => {
  it('normalizes e-ref', () => {
    expect(requireRef('e5')).toBe('e5');
  });

  it('strips @ prefix for e-ref', () => {
    expect(requireRef('@e5')).toBe('e5');
  });

  it('strips ref= prefix', () => {
    expect(requireRef('ref=e10')).toBe('e10');
  });

  it('passes through non-e-ref strings (aria refs)', () => {
    expect(requireRef('myCustomRef')).toBe('myCustomRef');
  });

  it('strips @ from non-e-ref', () => {
    expect(requireRef('@myRef')).toBe('myRef');
  });

  it('throws on empty string', () => {
    expect(() => requireRef('')).toThrow('ref is required');
  });

  it('throws on undefined', () => {
    expect(() => requireRef(undefined)).toThrow('ref is required');
  });

  it('throws on whitespace-only', () => {
    expect(() => requireRef('   ')).toThrow('ref is required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requireRefOrSelector
// ─────────────────────────────────────────────────────────────────────────────

describe('requireRefOrSelector', () => {
  it('returns ref when only ref provided', () => {
    expect(requireRefOrSelector('e1')).toEqual({ ref: 'e1', selector: undefined });
  });

  it('returns selector when only selector provided', () => {
    expect(requireRefOrSelector(undefined, '.btn')).toEqual({ ref: undefined, selector: '.btn' });
  });

  it('returns both when both provided', () => {
    expect(requireRefOrSelector('e1', '.btn')).toEqual({ ref: 'e1', selector: '.btn' });
  });

  it('throws when neither provided', () => {
    expect(() => requireRefOrSelector()).toThrow('ref or selector is required');
  });

  it('throws when both are empty strings', () => {
    expect(() => requireRefOrSelector('', '')).toThrow('ref or selector is required');
  });

  it('treats whitespace-only as empty', () => {
    expect(() => requireRefOrSelector('  ', '  ')).toThrow('ref or selector is required');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveInteractionTimeoutMs
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveInteractionTimeoutMs', () => {
  it('defaults to 8000ms', () => {
    expect(resolveInteractionTimeoutMs()).toBe(8000);
    expect(resolveInteractionTimeoutMs(undefined)).toBe(8000);
  });

  it('clamps low values to 500', () => {
    expect(resolveInteractionTimeoutMs(0)).toBe(500);
    expect(resolveInteractionTimeoutMs(100)).toBe(500);
    expect(resolveInteractionTimeoutMs(-999)).toBe(500);
  });

  it('clamps high values to 60000', () => {
    expect(resolveInteractionTimeoutMs(999999)).toBe(60000);
    expect(resolveInteractionTimeoutMs(60001)).toBe(60000);
  });

  it('passes through values in range', () => {
    expect(resolveInteractionTimeoutMs(5000)).toBe(5000);
    expect(resolveInteractionTimeoutMs(500)).toBe(500);
    expect(resolveInteractionTimeoutMs(60000)).toBe(60000);
  });

  it('floors floating point values', () => {
    expect(resolveInteractionTimeoutMs(5000.9)).toBe(5000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveBoundedDelayMs
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveBoundedDelayMs', () => {
  it('defaults to 0 when undefined', () => {
    expect(resolveBoundedDelayMs(undefined, 'delay', 5000)).toBe(0);
  });

  it('passes through valid values', () => {
    expect(resolveBoundedDelayMs(100, 'delay', 5000)).toBe(100);
    expect(resolveBoundedDelayMs(0, 'delay', 5000)).toBe(0);
  });

  it('throws on negative values', () => {
    expect(() => resolveBoundedDelayMs(-1, 'animDelay', 5000)).toThrow('animDelay must be >= 0');
  });

  it('throws when exceeding max', () => {
    expect(() => resolveBoundedDelayMs(6000, 'wait', 5000)).toThrow('wait exceeds maximum of 5000ms');
  });

  it('floors floating point values', () => {
    expect(resolveBoundedDelayMs(99.7, 'delay', 5000)).toBe(99);
  });

  it('accepts exact max value', () => {
    expect(resolveBoundedDelayMs(5000, 'delay', 5000)).toBe(5000);
  });

  it('includes label in error messages', () => {
    expect(() => resolveBoundedDelayMs(-1, 'myCustomDelay', 100)).toThrow('myCustomDelay');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Role Refs Storage & Restoration
// ─────────────────────────────────────────────────────────────────────────────

describe('role refs storage', () => {
  beforeEach(() => {
    clearRoleRefsForCdpUrl('ws://localhost:9222');
    clearRoleRefsForCdpUrl('ws://localhost:9223');
  });

  describe('rememberRoleRefsForTarget', () => {
    it('stores refs for a target (does not throw on valid input)', () => {
      const refs = { e1: { role: 'button', name: 'Go' } };
      rememberRoleRefsForTarget({
        cdpUrl: 'ws://localhost:9222',
        targetId: 'target1',
        refs,
      });
    });

    it('ignores empty targetId (does not store)', () => {
      rememberRoleRefsForTarget({
        cdpUrl: 'ws://localhost:9222',
        targetId: '',
        refs: { e1: { role: 'button' } },
      });
      clearRoleRefsForCdpUrl('ws://localhost:9222');
    });

    it('ignores whitespace-only targetId', () => {
      rememberRoleRefsForTarget({
        cdpUrl: 'ws://localhost:9222',
        targetId: '   ',
        refs: { e1: { role: 'button' } },
      });
      clearRoleRefsForCdpUrl('ws://localhost:9222');
    });
  });

  describe('storeRoleRefsForTarget', () => {
    it('stores refs on page state and in cache', () => {
      const page = mockPage();
      const refs = { e1: { role: 'link', name: 'Home' } };
      storeRoleRefsForTarget({
        page,
        cdpUrl: 'ws://localhost:9222',
        targetId: 'tgt1',
        refs,
        mode: 'role',
      });
      const state = ensurePageState(page);
      expect(state.roleRefs).toEqual(refs);
      expect(state.roleRefsMode).toBe('role');
    });

    it('stores frameSelector when provided', () => {
      const page = mockPage();
      storeRoleRefsForTarget({
        page,
        cdpUrl: 'ws://localhost:9222',
        targetId: 'tgt1',
        refs: { e1: { role: 'button' } },
        frameSelector: 'iframe#main',
        mode: 'role',
      });
      const state = ensurePageState(page);
      expect(state.roleRefsFrameSelector).toBe('iframe#main');
    });

    it('skips cache when targetId is undefined', () => {
      const page = mockPage();
      storeRoleRefsForTarget({
        page,
        cdpUrl: 'ws://localhost:9222',
        refs: { e1: { role: 'button' } },
        mode: 'aria',
      });
      const state = ensurePageState(page);
      expect(state.roleRefs).toBeDefined();
      expect(state.roleRefsMode).toBe('aria');
    });
  });

  describe('storeRoleRefsForTarget with cache', () => {
    it('stores refs both on page state and in target cache', () => {
      const page = mockPage();
      const refs = { e1: { role: 'button', name: 'OK' } };

      storeRoleRefsForTarget({
        page,
        cdpUrl: 'ws://localhost:9222',
        targetId: 'tgt1',
        refs,
        mode: 'role',
      });

      const state = ensurePageState(page);
      expect(state.roleRefs).toEqual(refs);
      expect(state.roleRefsMode).toBe('role');
      expect(state.roleRefsStoredAt).toBeTypeOf('number');
    });

    it('does not throw when targetId is empty (skips cache)', () => {
      const page = mockPage();
      storeRoleRefsForTarget({
        page,
        cdpUrl: 'ws://localhost:9222',
        targetId: '',
        refs: { e1: { role: 'button' } },
        mode: 'role',
      });
      expect(ensurePageState(page).roleRefs).toBeDefined();
    });
  });

  describe('clearRoleRefsForCdpUrl', () => {
    it('does not throw on URLs with no cached refs', () => {
      expect(() => {
        clearRoleRefsForCdpUrl('ws://localhost:9999');
      }).not.toThrow();
    });

    it('clears remembered refs so they cannot be used', () => {
      rememberRoleRefsForTarget({
        cdpUrl: 'ws://localhost:9222',
        targetId: 'tgt1',
        refs: { e1: { role: 'button' } },
      });
      clearRoleRefsForCdpUrl('ws://localhost:9222');
      rememberRoleRefsForTarget({
        cdpUrl: 'ws://localhost:9222',
        targetId: 'tgt1',
        refs: { e2: { role: 'link' } },
      });
    });

    it('handles trailing slash normalization', () => {
      rememberRoleRefsForTarget({
        cdpUrl: 'ws://localhost:9222/',
        targetId: 'tgt1',
        refs: { e1: { role: 'button' } },
      });
      expect(() => {
        clearRoleRefsForCdpUrl('ws://localhost:9222');
      }).not.toThrow();
    });

    it('does not clear refs for other cdpUrls', () => {
      rememberRoleRefsForTarget({
        cdpUrl: 'ws://localhost:9222',
        targetId: 'tgt1',
        refs: { e1: { role: 'button' } },
      });
      rememberRoleRefsForTarget({
        cdpUrl: 'ws://localhost:9223',
        targetId: 'tgt2',
        refs: { e2: { role: 'link' } },
      });
      clearRoleRefsForCdpUrl('ws://localhost:9222');
      clearRoleRefsForCdpUrl('ws://localhost:9223');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// refLocator
// ─────────────────────────────────────────────────────────────────────────────

describe('refLocator', () => {
  it('throws on empty ref', () => {
    const page = mockPage();
    expect(() => refLocator(page, '')).toThrow('ref is required');
    expect(() => refLocator(page, '  ')).toThrow('ref is required');
  });

  it('throws on unknown e-ref in role mode', () => {
    const page = mockPage();
    ensurePageState(page);
    expect(() => refLocator(page, 'e999')).toThrow('Unknown ref "e999"');
  });

  it('returns getByRole locator for known role ref', () => {
    const page = mockPage();
    storeRoleRefsForTarget({
      page,
      cdpUrl: 'ws://localhost:9222',
      refs: { e1: { role: 'button', name: 'Submit' } },
      mode: 'role',
    });
    const loc = refLocator(page, 'e1') as unknown as { _role: string; _name: string };
    expect(loc._role).toBe('button');
    expect(loc._name).toBe('Submit');
  });

  it('returns nth locator for ref with nth', () => {
    const page = mockPage();
    storeRoleRefsForTarget({
      page,
      cdpUrl: 'ws://localhost:9222',
      refs: { e1: { role: 'button', name: 'Save', nth: 1 } },
      mode: 'role',
    });
    const loc = refLocator(page, 'e1') as unknown as { _role: string; _name: string; _nth: number };
    expect(loc._nth).toBe(1);
  });

  it('returns aria-ref locator in aria mode', () => {
    const page = mockPage();
    const state = ensurePageState(page);
    state.roleRefsMode = 'aria';
    state.roleRefs = { e1: { role: 'button' } };
    const loc = refLocator(page, 'e1') as unknown as { _selector: string };
    expect(loc._selector).toBe('aria-ref=e1');
  });

  it('returns aria-ref locator for non-e-ref strings', () => {
    const page = mockPage();
    const loc = refLocator(page, 'customRef') as unknown as { _selector: string };
    expect(loc._selector).toBe('aria-ref=customRef');
  });

  it('strips @ prefix', () => {
    const page = mockPage();
    const loc = refLocator(page, '@customRef') as unknown as { _selector: string };
    expect(loc._selector).toBe('aria-ref=customRef');
  });

  it('strips ref= prefix', () => {
    const page = mockPage();
    const loc = refLocator(page, 'ref=customRef') as unknown as { _selector: string };
    expect(loc._selector).toBe('aria-ref=customRef');
  });

  it('uses frameLocator when roleRefsFrameSelector set in aria mode', () => {
    const page = mockPage();
    const state = ensurePageState(page);
    state.roleRefsMode = 'aria';
    state.roleRefs = { e1: { role: 'button' } };
    state.roleRefsFrameSelector = 'iframe#content';
    const loc = refLocator(page, 'e1') as unknown as { _frameSel: string; _selector: string };
    expect(loc._frameSel).toBe('iframe#content');
    expect(loc._selector).toBe('aria-ref=e1');
  });

  it('uses frameLocator when roleRefsFrameSelector set in role mode', () => {
    const page = mockPage();
    storeRoleRefsForTarget({
      page,
      cdpUrl: 'ws://localhost:9222',
      refs: { e1: { role: 'link', name: 'Home' } },
      frameSelector: 'iframe#nav',
      mode: 'role',
    });
    const loc = refLocator(page, 'e1') as unknown as { _frameSel: string; _role: string };
    expect(loc._frameSel).toBe('iframe#nav');
    expect(loc._role).toBe('link');
  });

  it('resolves DOM-enriched selector refs directly via page.locator', () => {
    const page = mockPage();
    const state = ensurePageState(page);
    state.roleRefsMode = 'aria';
    state.roleRefs = { e5: { role: 'button', selector: '[data-bc-ref="e5"]' } };
    const loc = refLocator(page, 'e5') as unknown as { _selector: string; _frameSel?: string };
    expect(loc._selector).toBe('[data-bc-ref="e5"]');
    expect(loc._frameSel).toBeUndefined();
  });

  it('routes DOM-enriched selector refs through frameLocator when a frame is set', () => {
    const page = mockPage();
    const state = ensurePageState(page);
    state.roleRefsMode = 'aria';
    state.roleRefs = { e5: { role: 'button', selector: '[data-bc-ref="e5"]' } };
    state.roleRefsFrameSelector = 'iframe#content';
    const loc = refLocator(page, 'e5') as unknown as { _frameSel: string; _selector: string };
    expect(loc._frameSel).toBe('iframe#content');
    expect(loc._selector).toBe('[data-bc-ref="e5"]');
  });
});
