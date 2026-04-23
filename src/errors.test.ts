import { describe, it, expect } from 'vitest';

import { BrowserTabNotFoundError, StaleRefError, SnapshotHydrationError, NavigationRaceError } from './errors.js';

describe('structured errors', () => {
  it('BrowserTabNotFoundError carries a default message and name', () => {
    const err = new BrowserTabNotFoundError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BrowserTabNotFoundError');
    expect(err.message).toBe('Tab not found');
  });

  it('StaleRefError exposes the offending ref', () => {
    const err = new StaleRefError('e7');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('StaleRefError');
    expect(err.ref).toBe('e7');
    expect(err.message).toContain('Unknown ref "e7"');
    expect(err.message).toContain('re-rendered');
  });

  it('StaleRefError accepts a custom message', () => {
    const err = new StaleRefError('e2', 'custom');
    expect(err.ref).toBe('e2');
    expect(err.message).toBe('custom');
  });

  it('SnapshotHydrationError reports attempts and elapsed time', () => {
    const err = new SnapshotHydrationError({ attempts: 4, elapsedMs: 5200 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SnapshotHydrationError');
    expect(err.attempts).toBe(4);
    expect(err.elapsedMs).toBe(5200);
    expect(err.message).toContain('4 attempts');
    expect(err.message).toContain('5200ms');
  });

  it('NavigationRaceError reports from/to urls', () => {
    const err = new NavigationRaceError({ fromUrl: 'https://a.test/', toUrl: 'https://b.test/' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('NavigationRaceError');
    expect(err.fromUrl).toBe('https://a.test/');
    expect(err.toUrl).toBe('https://b.test/');
    expect(err.message).toContain('https://a.test/');
    expect(err.message).toContain('https://b.test/');
  });

  it('errors are distinguishable via instanceof', () => {
    const a: unknown = new StaleRefError('e1');
    const b: unknown = new SnapshotHydrationError({ attempts: 1, elapsedMs: 1 });
    expect(a instanceof StaleRefError).toBe(true);
    expect(a instanceof SnapshotHydrationError).toBe(false);
    expect(b instanceof SnapshotHydrationError).toBe(true);
    expect(b instanceof NavigationRaceError).toBe(false);
  });
});
