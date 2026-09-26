import { describe, expect, it } from 'vitest';

import { finalizeSnapshot } from './finalize.js';

describe('final snapshot budgets', () => {
  it.each([31, 32])('keeps the upstream marker at the %i-character boundary', (maxChars) => {
    const result = finalizeSnapshot('- button "A long button name" [ref=e1]', { e1: { role: 'button' } }, maxChars);
    expect(result.snapshot).toBe('[...TRUNCATED - page too large]');
    expect(result.snapshot.length).toBeLessThanOrEqual(maxChars);
    expect(result.refs).toEqual({});
  });

  it('uses the compact marker below the full-marker boundary', () => {
    expect(finalizeSnapshot('a'.repeat(50), {}, 30).snapshot).toBe('…');
  });
});
