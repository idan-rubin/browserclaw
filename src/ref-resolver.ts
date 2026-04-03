import type { Page } from 'playwright-core';

import { ensurePageState, getPageState } from './page-state.js';
import type { RoleRefs } from './types.js';

// ── Ref cache: keyed by "cdpUrl::targetId" ──

const roleRefsByTarget = new Map<
  string,
  {
    refs: RoleRefs;
    frameSelector?: string;
    mode?: 'role' | 'aria';
  }
>();
const MAX_ROLE_REFS_CACHE = 50;

function normalizeCdpUrl(raw: string): string {
  return raw.replace(/\/$/, '');
}

function roleRefsKey(cdpUrl: string, targetId: string): string {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

// ── Role Refs Storage ──

/**
 * Remember role refs in the target cache (without storing on page state).
 * Used to persist refs across page reconnections.
 */
export function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: 'role' | 'aria';
}): void {
  const targetId = opts.targetId.trim();
  if (targetId === '') return;
  roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    refs: opts.refs,
    ...(opts.frameSelector !== undefined && opts.frameSelector !== '' ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done === true) break;
    roleRefsByTarget.delete(first.value);
  }
}

export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode: 'role' | 'aria';
}): void {
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsMode = opts.mode;

  if (opts.targetId === undefined || opts.targetId.trim() === '') return;
  rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
  });
}

export function restoreRoleRefsForTarget(opts: { cdpUrl: string; targetId?: string; page: Page }): void {
  const targetId = opts.targetId?.trim() ?? '';
  if (targetId === '') return;
  const entry = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
  if (!entry) return;
  const state = ensurePageState(opts.page);
  if (state.roleRefs) return;
  state.roleRefs = entry.refs;
  state.roleRefsFrameSelector = entry.frameSelector;
  state.roleRefsMode = entry.mode;
}

/**
 * Clear role refs for all targets associated with a CDP URL.
 * Called when a browser disconnects.
 */
export function clearRoleRefsForCdpUrl(cdpUrl: string): void {
  const normalized = normalizeCdpUrl(cdpUrl);
  for (const key of roleRefsByTarget.keys()) {
    if (key.startsWith(normalized + '::')) roleRefsByTarget.delete(key);
  }
}

// ── Ref Parsing ──

/**
 * Parse a role ref string (e.g. "e1", "@e1", "ref=e1") to a normalized ref ID.
 * Returns null if the string is not a valid role ref.
 */
export function parseRoleRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('@')
    ? trimmed.slice(1)
    : trimmed.startsWith('ref=')
      ? trimmed.slice(4)
      : trimmed;
  return /^e\d+$/.test(normalized) ? normalized : null;
}

/**
 * Require a ref string, normalizing and validating it.
 * Throws if the ref is empty.
 */
export function requireRef(value: string | undefined): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  const ref = (raw ? parseRoleRef(raw) : null) ?? (raw.startsWith('@') ? raw.slice(1) : raw);
  if (!ref) throw new Error('ref is required');
  return ref;
}

/**
 * Require either a ref or selector, returning whichever is provided.
 * Throws if neither is provided.
 */
export function requireRefOrSelector(ref?: string, selector?: string): { ref?: string; selector?: string } {
  const trimmedRef = typeof ref === 'string' ? ref.trim() : '';
  const trimmedSelector = typeof selector === 'string' ? selector.trim() : '';
  if (!trimmedRef && !trimmedSelector) throw new Error('ref or selector is required');
  return { ref: trimmedRef || undefined, selector: trimmedSelector || undefined };
}

/** Clamp interaction timeout to [500, 60000]ms range, defaulting to 8000ms. */
export function resolveInteractionTimeoutMs(timeoutMs?: number): number {
  return Math.max(500, Math.min(60000, Math.floor(timeoutMs ?? 8000)));
}

/** Bounded delay validator for animation/interaction delays. */
export function resolveBoundedDelayMs(value: number | undefined, label: string, maxMs: number): number {
  const normalized = Math.floor(value ?? 0);
  if (!Number.isFinite(normalized) || normalized < 0) throw new Error(`${label} must be >= 0`);
  if (normalized > maxMs) throw new Error(`${label} exceeds maximum of ${String(maxMs)}ms`);
  return normalized;
}

// ── Ref Locator ──

export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith('@') ? ref.slice(1) : ref.startsWith('ref=') ? ref.slice(4) : ref;
  if (normalized.trim() === '') throw new Error('ref is required');

  if (/^e\d+$/.test(normalized)) {
    const state = getPageState(page);

    // Aria mode: use aria-ref locator
    if (state?.roleRefsMode === 'aria') {
      return (
        state.roleRefsFrameSelector !== undefined && state.roleRefsFrameSelector !== ''
          ? page.frameLocator(state.roleRefsFrameSelector)
          : page
      ).locator(`aria-ref=${normalized}`);
    }

    // Role mode: use getByRole
    const info = state?.roleRefs?.[normalized];
    if (!info) throw new Error(`Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`);

    const locAny =
      state.roleRefsFrameSelector !== undefined && state.roleRefsFrameSelector !== ''
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
    const role = info.role as Parameters<Page['getByRole']>[0];
    const locator =
      info.name !== undefined && info.name !== ''
        ? locAny.getByRole(role, { name: info.name, exact: true })
        : locAny.getByRole(role);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}
