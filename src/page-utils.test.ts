import { describe, it, expect } from 'vitest';

import {
  normalizeTimeoutMs,
  toAIFriendlyError,
  bumpUploadArmId,
  bumpDialogArmId,
  bumpDownloadArmId,
  findNetworkRequestById,
  ensurePageState,
  ensureContextState,
} from './page-utils.js';
import type { PageState, NetworkRequest } from './types.js';

// ─── Minimal mocks ───

function mockPage(): import('playwright-core').Page {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(fn);
    },
    off: () => {},
    url: () => 'about:blank',
    evaluate: async () => undefined,
    context: () => ({ newCDPSession: async () => ({}) }),
  } as unknown as import('playwright-core').Page;
}

function mockContext(): import('playwright-core').BrowserContext {
  return {
    pages: () => [],
    on: () => {},
    addInitScript: async () => {},
  } as unknown as import('playwright-core').BrowserContext;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeTimeoutMs
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeTimeoutMs', () => {
  it('uses fallback when undefined', () => {
    expect(normalizeTimeoutMs(undefined, 5000)).toBe(5000);
  });

  it('uses provided value when defined', () => {
    expect(normalizeTimeoutMs(10000, 5000)).toBe(10000);
  });

  it('clamps to minimum 500ms', () => {
    expect(normalizeTimeoutMs(0, 5000)).toBe(500);
    expect(normalizeTimeoutMs(100, 5000)).toBe(500);
    expect(normalizeTimeoutMs(-999, 5000)).toBe(500);
  });

  it('clamps to default max 120000ms', () => {
    expect(normalizeTimeoutMs(999999, 5000)).toBe(120000);
  });

  it('clamps to custom max', () => {
    expect(normalizeTimeoutMs(10000, 5000, 8000)).toBe(8000);
  });

  it('accepts exact boundary values', () => {
    expect(normalizeTimeoutMs(500, 5000)).toBe(500);
    expect(normalizeTimeoutMs(120000, 5000)).toBe(120000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toAIFriendlyError
// ─────────────────────────────────────────────────────────────────────────────

describe('toAIFriendlyError', () => {
  it('transforms strict mode violation', () => {
    const err = new Error('locator(foo).click: strict mode violation, resolved to 3 elements');
    const result = toAIFriendlyError(err, 'e5');
    expect(result.message).toContain('matched 3 elements');
    expect(result.message).toContain('e5');
    expect(result.message).toContain('snapshot');
  });

  it('transforms strict mode violation without count', () => {
    const err = new Error('strict mode violation');
    const result = toAIFriendlyError(err, 'e1');
    expect(result.message).toContain('matched multiple elements');
  });

  it('transforms timeout with visibility issue', () => {
    const err = new Error('Timeout 8000ms exceeded waiting for to be visible');
    const result = toAIFriendlyError(err, '.btn');
    expect(result.message).toContain('not found or not visible');
    expect(result.message).toContain('.btn');
  });

  it('transforms not visible error', () => {
    const err = new Error('element is not visible');
    const result = toAIFriendlyError(err, 'e3');
    expect(result.message).toContain('not interactable');
  });

  it('transforms pointer interception error', () => {
    const err = new Error('element intercepts pointer events');
    const result = toAIFriendlyError(err, 'e7');
    expect(result.message).toContain('not interactable');
    expect(result.message).toContain('hidden or covered');
  });

  it('transforms generic timeout', () => {
    const err = new Error('Timeout 5000ms exceeded');
    const result = toAIFriendlyError(err, 'e2');
    expect(result.message).toContain('timed out after 5000ms');
  });

  it('strips locator internals from unknown errors', () => {
    const err = new Error('locator(#foo).click: something went wrong');
    const result = toAIFriendlyError(err, '#foo');
    expect(result.message).not.toContain('locator(');
  });

  it('handles non-Error inputs', () => {
    const result = toAIFriendlyError('string error', 'e1');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('string error');
  });

  it('handles null/undefined inputs', () => {
    const result = toAIFriendlyError(null, 'e1');
    expect(result).toBeInstanceOf(Error);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Arm ID bumping
// ─────────────────────────────────────────────────────────────────────────────

describe('arm ID bumping', () => {
  function makeState(): PageState {
    return {
      console: [],
      errors: [],
      requests: [],
      requestIds: new WeakMap(),
      nextRequestId: 0,
      armIdUpload: 0,
      armIdDialog: 0,
      armIdDownload: 0,
      nextArmIdUpload: 0,
      nextArmIdDialog: 0,
      nextArmIdDownload: 0,
    };
  }

  it('bumpUploadArmId increments and returns new value', () => {
    const state = makeState();
    expect(bumpUploadArmId(state)).toBe(1);
    expect(bumpUploadArmId(state)).toBe(2);
    expect(state.nextArmIdUpload).toBe(2);
  });

  it('bumpDialogArmId increments and returns new value', () => {
    const state = makeState();
    expect(bumpDialogArmId(state)).toBe(1);
    expect(bumpDialogArmId(state)).toBe(2);
    expect(state.nextArmIdDialog).toBe(2);
  });

  it('bumpDownloadArmId increments and returns new value', () => {
    const state = makeState();
    expect(bumpDownloadArmId(state)).toBe(1);
    expect(bumpDownloadArmId(state)).toBe(2);
    expect(state.nextArmIdDownload).toBe(2);
  });

  it('arm IDs are independent per type', () => {
    const state = makeState();
    bumpUploadArmId(state);
    bumpUploadArmId(state);
    bumpDialogArmId(state);
    expect(state.nextArmIdUpload).toBe(2);
    expect(state.nextArmIdDialog).toBe(1);
    expect(state.nextArmIdDownload).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findNetworkRequestById
// ─────────────────────────────────────────────────────────────────────────────

describe('findNetworkRequestById', () => {
  function makeStateWithRequests(requests: NetworkRequest[]): PageState {
    return {
      console: [],
      errors: [],
      requests,
      requestIds: new WeakMap(),
      nextRequestId: requests.length,
      armIdUpload: 0,
      armIdDialog: 0,
      armIdDownload: 0,
      nextArmIdUpload: 0,
      nextArmIdDialog: 0,
      nextArmIdDownload: 0,
    };
  }

  it('finds request by ID', () => {
    const req: NetworkRequest = {
      id: 'r1',
      timestamp: '2026-01-01T00:00:00Z',
      method: 'GET',
      url: 'https://example.com',
      resourceType: 'document',
    };
    const state = makeStateWithRequests([req]);
    expect(findNetworkRequestById(state, 'r1')).toBe(req);
  });

  it('returns the last matching request (searches from end)', () => {
    const req1: NetworkRequest = {
      id: 'r1',
      timestamp: '2026-01-01T00:00:00Z',
      method: 'GET',
      url: 'https://example.com/1',
      resourceType: 'document',
    };
    const req2: NetworkRequest = {
      id: 'r1',
      timestamp: '2026-01-01T00:00:01Z',
      method: 'POST',
      url: 'https://example.com/2',
      resourceType: 'xhr',
    };
    const state = makeStateWithRequests([req1, req2]);
    expect(findNetworkRequestById(state, 'r1')).toBe(req2);
  });

  it('returns undefined for non-existent ID', () => {
    const state = makeStateWithRequests([]);
    expect(findNetworkRequestById(state, 'r999')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensurePageState
// ─────────────────────────────────────────────────────────────────────────────

describe('ensurePageState', () => {
  it('returns a new state for a fresh page', () => {
    const page = mockPage();
    const state = ensurePageState(page);
    expect(state.console).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.requests).toEqual([]);
    expect(state.nextRequestId).toBe(0);
    expect(state.nextArmIdUpload).toBe(0);
    expect(state.nextArmIdDialog).toBe(0);
    expect(state.nextArmIdDownload).toBe(0);
  });

  it('returns the same state on subsequent calls (idempotent)', () => {
    const page = mockPage();
    const state1 = ensurePageState(page);
    const state2 = ensurePageState(page);
    expect(state1).toBe(state2);
  });

  it('returns different states for different pages', () => {
    const page1 = mockPage();
    const page2 = mockPage();
    const state1 = ensurePageState(page1);
    const state2 = ensurePageState(page2);
    expect(state1).not.toBe(state2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureContextState
// ─────────────────────────────────────────────────────────────────────────────

describe('ensureContextState', () => {
  it('returns a new state for a fresh context', () => {
    const ctx = mockContext();
    const state = ensureContextState(ctx);
    expect(state.traceActive).toBe(false);
  });

  it('returns the same state on subsequent calls (idempotent)', () => {
    const ctx = mockContext();
    const state1 = ensureContextState(ctx);
    const state2 = ensureContextState(ctx);
    expect(state1).toBe(state2);
  });
});
