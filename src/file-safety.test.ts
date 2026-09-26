import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fitFileNameToPortableComponent, hasWindowsPathAlias, sanitizeUntrustedFileName } from './file-safety.js';
import {
  resolvePathWithinRoot,
  resolveWritablePathWithinRoot,
  resolveExistingPathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  writeViaSiblingTempPath,
} from './security.js';

describe('portable filename sanitization', () => {
  it.each(['CON', 'NUL', 'CLOCK$', 'CONIN$', 'CONOUT$', 'COM1', 'COM¹', 'LPT9', 'LPT³'])(
    'defangs Windows device %s',
    (name) => {
      expect(sanitizeUntrustedFileName(`${name}.txt`, 'fallback')).toBe(`${name}_.txt`);
    },
  );
  it('keeps ordinary device-like names intact (control)', () => {
    expect(sanitizeUntrustedFileName('CONTEXT.txt', 'fallback')).toBe('CONTEXT.txt');
    expect(sanitizeUntrustedFileName('COM10.txt', 'fallback')).toBe('COM10.txt');
  });
  it('sanitizes dangerous fallback names and removes Windows-invalid/C1 characters', () => {
    expect(sanitizeUntrustedFileName('', '../escape')).toBe('escape');
    expect(sanitizeUntrustedFileName('.', '..')).toBe('file');
    expect(sanitizeUntrustedFileName('..', 'CON.txt')).toBe('CON_.txt');
    expect(sanitizeUntrustedFileName('report\u0085<>:"|?*.txt', 'fallback')).toBe('report.txt');
  });
  it('does not split a surrogate pair or truncate away a device-safety suffix', () => {
    expect(sanitizeUntrustedFileName('x'.repeat(199) + '😀', 'fallback')).toBe('x'.repeat(199));
    const padded = sanitizeUntrustedFileName('CON' + ' '.repeat(197) + '.txt', 'fallback');
    expect(padded.length).toBeLessThanOrEqual(200);
    expect(padded.endsWith('_')).toBe(true);
    expect(sanitizeUntrustedFileName('report-😀.txt', 'fallback')).toBe('report-😀.txt');
  });
});

describe('portable composite filenames', () => {
  it.each(['文'.repeat(80), 'é'.repeat(100), '🙂'.repeat(60)])(
    'bounds raw/NFC/NFD bytes and preserves extension',
    (stem) => {
      const prefix = '.browserclaw-output-' + 'a'.repeat(36) + '-';
      const fileName = stem + '.txt';
      const fitted = fitFileNameToPortableComponent({ prefix, fileName, suffix: '.part' });
      expect(fitted.endsWith('.txt')).toBe(true);
      expect(fitted).not.toBe(fileName);
      for (const form of [undefined, 'NFC', 'NFD'] as const) {
        const value = prefix + fitted + '.part';
        expect(Buffer.byteLength(form === undefined ? value : value.normalize(form))).toBeLessThanOrEqual(255);
      }
    },
  );

  it('keeps short filenames exact and preserves the caller-prefix error boundary', () => {
    expect(fitFileNameToPortableComponent({ prefix: '.tmp-', fileName: 'report.txt', suffix: '.part' })).toBe(
      'report.txt',
    );
    expect(fitFileNameToPortableComponent({ prefix: 'x'.repeat(256), fileName: 'report.txt', suffix: '' })).toBe(
      'report.txt',
    );
  });

  it('writes a valid long Unicode target through a portable sibling temporary name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bc-portable-temp-'));
    const targetPath = join(root, '文'.repeat(80) + '.txt');
    try {
      await writeViaSiblingTempPath({
        rootDir: root,
        targetPath,
        writeTemp: async (tempPath) => {
          expect(Buffer.byteLength(basename(tempPath))).toBeLessThanOrEqual(255);
          await writeFile(tempPath, 'payload');
        },
      });
      expect(await readFile(targetPath, 'utf8')).toBe('payload');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('Windows filesystem aliases', () => {
  it.each(['file.txt:secret', 'C:relative.txt', 'C:\\safe\\file:stream', '\\\\?\\C:', '\\\\?\\C:\\safe\\file:stream'])(
    'rejects %s on Windows',
    (path) => {
      expect(hasWindowsPathAlias(path, 'win32')).toBe(true);
    },
  );
  it.each([
    'C:\\safe\\file.txt',
    'C:/safe/file.txt',
    '\\\\?\\C:\\safe\\file.txt',
    '\\\\server\\share\\file.txt',
    'relative.txt',
  ])('admits ordinary path %s (control)', (path) => {
    expect(hasWindowsPathAlias(path, 'win32')).toBe(false);
  });
  it('does not reinterpret POSIX colons as Windows streams', () => {
    expect(hasWindowsPathAlias('/tmp/report:2026.txt', 'darwin')).toBe(false);
    expect(hasWindowsPathAlias('/tmp/report:2026.txt', 'linux')).toBe(false);
  });
  it('rejects aliases at every confinement API before filesystem access', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!original) throw new Error('process.platform descriptor missing');
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' });
    try {
      for (const rootDir of ['/safe/root', 'C:relative-root']) {
        const requestedPath = rootDir.includes(':') ? 'ordinary.txt' : 'file.txt:secret';
        const single = { rootDir, requestedPath, scopeLabel: 'test' };
        const multiple = { rootDir, requestedPaths: [requestedPath], scopeLabel: 'test' };
        expect(resolvePathWithinRoot(single)).toMatchObject({
          ok: false,
        });
        await expect(resolveWritablePathWithinRoot(single)).resolves.toMatchObject({
          ok: false,
        });
        await expect(resolveExistingPathsWithinRoot(multiple)).resolves.toMatchObject({
          ok: false,
        });
        await expect(resolveStrictExistingPathsWithinRoot(multiple)).resolves.toMatchObject({
          ok: false,
        });
      }
      expect(
        resolvePathWithinRoot({
          rootDir: '/safe/root',
          requestedPath: '',
          defaultFileName: 'file:secret',
          scopeLabel: 'test',
        }).ok,
      ).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
  it('keeps existing files and macOS realpath-root handling available (control)', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'browserclaw-alias-control-'));
    try {
      const path = join(rootDir, 'file.txt');
      await writeFile(path, 'control');
      expect(resolvePathWithinRoot({ rootDir, requestedPath: 'file.txt', scopeLabel: 'test' }).ok).toBe(true);
      for (const resolvePaths of [resolveExistingPathsWithinRoot, resolveStrictExistingPathsWithinRoot]) {
        await expect(
          resolvePaths({ rootDir, requestedPaths: ['file.txt'], scopeLabel: 'test' }),
        ).resolves.toMatchObject({ ok: true });
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
