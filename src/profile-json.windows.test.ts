import fs from 'node:fs';
import type * as Path from 'node:path';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof Path>();
  return { ...actual, ...actual.win32, default: actual.win32 };
});

import { readProfileJson, writeProfileJson } from './profile-json.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
if (originalPlatform === undefined) throw new Error('process.platform descriptor missing');

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
});

describe('profile JSON Windows path admission (platform-mocked)', () => {
  it.each([
    'C:\\profile:stream\\Preferences',
    'C:\\profile\\Preferences:stream',
    'C:Preferences',
    '\\\\?\\C:',
    'C:\\profile\\NUL.json',
    'C:\\profile\\COM¹ .json',
    '\\\\.\\C:\\Preferences',
    '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\Preferences',
  ])('rejects unsafe read path %s before filesystem access', (filePath) => {
    const stat = vi.spyOn(fs, 'lstatSync');
    const open = vi.spyOn(fs, 'openSync');
    expect(readProfileJson(filePath)).toBeNull();
    expect(stat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['C:\\profile:stream\\Preferences', 'C:\\profile\\Preferences:stream', '\\\\?\\C:'])(
    'rejects namespace alias %s before any filesystem write',
    (filePath) => {
      const mkdir = vi.spyOn(fs, 'mkdirSync');
      const open = vi.spyOn(fs, 'openSync');
      expect(() => {
        writeProfileJson(filePath, {});
      }).toThrow('namespace alias');
      expect(mkdir).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    },
  );

  it('anchors an ordinary drive-relative path without normalizing its raw suffix', () => {
    vi.spyOn(path, 'resolve').mockReturnValue('C:\\working');
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('stop before staging');
    });
    expect(() => {
      writeProfileJson('C:link\\..\\Preferences', {});
    }).toThrow('stop before staging');
    expect(path.resolve).toHaveBeenCalledWith('C:');
    expect(mkdir).toHaveBeenCalledWith('C:\\working\\link\\..', { recursive: true, mode: 0o700 });
    expect(open).toHaveBeenCalledWith(
      expect.stringContaining('C:\\working\\link\\..\\.browserclaw-profile-'),
      'wx',
      0o600,
    );
  });

  it('adapts an admitted namespace drive root only for mkdir', () => {
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const open = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('stop before staging');
    });
    expect(() => {
      writeProfileJson('\\\\?\\C:\\Preferences', {});
    }).toThrow('stop before staging');
    expect(mkdir).toHaveBeenCalledWith('C:\\', { recursive: true, mode: 0o700 });
    expect(open).toHaveBeenCalledWith(expect.stringContaining('\\\\?\\C:\\.browserclaw-profile-'), 'wx', 0o600);
  });
});

function receipt(dev: bigint, ino: bigint): fs.BigIntStats {
  return { dev, ino, nlink: 1n, isFile: () => true, isSymbolicLink: () => false } as fs.BigIntStats;
}

function mockPublication(observations: fs.BigIntStats[], stable = receipt(2n, 3n)): void {
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'openSync').mockReturnValue(7);
  vi.spyOn(fs, 'fstatSync').mockImplementation(() => observations.shift() ?? stable);
  vi.spyOn(fs, 'lstatSync').mockReturnValue(stable);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'fchmodSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
  vi.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
}

describe('exact Windows profile identities (platform-mocked)', () => {
  it.each([receipt(0n, 3n), receipt(2n, 0n)])('rejects persistently unknown identities before writing', (unknown) => {
    mockPublication([unknown, unknown]);
    expect(() => {
      writeProfileJson('C:\\profile\\Preferences', {});
    }).toThrow('identity changed');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledWith(7);
  });

  it('allows one retry to resolve an unknown component while retaining a known component', () => {
    mockPublication([receipt(0n, 3n), receipt(2n, 3n)]);
    writeProfileJson('C:\\profile\\Preferences', { control: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith(7, '{\n  "control": true\n}\n');
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('rejects a changed known inode even when the unknown device becomes available', () => {
    mockPublication([receipt(0n, 3n), receipt(2n, 4n)]);
    expect(() => {
      writeProfileJson('C:\\profile\\Preferences', {});
    }).toThrow('identity changed');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('does not forget known components across two incomplete observations', () => {
    mockPublication([receipt(0n, 3n), receipt(2n, 0n)]);
    expect(() => {
      writeProfileJson('C:\\profile\\Preferences', {});
    }).toThrow('identity changed');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a later unknown pathname identity rather than treating it as equal', () => {
    mockPublication([]);
    vi.mocked(fs.lstatSync).mockReturnValue(receipt(0n, 3n));
    expect(() => {
      writeProfileJson('C:\\profile\\Preferences', {});
    }).toThrow('identity changed');
    expect(fs.renameSync).not.toHaveBeenCalled();
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('accepts stable exact identifiers above Number precision', () => {
    mockPublication([], receipt(2n, 9007199254740993n));
    writeProfileJson('C:\\profile\\Preferences', { control: true });
    expect(fs.renameSync).toHaveBeenCalled();
  });

  it('does not read when the pre-open identity stays unknown', () => {
    vi.spyOn(fs, 'lstatSync').mockReturnValue(receipt(0n, 3n));
    const open = vi.spyOn(fs, 'openSync');
    expect(readProfileJson('C:\\profile\\Preferences')).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
