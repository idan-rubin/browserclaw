import { resolve, normalize, dirname, basename, join, sep, relative, posix, win32 } from 'node:path';
import { lookup as dnsLookup } from 'node:dns/promises';
import { lookup as dnsLookupCb } from 'node:dns';
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as ipaddr from 'ipaddr.js';
import type { SsrfPolicy, PinnedHostname } from './types.js';

export type LookupFn = typeof dnsLookup;

/**
 * Thrown when a navigation URL is blocked by SSRF policy.
 * Callers can catch this specifically to distinguish navigation blocks
 * from other errors.
 */
export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidBrowserNavigationUrlError';
  }
}

/** Options for browser navigation SSRF policy. */
export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrfPolicy;
};

/** Playwright-compatible request interface for redirect chain inspection. */
export type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

/** Build a BrowserNavigationPolicyOptions from an SsrfPolicy. */
export function withBrowserNavigationPolicy(ssrfPolicy?: SsrfPolicy): BrowserNavigationPolicyOptions {
  return { ssrfPolicy };
}

// Only http: and https: are permitted for navigation; about:blank is the sole non-network exception.
const NETWORK_NAVIGATION_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_NON_NETWORK_URLS = new Set(['about:blank']);

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
]);

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

function isPrivateNetworkAllowedByPolicy(policy?: SsrfPolicy): boolean {
  return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}

function hasProxyEnvConfigured(env: Record<string, string | undefined> = process.env): boolean {
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) return true;
  }
  return false;
}

// ── Hostname normalization & blocking ──

