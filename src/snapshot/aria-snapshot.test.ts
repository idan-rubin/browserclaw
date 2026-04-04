import { describe, it, expect } from 'vitest';

import { buildRoleSnapshotFromAriaSnapshot } from './ref-map.js';

// ─────────────────────────────────────────────────────────────────────────────
// Empty and degenerate input handling
// (guards the same path as formatAriaNodes empty-input crash)
// ─────────────────────────────────────────────────────────────────────────────

describe('snapshot empty/degenerate input handling', () => {
  it('buildRoleSnapshotFromAriaSnapshot returns (empty) for empty string', () => {
    const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot('');
    expect(snapshot).toBe('(empty)');
    expect(Object.keys(refs)).toHaveLength(0);
  });

  it('buildRoleSnapshotFromAriaSnapshot returns no refs for whitespace-only input', () => {
    expect(Object.keys(buildRoleSnapshotFromAriaSnapshot('   \n  \n  ').refs)).toHaveLength(0);
  });

  it('buildRoleSnapshotFromAriaSnapshot does not throw on input with only non-matching lines', () => {
    // Lines that don't match the `- role` pattern are passed through unchanged
    expect(() => buildRoleSnapshotFromAriaSnapshot('no match here\nalso no match')).not.toThrow();
  });

  it('buildRoleSnapshotFromAriaSnapshot returns (no interactive elements) for interactive mode with empty input', () => {
    const { snapshot, refs } = buildRoleSnapshotFromAriaSnapshot('', { interactive: true });
    expect(snapshot).toBe('(no interactive elements)');
    expect(Object.keys(refs)).toHaveLength(0);
  });
});
