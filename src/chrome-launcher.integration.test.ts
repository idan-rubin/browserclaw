import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { isChromeCdpReady, launchChrome, stopChrome } from './chrome-launcher.js';

const executablePath = [chromium.executablePath(), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(
  (candidate) => candidate !== '' && fs.existsSync(candidate),
);

describe.skipIf(executablePath === undefined)('launchChrome (real Chromium)', () => {
  it('starts a brand-new headless profile from the files it wrote itself', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-launch-'));
    try {
      const running = await launchChrome({
        executablePath,
        userDataDir,
        headless: true,
        profileName: 'fresh-profile',
        noSandbox: process.platform === 'linux',
      });
      try {
        expect(running.proc.exitCode).toBeNull();
        expect(await isChromeCdpReady(`http://127.0.0.1:${String(running.cdpPort)}`)).toBe(true);
      } finally {
        await stopChrome(running);
      }
      const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8')) as {
        profile: { info_cache: { Default: { name: string } } };
      };
      expect(localState.profile.info_cache.Default.name).toBe('fresh-profile');
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