function normalizeHostname(hostname: string): string {
  let h = String(hostname ?? '').trim().toLowerCase();
  // Strip IPv6 brackets
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  // Strip trailing dot (FQDN)
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

function isBlockedHostnameNormalized(normalized: string): boolean {
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return normalized.endsWith('.localhost') || normalized.endsWith('.local') || normalized.endsWith('.internal');
}

// ── IP address checking via ipaddr.js ──

/**
 * Validate a single IPv4 octet string: must be a plain decimal integer 0-255
 * with no leading zeros, hex prefixes, or other non-standard forms.
 */
function isStrictDecimalOctet(part: string): boolean {
  if (!/^[0-9]+$/.test(part)) return false;
  const n = parseInt(part, 10);
  if (n < 0 || n > 255) return false;
  if (String(n) !== part) return false;
  return true;
}

/**
 * Returns true if the string looks like a legacy/non-standard IPv4 literal
 * that should be treated as internal and blocked (fail closed).
 */
function isUnsupportedIPv4Literal(ip: string): boolean {
  if (/^[0-9]+$/.test(ip)) return true;
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  if (!parts.every(isStrictDecimalOctet)) return true;
  return false;
}

const BLOCKED_IPV4_RANGES = new Set([
  'unspecified', 'broadcast', 'multicast', 'linkLocal',
  'loopback', 'carrierGradeNat', 'private', 'reserved',
]);

const BLOCKED_IPV6_RANGES = new Set([
  'unspecified', 'loopback', 'linkLocal', 'uniqueLocal', 'multicast',
]);

const RFC2544_BENCHMARK_PREFIX: [ipaddr.IPv4, number] = [ipaddr.IPv4.parse('198.18.0.0'), 15];

type IsPrivateIpOpts = { allowRfc2544BenchmarkRange?: boolean };

function isBlockedSpecialUseIpv4Address(address: ipaddr.IPv4, opts?: IsPrivateIpOpts): boolean {
  const inRfc2544 = address.match(RFC2544_BENCHMARK_PREFIX);
  if (inRfc2544 && opts?.allowRfc2544BenchmarkRange === true) return false;
  return BLOCKED_IPV4_RANGES.has(address.range()) || inRfc2544;
}

function isBlockedSpecialUseIpv6Address(address: ipaddr.IPv6): boolean {
  if (BLOCKED_IPV6_RANGES.has(address.range())) return true;
  // Deprecated site-local range (fec0::/10) — may not be caught by ipaddr.js range()
  return (address.parts[0] & 0xffc0) === 0xfec0;
}

/**
 * Extract embedded IPv4 from IPv6 transition formats (IPv4-mapped, NAT64, 6to4, Teredo)
 * and check if the embedded IPv4 is blocked. Returns null if not a transition format.
 */
function extractEmbeddedIpv4FromIpv6(v6: ipaddr.IPv6, opts?: IsPrivateIpOpts): boolean | null {
  // IPv4-mapped (::ffff:a.b.c.d)
  if (v6.isIPv4MappedAddress()) {
    return isBlockedSpecialUseIpv4Address(v6.toIPv4Address(), opts);
  }

  const parts = v6.parts; // 8 x 16-bit groups

  // NAT64 well-known prefix: 64:ff9b::/96
  if (parts[0] === 0x0064 && parts[1] === 0xff9b &&
      parts[2] === 0x0000 && parts[3] === 0x0000 &&
      parts[4] === 0x0000 && parts[5] === 0x0000) {
    const ip4str = `${(parts[6] >> 8) & 0xff}.${parts[6] & 0xff}.${(parts[7] >> 8) & 0xff}.${parts[7] & 0xff}`;
    try { return isBlockedSpecialUseIpv4Address(ipaddr.IPv4.parse(ip4str), opts); } catch { return true; }
  }

  // NAT64 local-use prefix: 64:ff9b:1::/48
  if (parts[0] === 0x0064 && parts[1] === 0xff9b && parts[2] === 0x0001) {
    const ip4str = `${(parts[6] >> 8) & 0xff}.${parts[6] & 0xff}.${(parts[7] >> 8) & 0xff}.${parts[7] & 0xff}`;
    try { return isBlockedSpecialUseIpv4Address(ipaddr.IPv4.parse(ip4str), opts); } catch { return true; }
  }

  // 6to4 prefix: 2002::/16
  if (parts[0] === 0x2002) {
    const ip4str = `${(parts[1] >> 8) & 0xff}.${parts[1] & 0xff}.${(parts[2] >> 8) & 0xff}.${parts[2] & 0xff}`;
    try { return isBlockedSpecialUseIpv4Address(ipaddr.IPv4.parse(ip4str), opts); } catch { return true; }
  }

  // Teredo prefix: 2001:0000::/32 — client IPv4 is in last 32 bits XOR'd with 0xFFFF
  if (parts[0] === 0x2001 && parts[1] === 0x0000) {
    const hiXored = parts[6] ^ 0xffff;
    const loXored = parts[7] ^ 0xffff;
    const ip4str = `${(hiXored >> 8) & 0xff}.${hiXored & 0xff}.${(loXored >> 8) & 0xff}.${loXored & 0xff}`;
    try { return isBlockedSpecialUseIpv4Address(ipaddr.IPv4.parse(ip4str), opts); } catch { return true; }
  }

  return null; // not a known transition format
}

/**
 * Check whether an IP address string is private/internal/loopback.
 * Uses ipaddr.js for proper CIDR matching.
 */
function isPrivateIpAddress(address: string, opts?: IsPrivateIpOpts): boolean {
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  if (!normalized) return false;

  // Try strict parse via ipaddr.js
  try {
    const parsed = ipaddr.parse(normalized);
    if (parsed.kind() === 'ipv4') {
      return isBlockedSpecialUseIpv4Address(parsed as ipaddr.IPv4, opts);
    }
    // IPv6
    const v6 = parsed as ipaddr.IPv6;
    if (isBlockedSpecialUseIpv6Address(v6)) return true;
    // Check for embedded IPv4 in transition formats
    const embeddedV4 = extractEmbeddedIpv4FromIpv6(v6, opts);
    if (embeddedV4 !== null) return embeddedV4;
    return false;
  } catch {
    // Parse failed
  }

  // Defense-in-depth: legacy IPv4 literal check (fail closed)
  if (!normalized.includes(':') && isUnsupportedIPv4Literal(normalized)) return true;

  // Unparseable IPv6-looking address — fail closed
  if (normalized.includes(':')) return true;

  return false;
}

// ── URL-level checks ──

/**
 * Check whether a URL targets a loopback or private/internal network address.
 * Synchronous hostname-based check. Used to prevent SSRF attacks.
 */
export function isInternalUrl(url: string, opts?: IsPrivateIpOpts): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (isBlockedHostnameNormalized(hostname)) return true;
  if (isPrivateIpAddress(hostname, opts)) return true;

  return false;
}

