import { randomUUID } from 'node:crypto';
import { lookup as dnsLookupCb } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  resolve,
  normalize,
  dirname,
  basename,
  join,
  sep,
  relative,
  posix,
  win32,
  isAbsolute as pathIsAbsolute,
} from 'node:path';

import * as ipaddr from 'ipaddr.js';

import { hasProxyEnvConfigured } from './chrome-launcher.js';
import type { SsrfPolicy, PinnedHostname } from './types.js';

// ── Default temp directories for downloads/uploads ──

function resolveDefaultBrowserTmpDir(): string {
  try {
    if (process.platform === 'linux' || process.platform === 'darwin') {
      return '/tmp/browserclaw';
    }
  } catch {
    /* fallback below */
  }
  return join(tmpdir(), 'browserclaw');
}

export const DEFAULT_BROWSER_TMP_DIR = resolveDefaultBrowserTmpDir();
export const DEFAULT_DOWNLOAD_DIR = join(DEFAULT_BROWSER_TMP_DIR, 'downloads');
export const DEFAULT_UPLOAD_DIR = join(DEFAULT_BROWSER_TMP_DIR, 'uploads');

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
export interface BrowserNavigationPolicyOptions {
  ssrfPolicy?: SsrfPolicy;
}

/** Playwright-compatible request interface for redirect chain inspection. */
export interface BrowserNavigationRequestLike {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
}

/** Build a BrowserNavigationPolicyOptions from an SsrfPolicy. */
export function withBrowserNavigationPolicy(ssrfPolicy?: SsrfPolicy): BrowserNavigationPolicyOptions {
  return ssrfPolicy ? { ssrfPolicy } : {};
}

// Only http: and https: are permitted for navigation; about:blank is the sole non-network exception.
const NETWORK_NAVIGATION_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_NON_NETWORK_URLS = new Set(['about:blank']);

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

function isPrivateNetworkAllowedByPolicy(policy?: SsrfPolicy): boolean {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  return policy?.dangerouslyAllowPrivateNetwork === true || policy?.allowPrivateNetwork === true;
}

// ── Hostname normalization & blocking ──

function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
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

const BLOCKED_IPV4_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'carrierGradeNat',
  'private',
  'reserved',
]);

const BLOCKED_IPV6_RANGES = new Set([
  'unspecified',
  'loopback',
  'linkLocal',
  'uniqueLocal',
  'multicast',
  'reserved',
  'benchmarking',
  'discard',
  'orchid2',
]);

const RFC2544_BENCHMARK_PREFIX: [ipaddr.IPv4, number] = [ipaddr.IPv4.parse('198.18.0.0'), 15];

interface IsPrivateIpOpts {
  allowRfc2544BenchmarkRange?: boolean;
}

const EMBEDDED_IPV4_SENTINEL_RULES: {
  matches: (parts: number[]) => boolean;
  toHextets: (parts: number[]) => [number, number];
}[] = [
  // IPv4-compatible (::a.b.c.d)
  {
    matches: (parts) =>
      parts[0] === 0 && parts[1] === 0 && parts[2] === 0 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0,
    toHextets: (parts) => [parts[6], parts[7]],
  },
  // NAT64 local-use (64:ff9b:1::/48)
  {
    matches: (parts) =>
      parts[0] === 100 && parts[1] === 65435 && parts[2] === 1 && parts[3] === 0 && parts[4] === 0 && parts[5] === 0,
    toHextets: (parts) => [parts[6], parts[7]],
  },
  // 6to4 (2002::/16)
  {
    matches: (parts) => parts[0] === 0x2002,
    toHextets: (parts) => [parts[1], parts[2]],
  },
  // Teredo (2001:0000::/32) — IPv4 XOR'd
  {
    matches: (parts) => parts[0] === 0x2001 && parts[1] === 0x0000,
    toHextets: (parts) => [parts[6] ^ 0xffff, parts[7] ^ 0xffff],
  },
  // ISATAP — sentinel in parts[4-5]: 0x0000:0x5efe or 0x0200:0x5efe
  {
    matches: (parts) => (parts[4] & 0xfcff) === 0 && parts[5] === 0x5efe,
    toHextets: (parts) => [parts[6], parts[7]],
  },
];

function stripIpv6Brackets(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1);
  return value;
}

