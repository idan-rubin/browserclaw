import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readProfileJson, writeProfileJson } from './profile-json.js';

let directory: string;
let destination: string;
const original = '{"existing":{"keep":true}}';

function stagingPath(): string {
  const name = fs.readdirSync(directory).find((entry) => entry.endsWith('.tmp'));
  if (name === undefined) throw new Error('Expected a staging file');
  return path.join(directory, name);
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-profile-json-'));
  destination = path.join(directory, 'Preferences');
  fs.writeFileSync(destination, original);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('profile JSON read admission', () => {
  it('reads an ordinary object through a nonblocking no-follow descriptor and closes it', () => {
    const read = vi.spyOn(fs, 'readFileSync');
    const open = vi.spyOn(fs, 'openSync');
    const close = vi.spyOn(fs, 'closeSync');
    expect(readProfileJson(destination)).toEqual({ existing: { keep: true } });
    const fd: unknown = open.mock.results[0].value;
    expect(read).toHaveBeenCalledWith(fd);
    expect(close).toHaveBeenCalledWith(fd);
    if (process.platform !== 'win32') {
      expect(open).toHaveBeenCalledWith(
        destination,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    }
  });

  it.each(['[]', 'null', '1', '"text"', '{bad'])('keeps the object-or-null contract for %s', (text) => {
    fs.writeFileSync(destination, text);
    expect(readProfileJson(destination)).toBeNull();
  });

  it('refuses a real leaf symlink before opening the linked JSON', () => {
    const link = path.join(directory, 'link');
    fs.symlinkSync(destination, link);
    expect(JSON.parse(fs.readFileSync(link, 'utf8'))).toEqual({ existing: { keep: true } });
    const open = vi.spyOn(fs, 'openSync');
    expect(readProfileJson(link)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO before a blocking open can occur', () => {
    const fifo = path.join(directory, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(fs.lstatSync(fifo).isFIFO()).toBe(true);
    const open = vi.spyOn(fs, 'openSync');
    expect(readProfileJson(fifo)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects directories and missing documents', () => {
    const open = vi.spyOn(fs, 'openSync');
    expect(readProfileJson(directory)).toBeNull();
    expect(readProfileJson(path.join(directory, 'missing'))).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects device and descriptor paths before stat or open', () => {
    const stat = vi.spyOn(fs, 'lstatSync');
    const open = vi.spyOn(fs, 'openSync');
    for (const candidate of ['/dev/zero', '/dev/../dev/random', '/dev/fd/3', '/proc/self/fd/4']) {
      expect(readProfileJson(candidate)).toBeNull();
    }
    expect(stat).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['before-open', 'after-open'] as const)('rejects a substituted pathname %s without reading it', (when) => {
    const replace = (): void => {
      fs.renameSync(destination, `${destination}.old`);
      fs.writeFileSync(destination, '{"substituted":true}');
    };
    const originalOpen = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((candidate, flags, mode) => {
      const guarded = candidate === destination && typeof flags === 'number';
      if (guarded && when === 'before-open') replace();
      const fd = originalOpen(candidate, flags, mode);
      if (guarded && when === 'after-open') replace();
      return fd;
    });
    const read = vi.spyOn(fs, 'readFileSync');
    const close = vi.spyOn(fs, 'closeSync');
    expect(readProfileJson(destination)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    read.mockRestore();
    expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual({ substituted: true });
  });

  it('distinguishes inode values that have identical Number representations', () => {
    const before = Object.assign(fs.lstatSync(destination, { bigint: true }), { ino: 9007199254740992n });
    const opened = Object.assign(fs.lstatSync(destination, { bigint: true }), { ino: 9007199254740993n });
    expect(Number(before.ino)).toBe(Number(opened.ino));
    vi.spyOn(fs, 'lstatSync').mockReturnValue(before);
    vi.spyOn(fs, 'fstatSync').mockReturnValue(opened);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(readProfileJson(destination)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('atomic profile JSON persistence', () => {
  it('does not publish or delete a staging name whose exact inode changed beyond Number precision', () => {
    const owned = Object.assign(fs.lstatSync(destination, { bigint: true }), { ino: 9007199254740992n });
    const replaced = Object.assign(fs.lstatSync(destination, { bigint: true }), { ino: 9007199254740993n });
    expect(Number(owned.ino)).toBe(Number(replaced.ino));
    vi.spyOn(fs, 'fstatSync').mockReturnValue(owned);
    vi.spyOn(fs, 'lstatSync').mockReturnValue(replaced);
    const rename = vi.spyOn(fs, 'renameSync');
    const unlink = vi.spyOn(fs, 'unlinkSync');
    expect(() => {
      writeProfileJson(destination, { changed: true });
    }).toThrow('identity changed');
    expect(rename).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.readFileSync(destination, 'utf8')).toBe(original);
  });

  it('syncs the publication directory and closes its descriptor', () => {
    const open = vi.spyOn(fs, 'openSync');
    const sync = vi.spyOn(fs, 'fsyncSync');
    const close = vi.spyOn(fs, 'closeSync');
    writeProfileJson(destination, { published: true });
    const directoryCall = open.mock.calls.findIndex(([candidate, flags]) => candidate === directory && flags === 'r');
    expect(directoryCall).toBeGreaterThanOrEqual(0);
    const result = open.mock.results[directoryCall];
    if (result.type !== 'return') throw new Error('Expected directory descriptor');
    expect(sync).toHaveBeenCalledWith(result.value);
    expect(close).toHaveBeenCalledWith(result.value);
  });

  it.each(['open', 'sync'] as const)('keeps publication when directory %s is unsupported', (failure) => {
    const originalOpen = fs.openSync;
    const originalSync = fs.fsyncSync;
    let directoryFd: number | undefined;
    vi.spyOn(fs, 'openSync').mockImplementation((candidate, flags, mode) => {
      if (candidate === directory && flags === 'r') {
        if (failure === 'open') throw new Error('directory open unsupported');
        directoryFd = originalOpen(candidate, flags, mode);
        return directoryFd;
      }
      return originalOpen(candidate, flags, mode);
    });
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (fd === directoryFd) throw new Error('directory sync unsupported');
      originalSync(fd);
    });
    const close = vi.spyOn(fs, 'closeSync');
    writeProfileJson(destination, { published: true });
    expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual({ published: true });
    expect(fs.readdirSync(directory)).toEqual(['Preferences']);
    if (directoryFd !== undefined) expect(close).toHaveBeenCalledWith(directoryFd);
  });

  it('stages in the literal target parent when symlink traversal precedes ..', () => {
    const actualParent = path.join(directory, 'actual');
    fs.mkdirSync(path.join(actualParent, 'child'), { recursive: true });
    fs.symlinkSync(path.join(actualParent, 'child'), path.join(directory, 'link'), 'dir');
    const rawTarget = `${directory}/link/../Preferences`;
    const rename = vi.spyOn(fs, 'renameSync');
    writeProfileJson(rawTarget, { actual: true });
    expect(rename).toHaveBeenCalledWith(
      expect.stringContaining(`${directory}/link/../.browserclaw-profile-`),
      rawTarget,
    );
    expect(JSON.parse(fs.readFileSync(path.join(actualParent, 'Preferences'), 'utf8'))).toEqual({ actual: true });
    expect(fs.readFileSync(destination, 'utf8')).toBe(original);
    expect(fs.readdirSync(actualParent).sort()).toEqual(['Preferences', 'child']);
  });

  it('publishes complete JSON with private permissions and preserves supplied fields', () => {
    writeProfileJson(destination, { existing: { keep: true }, net: { network_prediction_options: 2 } });
    expect(JSON.parse(fs.readFileSync(destination, 'utf8'))).toEqual({
      existing: { keep: true },
      net: { network_prediction_options: 2 },
    });
    if (process.platform !== 'win32') expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['Preferences']);
  });

  it.each(['writeFileSync', 'fchmodSync', 'fsyncSync', 'renameSync'] as const)(
    'preserves the previous document and cleans its own staging file when %s fails',
    (method) => {
      vi.spyOn(fs, method).mockImplementationOnce(() => {
        throw new Error('injected failure');
      });
      expect(() => {
        writeProfileJson(destination, { changed: true });
      }).toThrow('injected failure');
      expect(fs.readFileSync(destination, 'utf8')).toBe(original);
      expect(fs.readdirSync(directory)).toEqual(['Preferences']);
    },
  );

  it('does not publish or delete a replacement staging path', () => {
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce((fd) => {
      fsync(fd);
      const staging = stagingPath();
      fs.unlinkSync(staging);
      fs.writeFileSync(staging, 'replacement');
    });
    const rename = vi.spyOn(fs, 'renameSync');
    expect(() => {
      writeProfileJson(destination, { changed: true });
    }).toThrow('identity changed');
    expect(rename).not.toHaveBeenCalled();
    expect(fs.readFileSync(destination, 'utf8')).toBe(original);
    expect(fs.readFileSync(stagingPath(), 'utf8')).toBe('replacement');
  });

  it('rejects publication through a substituted symlink without changing its target', () => {
    const other = path.join(directory, 'other');
    fs.writeFileSync(other, 'unrelated');
    const fsync = fs.fsyncSync;
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce((fd) => {
      fsync(fd);
      const staging = stagingPath();
      fs.unlinkSync(staging);
      fs.symlinkSync(other, staging);
    });
    expect(() => {
      writeProfileJson(destination, { changed: true });
    }).toThrow('identity changed');
    expect(fs.readFileSync(other, 'utf8')).toBe('unrelated');
    expect(fs.readFileSync(destination, 'utf8')).toBe(original);
  });
});
