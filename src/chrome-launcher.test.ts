import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      optsOrCb: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const callback = typeof optsOrCb === 'function' ? (optsOrCb as typeof cb) : cb;
      execFileMock(file, args);
      if (typeof callback === 'function') callback(null, '', '');
      return { kill: () => undefined, unref: () => undefined } as unknown as ReturnType<typeof actual.execFile>;
    },
  };
});

const {
  isLoopbackHost,
  isDirectCdpWebSocketEndpoint,
  hasProxyEnvConfigured,
  normalizeCdpWsUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  resolveIsolatedProfile,
  processExists,
  clearChromeSingletonArtifacts,
  clearStaleChromeSingletonLocks,
  buildChromeLaunchArgs,
  wipeChromeSessionState,
  reservePortStartingAt,
  activateMacOsWindowByPid,
} = await import('./chrome-launcher.js');

// ─────────────────────────────────────────────────────────────────────────────
// isLoopbackHost
// ─────────────────────────────────────────────────────────────────────────────

describe('isLoopbackHost', () => {
  it('recognizes localhost', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
  });

  it('recognizes 127.0.0.1', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
  });

  it('recognizes ::1', () => {
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('recognizes [::1]', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('strips trailing dots', () => {
    expect(isLoopbackHost('localhost.')).toBe(true);
    expect(isLoopbackHost('localhost...')).toBe(true);
  });

  it('rejects external hostnames', () => {
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.1.1')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isLoopbackHost('')).toBe(false);
  });

  it('is case sensitive (hostnames are typically lowercase)', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(false);
    expect(isLoopbackHost('Localhost')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isDirectCdpWebSocketEndpoint
// ─────────────────────────────────────────────────────────────────────────────

describe('isDirectCdpWebSocketEndpoint', () => {
  it('recognizes /devtools/browser/<id>', () => {
    expect(isDirectCdpWebSocketEndpoint('ws://localhost:9222/devtools/browser/abc-123')).toBe(true);
    expect(isDirectCdpWebSocketEndpoint('wss://remote:443/devtools/browser/abc-123')).toBe(true);
  });

  it('recognizes /devtools/page/<id>, /devtools/worker/<id>, /devtools/shared_worker/<id>, /devtools/service_worker/<id>', () => {
    expect(isDirectCdpWebSocketEndpoint('ws://host/devtools/page/abc')).toBe(true);
    expect(isDirectCdpWebSocketEndpoint('ws://host/devtools/worker/abc')).toBe(true);
    expect(isDirectCdpWebSocketEndpoint('ws://host/devtools/shared_worker/abc')).toBe(true);
    expect(isDirectCdpWebSocketEndpoint('ws://host/devtools/service_worker/abc')).toBe(true);
  });

  it('rejects non-WS protocols', () => {
    expect(isDirectCdpWebSocketEndpoint('http://localhost:9222/devtools/browser/abc')).toBe(false);
    expect(isDirectCdpWebSocketEndpoint('https://localhost:9222/devtools/browser/abc')).toBe(false);
  });

  it('rejects WS URLs without a /devtools/<type>/<id> path', () => {
    expect(isDirectCdpWebSocketEndpoint('ws://proxy/cdp')).toBe(false);
    expect(isDirectCdpWebSocketEndpoint('ws://localhost:9222/')).toBe(false);
    expect(isDirectCdpWebSocketEndpoint('ws://localhost:9222/devtools/browser/')).toBe(false);
    expect(isDirectCdpWebSocketEndpoint('ws://localhost:9222/devtools/unknown/abc')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isDirectCdpWebSocketEndpoint('')).toBe(false);
    expect(isDirectCdpWebSocketEndpoint('not a url')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hasProxyEnvConfigured
// ─────────────────────────────────────────────────────────────────────────────

describe('hasProxyEnvConfigured', () => {
  it('returns false for empty env', () => {
    expect(hasProxyEnvConfigured({})).toBe(false);
  });

  it('detects HTTP_PROXY', () => {
    expect(hasProxyEnvConfigured({ HTTP_PROXY: 'http://proxy:8080' })).toBe(true);
  });

  it('detects HTTPS_PROXY', () => {
    expect(hasProxyEnvConfigured({ HTTPS_PROXY: 'http://proxy:8080' })).toBe(true);
  });

  it('detects ALL_PROXY', () => {
    expect(hasProxyEnvConfigured({ ALL_PROXY: 'socks5://proxy:1080' })).toBe(true);
  });

  it('detects lowercase variants', () => {
    expect(hasProxyEnvConfigured({ http_proxy: 'http://proxy:8080' })).toBe(true);
    expect(hasProxyEnvConfigured({ https_proxy: 'http://proxy:8080' })).toBe(true);
    expect(hasProxyEnvConfigured({ all_proxy: 'socks5://proxy:1080' })).toBe(true);
  });

  it('ignores empty string values', () => {
    expect(hasProxyEnvConfigured({ HTTP_PROXY: '' })).toBe(false);
  });

  it('ignores whitespace-only values', () => {
    expect(hasProxyEnvConfigured({ HTTP_PROXY: '   ' })).toBe(false);
  });

  it('ignores undefined values', () => {
    expect(hasProxyEnvConfigured({ HTTP_PROXY: undefined })).toBe(false);
  });

  it('ignores unrelated env vars', () => {
    expect(hasProxyEnvConfigured({ NODE_ENV: 'production', HOME: '/root' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeCdpWsUrl
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeCdpWsUrl', () => {
  it('preserves ws URL when both are local', () => {
    const result = normalizeCdpWsUrl('ws://127.0.0.1:9222/devtools/browser/abc', 'http://127.0.0.1:9222');
    expect(result).toContain('ws://');
    expect(result).toContain('127.0.0.1');
  });

  it('replaces loopback hostname with external CDP hostname', () => {
    const result = normalizeCdpWsUrl('ws://127.0.0.1:9222/devtools/browser/abc', 'https://remote.example.com:3000');
    expect(result).toContain('remote.example.com');
    expect(result).toContain('3000');
    expect(result).toContain('wss://');
  });

  it('replaces wildcard bind 0.0.0.0 with CDP hostname', () => {
    const result = normalizeCdpWsUrl('ws://0.0.0.0:9222/devtools/browser/abc', 'https://my-host.com:4000');
    expect(result).toContain('my-host.com');
  });

  it('replaces wildcard bind [::] with CDP hostname', () => {
    const result = normalizeCdpWsUrl('ws://[::]:9222/devtools/browser/abc', 'https://my-host.com:4000');
    expect(result).toContain('my-host.com');
  });

  it('upgrades ws to wss when CDP is https', () => {
    const result = normalizeCdpWsUrl('ws://127.0.0.1:9222/path', 'https://remote.com');
    expect(result.startsWith('wss://')).toBe(true);
  });

  it('normalizes loopback aliases (ws localhost, cdp 127.0.0.1 → use cdp alias)', () => {
    const result = normalizeCdpWsUrl('ws://localhost:9222/devtools/browser/abc', 'http://127.0.0.1:9222');
    expect(result).toContain('127.0.0.1');
    expect(result).not.toContain('localhost');
  });

  it('normalizes loopback aliases in reverse (ws 127.0.0.1, cdp localhost → use cdp alias)', () => {
    const result = normalizeCdpWsUrl('ws://127.0.0.1:9222/devtools/browser/abc', 'http://localhost:9222');
    expect(result).toContain('localhost');
    expect(result).not.toContain('127.0.0.1');
  });

  it('normalizes IPv6 loopback to IPv4 loopback when cdp is IPv4 ([::1] → 127.0.0.1)', () => {
    const result = normalizeCdpWsUrl('ws://[::1]:9222/devtools/browser/abc', 'http://127.0.0.1:9222');
    expect(result).toContain('127.0.0.1');
    expect(result).not.toContain('[::1]');
  });

  it('inherits URL credentials from CDP URL', () => {
    const result = normalizeCdpWsUrl('ws://localhost:9222/path', 'http://user:pass@localhost:9222');
    const parsed = new URL(result);
    expect(parsed.username).toBe('user');
    expect(parsed.password).toBe('pass');
  });

  it('does not override existing ws credentials', () => {
    const result = normalizeCdpWsUrl('ws://wsuser:wspass@localhost:9222/path', 'http://cdpuser:cdppass@localhost:9222');
    const parsed = new URL(result);
    expect(parsed.username).toBe('wsuser');
  });

  it('inherits search params from CDP URL', () => {
    const result = normalizeCdpWsUrl('ws://localhost:9222/path', 'http://localhost:9222?token=abc');
    expect(result).toContain('token=abc');
  });

  it('does not override existing ws search params', () => {
    const result = normalizeCdpWsUrl('ws://localhost:9222/path?token=ws', 'http://localhost:9222?token=cdp');
    const parsed = new URL(result);
    expect(parsed.searchParams.get('token')).toBe('ws');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeCdpHttpBaseForJsonEndpoints
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeCdpHttpBaseForJsonEndpoints', () => {
  it('converts ws: to http:', () => {
    expect(normalizeCdpHttpBaseForJsonEndpoints('ws://localhost:9222')).toBe('http://localhost:9222');
  });

  it('converts wss: to https:', () => {
    expect(normalizeCdpHttpBaseForJsonEndpoints('wss://remote.com:9222')).toBe('https://remote.com:9222');
  });

  it('strips /devtools/browser/ path', () => {
    const result = normalizeCdpHttpBaseForJsonEndpoints('ws://localhost:9222/devtools/browser/abc-123');
    expect(result).toBe('http://localhost:9222');
  });

  it('strips /cdp path', () => {
    const result = normalizeCdpHttpBaseForJsonEndpoints('ws://localhost:9222/cdp');
    expect(result).toBe('http://localhost:9222');
  });

  it('strips trailing slash', () => {
    const result = normalizeCdpHttpBaseForJsonEndpoints('http://localhost:9222/');
    expect(result).toBe('http://localhost:9222');
  });

  it('handles already-http URLs', () => {
    expect(normalizeCdpHttpBaseForJsonEndpoints('http://localhost:9222')).toBe('http://localhost:9222');
  });

  it('fallback: handles malformed URLs gracefully', () => {
    // The fallback branch uses string replacement
    const result = normalizeCdpHttpBaseForJsonEndpoints('ws://localhost:9222/devtools/browser/xyz');
    expect(result).toBe('http://localhost:9222');
  });

  it('preserves custom paths that are not CDP-specific', () => {
    const result = normalizeCdpHttpBaseForJsonEndpoints('ws://localhost:9222/custom/path');
    expect(result).toContain('/custom/path');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveIsolatedProfile
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveIsolatedProfile', () => {
  const isolatedRoot = path.join(os.tmpdir(), 'browserclaw', 'isolated');

  it('produces a unique directory for isolated: true across calls', () => {
    const a = resolveIsolatedProfile(true);
    const b = resolveIsolatedProfile(true);
    expect(a.userDataDir).not.toBe(b.userDataDir);
    expect(a.profileName).not.toBe(b.profileName);
  });

  it('produces a unique directory when the same string label is reused', () => {
    // Guards the concurrent-launch case: two runs with isolated: "myname"
    // must not end up on the same user-data-dir (Chrome SingletonLock).
    const a = resolveIsolatedProfile('myname');
    const b = resolveIsolatedProfile('myname');
    expect(a.userDataDir).not.toBe(b.userDataDir);
    expect(a.profileName).not.toBe(b.profileName);
  });

  it('prefixes the directory with the sanitized label for easy identification', () => {
    const { userDataDir } = resolveIsolatedProfile('my/weird name!');
    const namePart = path.basename(userDataDir);
    expect(namePart.startsWith('my_weird_name_-')).toBe(true);
    expect(path.dirname(userDataDir)).toBe(isolatedRoot);
  });

  it('falls back to "run" label when no string is provided', () => {
    const { userDataDir, profileName } = resolveIsolatedProfile(true);
    const namePart = path.basename(userDataDir);
    expect(namePart.startsWith('run-')).toBe(true);
    expect(profileName.startsWith('browserclaw-run-')).toBe(true);
  });

  it('treats empty / whitespace strings as an unlabelled run', () => {
    const { userDataDir } = resolveIsolatedProfile('   ');
    expect(path.basename(userDataDir).startsWith('run-')).toBe(true);
  });

  it('places isolated profiles under $TMPDIR/browserclaw/isolated/', () => {
    const { userDataDir } = resolveIsolatedProfile(true);
    expect(userDataDir.startsWith(isolatedRoot + path.sep)).toBe(true);
  });

  it('caps the label portion at 32 chars before appending the suffix', () => {
    const { userDataDir } = resolveIsolatedProfile('a'.repeat(100));
    const namePart = path.basename(userDataDir);
    const label = namePart.split('-')[0];
    expect(label.length).toBe(32);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// processExists
// ─────────────────────────────────────────────────────────────────────────────

describe('processExists', () => {
  it('returns true for the current process pid', () => {
    expect(processExists(process.pid)).toBe(true);
  });

  it('returns false for an obviously dead pid', () => {
    expect(processExists(2147483646)).toBe(false);
  });

  it('rejects non-positive integers', () => {
    expect(processExists(0)).toBe(false);
    expect(processExists(-1)).toBe(false);
    expect(processExists(1.5)).toBe(false);
    expect(processExists(Number.NaN)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearChromeSingletonArtifacts / clearStaleChromeSingletonLocks
// ─────────────────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-singleton-'));
}

describe('clearChromeSingletonArtifacts', () => {
  it('removes Singleton* files when present', () => {
    const dir = makeTempDir();
    try {
      fs.writeFileSync(path.join(dir, 'SingletonLock'), 'x');
      fs.writeFileSync(path.join(dir, 'SingletonSocket'), 'x');
      fs.writeFileSync(path.join(dir, 'SingletonCookie'), 'x');
      clearChromeSingletonArtifacts(dir);
      expect(() => fs.lstatSync(path.join(dir, 'SingletonLock'))).toThrow();
      expect(fs.existsSync(path.join(dir, 'SingletonSocket'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'SingletonCookie'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when no artifacts exist', () => {
    const dir = makeTempDir();
    try {
      expect(() => {
        clearChromeSingletonArtifacts(dir);
      }).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('clearStaleChromeSingletonLocks', () => {
  // Skip on Windows where SingletonLock isn't a symlink
  const itUnix = process.platform === 'win32' ? it.skip : it;

  itUnix('returns false when SingletonLock is absent', () => {
    const dir = makeTempDir();
    try {
      expect(clearStaleChromeSingletonLocks(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  itUnix('returns false when lock is held by a live process on the same host', () => {
    const dir = makeTempDir();
    try {
      const target = `${os.hostname()}-${String(process.pid)}`;
      fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
      expect(clearStaleChromeSingletonLocks(dir, os.hostname())).toBe(false);
      expect(fs.lstatSync(path.join(dir, 'SingletonLock')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  itUnix('clears artifacts when lock pid is dead', () => {
    const dir = makeTempDir();
    try {
      const target = `${os.hostname()}-2147483646`;
      fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
      fs.writeFileSync(path.join(dir, 'SingletonSocket'), 'x');
      expect(clearStaleChromeSingletonLocks(dir, os.hostname())).toBe(true);
      expect(() => fs.lstatSync(path.join(dir, 'SingletonLock'))).toThrow();
      expect(fs.existsSync(path.join(dir, 'SingletonSocket'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  itUnix('does NOT clear when lock host differs (cross-host liveness unknown)', () => {
    const dir = makeTempDir();
    try {
      const target = `some-other-host-${String(process.pid)}`;
      fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
      expect(clearStaleChromeSingletonLocks(dir, os.hostname())).toBe(false);
      expect(fs.lstatSync(path.join(dir, 'SingletonLock')).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  itUnix('returns false when lock target has unexpected format', () => {
    const dir = makeTempDir();
    try {
      fs.symlinkSync('not-a-valid-target', path.join(dir, 'SingletonLock'));
      expect(clearStaleChromeSingletonLocks(dir, os.hostname())).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildChromeLaunchArgs
// ─────────────────────────────────────────────────────────────────────────────

describe('buildChromeLaunchArgs', () => {
  const baseOpts = {
    cdpPort: 9222,
    userDataDir: '/tmp/test',
    headless: false,
    noSandbox: false,
    ignoreHTTPSErrors: false,
    ciDefaults: false,
    platform: 'darwin' as NodeJS.Platform,
  };

  it('emits the minimum CDP-required args by default', () => {
    const args = buildChromeLaunchArgs(baseOpts);
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--user-data-dir=/tmp/test');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--no-default-browser-check');
    expect(args).toContain('--disable-blink-features=AutomationControlled');
    expect(args).toContain('about:blank');
  });

  it('does NOT include CI-deterministic flags by default (anti-fingerprint)', () => {
    const args = buildChromeLaunchArgs(baseOpts);
    expect(args).not.toContain('--disable-sync');
    expect(args).not.toContain('--disable-background-networking');
    expect(args).not.toContain('--disable-component-update');
    expect(args).not.toContain('--disable-features=Translate,MediaRouter');
  });

  it('adds CI-deterministic flags when ciDefaults: true', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, ciDefaults: true });
    expect(args).toContain('--disable-sync');
    expect(args).toContain('--disable-background-networking');
    expect(args).toContain('--disable-component-update');
    expect(args).toContain('--disable-features=Translate,MediaRouter');
  });

  it('adds --password-store=basic on linux always (avoid keyring hang)', () => {
    expect(buildChromeLaunchArgs({ ...baseOpts, platform: 'linux' })).toContain('--password-store=basic');
    expect(buildChromeLaunchArgs({ ...baseOpts, platform: 'linux', ciDefaults: true })).toContain(
      '--password-store=basic',
    );
  });

  it('does NOT add --password-store=basic on non-linux', () => {
    expect(buildChromeLaunchArgs({ ...baseOpts, platform: 'darwin' })).not.toContain('--password-store=basic');
    expect(buildChromeLaunchArgs({ ...baseOpts, platform: 'win32' })).not.toContain('--password-store=basic');
  });

  it('adds --ignore-certificate-errors when ignoreHTTPSErrors: true', () => {
    expect(buildChromeLaunchArgs({ ...baseOpts, ignoreHTTPSErrors: true })).toContain('--ignore-certificate-errors');
    expect(buildChromeLaunchArgs(baseOpts)).not.toContain('--ignore-certificate-errors');
  });

  it('adds --headless=new and --disable-gpu when headless', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, headless: true });
    expect(args).toContain('--headless=new');
    expect(args).toContain('--disable-gpu');
  });

  it('adds --no-sandbox when requested', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, noSandbox: true });
    expect(args).toContain('--no-sandbox');
  });

  it('does NOT add --disable-setuid-sandbox (was redundant with --no-sandbox)', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, noSandbox: true });
    expect(args).not.toContain('--disable-setuid-sandbox');
  });

  it('adds --disable-dev-shm-usage on linux', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, platform: 'linux' });
    expect(args).toContain('--disable-dev-shm-usage');
  });

  it('does not add --disable-dev-shm-usage on darwin', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, platform: 'darwin' });
    expect(args).not.toContain('--disable-dev-shm-usage');
  });

  it('appends extra chromeArgs after defaults but before about:blank', () => {
    const args = buildChromeLaunchArgs({ ...baseOpts, chromeArgs: ['--start-maximized', '--lang=en-US'] });
    expect(args).toContain('--start-maximized');
    expect(args).toContain('--lang=en-US');
    expect(args[args.length - 1]).toBe('about:blank');
  });

  it('filters non-string and empty chromeArgs entries', () => {
    const args = buildChromeLaunchArgs({
      ...baseOpts,
      chromeArgs: ['--ok', '', '   ', null as unknown as string, '--also-ok'],
    });
    expect(args).toContain('--ok');
    expect(args).toContain('--also-ok');
    expect(args).not.toContain('');
    expect(args).not.toContain('   ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wipeChromeSessionState
// ─────────────────────────────────────────────────────────────────────────────

describe('wipeChromeSessionState', () => {
  it('removes Tabs_* and Session_* files but preserves cookies and other data', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wipe-'));
    const sessionsDir = path.join(tmpRoot, 'Default', 'Sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'Tabs_1700000000000'), 'tabs');
    fs.writeFileSync(path.join(sessionsDir, 'Session_1700000000000'), 'session');
    fs.writeFileSync(path.join(sessionsDir, 'Cookies'), 'cookies');
    fs.writeFileSync(path.join(tmpRoot, 'Default', 'Preferences'), '{}');

    wipeChromeSessionState(tmpRoot);

    expect(fs.existsSync(path.join(sessionsDir, 'Tabs_1700000000000'))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, 'Session_1700000000000'))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, 'Cookies'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'Default', 'Preferences'))).toBe(true);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('does not throw when Sessions dir does not exist', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-wipe-'));
    expect(() => wipeChromeSessionState(tmpRoot)).not.toThrow();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reservePortStartingAt
// ─────────────────────────────────────────────────────────────────────────────

describe('reservePortStartingAt', () => {
  it('returns the start port when it is free', async () => {
    // Pick a high port unlikely to be held.
    const start = 39000 + Math.floor(Math.random() * 1000);
    const port = await reservePortStartingAt(start);
    expect(port).toBeGreaterThanOrEqual(start);
    expect(port).toBeLessThan(start + 20);
  });

  it('skips a held port and returns the next free one', async () => {
    const net = await import('node:net');
    const start = 39000 + Math.floor(Math.random() * 1000);
    const blocker = await new Promise<import('node:net').Server>((resolve, reject) => {
      const s = net
        .createServer()
        .once('error', reject)
        .once('listening', () => resolve(s))
        .listen(start);
    });
    try {
      const port = await reservePortStartingAt(start);
      expect(port).toBe(start + 1);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// activateMacOsWindowByPid
// ─────────────────────────────────────────────────────────────────────────────

describe('activateMacOsWindowByPid', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('invokes osascript with frontmost-by-pid for the given numeric pid', async () => {
    await activateMacOsWindowByPid(12345);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [file, args] = execFileMock.mock.calls[0] ?? [];
    expect(file).toBe('osascript');
    expect(args[0]).toBe('-e');
    expect(args[1]).toContain('System Events');
    expect(args[1]).toContain('unix id is 12345');
    expect(args[1]).toContain('set frontmost');
  });

  it('does not throw when execFile errors (best-effort contract)', async () => {
    execFileMock.mockImplementationOnce((_file: string, _args: string[]) => {
      throw new Error('osascript not found');
    });
    await expect(activateMacOsWindowByPid(99)).resolves.toBeUndefined();
  });
});
