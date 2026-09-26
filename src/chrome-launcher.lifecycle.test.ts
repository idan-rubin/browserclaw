import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import { isChromeReachable, launchChrome, stopChrome } from './chrome-launcher.js';
import { startFakeCdpServer } from './fake-cdp.test-support.js';
import type { RunningChrome } from './types.js';

const CLOSED_PORT = 1;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function spawnSigtermIgnoringProcess(): Promise<ChildProcess> {
  const proc = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  await once(proc, 'message');
  proc.disconnect();
  return proc;
}

function runningChromeFor(proc: ChildProcess, cdpPort: number): RunningChrome {
  return {
    pid: proc.pid ?? -1,
    exe: { kind: 'chrome', path: process.execPath },
    userDataDir: '',
    cdpPort,
    startedAt: Date.now(),
    launchMs: 0,
    proc,
  } as unknown as RunningChrome;
}

describe('isChromeReachable against a direct WebSocket endpoint that requires Basic auth', () => {
  const auth = `Basic ${Buffer.from('user:pass').toString('base64')}`;

  it('sends the URL credentials on the probe', async () => {
    const cdp = await startFakeCdpServer({ requireAuthorization: auth });
    try {
      await expect(
        isChromeReachable(`ws://user:pass@127.0.0.1:${String(cdp.port)}/devtools/browser/abc`, 500),
      ).resolves.toBe(true);
      expect(cdp.authSeen).toContain(auth);
    } finally {
      await cdp.close();
    }
  });

  it('control: the same endpoint without credentials is rejected by the server', async () => {
    const cdp = await startFakeCdpServer({ requireAuthorization: auth });
    try {
      await expect(isChromeReachable(`ws://127.0.0.1:${String(cdp.port)}/devtools/browser/abc`, 500)).resolves.toBe(
        false,
      );
    } finally {
      await cdp.close();
    }
  });
});

describe('stopChrome deadline', () => {
  it('escalates to SIGKILL within timeoutMs when the process ignores SIGTERM and CDP is unreachable', async () => {
    const proc = await spawnSigtermIgnoringProcess();
    const timeoutMs = 800;
    const started = Date.now();
    await stopChrome(runningChromeFor(proc, CLOSED_PORT), timeoutMs);
    const elapsed = Date.now() - started;
    await sleep(100);
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    expect(elapsed).toBeLessThan(timeoutMs + 700);
  });

  it('stays within timeoutMs when CDP accepts Browser.close and then stalls every probe', async () => {
    const proc = await spawnSigtermIgnoringProcess();
    const cdp = await startFakeCdpServer({ stallOnBrowserClose: true, browserProcessId: proc.pid });
    try {
      const timeoutMs = 100;
      const started = Date.now();
      let unconfirmed: unknown;
      try {
        await stopChrome(runningChromeFor(proc, cdp.port), timeoutMs);
      } catch (error) {
        unconfirmed = error;
      }
      const elapsed = Date.now() - started;
      if (unconfirmed !== undefined) {
        expect(unconfirmed).toBeInstanceOf(Error);
        expect((unconfirmed as Error).message).toBe(
          `Chrome process ${String(proc.pid)} survived shutdown; its profile was preserved.`,
        );
      }
      expect(cdp.frames.map((f) => f.method)).toContain('Browser.close');
      expect(elapsed).toBeLessThan(400);
      await vi.waitFor(
        () => {
          expect(proc.signalCode).toBe('SIGKILL');
        },
        { timeout: 2000 },
      );
    } finally {
      proc.kill('SIGKILL');
      await cdp.close();
    }
  });

  it('does not close a different browser that now owns the CDP port', async () => {
    const proc = await spawnSigtermIgnoringProcess();
    const cdp = await startFakeCdpServer({ browserProcessId: (proc.pid ?? 0) + 1 });
    try {
      await stopChrome(runningChromeFor(proc, cdp.port), 500);
      expect(cdp.frames.map((frame) => frame.method)).toContain('SystemInfo.getProcessInfo');
      expect(cdp.frames.map((frame) => frame.method)).not.toContain('Browser.close');
      expect(proc.signalCode).toBe('SIGKILL');
    } finally {
      proc.kill('SIGKILL');
      await cdp.close();
    }
  });

  it('confirms the signal exit before deleting an isolated profile', async () => {
    const proc = await spawnSigtermIgnoringProcess();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-stop-test-'));
    const running = { ...runningChromeFor(proc, CLOSED_PORT), userDataDir, isolated: true };
    let profileExistedAtExit = false;
    proc.once('exit', () => {
      profileExistedAtExit = fs.existsSync(userDataDir);
    });
    try {
      await stopChrome(running, 500);
      expect(profileExistedAtExit).toBe(true);
      expect(proc.signalCode).toBe('SIGKILL');
      expect(fs.existsSync(userDataDir)).toBe(false);
    } finally {
      proc.kill('SIGKILL');
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('preserves the isolated profile when neither signal confirms child exit', async () => {
    const proc = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true) });
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-survivor-test-'));
    const running = {
      ...runningChromeFor(proc as unknown as ChildProcess, CLOSED_PORT),
      userDataDir,
      isolated: true,
    };
    try {
      await expect(stopChrome(running, 80)).rejects.toThrow('profile was preserved');
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
      expect(fs.existsSync(userDataDir)).toBe(true);
      expect(proc.listenerCount('exit')).toBe(0);
      expect(proc.listenerCount('close')).toBe(0);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});

describe('launchChrome asynchronous spawn failures', () => {
  it.each([false, true])('rejects without an unhandled process error (existing profile: %s)', async (existing) => {
    if (process.platform === 'win32') return;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-spawn-test-'));
    const executablePath = path.join(userDataDir, 'not-executable');
    fs.writeFileSync(executablePath, 'not an executable', { mode: 0o600 });
    if (existing) {
      fs.writeFileSync(path.join(userDataDir, 'Local State'), '{}');
      fs.mkdirSync(path.join(userDataDir, 'Default'));
      fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), '{}');
    }
    try {
      await expect(launchChrome({ executablePath, userDataDir })).rejects.toThrow(/EACCES/);
      if (existing) {
        const prefs = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Default', 'Preferences'), 'utf8')) as {
          net: { network_prediction_options: number };
        };
        expect(prefs.net.network_prediction_options).toBe(2);
      }
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
