import type * as FsPromises from 'node:fs/promises';
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import type * as Path from 'node:path';
import { win32 } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof Path>();
  return { ...actual, ...actual.win32, default: actual.win32 };
});
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  lstat: vi.fn(),
  realpath: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
}));

import { pathForWindowsFilesystem } from './file-safety.js';
import {
  resolveExistingPathsWithinRoot,
  resolvePathWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
  writeViaSiblingTempPath,
} from './security.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
if (originalPlatform === undefined) throw new Error('process.platform descriptor missing');

beforeEach(() => {
  vi.mocked(rename).mockResolvedValue(undefined);
  vi.mocked(rm).mockResolvedValue(undefined);
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  vi.mocked(realpath).mockImplementation(((value: string) => {
    if (value === '\\\\?\\C:\\') throw new Error('Node root separator dispatch bug');
    return Promise.resolve(value);
  }) as typeof realpath);
  vi.mocked(lstat).mockImplementation(((value: string) => {
    if (value === '\\\\?\\C:\\') throw new Error('Node root separator dispatch bug');
    return Promise.resolve({
      isDirectory: () => value === 'C:\\',
      isFile: () => value !== 'C:\\',
      isSymbolicLink: () => false,
      nlink: 1,
    });
  }) as typeof lstat);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.clearAllMocks();
});

