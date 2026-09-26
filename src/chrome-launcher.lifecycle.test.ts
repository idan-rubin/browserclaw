import { spawn, type ChildProcess } from 'node:child_process';

import { describe, it, expect } from 'vitest';

import { isChromeReachable, stopChrome } from './chrome-launcher.js';
import { startFakeCdpServer } from './fake-cdp.test-support.js';
import type { RunningChrome } from './types.js';

const CLOSED_PORT = 1;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function spawnSigtermIgnoringProcess(): Promise<ChildProcess> {
  const proc = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
    detached: true,
    stdio: 'ignore',
  });
  await sleep(300);
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
    const cdp = await startFakeCdpServer({ stallOnBrowserClose: true });
    const proc = await spawnSigtermIgnoringProcess();
    try {
      const timeoutMs = 100;
      const started = Date.now();
      await stopChrome(runningChromeFor(proc, cdp.port), timeoutMs);
      const elapsed = Date.now() - started;
      await sleep(100);
      expect(cdp.frames.map((f) => f.method)).toContain('Browser.close');
      expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
      expect(elapsed).toBeLessThan(400);
    } finally {
      await cdp.close();
    }
  });
});