// ── DNS pinning (prevents TOCTOU rebinding) ──

function dedupeAndPreferIpv4(results: { address: string; family: number }[]): string[] {
  const seen = new Set<string>();
  const ipv4: string[] = [];
  const ipv6: string[] = [];
  for (const r of results) {
    if (seen.has(r.address)) continue;
    seen.add(r.address);
    if (r.family === 4) ipv4.push(r.address);
    else ipv6.push(r.address);
  }
  return [...ipv4, ...ipv6];
}

/**
 * Create a pinned DNS lookup function that always resolves to the pre-resolved
 * addresses for the given hostname. Falls back to real DNS for other hostnames.
 */
export function createPinnedLookup(params: {
  hostname: string;
  addresses: string[];
  fallback?: typeof dnsLookupCb;
}): typeof dnsLookupCb {
  const normalizedHost = normalizeHostname(params.hostname);
  const fallback = params.fallback ?? dnsLookupCb;
  const records = params.addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 as const : 4 as const,
  }));
  let index = 0;

  return ((host: string, options: any, callback?: any) => {
    const cb = typeof options === 'function' ? options : callback;
    if (!cb) return;

    const normalized = normalizeHostname(host);
    if (!normalized || normalized !== normalizedHost) {
      if (typeof options === 'function' || options === undefined) return (fallback as any)(host, cb);
      return (fallback as any)(host, options, cb);
    }

    const opts = typeof options === 'object' && options !== null ? options : {};
    const requestedFamily = typeof options === 'number' ? options : typeof opts.family === 'number' ? opts.family : 0;
    const candidates = requestedFamily === 4 || requestedFamily === 6
      ? records.filter((entry) => entry.family === requestedFamily)
      : records;
    const usable = candidates.length > 0 ? candidates : records;

    if (opts.all) {
      cb(null, usable);
      return;
    }
    const chosen = usable[index % usable.length];
    index += 1;
    cb(null, chosen.address, chosen.family);
  }) as typeof dnsLookupCb;
}

/**
 * Resolve DNS for a hostname and validate resolved addresses against SSRF policy.
 * Returns a PinnedHostname with pre-resolved addresses and a pinned lookup function.
 */
