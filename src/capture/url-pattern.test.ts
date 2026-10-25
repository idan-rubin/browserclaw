import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { matchUrlPattern } from './url-pattern.js';

describe('capture URL patterns', () => {
  it.each([
    ['https://example.com/a', 'https://example.com/a', true],
    ['/api', 'https://example.com/api/items', true],
    ['*/api/*', 'https://example.com/api/nested/items?q=1', true],
    ['**/api/**', 'https://example.com/api/nested/items?q=1', true],
    ['a**b***c', 'a/b/c', true],
    ['a*b', 'prefix-ab', false],
    ['a*b', 'ab-suffix', false],
    ['*a*a*b', 'aaab', true],
    ['*a*a*b', 'aaaa', false],
    ['*[x]?(.json)', 'https://example.com/[x]?(.json)', true],
    ['*[x]?(.json)', 'https://example.com/x.json', false],
    ['', 'https://example.com/', false],
    ['*', '', false],
  ])('matches %s against %s', (pattern, url, expected) => {
    expect(matchUrlPattern(pattern, url)).toBe(expected);
  });

  it('rejects an adversarial wildcard near-match without blocking the process', () => {
    // Isolate the old failure mode: synchronous regex backtracking would prevent
    // even a test timeout from running in this process.
    const pattern = '*a'.repeat(28) + 'b';
    const url = 'a'.repeat(2000);
    const sourceUrl = new URL('./url-pattern.ts', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `import { matchUrlPattern } from ${JSON.stringify(sourceUrl)};
         process.stdout.write(String(matchUrlPattern(${JSON.stringify(pattern)}, ${JSON.stringify(url)})));`,
      ],
      { timeout: 3000, encoding: 'utf8' },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('false');

    // Non-vacuity control: the exact previous matcher stalls on these inputs.
    const previousMatch = (oldPattern: string, oldUrl: string): boolean => {
      const escaped = oldPattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(oldUrl);
    };
    const previous = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const previousMatch = ${previousMatch.toString()};
         process.stdout.write(String(previousMatch(${JSON.stringify(pattern)}, ${JSON.stringify(url)})));`,
      ],
      { timeout: 500, encoding: 'utf8' },
    );
    expect(previous.error).toMatchObject({ code: 'ETIMEDOUT' });
  });
});
