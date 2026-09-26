import { randomUUID } from 'node:crypto';
import { lookup as dnsLookupCb } from 'node:dns';
import { lookup as dnsLookup } from 'node:dns/promises';
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, normalize, dirname, basename, join, sep, relative, isAbsolute as pathIsAbsolute } from 'node:path';

import * as ipaddr from 'ipaddr.js';

import { hasProxyEnvConfigured } from './chrome-launcher.js';
import {
  fitFileNameToPortableComponent,
  hasWindowsPathAlias,
  pathForWindowsFilesystem,
  resolvePathPreservingWindowsRoot,
  sanitizeUntrustedFileName,
} from './file-safety.js';
import { assertConfinedFilePath } from './path-confinement.js';
import type { SsrfPolicy, PinnedHostname } from './types.js';

export { sanitizeUntrustedFileName } from './file-safety.js';

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

/** Thrown when the CDP endpoint URL is blocked by the configured SSRF policy. */
export class BrowserCdpEndpointBlockedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'BrowserCdpEndpointBlockedError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * Build request headers with Basic auth derived from URL userinfo, unless an
 * Authorization header is already present. Percent-encoded credentials are
 * decoded before base64-encoding (RFC 7617).
 */
export function getHeadersWithAuth(endpoint: string, baseHeaders: Record<string, string> = {}): Record<string, string> {
  const headers = { ...baseHeaders };
  try {
    const parsed = new URL(endpoint);
    if (Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')) return headers;
    if (parsed.username || parsed.password) {
      const decode = (value: string): string => {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      };
      const credentials = Buffer.from(`${decode(parsed.username)}:${decode(parsed.password)}`).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
    }
  } catch {
    // endpoint is not a valid URL (e.g. a raw WebSocket path) — skip auth header injection
  }
  return headers;
}

/**
 * Strip URL userinfo (user:pass@) so the URL can be safely logged or passed to
 * fetch without leaking credentials. Pair with `getHeadersWithAuth` to move
 * credentials into an Authorization header before issuing the request.
 */
export function stripUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function isCdpLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function hasExplicitCdpAllowlist(policy: SsrfPolicy): boolean {
  return (
    (Array.isArray(policy.allowedHostnames) && policy.allowedHostnames.length > 0) ||
    (Array.isArray(policy.hostnameAllowlist) && policy.hostnameAllowlist.length > 0)
  );
}

const discoveredCdpAuthorityChangeByPolicy = new WeakMap<SsrfPolicy, boolean>();

function allowsDiscoveredCdpAuthorityChange(policy?: SsrfPolicy): boolean {
  const prepared = policy ? discoveredCdpAuthorityChangeByPolicy.get(policy) : undefined;
  if (prepared !== undefined) return prepared;
  const hasExplicitAllowedHostnames = (policy?.allowedHostnames ?? []).some((hostname) => hostname.trim().length > 0);
  return !policy || (!hasExplicitAllowedHostnames && isPrivateNetworkAllowedByPolicy(policy));
}

/**
 * Pin a policy to the configured CDP hostname so `/json/*` discovery cannot use a broader allowlist.
 * `allowedHostnames` also skips private-network checks; keep it only if the caller or loopback auto-allow already did.
 */
export function scopeCdpPolicyToConfiguredEndpoint(cdpUrl: string, ssrfPolicy?: SsrfPolicy): SsrfPolicy | undefined {
  if (!ssrfPolicy) return undefined;
  let hostname: string;
  try {
    hostname = new URL(cdpUrl).hostname;
  } catch {
    return ssrfPolicy;
  }
  const keepsPrivateExemption =
    normalizeHostnameSet(ssrfPolicy.allowedHostnames).has(normalizeHostname(hostname)) ||
    (isCdpLoopbackHostname(hostname.replace(/\.+$/, '')) && !hasExplicitCdpAllowlist(ssrfPolicy));
  const scopedPolicy: SsrfPolicy = {
    ...ssrfPolicy,
    allowedHostnames: keepsPrivateExemption ? [hostname] : [],
    hostnameAllowlist: [hostname],
  };
  // Scoping may add a loopback grant or narrow an existing list. Preserve the
  // original authority decision instead of treating those derived fields as caller intent.
  discoveredCdpAuthorityChangeByPolicy.set(scopedPolicy, allowsDiscoveredCdpAuthorityChange(ssrfPolicy));
  return scopedPolicy;
}

function cdpEndpointAuthority(url: string): string {
  const parsed = new URL(url);
  const usesTls = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  const port = parsed.port || (usesTls ? '443' : '80');
  return `${usesTls ? 'tls' : 'plain'}://${parsed.hostname}:${port}`;
}

function assertDiscoveredCdpEndpointMatchesConfigured(
  discoveredUrl: string,
  configuredUrl: string,
  ssrfPolicy?: SsrfPolicy,
): void {
  if (allowsDiscoveredCdpAuthorityChange(ssrfPolicy)) return;
  let matches: boolean;
  try {
    matches = cdpEndpointAuthority(discoveredUrl) === cdpEndpointAuthority(configuredUrl);
  } catch {
    matches = false;
  }
  if (matches) return;
  throw new BrowserCdpEndpointBlockedError(
    'CDP endpoint blocked: discovered CDP endpoint changed configured authority',
  );
}

/** A `discovered` URL (from `/json/*`) must not change the configured endpoint's authority. */
export interface CdpEndpointSourceOptions {
  source?: 'configured' | 'discovered';
  configuredUrl?: string;
}

/**
 * Validate a CDP endpoint URL against an SSRF policy. No-op without a policy.
 * Loopback hostnames (`localhost`, `127.0.0.1`, `[::1]`) are allowed by default
 * when no explicit `allowedHostnames` or `hostnameAllowlist` is provided.
 * To reach a non-loopback private/internal endpoint, add its hostname to
 * `ssrfPolicy.allowedHostnames` or set `dangerouslyAllowPrivateNetwork: true`.
 * Discovered endpoints (from `/json/*` responses) get no loopback auto-allow
 * and must keep the configured endpoint's authority.
 */
export async function assertCdpEndpointAllowed(
  cdpUrl: string,
  ssrfPolicy?: SsrfPolicy,
  options?: CdpEndpointSourceOptions,
): Promise<void> {
  await resolveCdpEndpointPin(cdpUrl, ssrfPolicy, options);
}

/** @internal Validate and retain the DNS result used by the actual CDP dial. */
export async function resolveCdpEndpointPin(
  cdpUrl: string,
  ssrfPolicy?: SsrfPolicy,
  options?: CdpEndpointSourceOptions,
  signal?: AbortSignal,
): Promise<PinnedHostname | undefined> {
  if (options?.source === 'discovered' && options.configuredUrl !== undefined)
    assertDiscoveredCdpEndpointMatchesConfigured(cdpUrl, options.configuredUrl, ssrfPolicy);
  if (!ssrfPolicy) return;
  let parsed: URL;
  try {
    parsed = new URL(cdpUrl);
  } catch {
    throw new BrowserCdpEndpointBlockedError(`CDP endpoint blocked: invalid URL "${cdpUrl}"`);
  }
  const allowedProtocols = new Set(['http:', 'https:', 'ws:', 'wss:']);
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new BrowserCdpEndpointBlockedError(
      `CDP endpoint blocked: protocol "${parsed.protocol.replace(':', '')}" is not allowed (use http/https/ws/wss)`,
    );
  }
  const isLoopback = isCdpLoopbackHostname(parsed.hostname.replace(/\.+$/, ''));
  const hasExplicitAllowlist = hasExplicitCdpAllowlist(ssrfPolicy);
  const effectivePolicy =
    isLoopback && !hasExplicitAllowlist && options?.source !== 'discovered'
      ? {
          ...ssrfPolicy,
          allowedHostnames: Array.from(new Set([...(ssrfPolicy.allowedHostnames ?? []), parsed.hostname])),
        }
      : ssrfPolicy;
  try {
    return await resolvePinnedHostnameWithPolicy(parsed.hostname, { policy: effectivePolicy, signal });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BrowserCdpEndpointBlockedError(
      `CDP endpoint "${parsed.hostname}" blocked by SSRF policy: ${reason}. ` +
        `If connecting to a private/internal CDP endpoint, set ssrfPolicy.dangerouslyAllowPrivateNetwork = true ` +
        `or add the hostname to ssrfPolicy.allowedHostnames.`,
      { cause: error },
    );
  }
}