function isNumericIpv4LiteralPart(value: string): boolean {
  return /^[0-9]+$/.test(value) || /^0x[0-9a-f]+$/i.test(value);
}

function parseIpv6WithEmbeddedIpv4(raw: string): ipaddr.IPv6 | undefined {
  if (!raw.includes(':') || !raw.includes('.')) return;
  const match = /^(.*:)([^:%]+(?:\.[^:%]+){3})(%[0-9A-Za-z]+)?$/i.exec(raw);
  if (!match) return;
  const [, prefix, embeddedIpv4, zoneSuffix = ''] = match;
  if (!ipaddr.IPv4.isValidFourPartDecimal(embeddedIpv4)) return;
  const octets = embeddedIpv4.split('.').map((part) => Number.parseInt(part, 10));
  const normalizedIpv6 = `${prefix}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}${zoneSuffix}`;
  if (!ipaddr.IPv6.isValid(normalizedIpv6)) return;
  return ipaddr.IPv6.parse(normalizedIpv6);
}

function normalizeIpParseInput(raw: string | undefined | null): string | undefined {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === '') return;
  return stripIpv6Brackets(trimmed);
}

function parseCanonicalIpAddress(raw: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (normalized === undefined) return;
  if (ipaddr.IPv4.isValid(normalized)) {
    if (!ipaddr.IPv4.isValidFourPartDecimal(normalized)) return;
    return ipaddr.IPv4.parse(normalized);
  }
  if (ipaddr.IPv6.isValid(normalized)) return ipaddr.IPv6.parse(normalized);
  return parseIpv6WithEmbeddedIpv4(normalized);
}

function parseLooseIpAddress(raw: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const normalized = normalizeIpParseInput(raw);
  if (normalized === undefined) return;
  if (ipaddr.isValid(normalized)) return ipaddr.parse(normalized);
  return parseIpv6WithEmbeddedIpv4(normalized);
}

function isCanonicalDottedDecimalIPv4(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  const normalized = stripIpv6Brackets(trimmed);
  if (!normalized) return false;
  return ipaddr.IPv4.isValidFourPartDecimal(normalized);
}

function isLegacyIpv4Literal(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  const normalized = stripIpv6Brackets(trimmed);
  if (!normalized || normalized.includes(':')) return false;
  if (isCanonicalDottedDecimalIPv4(normalized)) return false;
  const parts = normalized.split('.');
  if (parts.length === 0 || parts.length > 4) return false;
  if (parts.some((part) => part.length === 0)) return false;
  if (!parts.every((part) => isNumericIpv4LiteralPart(part))) return false;
  return true;
}

function looksLikeUnsupportedIpv4Literal(address: string): boolean {
  const parts = address.split('.');
  if (parts.length === 0 || parts.length > 4) return false;
  if (parts.some((part) => part.length === 0)) return true;
  return parts.every((part) => /^[0-9]+$/.test(part) || /^0x/i.test(part));
}

function isBlockedSpecialUseIpv4Address(address: ipaddr.IPv4, opts?: IsPrivateIpOpts): boolean {
  const inRfc2544 = address.match(RFC2544_BENCHMARK_PREFIX);
  if (inRfc2544 && opts?.allowRfc2544BenchmarkRange === true) return false;
  return BLOCKED_IPV4_RANGES.has(address.range()) || inRfc2544;
}

function isBlockedSpecialUseIpv6Address(address: ipaddr.IPv6): boolean {
  if (BLOCKED_IPV6_RANGES.has(address.range())) return true;
  return (address.parts[0] & 0xffc0) === 0xfec0;
}

function decodeIpv4FromHextets(high: number, low: number): ipaddr.IPv4 {
  const octets = [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff];
  return ipaddr.IPv4.parse(octets.join('.'));
}

function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  if (address.isIPv4MappedAddress()) return address.toIPv4Address();
  if (address.range() === 'rfc6145') return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  if (address.range() === 'rfc6052') return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  for (const rule of EMBEDDED_IPV4_SENTINEL_RULES) {
    if (!rule.matches(address.parts)) continue;
    const [high, low] = rule.toHextets(address.parts);
    return decodeIpv4FromHextets(high, low);
  }
}

