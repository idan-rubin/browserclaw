import { spawn } from 'node:child_process';

import { describe, it, expect } from 'vitest';

import { isChromeReachable, stopChrome } from './chrome-launcher.js';
import type { RunningChrome } from './types.js';

const CLOSED_PORT = 1;

describe('isChromeReachable with an authenticated direct WebSocket endpoint', () => {
  it('defers to the authenticated dial instead of probing with a credential-less socket', async () => {
    await expect(
      isChromeReachable(`ws://user:pass@127.0.0.1:${String(CLOSED_PORT)}/devtools/browser/abc`, 200),
    ).resolves.toBe(true);
    await expect(
      isChromeReachable(`ws://127.0.0.1:${String(CLOSED_PORT)}/devtools/browser/abc`, 200, 'token'),
    ).resolves.toBe(true);
  });

  it('control: the same endpoint without credentials is probed and found unreachable', async () => {
    await expect(isChromeReachable(`ws://127.0.0.1:${String(CLOSED_PORT)}/devtools/browser/abc`, 200)).resolves.toBe(
      false,
    );
  });
});

describe('stopChrome deadline', () => {
  it('escalates to SIGKILL within timeoutMs when the process ignores SIGTERM and CDP is unreachable', async () => {
    const proc = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
      detached: true,
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const running = {
      pid: proc.pid ?? -1,
      exe: { kind: 'chrome', path: process.execPath },
      userDataDir: '',
      cdpPort: CLOSED_PORT,
      startedAt: Date.now(),
      launchMs: 0,
      proc,
    } as unknown as RunningChrome;
    const timeoutMs = 800;
    const started = Date.now();
    await stopChrome(running, timeoutMs);
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(proc.exitCode !== null || proc.signalCode !== null).toBe(true);
    expect(elapsed).toBeLessThan(timeoutMs + 700);
  });
});