/**
 * How the target browser reaches the network.
 * `explicit-browser-proxy`: Chrome was launched with a proxy-routing arg, so the
 * proxy resolves DNS and egresses — local SSRF address validation is meaningless.
 */
export type BrowserProxyMode = 'direct' | 'explicit-browser-proxy';

/** Options for browser navigation SSRF policy. */
export interface BrowserNavigationPolicyOptions {
  ssrfPolicy?: SsrfPolicy;
  browserProxyMode?: BrowserProxyMode;
  signal?: AbortSignal;
}

/** Playwright-compatible request interface for redirect chain inspection. */
export interface BrowserNavigationRequestLike {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
}

/** Build a BrowserNavigationPolicyOptions from an SsrfPolicy (and optional proxy mode). */
export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrfPolicy,
  opts?: { browserProxyMode?: BrowserProxyMode },
): BrowserNavigationPolicyOptions {
  return {
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(opts?.browserProxyMode && opts.browserProxyMode !== 'direct'
      ? { browserProxyMode: opts.browserProxyMode }
      : {}),
  };
}

// Only http: and https: are permitted for navigation; about:blank is the sole non-network exception.
const NETWORK_NAVIGATION_PROTOCOLS = new Set(['http:', 'https:']);
const SAFE_NON_NETWORK_URLS = new Set(['about:blank']);