function resolveIpv4SpecialUseBlockOptions(policy?: SsrfPolicy): IsPrivateIpOpts {
  return { allowRfc2544BenchmarkRange: policy?.allowRfc2544BenchmarkRange === true };
}

function isBlockedHostnameOrIp(hostname: string, policy?: SsrfPolicy): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  return isBlockedHostnameNormalized(normalized) || isPrivateIpAddress(normalized, policy);
}

function isPrivateIpAddress(address: string, policy?: SsrfPolicy): boolean {
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  if (!normalized) return false;

  const blockOptions = resolveIpv4SpecialUseBlockOptions(policy);

  const strictIp = parseCanonicalIpAddress(normalized);
  if (strictIp) {
    if (strictIp.kind() === 'ipv4') return isBlockedSpecialUseIpv4Address(strictIp as ipaddr.IPv4, blockOptions);
    const v6 = strictIp as ipaddr.IPv6;
    if (isBlockedSpecialUseIpv6Address(v6)) return true;
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(v6);
    if (embeddedIpv4) return isBlockedSpecialUseIpv4Address(embeddedIpv4, blockOptions);
    return false;
  }

  if (normalized.includes(':') && !parseLooseIpAddress(normalized)) return true;
  if (!isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized)) return true;
  if (looksLikeUnsupportedIpv4Literal(normalized)) return true;
  return false;
}

// ── URL-level checks ──

/**
 * Check whether a URL targets a loopback or private/internal network address.
 * Synchronous hostname-based check. Used to prevent SSRF attacks.
 */
export function isInternalUrl(url: string, policy?: SsrfPolicy): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (isBlockedHostnameNormalized(hostname)) return true;
  if (isPrivateIpAddress(hostname, policy)) return true;

  return false;
}

// ── Hostname allowlist with wildcard pattern support ──

function normalizeHostnameSet(values?: string[]): Set<string> {
  if (!values || values.length === 0) return new Set();
  return new Set(values.map((v) => normalizeHostname(v)).filter(Boolean));
}

function normalizeHostnameAllowlist(values?: string[]): string[] {
  if (!values || values.length === 0) return [];
  return Array.from(
    new Set(values.map((v) => normalizeHostname(v)).filter((v) => v !== '*' && v !== '*.' && v.length > 0)),
  );
}

function isHostnameAllowedByPattern(hostname: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2);
    if (!suffix || hostname === suffix) return false;
    return hostname.endsWith(`.${suffix}`);
  }
  return hostname === pattern;
}

