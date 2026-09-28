import { describe, expect, it } from 'vitest';

import { BlockedBrowserTargetError } from './connection.js';
import { BrowserTabNotFoundError, NavigationRaceError, SnapshotHydrationError, StaleRefError } from './errors.js';
import { toAIFriendlyError } from './page-utils.js';
import { BrowserCdpEndpointBlockedError, InvalidBrowserNavigationUrlError } from './security.js';

describe('actionable error diagnostics', () => {
  it.each([
    new BrowserTabNotFoundError(),
    new StaleRefError('e1'),
    new SnapshotHydrationError({ attempts: 2, elapsedMs: 500 }),
    new NavigationRaceError({ fromUrl: 'a', toUrl: 'b' }),
    new InvalidBrowserNavigationUrlError('blocked'),
    new BrowserCdpEndpointBlockedError('blocked'),
    new BlockedBrowserTargetError(),
  ])('preserves structured $name identity', (error) => {
    expect(toAIFriendlyError(error, 'e1')).toBe(error);
  });

  it.each([
    ['Element is not an <input>, <textarea> or [contenteditable] element', 'not editable'],
    ['Cannot type text into input[type=number]', 'numeric value'],
    ['Input of type "checkbox" cannot be filled', 'input type that cannot be filled'],
    ['Malformed value', 'value format'],
    ['element is not editable', 'read-only'],
    ['element is not enabled', 'prerequisites'],
    ['element is not stable', 'animation'],
    ['element is not visible', 'not interactable'],
    ['<div class="overlay"> intercepts pointer events', 'not interactable'],
    ['Element is not receiving pointer events', 'not interactable'],
  ])('recognizes anchored diagnostic %s', (message, expected) => {
    expect(toAIFriendlyError(new Error(`locator.fill: ${message}`), 'e1').message).toContain(expected);
  });

  it('uses the final timeout state rather than an earlier transient state', () => {
    const error = new Error(
      'locator.click: Timeout 5000ms exceeded.\nCall log:\n - element is not visible\n 2 × element is not enabled',
    );
    expect(toAIFriendlyError(error, 'e1').message).toContain('not enabled');
  });

  it.each([
    'Timeout 5000ms exceeded.\n - waiting for locator("#x") to be attached',
    'Timeout 5000ms exceeded.\n - waiting for getByRole("button")',
  ])('does not label a generic locator wait as a visibility failure', (message) => {
    const result = toAIFriendlyError(new Error(message), 'e1').message;
    expect(result).toContain('timed out after 5000ms');
    expect(result).not.toContain('not found or not visible');
  });

  it.each([
    'Page text: strict mode violation',
    'Something failed\nElement is not an <input>',
    'Something failed\n - element is not enabled',
    'Page says element is not visible',
    'Page says Malformed value',
    'Page text: <div> intercepts pointer events',
    'Page text: Timeout 5000ms exceeded.',
  ])('does not promote unrelated text into a diagnostic: %s', (message) => {
    expect(toAIFriendlyError(new Error(message), 'e1').message).toBe(message);
  });

  it('strips terminal escapes and bounds selector labels without splitting surrogate pairs', () => {
    const message = '\u001b[31mError: locator.fill: Element is not an <input>\u001b[0m';
    const result = toAIFriendlyError(new Error(message), '\u001b[31m' + 'a'.repeat(199) + '🙂more');
    expect(result.message).toContain(`Element "${'a'.repeat(199)}"`);
    expect(result.message).not.toContain('\u001b');
    expect(result.message).not.toContain('\ud83d');
  });

  it('preserves unknown Error identity when no cleanup is needed', () => {
    const error = new Error('unrelated failure');
    expect(toAIFriendlyError(error, 'e1')).toBe(error);
  });
});