const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

export function isPrivateNetworkAllowedByPolicy(policy?: SsrfPolicy): boolean {
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

interface IsPrivateIpv4Opts {
  allowRfc2544BenchmarkRange?: boolean;
}

interface IsPrivateIpv6Opts {
  allowUniqueLocalRange?: boolean;
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

function isBlockedSpecialUseIpv4Address(address: ipaddr.IPv4, opts?: IsPrivateIpv4Opts): boolean {
  const inRfc2544 = address.match(RFC2544_BENCHMARK_PREFIX);
  if (inRfc2544 && opts?.allowRfc2544BenchmarkRange === true) return false;
  return BLOCKED_IPV4_RANGES.has(address.range()) || inRfc2544;
}

function isBlockedSpecialUseIpv6Address(address: ipaddr.IPv6, opts?: IsPrivateIpv6Opts): boolean {
  const range = address.range();
  if (isRfc8215Nat64LocalUseAddress(address)) return true;
  if (
    CLOUD_METADATA_IPV6.some(
      (metadata) => address.toNormalizedString() === ipaddr.IPv6.parse(metadata).toNormalizedString(),
    )
  )
    return true;
  if (range === 'uniqueLocal' && opts?.allowUniqueLocalRange === true) return false;
  if (BLOCKED_IPV6_RANGES.has(range)) return true;
  return (address.parts[0] & 0xffc0) === 0xfec0;
}

function decodeIpv4FromHextets(high: number, low: number): ipaddr.IPv4 {
  const octets = [(high >>> 8) & 0xff, high & 0xff, (low >>> 8) & 0xff, low & 0xff];
  return ipaddr.IPv4.parse(octets.join('.'));
}

function extractEmbeddedIpv4FromIpv6(address: ipaddr.IPv6): ipaddr.IPv4 | undefined {
  // RFC 8215 permits multiple embedding layouts across this /48; low 32 bits
  // cannot safely identify the destination. The entire prefix is blocked above.
  if (isRfc8215Nat64LocalUseAddress(address)) return;
  if (address.isIPv4MappedAddress()) return address.toIPv4Address();
  if (address.range() === 'rfc6145') return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  if (address.range() === 'rfc6052') return decodeIpv4FromHextets(address.parts[6], address.parts[7]);
  for (const rule of EMBEDDED_IPV4_SENTINEL_RULES) {
    if (!rule.matches(address.parts)) continue;
    const [high, low] = rule.toHextets(address.parts);
    return decodeIpv4FromHextets(high, low);
  }
}

function isRfc8215Nat64LocalUseAddress(address: ipaddr.IPv6): boolean {
  return address.parts[0] === 0x64 && address.parts[1] === 0xff9b && address.parts[2] === 1;
}

function isBlockedTrustedResolvedIpv6Address(address: string): boolean {
  const parsed = parseCanonicalIpAddress(address);
  if (parsed?.kind() !== 'ipv6') return false;
  const range = parsed.range();
  if (range !== 'unicast' && range !== 'rfc6052') return false;
  return isBlockedSpecialUseIpv6Address(parsed as ipaddr.IPv6);
}

function resolveIpv4SpecialUseBlockOptions(policy?: SsrfPolicy): IsPrivateIpv4Opts {
  return { allowRfc2544BenchmarkRange: policy?.allowRfc2544BenchmarkRange === true };
}

function resolveIpv6SpecialUseBlockOptions(policy?: SsrfPolicy): IsPrivateIpv6Opts {
  return { allowUniqueLocalRange: policy?.allowIpv6UniqueLocalRange === true };
}

function isBlockedHostnameOrIp(hostname: string, policy?: SsrfPolicy): boolean {
  const normalized = normalizeHostname(hostname);
  if (!normalized) return false;
  return isBlockedHostnameNormalized(normalized) || isPrivateIpAddress(normalized, policy);
}

function isPrivateIpAddress(address: string, policy?: SsrfPolicy): boolean {
  let normalized = address.trim().toLowerCase();
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  // "[]" strips to empty string — treat as unspecified (blocked)
  if (!normalized) return true;

  const blockOptions = resolveIpv4SpecialUseBlockOptions(policy);
  const ipv6BlockOptions = resolveIpv6SpecialUseBlockOptions(policy);

  const strictIp = parseCanonicalIpAddress(normalized);
  if (strictIp) {
    if (strictIp.kind() === 'ipv4') return isBlockedSpecialUseIpv4Address(strictIp as ipaddr.IPv4, blockOptions);
    const v6 = strictIp as ipaddr.IPv6;
    if (isBlockedSpecialUseIpv6Address(v6, ipv6BlockOptions)) return true;
    const embeddedIpv4 = extractEmbeddedIpv4FromIpv6(v6);
    if (embeddedIpv4) return isBlockedSpecialUseIpv4Address(embeddedIpv4, blockOptions);
    return false;
  }

  if (normalized.includes(':') && !parseLooseIpAddress(normalized)) return true;
  if (!isCanonicalDottedDecimalIPv4(normalized) && isLegacyIpv4Literal(normalized)) return true;
  if (looksLikeUnsupportedIpv4Literal(normalized)) return true;
  return false;
}

// Addresses that are never a legitimate target even for an explicitly
// allow-listed hostname (DNS-rebinding defense): link-local ranges and known
// cloud-metadata endpoints (AWS/GCP 169.254.169.254, AWS IPv6 fd00:ec2::254,
// Alibaba 100.100.100.200).
const CLOUD_METADATA_IPV4 = ['169.254.169.254', '100.100.100.200'];
const CLOUD_METADATA_IPV6 = ['fd00:ec2::254'];

function isCloudMetadataOrLinkLocalIpv4(v4: ipaddr.IPv4): boolean {
  if (v4.range() === 'linkLocal') return true;
  return CLOUD_METADATA_IPV4.some((m) => v4.toNormalizedString() === ipaddr.IPv4.parse(m).toNormalizedString());
}

function isCloudMetadataOrLinkLocalAddress(address: string): boolean {
  const parsed = parseCanonicalIpAddress(address);
  if (!parsed) return false;
  if (parsed.kind() === 'ipv4') return isCloudMetadataOrLinkLocalIpv4(parsed as ipaddr.IPv4);
  const v6 = parsed as ipaddr.IPv6;
  if (v6.range() === 'linkLocal') return true;
  if (CLOUD_METADATA_IPV6.some((m) => v6.toNormalizedString() === ipaddr.IPv6.parse(m).toNormalizedString()))
    return true;
  // An IPv4-mapped/6to4/Teredo v6 whose embedded IPv4 is metadata/link-local reaches
  // the same target once Node dials it — mirror the loopback/unspecified embedded checks.
  const embedded = extractEmbeddedIpv4FromIpv6(v6);
  return embedded ? isCloudMetadataOrLinkLocalIpv4(embedded) : false;
}

function isLoopbackIpAddressIncludingEmbeddedIpv4(address: string): boolean {
  const parsed = parseCanonicalIpAddress(address);
  if (!parsed) return false;
  if (parsed.range() === 'loopback') return true;
  if (parsed.kind() === 'ipv4') return false;
  return extractEmbeddedIpv4FromIpv6(parsed as ipaddr.IPv6)?.range() === 'loopback';
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === 'localhost.localdomain' ||
    hostname.endsWith('.localhost') ||
    isLoopbackIpAddressIncludingEmbeddedIpv4(hostname)
  );
}

function isUnspecifiedIpAddressIncludingEmbeddedIpv4(address: string): boolean {
  const parsed = parseCanonicalIpAddress(address);
  if (!parsed) return false;
  if (parsed.kind() === 'ipv4') return parsed.range() === 'unspecified';
  if (parsed.range() === 'unspecified') return true;
  if (parsed.range() === 'loopback') return false;
  return extractEmbeddedIpv4FromIpv6(parsed as ipaddr.IPv6)?.range() === 'unspecified';
}

// ── URL-level checks ──

/**
 * Check whether a URL targets a loopback or private/internal network address.
 * Synchronous hostname-based check — does NOT perform DNS resolution, so
 * hostnames that resolve to private IPs will not be caught. Use
 * `assertBrowserNavigationAllowed` for the full async DNS-pinned check.
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

function isIpLiteralHostname(hostname: string): boolean {
  return isIP(normalizeHostname(hostname)) !== 0;
}

/** True when the hostname is exactly allow-listed or matches a hostnameAllowlist pattern. */
function isExplicitlyAllowedBrowserHostname(hostname: string, policy?: SsrfPolicy): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalizeHostnameSet(policy?.allowedHostnames).has(normalized)) return true;
  const allowlist = normalizeHostnameAllowlist(policy?.hostnameAllowlist);
  return allowlist.length > 0 ? matchesHostnameAllowlist(normalized, allowlist) : false;
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
  const ipv4Records = records.filter((entry) => entry.family === 4);
  const automaticRecords = ipv4Records.length > 0 ? ipv4Records : records;
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
    const requestedFamily: number | undefined =
      typeof second === 'number' ? second : typeof opts.family === 'number' ? opts.family : undefined;
    const fallbackPool = requestedFamily === undefined ? automaticRecords : records;
    const candidates =
      requestedFamily === 4 || requestedFamily === 6
        ? records.filter((entry) => entry.family === requestedFamily)
        : fallbackPool;
    const usable = candidates.length > 0 ? candidates : fallbackPool;

    if (opts.all === true) {
      process.nextTick(() => {
        cb(null, usable);
      });
      return;
    }
    const chosen = usable[index % usable.length];
    index += 1;
    process.nextTick(() => {
      cb(null, chosen.address, chosen.family);
    });
  }) as typeof dnsLookupCb;
}

