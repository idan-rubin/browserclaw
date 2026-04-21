import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  isInternalUrl,
  createPinnedLookup,
  resolvePinnedHostnameWithPolicy,
  assertBrowserNavigationAllowed,
  assertCdpEndpointAllowed,
  BrowserCdpEndpointBlockedError,
  assertSafeOutputPath,
  assertSafeUploadPaths,
  resolveStrictExistingUploadPaths,
  resolvePathWithinRoot,
  resolveWritablePathWithinRoot,
  resolveExistingPathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  sanitizeUntrustedFileName,
  writeViaSiblingTempPath,
  assertBrowserNavigationResultAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  requiresInspectableBrowserNavigationRedirects,
  requiresInspectableBrowserNavigationRedirectsForUrl,
  withBrowserNavigationPolicy,
  InvalidBrowserNavigationUrlError,
  DEFAULT_BROWSER_TMP_DIR,
  DEFAULT_DOWNLOAD_DIR,
  DEFAULT_UPLOAD_DIR,
} from './security.js';
import type { LookupFn } from './security.js';
import type { SsrfPolicy } from './types.js';

// ── Helpers ──

/** Strict policy: private network NOT allowed */
const STRICT_POLICY: SsrfPolicy = { dangerouslyAllowPrivateNetwork: false };

/** Permissive policy: private network allowed */
const PERMISSIVE_POLICY: SsrfPolicy = { dangerouslyAllowPrivateNetwork: true };

/** Mock DNS lookup that resolves a hostname to a single public IP */
function mockPublicLookup(): LookupFn {
  return (() => Promise.resolve([{ address: '93.184.216.34', family: 4 }])) as unknown as LookupFn;
}

/** Mock DNS lookup that resolves a hostname to a loopback IP */
function mockLoopbackLookup(): LookupFn {
  return (() => Promise.resolve([{ address: '127.0.0.1', family: 4 }])) as unknown as LookupFn;
}

