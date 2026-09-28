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

  it('clears actual same-host zombie lock artifacts but preserves a live owner', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-zombie-lock-'));
    const originalRead = fs.readFileSync.bind(fs);
    let status = 'State:\tS\nThreads:\t1\n';
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file, ...args) =>
      String(file) === `/proc/${String(pid)}/status` ? status : originalRead(file, ...args)) as typeof fs.readFileSync);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      fs.symlinkSync(`${os.hostname()}-${String(pid)}`, path.join(dir, 'SingletonLock'));
      fs.writeFileSync(path.join(dir, 'SingletonSocket'), 'test');
      expect(clearStaleChromeSingletonLocks(dir)).toBe(false);
      expect(fs.lstatSync(path.join(dir, 'SingletonLock')).isSymbolicLink()).toBe(true);
      status = 'State:\tZ\nThreads:\t1\n';
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
