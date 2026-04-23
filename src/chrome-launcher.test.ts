import os from 'node:os';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  isLoopbackHost,
  isDirectCdpWebSocketEndpoint,
  hasProxyEnvConfigured,
  normalizeCdpWsUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
  resolveIsolatedProfile,
} from './chrome-launcher.js';

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