export async function resolvePinnedHostnameWithPolicy(hostname: string, params: {
  lookupFn?: LookupFn;
  policy?: SsrfPolicy;
} = {}): Promise<PinnedHostname> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) throw new InvalidBrowserNavigationUrlError(`Invalid hostname: "${hostname}"`);

  const allowPrivateNetwork = isPrivateNetworkAllowedByPolicy(params.policy);

  const allowedHostnames = [
    ...(params.policy?.allowedHostnames ?? []),
    ...(params.policy?.hostnameAllowlist ?? []),
  ].map(h => normalizeHostname(h));

  const isExplicitlyAllowed = allowedHostnames.some(h => h === normalized);
  const skipPrivateNetworkChecks = allowPrivateNetwork || isExplicitlyAllowed;

  // Check hostname itself
  if (!skipPrivateNetworkChecks) {
    if (isBlockedHostnameNormalized(normalized)) {
      throw new InvalidBrowserNavigationUrlError(
        `Navigation to internal/loopback address blocked: "${hostname}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`
      );
    }
    const ipOpts: IsPrivateIpOpts = { allowRfc2544BenchmarkRange: params.policy?.allowRfc2544BenchmarkRange };
    if (isPrivateIpAddress(normalized, ipOpts)) {
      throw new InvalidBrowserNavigationUrlError(
        `Navigation to internal/loopback address blocked: "${hostname}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`
      );
    }
  }

  // Resolve DNS
  const lookupFn = params.lookupFn ?? dnsLookup;
  let results: { address: string; family: number }[];
  try {
    results = await lookupFn(normalized, { all: true }) as unknown as { address: string; family: number }[];
  } catch {
    throw new InvalidBrowserNavigationUrlError(
      `Navigation to internal/loopback address blocked: unable to resolve "${hostname}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`
    );
  }

  if (!results || results.length === 0) {
    throw new InvalidBrowserNavigationUrlError(
      `Navigation to internal/loopback address blocked: unable to resolve "${hostname}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`
    );
  }

  // Validate resolved addresses
  if (!skipPrivateNetworkChecks) {
    const ipOpts: IsPrivateIpOpts = { allowRfc2544BenchmarkRange: params.policy?.allowRfc2544BenchmarkRange };
    for (const r of results) {
      if (isPrivateIpAddress(r.address, ipOpts)) {
        throw new InvalidBrowserNavigationUrlError(
          `Navigation to internal/loopback address blocked: "${hostname}" resolves to "${r.address}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`
        );
      }
    }
  }

  const addresses = dedupeAndPreferIpv4(results);
  if (addresses.length === 0) {
    throw new InvalidBrowserNavigationUrlError(
      `Navigation to internal/loopback address blocked: unable to resolve "${hostname}".`
    );
  }

  return {
    hostname: normalized,
    addresses,
    lookup: createPinnedLookup({ hostname: normalized, addresses }),
  };
}

/**
 * Assert that a URL is allowed for browser navigation under the given SSRF policy.
 * Throws `InvalidBrowserNavigationUrlError` if the URL is blocked.
 */
export async function assertBrowserNavigationAllowed(opts: {
  url: string;
  lookupFn?: LookupFn;
} & BrowserNavigationPolicyOptions): Promise<void> {
  const rawUrl = String(opts.url ?? '').trim();

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: "${rawUrl}"`);
  }

  // Block non-network protocols (file:, data:, javascript:, etc.) — only http/https allowed.
  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (isAllowedNonNetworkNavigationUrl(parsed)) return;
    throw new InvalidBrowserNavigationUrlError(`Navigation blocked: unsupported protocol "${parsed.protocol}"`);
  }

  // Fail closed when proxy env vars are set — SSRF checks cannot be reliably enforced
  if (hasProxyEnvConfigured() && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)) {
    throw new InvalidBrowserNavigationUrlError(
      'Navigation blocked: strict browser SSRF policy cannot be enforced while env proxy variables are set'
    );
  }

  const policy = opts.ssrfPolicy;

  if (policy?.dangerouslyAllowPrivateNetwork ?? policy?.allowPrivateNetwork ?? true) return;

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy,
  });
}

/**
 * Validate that an output file path is safe — no directory traversal or escape.
 */
export async function assertSafeOutputPath(path: string, allowedRoots?: string[]): Promise<void> {
  if (!path || typeof path !== 'string') {
    throw new Error('Output path is required.');
  }

  const normalized = normalize(path);

  if (normalized.includes('..')) {
    throw new Error(`Unsafe output path: directory traversal detected in "${path}".`);
  }

  if (allowedRoots?.length) {
    const resolved = resolve(normalized);

    let parentReal: string;
    try {
      parentReal = await realpath(dirname(resolved));
    } catch {
      throw new Error(`Unsafe output path: parent directory is inaccessible for "${path}".`);
    }

    try {
      const targetStat = await lstat(resolved);
      if (targetStat.isSymbolicLink()) {
        throw new Error(`Unsafe output path: "${path}" is a symbolic link.`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }

    const results = await Promise.all(
      allowedRoots.map(async (root) => {
        try {
          const rootStat = await lstat(resolve(root));
          if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
          const rootReal = await realpath(resolve(root));
          return parentReal === rootReal || parentReal.startsWith(rootReal + sep);
        } catch {
          return false;
        }
      })
    );
    if (!results.some(Boolean)) {
      throw new Error(`Unsafe output path: "${path}" is outside allowed directories.`);
    }
  }
}

/**
 * Validate upload file paths immediately before use.
 */
export async function assertSafeUploadPaths(paths: string[]): Promise<void> {
  for (const filePath of paths) {
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(filePath);
    } catch {
      throw new Error(`Upload path does not exist or is inaccessible: "${filePath}".`);
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Upload path is a symbolic link: "${filePath}".`);
    }
    if (!stat.isFile()) {
      throw new Error(`Upload path is not a regular file: "${filePath}".`);
    }
  }
}