// ── DNS Resolution Cache (short-lived) ──

const DNS_CACHE_TTL_MS = 30_000;
const MAX_DNS_CACHE_SIZE = 100;
const dnsCache = new Map<string, { result: PinnedHostname; expiresAt: number }>();

/**
 * Build a fingerprint of the SSRF policy fields that affect DNS validation.
 * The cache key includes this fingerprint so a permissive-policy result cannot
 * be served to a stricter-policy caller (which would skip the per-address check).
 */
function dnsPolicyFingerprint(policy: SsrfPolicy | undefined): string {
  const allowPrivate = isPrivateNetworkAllowedByPolicy(policy);
  const allowed = normalizeHostnameSet(policy?.allowedHostnames);
  const allowlist = normalizeHostnameAllowlist(policy?.hostnameAllowlist);
  const allowRfc2544 = policy?.allowRfc2544BenchmarkRange === true;
  const allowIpv6Ula = policy?.allowIpv6UniqueLocalRange === true;
  return JSON.stringify([
    allowPrivate,
    allowRfc2544,
    allowIpv6Ula,
    [...allowed].sort(),
    allowlist.sort(),
    normalizeHostnameAllowlist(policy?.blockedHostnames).sort(),
  ]);
}

function dnsCacheKey(hostname: string, policy: SsrfPolicy | undefined): string {
  return `${hostname}\u0000${dnsPolicyFingerprint(policy)}`;
}