describe('Windows namespace root filesystem dispatch (platform-mocked)', () => {
  it('rejects Unicode-folded foreign UNC hosts in lexical and filesystem validators', async () => {
    const rootDir = '\\\\khost\\share\\root';
    const requestedPath = '\\\\Khost\\share\\root\\file.txt';
    // Node folds these distinct hosts together: lexical relative containment alone is insufficient.
    expect(win32.relative(rootDir, requestedPath)).toBe('file.txt');
    expect(resolvePathWithinRoot({ rootDir, requestedPath, scopeLabel: 'test' }).ok).toBe(false);
    expect((await resolveWritablePathWithinRoot({ rootDir, requestedPath, scopeLabel: 'test' })).ok).toBe(false);
    for (const resolvePaths of [resolveExistingPathsWithinRoot, resolveStrictExistingPathsWithinRoot]) {
      expect((await resolvePaths({ rootDir, requestedPaths: [requestedPath], scopeLabel: 'test' })).ok).toBe(false);
    }
    expect(lstat).not.toHaveBeenCalled();
    expect(vi.mocked(realpath).mock.calls.every(([value]) => value === rootDir)).toBe(true);
  });

  it.each([
    '\\\\other\\share\\file.txt',
    '\\\\Khost\\share\\root\\file.txt',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\file.txt',
  ])('rejects foreign output %s before probing its parent', async (targetPath) => {
    const rootDir = '\\\\khost\\share\\root';
    const writeTemp = vi.fn();
    await expect(writeViaSiblingTempPath({ rootDir, targetPath, writeTemp })).rejects.toThrow(
      'outside the allowed root',
    );
    expect(realpath).toHaveBeenCalledExactlyOnceWith(rootDir);
    expect(lstat).not.toHaveBeenCalled();
    expect(writeTemp).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('keeps writes and lexical paths on the trusted UNC share available (control)', async () => {
    const rootDir = '\\\\khost\\share\\root';
    const targetPath = `${rootDir}\\file.txt`;
    expect(resolvePathWithinRoot({ rootDir, requestedPath: targetPath, scopeLabel: 'test' })).toEqual({
      ok: true,
      path: targetPath,
    });
    const writeTemp = vi.fn().mockResolvedValue(undefined);
    await writeViaSiblingTempPath({ rootDir, targetPath, writeTemp });
    expect(writeTemp).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledWith(expect.stringContaining('.browserclaw-output-'), targetPath);
  });

  it('keeps canonical spelling of a trusted root alias available to the writer (control)', async () => {
    const rootDir = 'C:\\alias';
    const canonical = '\\\\khost\\share\\root';
    vi.mocked(realpath).mockImplementation(((value: string) =>
      Promise.resolve(value === rootDir ? canonical : value)) as typeof realpath);
    const writeTemp = vi.fn().mockResolvedValue(undefined);
    await writeViaSiblingTempPath({ rootDir, targetPath: `${canonical}\\file.txt`, writeTemp });
    expect(writeTemp).toHaveBeenCalledOnce();
  });

  it('rejects a distinct case-sensitive sibling root before staging or publication', async () => {
    const rootDir = 'C:\\Root';
    const targetPath = 'C:\\root\\file.txt';
    // Non-vacuousness: Windows lexical containment accepts this static sibling.
    expect(win32.relative(rootDir, targetPath)).toBe('file.txt');
    expect(win32.resolve(rootDir, win32.relative(rootDir, targetPath))).not.toBe(targetPath);
    const writeTemp = vi.fn();
    await expect(writeViaSiblingTempPath({ rootDir, targetPath, writeTemp })).rejects.toThrow(
      'outside the allowed root',
    );
    expect(realpath).toHaveBeenCalledWith(rootDir);
    expect(realpath).toHaveBeenCalledWith('C:\\root');
    expect(writeTemp).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive aliases when canonical resolution identifies the trusted root', async () => {
    vi.mocked(realpath).mockImplementation(((value: string) =>
      Promise.resolve(value === 'C:\\root' ? 'C:\\Root' : value)) as typeof realpath);
    const writeTemp = vi.fn().mockResolvedValue(undefined);
    await writeViaSiblingTempPath({ rootDir: 'C:\\Root', targetPath: 'C:\\root\\file.txt', writeTemp });
    expect(writeTemp).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledWith(expect.stringContaining('.browserclaw-output-'), 'C:\\Root\\file.txt');
  });

  it.each([
    { rootDir: 'C:\\root', targetPath: 'C:\\root\\file:stream' },
    { rootDir: 'C:root', targetPath: 'C:\\root\\file.txt' },
    { rootDir: '\\\\?\\C:', targetPath: 'C:\\file.txt' },
  ])('rejects sibling-write aliases before filesystem work: %j', async (paths) => {
    const writeTemp = vi.fn();
    await expect(writeViaSiblingTempPath({ ...paths, writeTemp })).rejects.toThrow('namespace alias');
    expect(writeTemp).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it.each(['C:\\', '\\\\?\\C:\\'])('publishes an ordinary sibling write below admitted root %s', async (rootDir) => {
    const writeTemp = vi.fn().mockResolvedValue(undefined);
    await writeViaSiblingTempPath({ rootDir, targetPath: 'C:\\file.txt', writeTemp });
    expect(writeTemp).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledWith(expect.stringContaining('.browserclaw-output-'), 'C:\\file.txt');
    expect(realpath).toHaveBeenCalledWith('C:\\');
    expect(realpath).not.toHaveBeenCalledWith('\\\\?\\C:\\');
  });

  it('rejects an alias returned by canonical root resolution', async () => {
    vi.mocked(realpath).mockResolvedValueOnce('C:\\root:stream');
    const writeTemp = vi.fn();
    await expect(
      writeViaSiblingTempPath({ rootDir: 'C:\\root', targetPath: 'C:\\root\\file.txt', writeTemp }),
    ).rejects.toThrow('namespace alias');
    expect(writeTemp).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });
  it('adapts admitted namespace roots without changing ordinary or child paths', () => {
    expect(pathForWindowsFilesystem('\\\\?\\C:\\')).toBe('C:\\');
    expect(pathForWindowsFilesystem('\\\\.\\C:\\')).toBe('C:\\');
    expect(pathForWindowsFilesystem('C:\\')).toBe('C:\\');
    expect(pathForWindowsFilesystem('\\\\?\\C:\\file.txt')).toBe('\\\\?\\C:\\file.txt');
    expect(pathForWindowsFilesystem('\\\\?\\C:')).toBe('\\\\?\\C:');
  });

  it('uses the adapted root in realpath/lstat for each confined filesystem API', async () => {
    const rootDir = '\\\\?\\C:\\';
    expect((await resolveWritablePathWithinRoot({ rootDir, requestedPath: 'file.txt', scopeLabel: 'test' })).ok).toBe(
      true,
    );
    for (const resolve of [resolveExistingPathsWithinRoot, resolveStrictExistingPathsWithinRoot]) {
      expect((await resolve({ rootDir, requestedPaths: ['file.txt'], scopeLabel: 'test' })).ok).toBe(true);
    }
    expect(realpath).toHaveBeenCalledWith('C:\\');
    expect(lstat).toHaveBeenCalledWith('C:\\');
    expect(realpath).not.toHaveBeenCalledWith(rootDir);
    expect(lstat).not.toHaveBeenCalledWith(rootDir);
  });

  it('rejects a bare namespace drive before any filesystem operation', async () => {
    const rootDir = '\\\\?\\C:';
    expect((await resolveWritablePathWithinRoot({ rootDir, requestedPath: 'file.txt', scopeLabel: 'test' })).ok).toBe(
      false,
    );
    for (const resolve of [resolveExistingPathsWithinRoot, resolveStrictExistingPathsWithinRoot]) {
      expect((await resolve({ rootDir, requestedPaths: ['file.txt'], scopeLabel: 'test' })).ok).toBe(false);
    }
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });
});