function matchesHostnameAllowlist(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true; // empty allowlist = no restriction
  return allowlist.some((pattern) => isHostnameAllowedByPattern(hostname, pattern));
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
  if (params.addresses.length === 0)
    throw new Error(`Pinned lookup requires at least one address for ${params.hostname}`);
  const fallback = params.fallback ?? dnsLookupCb;
  const records = params.addresses.map((address) => ({
    address,
    family: address.includes(':') ? (6 as const) : (4 as const),
  }));
  let index = 0;

  // dns.lookup has complex overloads; we use a loosely-typed inner signature
  // and cast the result back to the proper type at the boundary.
  type DnsLookupArg = string | number | { all?: boolean; family?: number } | ((...a: unknown[]) => void) | undefined;
  return ((_host: string, ...rest: DnsLookupArg[]) => {
    const second = rest[0];
    const third = rest[1];
    const cb = typeof second === 'function' ? second : typeof third === 'function' ? third : undefined;
    if (cb === undefined) return;

    const normalized = normalizeHostname(_host);
    if (normalized === '' || normalized !== normalizedHost) {
      if (typeof second === 'function' || second === undefined) {
        (fallback as (...a: unknown[]) => void)(_host, cb);
        return;
      }
      (fallback as (...a: unknown[]) => void)(_host, second, cb);
      return;
    }

    const opts: { all?: boolean; family?: number } =
      typeof second === 'object' ? (second as { all?: boolean; family?: number }) : {};
    const requestedFamily = typeof second === 'number' ? second : typeof opts.family === 'number' ? opts.family : 0;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : records;
    const usable = candidates.length > 0 ? candidates : records;

    if (opts.all === true) {
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
export async function resolvePinnedHostnameWithPolicy(
  hostname: string,
  params: {
    lookupFn?: LookupFn;
    policy?: SsrfPolicy;
  } = {},
): Promise<PinnedHostname> {
  const normalized = normalizeHostname(hostname);
  if (!normalized) throw new InvalidBrowserNavigationUrlError(`Invalid hostname: "${hostname}"`);

  const allowPrivateNetwork = isPrivateNetworkAllowedByPolicy(params.policy);
  const allowedHostnames = normalizeHostnameSet(params.policy?.allowedHostnames);
  const hostnameAllowlist = normalizeHostnameAllowlist(params.policy?.hostnameAllowlist);
  const isExplicitlyAllowed = allowedHostnames.has(normalized);
  const skipPrivateNetworkChecks = allowPrivateNetwork || isExplicitlyAllowed;

  // hostnameAllowlist is a restriction: if specified, hostname must match a pattern
  if (!matchesHostnameAllowlist(normalized, hostnameAllowlist)) {
    throw new InvalidBrowserNavigationUrlError(`Navigation blocked: hostname "${hostname}" is not in the allowlist.`);
  }

  if (!skipPrivateNetworkChecks) {
    if (isBlockedHostnameOrIp(normalized, params.policy)) {
      throw new InvalidBrowserNavigationUrlError(
        `Navigation to internal/loopback address blocked: "${hostname}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`,
      );
    }
  }

  const lookupFn = params.lookupFn ?? dnsLookup;
  let results: { address: string; family: number }[];
  try {
    results = (await lookupFn(normalized, { all: true })) as unknown as { address: string; family: number }[];
  } catch {
    throw new InvalidBrowserNavigationUrlError(
      `Navigation to internal/loopback address blocked: unable to resolve "${hostname}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`,
    );
  }

  if (results.length === 0) {
    throw new InvalidBrowserNavigationUrlError(
      `Navigation to internal/loopback address blocked: unable to resolve "${hostname}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`,
    );
  }

  if (!skipPrivateNetworkChecks) {
    for (const r of results) {
      if (isBlockedHostnameOrIp(r.address, params.policy)) {
        throw new InvalidBrowserNavigationUrlError(
          `Navigation to internal/loopback address blocked: "${hostname}" resolves to "${r.address}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`,
        );
      }
    }
  }

  const addresses = dedupeAndPreferIpv4(results);
  if (addresses.length === 0) {
    throw new InvalidBrowserNavigationUrlError(
      `Navigation to internal/loopback address blocked: unable to resolve "${hostname}".`,
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
export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = opts.url.trim();
  if (rawUrl === '') throw new InvalidBrowserNavigationUrlError('url is required');

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
      'Navigation blocked: strict browser SSRF policy cannot be enforced while env proxy variables are set',
    );
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
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

  if (allowedRoots !== undefined && allowedRoots.length > 0) {
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
      }),
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

/**
 * Resolve and validate upload file paths, returning them if all are safe.
 * Returns `{ ok: true, paths }` or `{ ok: false, error }`.
 *
 * **Note:** This function does NOT provide root confinement — it only checks that
 * each path exists and is a regular file. An attacker-controlled path can still
 * reference any readable file on the system (e.g. `/etc/passwd`).
 * For uploads that must stay within a specific directory, use
 * `resolveStrictExistingPathsWithinRoot` instead.
 */
export async function resolveStrictExistingUploadPaths(params: {
  requestedPaths: string[];
  scopeLabel?: string;
}): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> {
  try {
    await assertSafeUploadPaths(params.requestedPaths);
    return { ok: true, paths: params.requestedPaths };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Path confinement utilities ──

type PathResult = { ok: true; path: string } | { ok: false; error: string };
type PathsResult = { ok: true; paths: string[] } | { ok: false; error: string };

/**
 * Lexical confinement: resolve(root, raw) must not escape root.
 */
export function resolvePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): PathResult {
  const root = resolve(params.rootDir);
  const raw = params.requestedPath.trim();
  const effectivePath =
    raw === '' && params.defaultFileName != null && params.defaultFileName !== '' ? params.defaultFileName : raw;
  if (effectivePath === '') return { ok: false, error: `Empty path is not allowed (${params.scopeLabel}).` };

  const resolved = resolve(root, effectivePath);
  const rel = relative(root, resolved);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || pathIsAbsolute(rel)) {
    return { ok: false, error: `Path escapes ${params.scopeLabel}: "${params.requestedPath}".` };
  }
  return { ok: true, path: resolved };
}

/**
 * Async writable-path check: verifies parent dir realpath is within root,
 * and that the target (if it exists) is not a symlink.
 */
export async function resolveWritablePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): Promise<PathResult> {
  const lexical = resolvePathWithinRoot(params);
  if (!lexical.ok) return lexical;

  const root = resolve(params.rootDir);
  const target = lexical.path;

  let parentReal: string;
  try {
    parentReal = await realpath(dirname(target));
  } catch {
    return {
      ok: false,
      error: `Parent directory is inaccessible for "${params.requestedPath}" (${params.scopeLabel}).`,
    };
  }

  const parentRel = relative(root, parentReal);
  if (parentRel === '..' || parentRel.startsWith(`..${sep}`) || pathIsAbsolute(parentRel)) {
    return { ok: false, error: `Path escapes ${params.scopeLabel} via symlink: "${params.requestedPath}".` };
  }

  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      return { ok: false, error: `Path is a symbolic link (${params.scopeLabel}): "${params.requestedPath}".` };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        ok: false,
        error: `Cannot stat "${params.requestedPath}" (${params.scopeLabel}): ${(e as Error).message}`,
      };
    }
  }

  return { ok: true, path: target };
}

/**
 * For each path: lexical check then realpath check. Missing files are allowed
 * (returns the fallback resolved path).
 */
export async function resolveExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): Promise<PathsResult> {
  const root = resolve(params.rootDir);
  const resolved: string[] = [];

  for (const raw of params.requestedPaths) {
    const lexical = resolvePathWithinRoot({ rootDir: root, requestedPath: raw, scopeLabel: params.scopeLabel });
    if (!lexical.ok) return lexical;

    try {
      const real = await realpath(lexical.path);
      const rel = relative(root, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || pathIsAbsolute(rel)) {
        return { ok: false, error: `Path escapes ${params.scopeLabel} via symlink: "${raw}".` };
      }
      resolved.push(real);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        resolved.push(lexical.path);
      } else {
        return { ok: false, error: `Cannot resolve "${raw}" (${params.scopeLabel}): ${(e as Error).message}` };
      }
    }
  }

  return { ok: true, paths: resolved };
}

