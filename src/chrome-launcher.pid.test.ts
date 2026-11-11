import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { clearStaleChromeSingletonLocks, processExists } from './chrome-launcher.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
if (!originalPlatform) throw new Error('Missing platform descriptor');
const pid = 987654;
let kill: MockInstance<typeof process.kill>;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
  kill = vi.spyOn(process, 'kill').mockReturnValue(true);
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks();
});

describe('Chrome singleton PID liveness', () => {
  it.each([
    ['State:\tZ (zombie)\nThreads:\t1\n', false],
    ['State:\tZ (zombie)\nThreads:\t2\n', true],
    ['State:\tS (sleeping)\nThreads:\t1\n', true],
    ['State:\tZ (zombie)\n', true],
    ['State:\tX (dead)\nThreads:\t1\n', false],
    [`State:\tS (sleeping)\nTgid:\t${String(pid)}\nThreads:\t4\n`, true],
    [`State:\tZ (zombie)\nTgid:\t${String(pid)}\nThreads:\t4\n`, true],
    ['State:\tS (sleeping)\nTgid:\t4321\nThreads:\t4\n', false],
  ])('checks exited threads in %s', (status, alive) => {
    vi.spyOn(fs, 'readFileSync').mockReturnValue(status);
    expect(processExists(pid)).toBe(alive);
    expect(fs.readFileSync).toHaveBeenCalledWith(`/proc/${String(pid)}/status`, 'utf8');
    expect(kill).toHaveBeenCalledWith(pid, 0);
  });

  it('retains an owner when Linux status cannot be read', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('unreadable');
    });
    expect(processExists(pid)).toBe(true);
  });

  it.each([
    ['an unreadable status', undefined],
    ['a reaped status snapshot', 'State:\tZ (zombie)\nThreads:\t0\n'],
  ])('probes again after %s', (_label, status) => {
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      if (status === undefined) throw new Error('unreadable');
      return status;
    });
    expect(processExists(pid)).toBe(true);
    expect(kill).toHaveBeenCalledTimes(2);
    kill.mockReturnValueOnce(true).mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(processExists(pid)).toBe(true);
    kill.mockReturnValueOnce(true).mockImplementationOnce(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    expect(processExists(pid)).toBe(false);
  });

  it('checks zombie status even after EPERM, but skips it for ESRCH', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue('State:\tZ\nThreads:\t1\n');
    kill.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    expect(processExists(pid)).toBe(false);
    read.mockClear();
    kill.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });
    expect(processExists(pid)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not inspect Linux proc files on other platforms', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    const read = vi.spyOn(fs, 'readFileSync');
    expect(processExists(pid)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['zombie', 'State:\tS\nThreads:\t1\n', 'State:\tZ\nThreads:\t1\n'],
    [
      'recycled worker thread ID',
      `State:\tS\nTgid:\t${String(pid)}\nThreads:\t3\n`,
      'State:\tS\nTgid:\t4321\nThreads:\t3\n',
    ],
  ])('clears actual same-host %s lock artifacts but preserves a live owner', (_label, liveStatus, staleStatus) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-stale-lock-'));
    const originalRead = fs.readFileSync.bind(fs);
    let status = liveStatus;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file, ...args) =>
      String(file) === `/proc/${String(pid)}/status` ? status : originalRead(file, ...args)) as typeof fs.readFileSync);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fs.symlinkSync(`${os.hostname()}-${String(pid)}`, path.join(dir, 'SingletonLock'));
      fs.writeFileSync(path.join(dir, 'SingletonSocket'), 'test');
      expect(clearStaleChromeSingletonLocks(dir)).toBe(false);
      expect(fs.lstatSync(path.join(dir, 'SingletonLock')).isSymbolicLink()).toBe(true);
      status = staleStatus;
      expect(clearStaleChromeSingletonLocks(dir)).toBe(true);
      expect(() => fs.lstatSync(path.join(dir, 'SingletonLock'))).toThrow();
      expect(fs.existsSync(path.join(dir, 'SingletonSocket'))).toBe(false);
      expect(kill).toHaveBeenCalledTimes(2);
      expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
