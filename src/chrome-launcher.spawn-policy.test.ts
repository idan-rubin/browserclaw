import type * as ChildProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  spawn: spawnMock,
}));

import { launchChrome } from './chrome-launcher.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
if (!originalPlatform) throw new Error('Missing platform descriptor');
let userDataDir: string;
let executablePath: string;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserclaw-spawn-policy-'));
  executablePath = path.join(userDataDir, 'browser');
  fs.writeFileSync(executablePath, 'test fixture');
  spawnMock.mockReset().mockImplementation(() => {
    throw new Error('spawn captured');
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.unstubAllEnvs();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('Chrome spawn policy', () => {
  it.each([
    { localState: false, preferences: false, marker: false, headless: true, mock: true },
    { localState: true, preferences: false, marker: false, headless: true, mock: false },
    { localState: true, preferences: true, marker: false, headless: true, mock: false },
    { localState: true, preferences: false, marker: true, headless: true, mock: true },
    { localState: false, preferences: false, marker: false, headless: false, mock: false },
  ])('preserves keychain mode for $localState/$preferences/$marker/$headless', async (testCase) => {
    if (testCase.localState)
      fs.writeFileSync(
        path.join(userDataDir, 'Local State'),
        JSON.stringify({ profile: { info_cache: { Default: { browserclaw_mock_keychain: testCase.marker } } } }),
      );
    if (testCase.preferences) {
      fs.mkdirSync(path.join(userDataDir, 'Default'));
      fs.writeFileSync(path.join(userDataDir, 'Default', 'Preferences'), '{}');
    }
    await expect(launchChrome({ executablePath, userDataDir, headless: testCase.headless })).rejects.toThrow(
      'spawn captured',
    );
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const options = spawnMock.mock.calls[0]?.[2] as ChildProcess.SpawnOptions;
    expect(args.includes('--use-mock-keychain')).toBe(testCase.mock);
    const incomplete = !testCase.localState || !testCase.preferences;
    // Only a headed launch of an incomplete profile runs the detached bootstrap, and that run is headless.
    expect(options.detached === true).toBe(incomplete && !testCase.headless);
    if (incomplete) expect(args).toContain('--headless=new');
  });

  it('writes the profile files itself for a headless launch of a new profile', async () => {
    await expect(launchChrome({ executablePath, userDataDir, headless: true, profileName: 'fresh' })).rejects.toThrow(
      'spawn captured',
    );
    expect(spawnMock).toHaveBeenCalledOnce();
    const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8')) as {
      profile: { info_cache: { Default: { name: string } } };
    };
    const preferences = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Default', 'Preferences'), 'utf8')) as {
      profile: { name: string };
      exit_type: string;
    };
    expect(localState.profile.info_cache.Default.name).toBe('fresh');
    expect(preferences.profile.name).toBe('fresh');
    expect(preferences.exit_type).toBe('Normal');
  });

  it.each(['chrome-headless-shell', 'headless_shell', 'chrome-headless-shell.exe'])(
    'refuses a headed launch of %s before spawning',
    async (name) => {
      const shell = path.join(userDataDir, name);
      fs.writeFileSync(shell, 'test fixture');
      await expect(launchChrome({ executablePath: shell, userDataDir })).rejects.toThrow(
        'Chromium headless shell cannot open a headed window',
      );
      expect(spawnMock).not.toHaveBeenCalled();
      await expect(launchChrome({ executablePath: shell, userDataDir, headless: true })).rejects.toThrow(
        'spawn captured',
      );
    },
  );

  it.each([
    { platform: 'linux', tmp: '/' + 'x'.repeat(49), shorten: false },
    { platform: 'linux', tmp: '/' + 'é'.repeat(25), shorten: true },
    { platform: 'darwin', tmp: '/' + 'é'.repeat(25), shorten: false },
  ])('sets a short child TMPDIR only when a Linux path exceeds 50 bytes ($platform, $shorten)', async (testCase) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: testCase.platform });
    vi.stubEnv('TMPDIR', testCase.tmp);
    await expect(launchChrome({ executablePath, userDataDir })).rejects.toThrow('spawn captured');
    const options = spawnMock.mock.calls[0]?.[2] as ChildProcess.SpawnOptions;
    expect(options.env?.TMPDIR).toBe(testCase.shorten ? '/tmp' : testCase.tmp);
    expect(process.env.TMPDIR).toBe(testCase.tmp);
  });

  it.each([
    { preload: 'libjemalloc.so', expected: undefined },
    {
      preload: '/lib/audit.so:/usr/lib/libjemalloc.so.2.0 /lib/custom-libjemalloc.so',
      expected: '/lib/audit.so:/lib/custom-libjemalloc.so',
    },
  ])('removes allocator settings only in the Chrome child ($preload)', async ({ preload, expected }) => {
    vi.stubEnv('MALLOC_CONF', 'background_thread:true');
    vi.stubEnv('LD_PRELOAD', preload);
    await expect(launchChrome({ executablePath, userDataDir, headless: true })).rejects.toThrow('spawn captured');
    const options = spawnMock.mock.calls[0]?.[2] as ChildProcess.SpawnOptions;
    expect(options.env?.LD_PRELOAD).toBe(expected);
    expect(options.env).not.toHaveProperty('MALLOC_CONF');
    expect(process.env.LD_PRELOAD).toBe(preload);
    expect(process.env.MALLOC_CONF).toBe('background_thread:true');
  });

  it('strips child proxy environment while preserving the parent, unrelated env and explicit proxy args', async () => {
    const keys = [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
    ];
    for (const key of keys) vi.stubEnv(key, `test-${key}`);
    vi.stubEnv('BROWSERCLAW_SPAWN_CONTROL', 'retained');
    const chromeArgs = ['--proxy-server=http://configured.test:8080'];
    await expect(launchChrome({ executablePath, userDataDir, chromeArgs })).rejects.toThrow('spawn captured');
    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const options = spawnMock.mock.calls[0]?.[2] as ChildProcess.SpawnOptions;
    for (const key of keys) {
      expect(options.env).not.toHaveProperty(key);
      expect(process.env[key]).toBe(`test-${key}`);
    }
    expect(options.env?.BROWSERCLAW_SPAWN_CONTROL).toBe('retained');
    expect(options.env?.HOME).toBe(os.homedir());
    expect(args).toContain(chromeArgs[0]);
    expect(args).not.toContain('--no-proxy-server');
  });
});