/**
 * Same as resolveExistingPathsWithinRoot but missing files are NOT allowed.
 */
export async function resolveStrictExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): Promise<PathsResult> {
  const root = resolve(params.rootDir);
  const resolved: string[] = [];

  for (const raw of params.requestedPaths) {
    const lexical = resolvePathWithinRoot({ rootDir: root, requestedPath: raw, scopeLabel: params.scopeLabel });
    if (!lexical.ok) return lexical;

    let real: string;
    try {
      real = await realpath(lexical.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, error: `Path does not exist (${params.scopeLabel}): "${raw}".` };
      }
      return { ok: false, error: `Cannot resolve "${raw}" (${params.scopeLabel}): ${(e as Error).message}` };
    }

    const rel = relative(root, real);
    if (rel === '..' || rel.startsWith(`..${sep}`) || pathIsAbsolute(rel)) {
      return { ok: false, error: `Path escapes ${params.scopeLabel} via symlink: "${raw}".` };
    }

    const stat = await lstat(real);
    if (stat.isSymbolicLink()) {
      return { ok: false, error: `Path is a symbolic link (${params.scopeLabel}): "${raw}".` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `Path is not a regular file (${params.scopeLabel}): "${raw}".` };
    }

    resolved.push(real);
  }

  return { ok: true, paths: resolved };
}

// ── Atomic file write utilities ──

/**
 * Sanitize an untrusted file name (e.g. from a download) to prevent path traversal.
 */
export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  const trimmed = fileName.trim();
  if (trimmed === '') return fallbackName;

  let base = posix.basename(trimmed);
  base = win32.basename(base);

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
    pathIsAbsolute(relativeTargetPath)
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
    if (!renameSucceeded)
      await rm(tempPath, { force: true }).catch(() => {
        /* noop */
      });
  }
}

/**
 * Best-effort post-navigation guard for the final page URL.
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = opts.url.trim();
  if (rawUrl === '') return;

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
export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
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