/** Mock DNS lookup that throws (simulating failed resolution) */
function mockFailingLookup(): LookupFn {
  return (() => Promise.reject(new Error('DNS resolution failed'))) as unknown as LookupFn;
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const;

/** Run a callback with all proxy env vars temporarily cleared */
async function withoutProxyEnv(fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(PROXY_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of PROXY_ENV_KEYS) Reflect.deleteProperty(process.env, k);
  try {
    await fn();
  } finally {
    for (const k of PROXY_ENV_KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  }
}

/** DNS record shape returned by pinned lookup */
interface DnsRecord {
  address: string;
  family: number;
}

// Typed callback overloads for calling pinned lookup in tests.
// dns.lookup has complex overloads; these narrow them for test convenience.

type SingleCb = (
  hostname: string,
  cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
) => void;

type AllCb = (
  hostname: string,
  opts: { all: true; family?: number },
  cb: (err: NodeJS.ErrnoException | null, records: DnsRecord[]) => void,
) => void;

/** Invoke pinned lookup (single-result, 2-arg form) and return a promise */
function callPinnedSingle(
  lookup: ReturnType<typeof createPinnedLookup>,
  hostname: string,
): Promise<{ err: NodeJS.ErrnoException | null; address: string; family: number }> {
  return new Promise((res) => {
    (lookup as unknown as SingleCb)(hostname, (err, address, family) => {
      res({ err, address, family });
    });
  });
}

/** Invoke pinned lookup with { all: true } and return a promise */
function callPinnedAll(
  lookup: ReturnType<typeof createPinnedLookup>,
  hostname: string,
  opts?: { family?: number },
): Promise<DnsRecord[]> {
  return new Promise((res) => {
    (lookup as unknown as AllCb)(hostname, { all: true, ...opts }, (_err, records) => {
      res(records);
    });
  });
}

// ── Temp directory helpers for filesystem tests ──

async function createTempRoot(): Promise<string> {
  const root = join(tmpdir(), `browserclaw-test-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  // Resolve symlinks (macOS /tmp -> /private/tmp) so path confinement checks work
  return realpath(root);
}

// ── Tests ──

describe('security.ts', () => {
  // ────────────────────────────────────────────────
  // Default constants
  // ────────────────────────────────────────────────

  describe('default constants', () => {
    it('should export DEFAULT_BROWSER_TMP_DIR', () => {
      expect(typeof DEFAULT_BROWSER_TMP_DIR).toBe('string');
      expect(DEFAULT_BROWSER_TMP_DIR.length).toBeGreaterThan(0);
    });

    it('should export DEFAULT_DOWNLOAD_DIR as a subdirectory of DEFAULT_BROWSER_TMP_DIR', () => {
      expect(DEFAULT_DOWNLOAD_DIR).toContain(DEFAULT_BROWSER_TMP_DIR);
      expect(DEFAULT_DOWNLOAD_DIR).toContain('downloads');
    });

    it('should export DEFAULT_UPLOAD_DIR as a subdirectory of DEFAULT_BROWSER_TMP_DIR', () => {
      expect(DEFAULT_UPLOAD_DIR).toContain(DEFAULT_BROWSER_TMP_DIR);
      expect(DEFAULT_UPLOAD_DIR).toContain('uploads');
    });
  });

  // ────────────────────────────────────────────────
  // InvalidBrowserNavigationUrlError
  // ────────────────────────────────────────────────

  describe('InvalidBrowserNavigationUrlError', () => {
    it('should be an instance of Error', () => {
      const err = new InvalidBrowserNavigationUrlError('test');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('InvalidBrowserNavigationUrlError');
      expect(err.message).toBe('test');
    });
  });

  // ────────────────────────────────────────────────
  // withBrowserNavigationPolicy
  // ────────────────────────────────────────────────

  describe('withBrowserNavigationPolicy', () => {
    it('should return policy options when policy is provided', () => {
      const result = withBrowserNavigationPolicy(STRICT_POLICY);
      expect(result).toEqual({ ssrfPolicy: STRICT_POLICY });
    });

    it('should return empty options when policy is undefined', () => {
      const result = withBrowserNavigationPolicy(undefined);
      expect(result).toEqual({});
    });
  });

  // ────────────────────────────────────────────────
  // isInternalUrl — IPv4 private/reserved ranges
  // ────────────────────────────────────────────────

  describe('isInternalUrl', () => {
    describe('IPv4 loopback (127.0.0.0/8)', () => {
      it('should block 127.0.0.1', () => {
        expect(isInternalUrl('http://127.0.0.1')).toBe(true);
      });

      it('should block 127.255.255.255', () => {
        expect(isInternalUrl('http://127.255.255.255')).toBe(true);
      });

      it('should block 127.0.0.1 with port', () => {
        expect(isInternalUrl('http://127.0.0.1:8080')).toBe(true);
      });

      it('should block 127.1.2.3 (non-standard loopback)', () => {
        expect(isInternalUrl('http://127.1.2.3')).toBe(true);
      });
    });

    describe('IPv4 link-local (169.254.0.0/16)', () => {
      it('should block 169.254.0.1', () => {
        expect(isInternalUrl('http://169.254.0.1')).toBe(true);
      });

      it('should block 169.254.169.254 (cloud metadata)', () => {
        expect(isInternalUrl('http://169.254.169.254')).toBe(true);
      });

      it('should block 169.254.255.255', () => {
        expect(isInternalUrl('http://169.254.255.255')).toBe(true);
      });
    });

    describe('IPv4 RFC1918 private ranges', () => {
      it('should block 10.0.0.0/8 start', () => {
        expect(isInternalUrl('http://10.0.0.1')).toBe(true);
      });

      it('should block 10.255.255.255 end', () => {
        expect(isInternalUrl('http://10.255.255.255')).toBe(true);
      });

      it('should block 172.16.0.1 (/12 start)', () => {
        expect(isInternalUrl('http://172.16.0.1')).toBe(true);
      });

      it('should block 172.31.255.255 (/12 end)', () => {
        expect(isInternalUrl('http://172.31.255.255')).toBe(true);
      });

      it('should NOT block 172.32.0.1 (just outside /12)', () => {
        expect(isInternalUrl('http://172.32.0.1')).toBe(false);
      });

      it('should block 192.168.0.1', () => {
        expect(isInternalUrl('http://192.168.0.1')).toBe(true);
      });

      it('should block 192.168.255.255', () => {
        expect(isInternalUrl('http://192.168.255.255')).toBe(true);
      });
    });

    describe('IPv4 broadcast', () => {
      it('should block 255.255.255.255', () => {
        expect(isInternalUrl('http://255.255.255.255')).toBe(true);
      });
    });

    describe('IPv4 unspecified', () => {
      it('should block 0.0.0.0', () => {
        expect(isInternalUrl('http://0.0.0.0')).toBe(true);
      });
    });

    describe('IPv4 carrier-grade NAT (100.64.0.0/10)', () => {
      it('should block 100.64.0.1', () => {
        expect(isInternalUrl('http://100.64.0.1')).toBe(true);
      });

      it('should block 100.127.255.255', () => {
        expect(isInternalUrl('http://100.127.255.255')).toBe(true);
      });
    });

    describe('IPv4 multicast (224.0.0.0/4)', () => {
      it('should block 224.0.0.1', () => {
        expect(isInternalUrl('http://224.0.0.1')).toBe(true);
      });

      it('should block 239.255.255.255', () => {
        expect(isInternalUrl('http://239.255.255.255')).toBe(true);
      });
    });

    describe('IPv4 RFC2544 benchmark (198.18.0.0/15)', () => {
      it('should block 198.18.0.1 by default', () => {
        expect(isInternalUrl('http://198.18.0.1')).toBe(true);
      });

      it('should block 198.19.255.255 by default', () => {
        expect(isInternalUrl('http://198.19.255.255')).toBe(true);
      });

      it('should allow 198.18.0.1 when allowRfc2544BenchmarkRange is true', () => {
        expect(isInternalUrl('http://198.18.0.1', { allowRfc2544BenchmarkRange: true })).toBe(false);
      });

      it('should NOT allow 198.18.0.1 when policy does not explicitly allow it', () => {
        expect(isInternalUrl('http://198.18.0.1', {})).toBe(true);
      });
    });

    describe('valid public IPv4 addresses', () => {
      it('should allow 8.8.8.8 (Google DNS)', () => {
        expect(isInternalUrl('http://8.8.8.8')).toBe(false);
      });

      it('should allow 93.184.216.34 (public IP)', () => {
        expect(isInternalUrl('http://93.184.216.34')).toBe(false);
      });

      it('should allow 1.1.1.1 (Cloudflare DNS)', () => {
        expect(isInternalUrl('http://1.1.1.1')).toBe(false);
      });
    });

    // ────────────────────────────────────────────────
    // isInternalUrl — IPv6 ranges
    // ────────────────────────────────────────────────

    describe('IPv6 loopback', () => {
      it('should block ::1', () => {
        expect(isInternalUrl('http://[::1]')).toBe(true);
      });

      it('should block ::1 with port', () => {
        expect(isInternalUrl('http://[::1]:8080')).toBe(true);
      });
    });

    describe('IPv6 unspecified', () => {
      it('should block [::]', () => {
        expect(isInternalUrl('http://[::]')).toBe(true);
      });
    });

    describe('IPv6 link-local (fe80::/10)', () => {
      it('should block fe80::1', () => {
        expect(isInternalUrl('http://[fe80::1]')).toBe(true);
      });

      it('should block febf::1 (end of link-local)', () => {
        expect(isInternalUrl('http://[febf::1]')).toBe(true);
      });
    });

    describe('IPv6 unique-local (fc00::/7)', () => {
      it('should block fc00::1', () => {
        expect(isInternalUrl('http://[fc00::1]')).toBe(true);
      });

      it('should block fd00::1', () => {
        expect(isInternalUrl('http://[fd00::1]')).toBe(true);
      });
    });

    describe('IPv6 multicast (ff00::/8)', () => {
      it('should block ff02::1', () => {
        expect(isInternalUrl('http://[ff02::1]')).toBe(true);
      });

      it('should block ff05::1', () => {
        expect(isInternalUrl('http://[ff05::1]')).toBe(true);
      });
    });

    describe('IPv6 deprecated site-local (fec0::/10)', () => {
      it('should block fec0::1', () => {
        expect(isInternalUrl('http://[fec0::1]')).toBe(true);
      });
    });

    describe('IPv6 IPv4-mapped addresses (::ffff:x.x.x.x)', () => {
      it('should block ::ffff:127.0.0.1 (mapped loopback)', () => {
        expect(isInternalUrl('http://[::ffff:127.0.0.1]')).toBe(true);
      });

      it('should block ::ffff:192.168.1.1 (mapped private)', () => {
        expect(isInternalUrl('http://[::ffff:192.168.1.1]')).toBe(true);
      });

      it('should block ::ffff:10.0.0.1 (mapped RFC1918)', () => {
        expect(isInternalUrl('http://[::ffff:10.0.0.1]')).toBe(true);
      });

      it('should allow ::ffff:8.8.8.8 (mapped public)', () => {
        expect(isInternalUrl('http://[::ffff:8.8.8.8]')).toBe(false);
      });
    });

    describe('IPv6 6to4 (2002::/16) with embedded private IPv4', () => {
      // 2002:7f00:0001:: encodes 127.0.0.1
      it('should block 2002:7f00:0001:: (encodes 127.0.0.1)', () => {
        expect(isInternalUrl('http://[2002:7f00:0001::]')).toBe(true);
      });

      // 2002:c0a8:0101:: encodes 192.168.1.1
      it('should block 2002:c0a8:0101:: (encodes 192.168.1.1)', () => {
        expect(isInternalUrl('http://[2002:c0a8:0101::]')).toBe(true);
      });

      // 2002:0a00:0001:: encodes 10.0.0.1
      it('should block 2002:0a00:0001:: (encodes 10.0.0.1)', () => {
        expect(isInternalUrl('http://[2002:0a00:0001::]')).toBe(true);
      });
    });

    describe('IPv6 Teredo (2001:0000::/32) with embedded private IPv4', () => {
      // Teredo encodes IPv4 as XOR with 0xFFFF in last 32 bits
      // 127.0.0.1 = 7f.00.00.01 XOR ffff = 80ff:fffe
      it('should block 2001:0000::80ff:fffe (Teredo loopback)', () => {
        expect(isInternalUrl('http://[2001:0000::80ff:fffe]')).toBe(true);
      });
    });

    describe('IPv6 NAT64 (64:ff9b::/96)', () => {
      // 64:ff9b::127.0.0.1 — rfc6052 range with embedded loopback
      it('should block 64:ff9b::7f00:1 (NAT64 loopback)', () => {
        expect(isInternalUrl('http://[64:ff9b::7f00:1]')).toBe(true);
      });
    });

    describe('IPv6 ISATAP embedded IPv4', () => {
      // ISATAP: parts[4]=0x0000, parts[5]=0x5efe, followed by IPv4
      it('should block ::0:5efe:7f00:1 (ISATAP loopback)', () => {
        expect(isInternalUrl('http://[::5efe:127.0.0.1]')).toBe(true);
      });
    });

    describe('valid public IPv6', () => {
      it('should allow 2607:f8b0:4004:800::200e (Google)', () => {
        expect(isInternalUrl('http://[2607:f8b0:4004:800::200e]')).toBe(false);
      });
    });

    // ────────────────────────────────────────────────
    // isInternalUrl — Hostname blocking
    // ────────────────────────────────────────────────

    describe('hostname blocking', () => {
      it('should block localhost', () => {
        expect(isInternalUrl('http://localhost')).toBe(true);
      });

      it('should block localhost.localdomain', () => {
        expect(isInternalUrl('http://localhost.localdomain')).toBe(true);
      });

      it('should block metadata.google.internal', () => {
        expect(isInternalUrl('http://metadata.google.internal')).toBe(true);
      });

      it('should block *.localhost subdomains', () => {
        expect(isInternalUrl('http://foo.localhost')).toBe(true);
        expect(isInternalUrl('http://bar.baz.localhost')).toBe(true);
      });

      it('should block *.local domains', () => {
        expect(isInternalUrl('http://myhost.local')).toBe(true);
      });

      it('should block *.internal domains', () => {
        expect(isInternalUrl('http://my-service.internal')).toBe(true);
      });

      it('should block LOCALHOST (case-insensitive)', () => {
        expect(isInternalUrl('http://LOCALHOST')).toBe(true);
      });

      it('should block localhost. (trailing dot)', () => {
        expect(isInternalUrl('http://localhost.')).toBe(true);
      });
    });

    describe('valid public hostnames', () => {
      it('should allow playwright.dev', () => {
        expect(isInternalUrl('http://playwright.dev')).toBe(false);
      });

      it('should allow google.com', () => {
        expect(isInternalUrl('https://google.com')).toBe(false);
      });
    });

    // ────────────────────────────────────────────────
    // isInternalUrl — Edge cases
    // ────────────────────────────────────────────────

    describe('edge cases', () => {
      it('should treat invalid URL as internal (fail-closed)', () => {
        expect(isInternalUrl('not-a-url')).toBe(true);
      });

      it('should treat empty string as internal (fail-closed)', () => {
        expect(isInternalUrl('')).toBe(true);
      });

      it('should handle URL with path', () => {
        expect(isInternalUrl('http://127.0.0.1/admin')).toBe(true);
      });

      it('should handle URL with query string', () => {
        expect(isInternalUrl('http://192.168.1.1?foo=bar')).toBe(true);
      });

      it('should handle URL with credentials', () => {
        expect(isInternalUrl('http://user:pass@127.0.0.1')).toBe(true);
      });
    });

    // ────────────────────────────────────────────────
    // isInternalUrl — Legacy/non-canonical IPv4 literals
    // ────────────────────────────────────────────────

    describe('legacy IPv4 literals (non-canonical formats)', () => {
      it('should block octal IP format like 0177.0.0.1', () => {
        // Non-canonical formats should be blocked (fail-closed)
        expect(isInternalUrl('http://0177.0.0.1')).toBe(true);
      });

      it('should block hex IP format like 0x7f.0.0.1', () => {
        expect(isInternalUrl('http://0x7f.0.0.1')).toBe(true);
      });
    });
  });

  // ────────────────────────────────────────────────
  // assertBrowserNavigationAllowed
  // ────────────────────────────────────────────────

  describe('assertBrowserNavigationAllowed', () => {
    it('should reject empty URL', async () => {
      await expect(assertBrowserNavigationAllowed({ url: '' })).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });

    it('should reject invalid URL', async () => {
      await expect(assertBrowserNavigationAllowed({ url: 'not-a-url' })).rejects.toThrow(
        InvalidBrowserNavigationUrlError,
      );
    });

    it('should reject file: protocol', async () => {
      await expect(assertBrowserNavigationAllowed({ url: 'file:///etc/passwd' })).rejects.toThrow(
        'unsupported protocol',
      );
    });

    it('should reject javascript: protocol', async () => {
      await expect(assertBrowserNavigationAllowed({ url: 'javascript:alert(1)' })).rejects.toThrow(
        'unsupported protocol',
      );
    });

    it('should reject data: protocol', async () => {
      await expect(assertBrowserNavigationAllowed({ url: 'data:text/html,<h1>Hi</h1>' })).rejects.toThrow(
        'unsupported protocol',
      );
    });

    it('should reject ftp: protocol', async () => {
      await expect(assertBrowserNavigationAllowed({ url: 'ftp://ftp.playwright.dev' })).rejects.toThrow(
        'unsupported protocol',
      );
    });

    it('should allow about:blank', async () => {
      await expect(assertBrowserNavigationAllowed({ url: 'about:blank' })).resolves.toBeUndefined();
    });

    it('should allow public URL with mock DNS', async () => {
      await withoutProxyEnv(async () => {
        await expect(
          assertBrowserNavigationAllowed({
            url: 'https://playwright.dev',
            lookupFn: mockPublicLookup(),
            ssrfPolicy: STRICT_POLICY,
          }),
        ).resolves.toBeUndefined();
      });
    });

    it('should block private IP with strict policy', async () => {
      await expect(
        assertBrowserNavigationAllowed({
          url: 'http://192.168.1.1',
          lookupFn: mockPublicLookup(),
          ssrfPolicy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });

    it('should block when DNS resolves to loopback with strict policy', async () => {
      await expect(
        assertBrowserNavigationAllowed({
          url: 'https://evil.com',
          lookupFn: mockLoopbackLookup(),
          ssrfPolicy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });

    it('should block when DNS fails with strict policy', async () => {
      await expect(
        assertBrowserNavigationAllowed({
          url: 'https://nonexistent.invalid',
          lookupFn: mockFailingLookup(),
          ssrfPolicy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });

    it('should allow private IP with permissive policy', async () => {
      await expect(
        assertBrowserNavigationAllowed({
          url: 'http://192.168.1.1',
          lookupFn: mockPublicLookup(),
          ssrfPolicy: PERMISSIVE_POLICY,
        }),
      ).resolves.toBeUndefined();
    });

    it('should block when proxy env vars are set with strict policy (fail closed)', async () => {
      const original = process.env.HTTP_PROXY;
      process.env.HTTP_PROXY = 'http://proxy.playwright.dev:8080';
      try {
        await expect(
          assertBrowserNavigationAllowed({
            url: 'https://playwright.dev',
            lookupFn: mockPublicLookup(),
            ssrfPolicy: STRICT_POLICY,
          }),
        ).rejects.toThrow('proxy variables are set');
      } finally {
        if (original !== undefined) process.env.HTTP_PROXY = original;
        else delete process.env.HTTP_PROXY;
      }
    });

    it('should allow navigation when proxy env vars are set with permissive policy', async () => {
      const original = process.env.HTTP_PROXY;
      process.env.HTTP_PROXY = 'http://proxy.playwright.dev:8080';
      try {
        await expect(
          assertBrowserNavigationAllowed({
            url: 'https://playwright.dev',
            lookupFn: mockPublicLookup(),
            ssrfPolicy: PERMISSIVE_POLICY,
          }),
        ).resolves.toBeUndefined();
      } finally {
        if (original !== undefined) process.env.HTTP_PROXY = original;
        else delete process.env.HTTP_PROXY;
      }
    });
  });

  // ────────────────────────────────────────────────
  // resolvePinnedHostnameWithPolicy — DNS pinning
  // ────────────────────────────────────────────────

  describe('resolvePinnedHostnameWithPolicy', () => {
    it('should resolve a public hostname and return pinned lookup', async () => {
      const result = await resolvePinnedHostnameWithPolicy('playwright.dev', {
        lookupFn: mockPublicLookup(),
        policy: STRICT_POLICY,
      });
      expect(result.hostname).toBe('playwright.dev');
      expect(result.addresses).toContain('93.184.216.34');
      expect(typeof result.lookup).toBe('function');
    });

    it('should reject empty hostname', async () => {
      await expect(resolvePinnedHostnameWithPolicy('', { lookupFn: mockPublicLookup() })).rejects.toThrow(
        InvalidBrowserNavigationUrlError,
      );
    });

    it('should block hostname resolving to private IP with strict policy', async () => {
      await expect(
        resolvePinnedHostnameWithPolicy('evil.com', {
          lookupFn: mockLoopbackLookup(),
          policy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });

    it('should allow localhost with permissive policy', async () => {
      const result = await resolvePinnedHostnameWithPolicy('localhost', {
        lookupFn: mockLoopbackLookup(),
        policy: PERMISSIVE_POLICY,
      });
      expect(result.hostname).toBe('localhost');
      expect(result.addresses).toContain('127.0.0.1');
    });

    it('should block when DNS returns empty results', async () => {
      const emptyLookup = (() => Promise.resolve([])) as unknown as LookupFn;
      await expect(
        resolvePinnedHostnameWithPolicy('empty.com', {
          lookupFn: emptyLookup,
          policy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });

    it('should block when DNS lookup throws', async () => {
      await expect(
        resolvePinnedHostnameWithPolicy('fail.com', {
          lookupFn: mockFailingLookup(),
          policy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });

    it('should prefer IPv4 addresses over IPv6 in deduplication', async () => {
      const multiLookup = (() =>
        Promise.resolve([
          { address: '2607:f8b0:4004:800::200e', family: 6 },
          { address: '93.184.216.34', family: 4 },
          { address: '2607:f8b0:4004:800::200f', family: 6 },
        ])) as unknown as LookupFn;
      const result = await resolvePinnedHostnameWithPolicy('multi.com', {
        lookupFn: multiLookup,
        policy: STRICT_POLICY,
      });
      // IPv4 should come first
      expect(result.addresses[0]).toBe('93.184.216.34');
    });

    it('should deduplicate addresses', async () => {
      const dupLookup = (() =>
        Promise.resolve([
          { address: '93.184.216.34', family: 4 },
          { address: '93.184.216.34', family: 4 },
        ])) as unknown as LookupFn;
      const result = await resolvePinnedHostnameWithPolicy('dup.com', {
        lookupFn: dupLookup,
        policy: STRICT_POLICY,
      });
      expect(result.addresses).toHaveLength(1);
    });

    it('should honor hostnameAllowlist restriction', async () => {
      await expect(
        resolvePinnedHostnameWithPolicy('evil.com', {
          lookupFn: mockPublicLookup(),
          policy: { ...STRICT_POLICY, hostnameAllowlist: ['allowed.com'] },
        }),
      ).rejects.toThrow('not in the allowlist');
    });

    it('should allow hostname matching allowlist wildcard pattern', async () => {
      const result = await resolvePinnedHostnameWithPolicy('api.allowed.com', {
        lookupFn: mockPublicLookup(),
        policy: { ...STRICT_POLICY, hostnameAllowlist: ['*.allowed.com'] },
      });
      expect(result.hostname).toBe('api.allowed.com');
    });

    it('should NOT match wildcard pattern against the base domain itself', async () => {
      await expect(
        resolvePinnedHostnameWithPolicy('allowed.com', {
          lookupFn: mockPublicLookup(),
          policy: { ...STRICT_POLICY, hostnameAllowlist: ['*.allowed.com'] },
        }),
      ).rejects.toThrow('not in the allowlist');
    });

    it('should allow explicitly allowedHostnames even with private IPs', async () => {
      const result = await resolvePinnedHostnameWithPolicy('internal.myapp.com', {
        lookupFn: mockLoopbackLookup(),
        policy: { ...STRICT_POLICY, allowedHostnames: ['internal.myapp.com'] },
      });
      expect(result.hostname).toBe('internal.myapp.com');
    });

    it('should normalize hostname (case, trailing dot) before checking', async () => {
      const result = await resolvePinnedHostnameWithPolicy('PLAYWRIGHT.DEV.', {
        lookupFn: mockPublicLookup(),
        policy: STRICT_POLICY,
      });
      expect(result.hostname).toBe('playwright.dev');
    });

    it('does not reuse a permissive-policy cache entry for a stricter-policy caller', async () => {
      // Regression for DNS-cache-not-keyed-by-policy bypass: a prior call with
      // `dangerouslyAllowPrivateNetwork: true` must not let a later strict call
      // receive the cached pinned result (which contains a private IP).
      const hostname = `cache-bypass-${randomUUID()}.test`;
      const permissive = await resolvePinnedHostnameWithPolicy(hostname, {
        lookupFn: mockLoopbackLookup(),
        policy: PERMISSIVE_POLICY,
      });
      expect(permissive.addresses).toContain('127.0.0.1');

      await expect(
        resolvePinnedHostnameWithPolicy(hostname, {
          lookupFn: mockLoopbackLookup(),
          policy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });
  });

  // ────────────────────────────────────────────────
  // createPinnedLookup — DNS pinning callback
  // ────────────────────────────────────────────────

  describe('createPinnedLookup', () => {
    it('should throw if addresses array is empty', () => {
      expect(() => createPinnedLookup({ hostname: 'test.com', addresses: [] })).toThrow('at least one address');
    });

    it('should return pinned address for matching hostname', async () => {
      const lookup = createPinnedLookup({
        hostname: 'test.com',
        addresses: ['1.2.3.4'],
      });
      const result = await callPinnedSingle(lookup, 'test.com');
      expect(result.err).toBeNull();
      expect(result.address).toBe('1.2.3.4');
      expect(result.family).toBe(4);
    });

    it('should return all addresses when opts.all is true', async () => {
      const lookup = createPinnedLookup({
        hostname: 'test.com',
        addresses: ['1.2.3.4', '2001:db8::1'],
      });
      const results = await callPinnedAll(lookup, 'test.com');
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ address: '1.2.3.4', family: 4 });
      expect(results[1]).toEqual({ address: '2001:db8::1', family: 6 });
    });

    it('should filter by requested family', async () => {
      const lookup = createPinnedLookup({
        hostname: 'test.com',
        addresses: ['1.2.3.4', '2001:db8::1'],
      });
      const results = await callPinnedAll(lookup, 'test.com', { family: 4 });
      expect(results).toHaveLength(1);
      expect(results[0].address).toBe('1.2.3.4');
    });

    it('should fall back to all records when requested family has no matches', async () => {
      const lookup = createPinnedLookup({
        hostname: 'test.com',
        addresses: ['1.2.3.4'], // only IPv4
      });
      const results = await callPinnedAll(lookup, 'test.com', { family: 6 });
      expect(results).toHaveLength(1);
      expect(results[0].address).toBe('1.2.3.4');
    });

    it('should round-robin through addresses', () => {
      const lookup = createPinnedLookup({
        hostname: 'test.com',
        addresses: ['1.1.1.1', '2.2.2.2'],
      });
      const addresses: string[] = [];
      for (let i = 0; i < 3; i++) {
        (lookup as unknown as SingleCb)('test.com', (_err, addr) => {
          addresses.push(addr);
        });
      }
      expect(addresses[0]).toBe('1.1.1.1');
      expect(addresses[1]).toBe('2.2.2.2');
      expect(addresses[2]).toBe('1.1.1.1');
    });

    it('should use fallback for non-matching hostnames', async () => {
      const fallback = ((_host: string, cb: (err: null, address: string, family: number) => void) => {
        cb(null, '9.9.9.9', 4);
      }) as unknown as ReturnType<typeof createPinnedLookup>;
      const lookup = createPinnedLookup({
        hostname: 'pinned.com',
        addresses: ['1.2.3.4'],
        fallback,
      });
      const result = await callPinnedSingle(lookup, 'other.com');
      expect(result.err).toBeNull();
      expect(result.address).toBe('9.9.9.9');
    });

    it('should normalize hostname for matching (case-insensitive, trailing dot)', async () => {
      const lookup = createPinnedLookup({
        hostname: 'Test.Com',
        addresses: ['1.2.3.4'],
      });
      const result = await callPinnedSingle(lookup, 'test.com');
      expect(result.err).toBeNull();
      expect(result.address).toBe('1.2.3.4');
    });
  });

  // ────────────────────────────────────────────────
  // requiresInspectableBrowserNavigationRedirects
  // ────────────────────────────────────────────────

  describe('requiresInspectableBrowserNavigationRedirects', () => {
    it('should return false when no policy is provided', () => {
      expect(requiresInspectableBrowserNavigationRedirects()).toBe(false);
    });

    it('should return true with strict policy', () => {
      expect(requiresInspectableBrowserNavigationRedirects(STRICT_POLICY)).toBe(true);
    });

    it('should return false with permissive policy', () => {
      expect(requiresInspectableBrowserNavigationRedirects(PERMISSIVE_POLICY)).toBe(false);
    });

    it('should return false with deprecated allowPrivateNetwork', () => {
      expect(requiresInspectableBrowserNavigationRedirects({ allowPrivateNetwork: true })).toBe(false);
    });

    it('should return false for policy without explicit dangerouslyAllowPrivateNetwork', () => {
      expect(requiresInspectableBrowserNavigationRedirects({})).toBe(false);
    });
  });

  // ────────────────────────────────────────────────
  // requiresInspectableBrowserNavigationRedirectsForUrl
  // ────────────────────────────────────────────────

  describe('requiresInspectableBrowserNavigationRedirectsForUrl', () => {
    it('should return true for http URL with strict policy', () => {
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('http://example.com', STRICT_POLICY)).toBe(true);
    });

    it('should return true for https URL with strict policy', () => {
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('https://example.com', STRICT_POLICY)).toBe(true);
    });

    it('should return false for non-network protocols with strict policy', () => {
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('file:///etc/passwd', STRICT_POLICY)).toBe(false);
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('about:blank', STRICT_POLICY)).toBe(false);
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('data:text/plain,x', STRICT_POLICY)).toBe(false);
    });

    it('should return false when policy does not require inspection', () => {
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('http://example.com', PERMISSIVE_POLICY)).toBe(false);
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('http://example.com')).toBe(false);
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('http://example.com', {})).toBe(false);
    });

    it('should return false for invalid URLs', () => {
      expect(requiresInspectableBrowserNavigationRedirectsForUrl('not a url', STRICT_POLICY)).toBe(false);
    });
  });

  // ────────────────────────────────────────────────
  // assertBrowserNavigationResultAllowed
  // ────────────────────────────────────────────────

  describe('assertBrowserNavigationResultAllowed', () => {
    it('should accept empty url gracefully', async () => {
      await expect(assertBrowserNavigationResultAllowed({ url: '' })).resolves.toBeUndefined();
    });

    it('should accept invalid url gracefully', async () => {
      await expect(assertBrowserNavigationResultAllowed({ url: 'not-a-url' })).resolves.toBeUndefined();
    });

    it('should block private IP result url with strict policy', async () => {
      await expect(
        assertBrowserNavigationResultAllowed({
          url: 'http://127.0.0.1',
          lookupFn: mockLoopbackLookup(),
          ssrfPolicy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });

    it('should allow public IP result url with strict policy', async () => {
      await withoutProxyEnv(async () => {
        await expect(
          assertBrowserNavigationResultAllowed({
            url: 'https://playwright.dev',
            lookupFn: mockPublicLookup(),
            ssrfPolicy: STRICT_POLICY,
          }),
        ).resolves.toBeUndefined();
      });
    });
  });

  // ────────────────────────────────────────────────
  // assertBrowserNavigationRedirectChainAllowed
  // ────────────────────────────────────────────────

  describe('assertBrowserNavigationRedirectChainAllowed', () => {
    it('should accept null request', async () => {
      await expect(
        assertBrowserNavigationRedirectChainAllowed({
          request: null,
          lookupFn: mockPublicLookup(),
          ssrfPolicy: STRICT_POLICY,
        }),
      ).resolves.toBeUndefined();
    });

    it('should accept undefined request', async () => {
      await expect(
        assertBrowserNavigationRedirectChainAllowed({
          lookupFn: mockPublicLookup(),
          ssrfPolicy: STRICT_POLICY,
        }),
      ).resolves.toBeUndefined();
    });

    it('should validate all URLs in a redirect chain', async () => {
      await withoutProxyEnv(async () => {
        const chain = {
          url: () => 'https://final.com',
          redirectedFrom: () => ({
            url: () => 'https://middle.com',
            redirectedFrom: () => ({
              url: () => 'https://start.com',
              redirectedFrom: () => null,
            }),
          }),
        };
        await expect(
          assertBrowserNavigationRedirectChainAllowed({
            request: chain,
            lookupFn: mockPublicLookup(),
            ssrfPolicy: STRICT_POLICY,
          }),
        ).resolves.toBeUndefined();
      });
    });

    it('should block if any URL in redirect chain is private', async () => {
      const chain = {
        url: () => 'http://127.0.0.1',
        redirectedFrom: () => ({
          url: () => 'https://start.com',
          redirectedFrom: () => null,
        }),
      };
      await expect(
        assertBrowserNavigationRedirectChainAllowed({
          request: chain,
          lookupFn: mockPublicLookup(),
          ssrfPolicy: STRICT_POLICY,
        }),
      ).rejects.toThrow(InvalidBrowserNavigationUrlError);
    });
  });

  // ────────────────────────────────────────────────
  // sanitizeUntrustedFileName
  // ────────────────────────────────────────────────

  describe('sanitizeUntrustedFileName', () => {
    it('should return fallback for empty string', () => {
      expect(sanitizeUntrustedFileName('', 'fallback.txt')).toBe('fallback.txt');
    });

    it('should return fallback for whitespace-only string', () => {
      expect(sanitizeUntrustedFileName('   ', 'fallback.txt')).toBe('fallback.txt');
    });

    it('should return fallback for "."', () => {
      expect(sanitizeUntrustedFileName('.', 'fallback.txt')).toBe('fallback.txt');
    });

    it('should return fallback for ".."', () => {
      expect(sanitizeUntrustedFileName('..', 'fallback.txt')).toBe('fallback.txt');
    });

    it('should strip directory traversal', () => {
      expect(sanitizeUntrustedFileName('../../../etc/passwd', 'fallback.txt')).toBe('passwd');
    });

    it('should strip Windows-style paths', () => {
      expect(sanitizeUntrustedFileName('C:\\Users\\evil\\file.exe', 'fallback.txt')).toBe('file.exe');
    });

    it('should strip control characters', () => {
      const name = 'file\x00\x01\x1f.txt';
      const result = sanitizeUntrustedFileName(name, 'fallback.txt');
      expect(result).toBe('file.txt');
      expect(result).not.toContain('\x00');
    });

    it('should strip DEL character (0x7F)', () => {
      const name = 'file\x7f.txt';
      expect(sanitizeUntrustedFileName(name, 'fallback.txt')).toBe('file.txt');
    });

    it('should truncate to 200 characters', () => {
      const longName = 'a'.repeat(300) + '.txt';
      const result = sanitizeUntrustedFileName(longName, 'fallback.txt');
      expect(result.length).toBeLessThanOrEqual(200);
    });

    it('should handle normal filenames unchanged', () => {
      expect(sanitizeUntrustedFileName('report.pdf', 'fallback.txt')).toBe('report.pdf');
    });

    it('should strip posix path prefix', () => {
      expect(sanitizeUntrustedFileName('/tmp/evil/file.txt', 'fallback.txt')).toBe('file.txt');
    });
  });

  // ────────────────────────────────────────────────
  // resolvePathWithinRoot — lexical confinement
  // ────────────────────────────────────────────────

  describe('resolvePathWithinRoot', () => {
    const root = '/safe/root';

    it('should resolve a simple file within root', () => {
      const result = resolvePathWithinRoot({ rootDir: root, requestedPath: 'file.txt', scopeLabel: 'test' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.path).toBe(resolve(root, 'file.txt'));
    });

    it('should resolve a nested file within root', () => {
      const result = resolvePathWithinRoot({ rootDir: root, requestedPath: 'sub/dir/file.txt', scopeLabel: 'test' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.path).toBe(resolve(root, 'sub/dir/file.txt'));
    });

    it('should reject path that escapes root via ..', () => {
      const result = resolvePathWithinRoot({ rootDir: root, requestedPath: '../../../etc/passwd', scopeLabel: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('escapes');
    });

    it('should reject empty path', () => {
      const result = resolvePathWithinRoot({ rootDir: root, requestedPath: '', scopeLabel: 'test' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Empty path');
    });

    it('should use defaultFileName for empty path when provided', () => {
      const result = resolvePathWithinRoot({
        rootDir: root,
        requestedPath: '',
        scopeLabel: 'test',
        defaultFileName: 'default.txt',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.path).toBe(resolve(root, 'default.txt'));
    });

    it('should reject absolute path outside root', () => {
      const result = resolvePathWithinRoot({ rootDir: root, requestedPath: '/etc/passwd', scopeLabel: 'test' });
      expect(result.ok).toBe(false);
    });

    it('should reject whitespace-only path', () => {
      const result = resolvePathWithinRoot({ rootDir: root, requestedPath: '   ', scopeLabel: 'test' });
      expect(result.ok).toBe(false);
    });
  });

  // ────────────────────────────────────────────────
  // assertSafeOutputPath — filesystem checks
  // ────────────────────────────────────────────────

  describe('assertSafeOutputPath', () => {
    it('should reject empty path', async () => {
      await expect(assertSafeOutputPath('')).rejects.toThrow('Output path is required');
    });

    it('should reject null-ish path', async () => {
      await expect(assertSafeOutputPath(null as unknown as string)).rejects.toThrow('Output path is required');
    });

    it('should reject path with directory traversal', async () => {
      // normalize() resolves /safe/../../../etc/passwd to a path containing ..
      await expect(assertSafeOutputPath('foo/../../../etc/passwd')).rejects.toThrow('directory traversal');
    });

    it('should accept simple absolute path without allowedRoots', async () => {
      // Without allowedRoots, only the traversal check applies
      await expect(assertSafeOutputPath('/tmp/test.txt')).resolves.toBeUndefined();
    });

    it('should accept /etc/passwd without allowedRoots (lexical check only)', async () => {
      await expect(assertSafeOutputPath('/etc/passwd')).resolves.toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────
  // assertSafeOutputPath — with real filesystem
  // ────────────────────────────────────────────────

  describe('assertSafeOutputPath with allowedRoots', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('should accept a file within allowedRoots', async () => {
      const filePath = join(tempRoot, 'file.txt');
      await writeFile(filePath, 'data');
      await expect(assertSafeOutputPath(filePath, [tempRoot])).resolves.toBeUndefined();
    });

    it('should reject a file outside allowedRoots', async () => {
      const outsideDir = await createTempRoot();
      try {
        const outsidePath = join(outsideDir, 'file.txt');
        await writeFile(outsidePath, 'data');
        await expect(assertSafeOutputPath(outsidePath, [tempRoot])).rejects.toThrow('outside allowed directories');
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('should reject a symlink target', async () => {
      const realFile = join(tempRoot, 'real.txt');
      const linkPath = join(tempRoot, 'link.txt');
      await writeFile(realFile, 'data');
      await symlink(realFile, linkPath);
      await expect(assertSafeOutputPath(linkPath, [tempRoot])).rejects.toThrow('symbolic link');
    });
  });

  // ────────────────────────────────────────────────
  // assertSafeUploadPaths
  // ────────────────────────────────────────────────

  describe('assertSafeUploadPaths', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('should accept existing regular files', async () => {
      const filePath = join(tempRoot, 'upload.txt');
      await writeFile(filePath, 'content');
      await expect(assertSafeUploadPaths([filePath])).resolves.toBeUndefined();
    });

    it('should reject nonexistent file', async () => {
      await expect(assertSafeUploadPaths([join(tempRoot, 'nonexistent.txt')])).rejects.toThrow(
        'does not exist or is inaccessible',
      );
    });

    it('should reject symlinks', async () => {
      const realFile = join(tempRoot, 'real.txt');
      const linkPath = join(tempRoot, 'link.txt');
      await writeFile(realFile, 'data');
      await symlink(realFile, linkPath);
      await expect(assertSafeUploadPaths([linkPath])).rejects.toThrow('symbolic link');
    });

    it('should reject directories', async () => {
      const dirPath = join(tempRoot, 'subdir');
      await mkdir(dirPath);
      await expect(assertSafeUploadPaths([dirPath])).rejects.toThrow('not a regular file');
    });
  });

  // ────────────────────────────────────────────────
  // resolveStrictExistingUploadPaths
  // ────────────────────────────────────────────────

  describe('resolveStrictExistingUploadPaths', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('should return ok:true for valid files', async () => {
      const filePath = join(tempRoot, 'file.txt');
      await writeFile(filePath, 'data');
      const result = await resolveStrictExistingUploadPaths({ requestedPaths: [filePath] });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.paths).toEqual([filePath]);
    });

    it('should return ok:false for nonexistent files', async () => {
      const result = await resolveStrictExistingUploadPaths({
        requestedPaths: [join(tempRoot, 'missing.txt')],
      });
      expect(result.ok).toBe(false);
    });
  });

  // ────────────────────────────────────────────────
  // resolveWritablePathWithinRoot — async filesystem checks
  // ────────────────────────────────────────────────

  describe('resolveWritablePathWithinRoot', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('should accept a writable file within root', async () => {
      const filePath = join(tempRoot, 'output.txt');
      await writeFile(filePath, 'data');
      const result = await resolveWritablePathWithinRoot({
        rootDir: tempRoot,
        requestedPath: 'output.txt',
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(true);
    });

    it('should accept a new file (not yet created) within root', async () => {
      const result = await resolveWritablePathWithinRoot({
        rootDir: tempRoot,
        requestedPath: 'new-file.txt',
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(true);
    });

    it('should reject symlink target', async () => {
      const realFile = join(tempRoot, 'real.txt');
      const linkPath = join(tempRoot, 'link.txt');
      await writeFile(realFile, 'data');
      await symlink(realFile, linkPath);
      const result = await resolveWritablePathWithinRoot({
        rootDir: tempRoot,
        requestedPath: 'link.txt',
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/symlink|symbolic link/);
    });

    it('should reject path that escapes root lexically', async () => {
      const result = await resolveWritablePathWithinRoot({
        rootDir: tempRoot,
        requestedPath: '../../etc/passwd',
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('escapes');
    });

    it.skipIf(process.getuid?.() === 0)('should return error when stat fails with non-ENOENT error', async () => {
      // Create a file inside an inaccessible directory to trigger EACCES on lstat
      const subdir = join(tempRoot, 'noaccess');
      await mkdir(subdir);
      await writeFile(join(subdir, 'file.txt'), 'data');
      const { chmod } = await import('node:fs/promises');
      await chmod(subdir, 0o000);
      try {
        const result = await resolveWritablePathWithinRoot({
          rootDir: tempRoot,
          requestedPath: 'noaccess/file.txt',
          scopeLabel: 'test',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('Cannot stat');
      } finally {
        await chmod(subdir, 0o755);
      }
    });
  });

  // ────────────────────────────────────────────────
  // resolveExistingPathsWithinRoot
  // ────────────────────────────────────────────────

  describe('resolveExistingPathsWithinRoot', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('should resolve existing files within root', async () => {
      const filePath = join(tempRoot, 'file.txt');
      await writeFile(filePath, 'data');
      const result = await resolveExistingPathsWithinRoot({
        rootDir: tempRoot,
        requestedPaths: ['file.txt'],
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(true);
    });

    it('should allow missing files (returns fallback resolved path)', async () => {
      const result = await resolveExistingPathsWithinRoot({
        rootDir: tempRoot,
        requestedPaths: ['missing.txt'],
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(true);
    });

    it('should reject path that escapes root', async () => {
      const result = await resolveExistingPathsWithinRoot({
        rootDir: tempRoot,
        requestedPaths: ['../../../etc/passwd'],
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(false);
    });
  });

  // ────────────────────────────────────────────────
  // resolveStrictExistingPathsWithinRoot
  // ────────────────────────────────────────────────

  describe('resolveStrictExistingPathsWithinRoot', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('should resolve existing files', async () => {
      const filePath = join(tempRoot, 'file.txt');
      await writeFile(filePath, 'data');
      const result = await resolveStrictExistingPathsWithinRoot({
        rootDir: tempRoot,
        requestedPaths: ['file.txt'],
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.paths[0]).toBe(filePath);
    });

    it('should reject missing files', async () => {
      const result = await resolveStrictExistingPathsWithinRoot({
        rootDir: tempRoot,
        requestedPaths: ['missing.txt'],
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('does not exist');
    });

    it('should reject symlinks pointing outside root', async () => {
      const outsideDir = await createTempRoot();
      try {
        const outsideFile = join(outsideDir, 'secret.txt');
        await writeFile(outsideFile, 'secret');
        const linkPath = join(tempRoot, 'link.txt');
        await symlink(outsideFile, linkPath);
        const result = await resolveStrictExistingPathsWithinRoot({
          rootDir: tempRoot,
          requestedPaths: ['link.txt'],
          scopeLabel: 'test',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/symlink|escapes/);
      } finally {
        await rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('should reject directories', async () => {
      const dirPath = join(tempRoot, 'subdir');
      await mkdir(dirPath);
      const result = await resolveStrictExistingPathsWithinRoot({
        rootDir: tempRoot,
        requestedPaths: ['subdir'],
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/not a regular file|symlink/);
    });

    it('should reject path escaping root', async () => {
      const result = await resolveStrictExistingPathsWithinRoot({
        rootDir: tempRoot,
        requestedPaths: ['../../etc/passwd'],
        scopeLabel: 'test',
      });
      expect(result.ok).toBe(false);
    });

    it.skipIf(process.getuid?.() === 0)('should return error when realpath fails with non-ENOENT error', async () => {
      const subdir = join(tempRoot, 'noaccess');
      await mkdir(subdir);
      await writeFile(join(subdir, 'file.txt'), 'data');
      const { chmod } = await import('node:fs/promises');
      await chmod(subdir, 0o000);
      try {
        const result = await resolveStrictExistingPathsWithinRoot({
          rootDir: tempRoot,
          requestedPaths: ['noaccess/file.txt'],
          scopeLabel: 'test',
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain('Cannot resolve');
      } finally {
        await chmod(subdir, 0o755);
      }
    });
  });

  // ────────────────────────────────────────────────
  // writeViaSiblingTempPath — atomic writes
  // ────────────────────────────────────────────────

  describe('writeViaSiblingTempPath', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('should write file atomically', async () => {
      const targetPath = join(tempRoot, 'output.txt');
      await writeViaSiblingTempPath({
        rootDir: tempRoot,
        targetPath,
        writeTemp: async (tempPath) => {
          await writeFile(tempPath, 'atomic content');
        },
      });
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(targetPath, 'utf-8');
      expect(content).toBe('atomic content');
    });

    it('should reject target path outside root', async () => {
      const outsidePath = join(tmpdir(), `outside-${randomUUID()}`, 'file.txt');
      await expect(
        writeViaSiblingTempPath({
          rootDir: tempRoot,
          targetPath: outsidePath,
          writeTemp: async (tempPath) => {
            await writeFile(tempPath, 'data');
          },
        }),
      ).rejects.toThrow('outside the allowed root');
    });

    it('should clean up temp file on write failure', async () => {
      const targetPath = join(tempRoot, 'output.txt');
      await expect(
        writeViaSiblingTempPath({
          rootDir: tempRoot,
          targetPath,
          writeTemp: () => Promise.reject(new Error('Write failed')),
        }),
      ).rejects.toThrow('Write failed');
      // Verify temp file is cleaned up
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(tempRoot);
      const partFiles = files.filter((f) => f.includes('.part'));
      expect(partFiles).toHaveLength(0);
    });
  });

  // ────────────────────────────────────────────────
  // isInternalUrl — SSRF policy interaction
  // ────────────────────────────────────────────────

  describe('isInternalUrl with policy', () => {
    it('should still block private IP even when policy has no relevant flags', () => {
      expect(isInternalUrl('http://127.0.0.1', {})).toBe(true);
    });

    it('should respect allowRfc2544BenchmarkRange in policy', () => {
      expect(isInternalUrl('http://198.18.0.1', { allowRfc2544BenchmarkRange: true })).toBe(false);
      expect(isInternalUrl('http://198.18.0.1', { allowRfc2544BenchmarkRange: false })).toBe(true);
    });
  });

  // ────────────────────────────────────────────────
  // IPv4 boundary addresses
  // ────────────────────────────────────────────────

  describe('IPv4 boundary addresses', () => {
    it('should block 10.0.0.0 (start of /8)', () => {
      expect(isInternalUrl('http://10.0.0.0')).toBe(true);
    });

    it('should NOT block 11.0.0.0 (just outside 10/8)', () => {
      expect(isInternalUrl('http://11.0.0.0')).toBe(false);
    });

    it('should block 172.16.0.0 (start of /12)', () => {
      expect(isInternalUrl('http://172.16.0.0')).toBe(true);
    });

    it('should NOT block 172.15.255.255 (just below /12)', () => {
      expect(isInternalUrl('http://172.15.255.255')).toBe(false);
    });

    it('should block 192.168.0.0 (start of /16)', () => {
      expect(isInternalUrl('http://192.168.0.0')).toBe(true);
    });

    it('should NOT block 192.167.255.255 (just below /16)', () => {
      expect(isInternalUrl('http://192.167.255.255')).toBe(false);
    });

    it('should block 169.254.0.0 (start of link-local)', () => {
      expect(isInternalUrl('http://169.254.0.0')).toBe(true);
    });

    it('should NOT block 169.253.255.255 (just below link-local)', () => {
      expect(isInternalUrl('http://169.253.255.255')).toBe(false);
    });
  });

  // ────────────────────────────────────────────────
  // assertSafeOutputPath — traversal detection
  //
  // Security model: normalize first, then check for remaining '..' segments.
  // Relative traversal that survives normalize is caught lexically.
  // Absolute-path security (e.g. /tmp/../etc/passwd) is enforced by the
  // allowedRoots containment check, not by the lexical '..' test — because
  // normalize('/tmp/../etc/passwd') === '/etc/passwd' (no '..' remains).
  // ────────────────────────────────────────────────

  describe('assertSafeOutputPath — traversal detection', () => {
    it('rejects relative path whose traversal survives normalize', async () => {
      // normalize('foo/../../../etc/passwd') === '../../etc/passwd' — '..' remains
      await expect(assertSafeOutputPath('foo/../../../etc/passwd')).rejects.toThrow('directory traversal');
    });

    it('accepts foo/bar/../baz (normalize collapses it cleanly)', async () => {
      // normalize('foo/bar/../baz') === 'foo/baz' — no '..' left, not a traversal
      await expect(assertSafeOutputPath('foo/bar/../baz')).resolves.toBeUndefined();
    });

    it('accepts /tmp/../etc/passwd without allowedRoots (normalize strips .., security via allowedRoots)', async () => {
      // normalize('/tmp/../etc/passwd') === '/etc/passwd' — no '..' left.
      // Without allowedRoots there is no containment guarantee; callers must pass allowedRoots.
      await expect(assertSafeOutputPath('/tmp/../etc/passwd')).resolves.toBeUndefined();
    });

    it('still accepts a clean absolute path with no traversal', async () => {
      await expect(assertSafeOutputPath('/tmp/output.zip')).resolves.toBeUndefined();
    });
  });

  describe('assertSafeOutputPath — allowedRoots blocks absolute traversal', () => {
    let tempRoot: string;
    let sibling: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
      sibling = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
      await rm(sibling, { recursive: true, force: true });
    });

    it('rejects a path that resolves outside allowedRoots after normalize strips ..', async () => {
      // Construct a path that uses .. to escape tempRoot into sibling.
      // normalize() removes the .., leaving a path inside sibling — which is
      // outside tempRoot. The realpath containment check catches this.
      const { basename: pathBasename } = await import('node:path');
      const traversal = join(tempRoot, '..', pathBasename(sibling), 'file.txt');
      await expect(assertSafeOutputPath(traversal, [tempRoot])).rejects.toThrow('outside allowed directories');
    });
  });

  // ────────────────────────────────────────────────
  // writeViaSiblingTempPath — regression: UNC path bypass
  // Bug: local isAbsolute() only checked '/' prefix and 'C:' pattern,
  // missing Windows UNC paths like \\server\share\file.
  // Fix: replaced with pathIsAbsolute() from node:path.
  // ────────────────────────────────────────────────

  describe('writeViaSiblingTempPath — UNC path rejection (regression)', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await createTempRoot();
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('rejects a Windows UNC path as targetPath', async () => {
      // \\server\share\file — pathIsAbsolute() returns true on all platforms for
      // UNC paths; the old local isAbsolute() returned false (only checked /
      // and drive letters), allowing the path to bypass the root containment check.
      const uncPath = '\\\\server\\share\\file.zip';
      await expect(
        writeViaSiblingTempPath({
          rootDir: tempRoot,
          targetPath: uncPath,
          writeTemp: async (p) => {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(p, 'data');
          },
        }),
      ).rejects.toThrow('outside the allowed root');
    });
  });

  describe('assertCdpEndpointAllowed', () => {
    it('is a no-op when no policy is provided', async () => {
      await expect(assertCdpEndpointAllowed('http://localhost:9222')).resolves.toBeUndefined();
      await expect(assertCdpEndpointAllowed('http://169.254.169.254/')).resolves.toBeUndefined();
    });

    it('is a no-op when policy is undefined explicitly', async () => {
      await expect(assertCdpEndpointAllowed('http://localhost:9222', undefined)).resolves.toBeUndefined();
    });

    it('allows loopback hostnames even under a strict policy', async () => {
      await expect(assertCdpEndpointAllowed('http://localhost:9222', {})).resolves.toBeUndefined();
      await expect(assertCdpEndpointAllowed('http://127.0.0.1:9222', {})).resolves.toBeUndefined();
      await expect(assertCdpEndpointAllowed('ws://[::1]:9222/devtools/browser/abc', {})).resolves.toBeUndefined();
    });

    it('blocks non-loopback private IPs under a strict policy', async () => {
      await expect(assertCdpEndpointAllowed('http://192.168.1.100:9222', {})).rejects.toThrow(
        BrowserCdpEndpointBlockedError,
      );
    });

    it('allows loopback when dangerouslyAllowPrivateNetwork is true', async () => {
      await expect(
        assertCdpEndpointAllowed('http://127.0.0.1:9222', { dangerouslyAllowPrivateNetwork: true }),
      ).resolves.toBeUndefined();
    });

    it('allows ws:// loopback when dangerouslyAllowPrivateNetwork is true', async () => {
      await expect(
        assertCdpEndpointAllowed('ws://127.0.0.1:9222/devtools/browser/abc', {
          dangerouslyAllowPrivateNetwork: true,
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects unsupported protocols even with permissive policy', async () => {
      await expect(
        assertCdpEndpointAllowed('file:///tmp/cdp.sock', { dangerouslyAllowPrivateNetwork: true }),
      ).rejects.toThrow(BrowserCdpEndpointBlockedError);
      await expect(
        assertCdpEndpointAllowed('javascript:alert(1)', { dangerouslyAllowPrivateNetwork: true }),
      ).rejects.toThrow(/protocol/);
    });

    it('rejects malformed URLs with a clear error', async () => {
      await expect(assertCdpEndpointAllowed('not a url', {})).rejects.toThrow(BrowserCdpEndpointBlockedError);
      await expect(assertCdpEndpointAllowed('not a url', {})).rejects.toThrow(/invalid URL/);
    });

    it('error message points users at the dangerouslyAllowPrivateNetwork fix', async () => {
      try {
        await assertCdpEndpointAllowed('http://192.168.1.100:9222', {});
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BrowserCdpEndpointBlockedError);
        expect((err as Error).message).toContain('dangerouslyAllowPrivateNetwork');
      }
    });

    it('preserves the underlying error as cause', async () => {
      try {
        await assertCdpEndpointAllowed('http://192.168.1.100:9222', {});
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BrowserCdpEndpointBlockedError);
        expect((err as { cause?: unknown }).cause).toBeDefined();
      }
    });

    // The loopback carve-out under a strict policy must respect an explicit user
    // allowlist — otherwise a user who sets `allowedHostnames: ['gateway']` or
    // `hostnameAllowlist: ['gateway']` expecting "only this host" would find
    // localhost silently reachable.
    it('respects explicit allowedHostnames: does not auto-allow loopback', async () => {
      await expect(
        assertCdpEndpointAllowed('http://localhost:9222', { allowedHostnames: ['cdp-gateway.internal'] }),
      ).rejects.toThrow(BrowserCdpEndpointBlockedError);
      await expect(
        assertCdpEndpointAllowed('http://127.0.0.1:9222', { allowedHostnames: ['cdp-gateway.internal'] }),
      ).rejects.toThrow(BrowserCdpEndpointBlockedError);
    });

    it('respects explicit hostnameAllowlist: loopback rejected when not in the allowlist', async () => {
      await expect(
        assertCdpEndpointAllowed('http://localhost:9222', { hostnameAllowlist: ['cdp-gateway.internal'] }),
      ).rejects.toThrow(BrowserCdpEndpointBlockedError);
    });

    it('treats empty allowlist arrays as "no explicit allowlist" (loopback allowed)', async () => {
      await expect(
        assertCdpEndpointAllowed('http://localhost:9222', { allowedHostnames: [] }),
      ).resolves.toBeUndefined();
      await expect(
        assertCdpEndpointAllowed('http://localhost:9222', { hostnameAllowlist: [] }),
      ).resolves.toBeUndefined();
    });
  });
});