// ── Atomic file write utilities ──

/**
 * Sanitize an untrusted file name (e.g. from a download) to prevent path traversal.
 */
export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  const trimmed = String(fileName ?? '').trim();
  if (!trimmed) return fallbackName;

  let base = posix.basename(trimmed);
  base = win32.basename(base);

  // Strip control characters
  let cleaned = '';
  for (let i = 0; i < base.length; i++) {
    const code = base.charCodeAt(i);
    if (code < 32 || code === 127) continue;
    cleaned += base[i];
  }
  base = cleaned.trim();

  if (!base || base === '.' || base === '..') return fallbackName;
  if (base.length > 200) base = base.slice(0, 200);
  return base;
}

/**
 * Build a sibling temp path for atomic writes.
 */
function buildSiblingTempPath(targetPath: string): string {
  const id = randomUUID();
  const safeTail = sanitizeUntrustedFileName(basename(targetPath), 'output.bin');
  return join(dirname(targetPath), `.browserclaw-output-${id}-${safeTail}.part`);
}

/**
 * Write a file atomically via a sibling temp path.
 * The writeTemp callback should write the content to tempPath.
 * After writeTemp completes, the temp file is renamed to the target path.
 */
export async function writeViaSiblingTempPath(params: {
  rootDir: string;
  targetPath: string;
  writeTemp: (tempPath: string) => Promise<void>;
}): Promise<void> {
  const rootDir = await realpath(resolve(params.rootDir)).catch(() => resolve(params.rootDir));
  const requestedTargetPath = resolve(params.targetPath);
  const targetPath = await realpath(dirname(requestedTargetPath))
    .then((realDir) => join(realDir, basename(requestedTargetPath)))
    .catch(() => requestedTargetPath);

  const relativeTargetPath = relative(rootDir, targetPath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === '..' ||
    relativeTargetPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeTargetPath)
  ) {
    throw new Error('Target path is outside the allowed root');
  }

  const tempPath = buildSiblingTempPath(targetPath);
  let renameSucceeded = false;
  try {
    await params.writeTemp(tempPath);
    await rename(tempPath, targetPath);
    renameSucceeded = true;
  } finally {
    if (!renameSucceeded) await rm(tempPath, { force: true }).catch(() => {});
  }
}

function isAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:/.test(p);
}

/**
 * Best-effort post-navigation guard for the final page URL.
 */
export async function assertBrowserNavigationResultAllowed(opts: {
  url: string;
  lookupFn?: LookupFn;
} & BrowserNavigationPolicyOptions): Promise<void> {
  const rawUrl = String(opts.url ?? '').trim();
  if (!rawUrl) return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }

  if (NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) || isAllowedNonNetworkNavigationUrl(parsed)) {
    await assertBrowserNavigationAllowed(opts);
  }
}

/**
 * Walk the full redirect chain and validate each hop against the SSRF policy.
 */
export async function assertBrowserNavigationRedirectChainAllowed(opts: {
  request?: BrowserNavigationRequestLike | null;
  lookupFn?: LookupFn;
} & BrowserNavigationPolicyOptions): Promise<void> {
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  for (const url of [...chain].reverse()) {
    await assertBrowserNavigationAllowed({ url, lookupFn: opts.lookupFn, ssrfPolicy: opts.ssrfPolicy });
  }
}

/**
 * Returns true if the SSRF policy requires redirect chain inspection.
 */
export function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrfPolicy): boolean {
  return !isPrivateNetworkAllowedByPolicy(ssrfPolicy);
}
