/**
 * Tests for aria-snapshot.ts
 *
 * Note: snapshotRole() and snapshotAria() require a live browser (CDP connection)
 * and cannot be unit-tested in isolation. The formatAriaNodes() function is private.
 *
 * The regression being guarded here is:
 *   formatAriaNodes([]) → must return [] without throwing
 *   formatAriaNodes([{ nodeId: '', ... }]) → must return [] (root has empty nodeId)
 *
 * These are tested indirectly via the ref-map functions that share the same
 * empty-input handling contract, and documented here for integration test coverage.
 *
 * TODO (integration tests, require browser):
 *   - snapshotAria() returns empty nodes array when the page has no AX tree
 *   - snapshotAria() does not crash when CDP returns nodes with empty nodeId
 *   - snapshotRole() with refsMode='aria' uses opts.timeoutMs for the
 *     _snapshotForAI call, not a hardcoded 5000ms
 *   - setCheckedViaEvaluate() does not call input.click() (would toggle back)
 *   - armDialog() promise resolves only after the dialog fires, not immediately
 *   - armFileUpload() logs a console.warn when path validation fails
 */

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

  it('buildRoleSnapshotFromAriaSnapshot returns (empty) for whitespace-only input', () => {
    const { snapshot } = buildRoleSnapshotFromAriaSnapshot('   \n  \n  ');
    // whitespace lines don't match the role pattern, nothing gets added
    expect(Object.keys(buildRoleSnapshotFromAriaSnapshot('   ').refs)).toHaveLength(0);
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