function getCachedDnsResult(hostname: string, policy: SsrfPolicy | undefined): PinnedHostname | undefined {
  const key = dnsCacheKey(hostname, policy);
  const entry = dnsCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    dnsCache.delete(key);
    return undefined;
  }
  return entry.result;
}

function cacheDnsResult(hostname: string, policy: SsrfPolicy | undefined, result: PinnedHostname): void {
  const key = dnsCacheKey(hostname, policy);
  dnsCache.set(key, { result, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
  if (dnsCache.size > MAX_DNS_CACHE_SIZE) {
    const first = dnsCache.keys().next();
    if (first.done !== true) dnsCache.delete(first.value);
  }
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
    signal?: AbortSignal;
  } = {},
): Promise<PinnedHostname> {
  params.signal?.throwIfAborted();
  const normalized = normalizeHostname(hostname);
  if (!normalized) throw new InvalidBrowserNavigationUrlError(`Invalid hostname: "${hostname}"`);

  const allowPrivateNetwork = isPrivateNetworkAllowedByPolicy(params.policy);
  const allowedHostnames = normalizeHostnameSet(params.policy?.allowedHostnames);
  const hostnameAllowlist = normalizeHostnameAllowlist(params.policy?.hostnameAllowlist);
  const isExplicitlyAllowed = allowedHostnames.has(normalized);
  const skipPrivateNetworkChecks = allowPrivateNetwork || isExplicitlyAllowed;

  if (
    normalizeHostnameAllowlist(params.policy?.blockedHostnames).some((pattern) =>
      isHostnameAllowedByPattern(normalized, pattern),
    )
  ) {
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: hostname "${hostname}" is in the configured blocklist.`,
    );
  }

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

  // Return cached result if available (avoids redundant DNS lookups in redirect chains).
  // The cache is keyed by policy fingerprint so a permissive-policy result cannot
  // be served to a stricter-policy caller (which would otherwise skip address-level
  // validation and admit private IPs within the TTL window).
  const cached = getCachedDnsResult(normalized, params.policy);
  if (cached) return cached;

  const lookupFn = params.lookupFn ?? dnsLookup;
  let results: { address: string; family: number }[];
  try {
    results = (await runAbortablePreflight(() => lookupFn(normalized, { all: true }), params.signal)) as unknown as {
      address: string;
      family: number;
    }[];
  } catch {
    params.signal?.throwIfAborted();
    throw new InvalidBrowserNavigationUrlError(
      `Navigation to internal/loopback address blocked: unable to resolve "${hostname}". ssrfPolicy.dangerouslyAllowPrivateNetwork is false (strict mode).`,
    );
  }
  params.signal?.throwIfAborted();

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
  } else if (isExplicitlyAllowed && !allowPrivateNetwork) {
    // Private IPs may be allow-listed on purpose; unspecified/metadata/link-local/loopback never are (DNS rebinding).
    const loopbackAllowed = isExplicitLoopbackHostname(normalized);
    for (const r of results) {
      if (isUnspecifiedIpAddressIncludingEmbeddedIpv4(r.address)) {
        throw new InvalidBrowserNavigationUrlError(
          `Navigation blocked: allow-listed hostname "${hostname}" resolves to an unspecified address "${r.address}".`,
        );
      }
      if (!loopbackAllowed && isLoopbackIpAddressIncludingEmbeddedIpv4(r.address)) {
        throw new InvalidBrowserNavigationUrlError(
          `Navigation blocked: allow-listed hostname "${hostname}" resolves to a loopback address "${r.address}".`,
        );
      }
      if (isCloudMetadataOrLinkLocalAddress(r.address)) {
        throw new InvalidBrowserNavigationUrlError(
          `Navigation blocked: allow-listed hostname "${hostname}" resolves to a cloud-metadata/link-local address "${r.address}".`,
        );
      }
      if (isBlockedTrustedResolvedIpv6Address(r.address)) {
        throw new InvalidBrowserNavigationUrlError(
          `Navigation blocked: allow-listed hostname "${hostname}" resolves to a special-use IPv6 address "${r.address}".`,
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

  const pinned: PinnedHostname = {
    hostname: normalized,
    addresses,
    lookup: createPinnedLookup({ hostname: normalized, addresses }),
  };
  cacheDnsResult(normalized, params.policy, pinned);
  return pinned;
}

async function runAbortablePreflight<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await run();
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      // AbortSignal accepts any reason; preserve the caller's cancellation identity.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, run()]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
  opts.signal?.throwIfAborted();
  const rawUrl = opts.url.trim();
  if (rawUrl === '') throw new InvalidBrowserNavigationUrlError('url is required');

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBrowserNavigationUrlError(
      `Invalid URL: "${rawUrl.includes('@') ? '[redacted credential-bearing URL]' : rawUrl}"`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new InvalidBrowserNavigationUrlError(
      'Navigation blocked: URL-embedded credentials are not supported for page navigation. ' +
        'Set HTTP Basic auth with `page.setHttpCredentials()` instead.',
    );
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

  // Fail closed when the browser itself is proxy-routed (launched with --proxy-server etc.):
  // the proxy resolves DNS and egresses, so local address validation cannot enforce the policy.
  if (opts.browserProxyMode === 'explicit-browser-proxy' && !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)) {
    throw new InvalidBrowserNavigationUrlError(
      'Navigation blocked: strict browser SSRF policy cannot be enforced while this browser is proxy-routed',
    );
  }

  if (
    opts.ssrfPolicy?.requireAllowlistedHostnames === true &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) &&
    !isIpLiteralHostname(parsed.hostname) &&
    !isExplicitlyAllowedBrowserHostname(parsed.hostname, opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      'Navigation blocked: ssrfPolicy.requireAllowlistedHostnames requires an IP-literal URL or an allow-listed ' +
        'hostname, because the browser resolves DNS itself and a hostname cannot be protected against rebinding. ' +
        'Add the hostname to ssrfPolicy.allowedHostnames or navigate by IP.',
    );
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
    signal: opts.signal,
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
  if (
    hasWindowsPathAlias(params.rootDir) ||
    hasWindowsPathAlias(params.requestedPath) ||
    (params.defaultFileName !== undefined && hasWindowsPathAlias(params.defaultFileName))
  ) {
    return { ok: false, error: `Path uses a Windows filesystem namespace alias (${params.scopeLabel}).` };
  }
  const root = resolvePathPreservingWindowsRoot(params.rootDir);
  const raw = params.requestedPath.trim();
  const effectivePath =
    raw === '' && params.defaultFileName != null && params.defaultFileName !== '' ? params.defaultFileName : raw;
  if (effectivePath === '') return { ok: false, error: `Empty path is not allowed (${params.scopeLabel}).` };

  const resolved = resolvePathPreservingWindowsRoot(root, effectivePath);
  const rel = relative(root, resolved);
  if (
    hasWindowsPathAlias(root) ||
    hasWindowsPathAlias(resolved) ||
    !rel ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    pathIsAbsolute(rel)
  ) {
    return { ok: false, error: `Path escapes ${params.scopeLabel}: "${params.requestedPath}".` };
  }
  return { ok: true, path: resolved };
}

/**
 * Validate an existing parent and a regular, non-linked target (or missing leaf).
 */
export async function resolveWritablePathWithinRoot(params: {
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
}): Promise<PathResult> {
  const lexical = resolvePathWithinRoot(params);
  if (!lexical.ok) return lexical;

  const root = await realRootOf(params.rootDir);
  const target = lexical.path;
  const canonicalTarget = resolvePathPreservingWindowsRoot(
    root,
    relative(resolvePathPreservingWindowsRoot(params.rootDir), target),
  );
  try {
    await assertConfinedFilePath(root, canonicalTarget, 'leaf');
  } catch (e) {
    return {
      ok: false,
      error: `Cannot stat "${params.requestedPath}" (${params.scopeLabel}): ${(e as Error).message}`,
    };
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
  if (hasWindowsPathAlias(params.rootDir)) {
    return { ok: false, error: `Path uses a Windows filesystem namespace alias (${params.scopeLabel}).` };
  }
  const root = await realRootOf(params.rootDir);
  const resolved: string[] = [];

  for (const raw of params.requestedPaths) {
    const lexical = resolvePathWithinCanonicalRoot(params, root, raw);
    if (!lexical.ok) return lexical;

    try {
      await assertConfinedFilePath(root, lexical.path, 'any');
      const real = await realpath(pathForWindowsFilesystem(lexical.path));
      const rel = relative(root, real);
      if (hasWindowsPathAlias(real) || rel === '..' || rel.startsWith(`..${sep}`) || pathIsAbsolute(rel)) {
        return { ok: false, error: `Path escapes ${params.scopeLabel} via symlink: "${raw}".` };
      }
      resolved.push(real);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          await assertConfinedFilePath(root, lexical.path, 'any');
          resolved.push(lexical.path);
        } catch (validationError) {
          return {
            ok: false,
            error: `Cannot resolve "${raw}" (${params.scopeLabel}): ${(validationError as Error).message}`,
          };
        }
      } else {
        return { ok: false, error: `Cannot resolve "${raw}" (${params.scopeLabel}): ${(e as Error).message}` };
      }
    }
  }

  return { ok: true, paths: resolved };
}

/** Escape checks compare realpath'd files, so the root must be realpath'd too (macOS /tmp -> /private/tmp). */
async function realRootOf(rootDir: string): Promise<string> {
  const lexical = resolvePathPreservingWindowsRoot(rootDir);
  try {
    return await realpath(pathForWindowsFilesystem(lexical));
  } catch {
    return lexical;
  }
}

function resolvePathWithinCanonicalRoot(
  params: { rootDir: string; scopeLabel: string },
  canonicalRoot: string,
  requestedPath: string,
): PathResult {
  const lexical = resolvePathWithinRoot({ ...params, requestedPath });
  if (!lexical.ok) {
    // Existing callers may already use the canonical spelling of an aliased root.
    return resolvePathWithinRoot({ ...params, rootDir: canonicalRoot, requestedPath });
  }
  const lexicalRoot = resolvePathPreservingWindowsRoot(params.rootDir);
  return {
    ok: true,
    path: resolvePathPreservingWindowsRoot(canonicalRoot, relative(lexicalRoot, lexical.path)),
  };
}

/**
 * Same as resolveExistingPathsWithinRoot but missing files are NOT allowed.
 */
export async function resolveStrictExistingPathsWithinRoot(params: {
  rootDir: string;
  requestedPaths: string[];
  scopeLabel: string;
}): Promise<PathsResult> {
  if (hasWindowsPathAlias(params.rootDir)) {
    return { ok: false, error: `Path uses a Windows filesystem namespace alias (${params.scopeLabel}).` };
  }
  const root = await realRootOf(params.rootDir);
  const resolved: string[] = [];

  for (const raw of params.requestedPaths) {
    const lexical = resolvePathWithinCanonicalRoot(params, root, raw);
    if (!lexical.ok) return lexical;

    let real: string;
    try {
      await assertConfinedFilePath(root, lexical.path, 'reject');
      real = await realpath(pathForWindowsFilesystem(lexical.path));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, error: `Path does not exist (${params.scopeLabel}): "${raw}".` };
      }
      return { ok: false, error: `Cannot resolve "${raw}" (${params.scopeLabel}): ${(e as Error).message}` };
    }

    const rel = relative(root, real);
    if (hasWindowsPathAlias(real) || rel === '..' || rel.startsWith(`..${sep}`) || pathIsAbsolute(rel)) {
      return { ok: false, error: `Path escapes ${params.scopeLabel} via symlink: "${raw}".` };
    }

    const stat = await lstat(pathForWindowsFilesystem(real));
    if (stat.isSymbolicLink()) {
      return { ok: false, error: `Path is a symbolic link (${params.scopeLabel}): "${raw}".` };
    }
    if (!stat.isFile()) {
      return { ok: false, error: `Path is not a regular file (${params.scopeLabel}): "${raw}".` };
    }
    if (stat.nlink > 1) {
      return { ok: false, error: `Path is a hardlinked file (${params.scopeLabel}): "${raw}".` };
    }

    resolved.push(real);
  }

  return { ok: true, paths: resolved };
}

// ── Atomic file write utilities ──

/**
 * Build a sibling temp path for atomic writes.
 */
function buildSiblingTempPath(targetPath: string): string {
  const id = randomUUID();
  const prefix = `.browserclaw-output-${id}-`;
  const suffix = '.part';
  const safeTail = fitFileNameToPortableComponent({
    prefix,
    fileName: sanitizeUntrustedFileName(basename(targetPath), 'output.bin'),
    suffix,
  });
  return join(dirname(targetPath), `${prefix}${safeTail}${suffix}`);
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
  const assertNoAlias = (value: string): void => {
    if (hasWindowsPathAlias(value)) throw new Error('Output path uses a Windows filesystem namespace alias');
  };
  assertNoAlias(params.rootDir);
  assertNoAlias(params.targetPath);
  let rootDir: string;
  try {
    rootDir = await realpath(pathForWindowsFilesystem(resolvePathPreservingWindowsRoot(params.rootDir)));
  } catch {
    console.warn(`[browserclaw] writeViaSiblingTempPath: rootDir realpath failed, using lexical resolve`);
    rootDir = resolvePathPreservingWindowsRoot(params.rootDir);
  }
  assertNoAlias(rootDir);
  const requestedTargetPath = resolvePathPreservingWindowsRoot(params.targetPath);
  assertNoAlias(requestedTargetPath);
  const targetPath = await realpath(pathForWindowsFilesystem(dirname(requestedTargetPath)))
    .then((realDir) => join(realDir, basename(requestedTargetPath)))
    .catch(() => requestedTargetPath);
  assertNoAlias(targetPath);

  const relativeTargetPath = relative(rootDir, targetPath);
  if (
    !relativeTargetPath ||
    relativeTargetPath === '..' ||
    relativeTargetPath.startsWith(`..${sep}`) ||
    pathIsAbsolute(relativeTargetPath) ||
    // Windows can host distinct case-sensitive siblings. Both paths above
    // are canonical: a case-folded relative match must not authorize another root.
    (process.platform === 'win32' && resolvePathPreservingWindowsRoot(rootDir, relativeTargetPath) !== targetPath)
  ) {
    throw new Error('Target path is outside the allowed root');
  }

  // Re-check for symlink right before write to narrow the TOCTOU window
  try {
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Unsafe output path: "${params.targetPath}" is a symbolic link.`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
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
  opts.signal?.throwIfAborted();
  const rawUrl = opts.url.trim();
  if (rawUrl === '') return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }

  // Block data: and blob: URLs in post-navigation results — these can be used to exfiltrate data
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
    throw new InvalidBrowserNavigationUrlError(`Navigation result blocked: "${parsed.protocol}" URLs are not allowed.`);
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
  opts.signal?.throwIfAborted();
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  for (const url of [...chain].reverse()) {
    await assertBrowserNavigationAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      signal: opts.signal,
    });
  }
}

/**
 * Returns true if the SSRF policy requires redirect chain inspection.
 * Strict inspection is required only when `dangerouslyAllowPrivateNetwork: false` is explicitly set.
 */
export function requiresInspectableBrowserNavigationRedirects(ssrfPolicy?: SsrfPolicy): boolean {
  return ssrfPolicy?.dangerouslyAllowPrivateNetwork === false;
}

/**
 * Like `requiresInspectableBrowserNavigationRedirects`, but also requires the URL's protocol
 * to be http/https — non-network protocols (file:, about:) never need redirect inspection.
 */
export function requiresInspectableBrowserNavigationRedirectsForUrl(url: string, ssrfPolicy?: SsrfPolicy): boolean {
  if (!requiresInspectableBrowserNavigationRedirects(ssrfPolicy)) return false;
  try {
    const parsed = new URL(url);
    return NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}
