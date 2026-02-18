import { resolve, normalize, sep } from 'node:path';
import { lookup } from 'node:dns/promises';

/**
 * Validate that an output file path is safe — no directory traversal or escape.
 * Rejects paths containing `..` segments or relative paths that could escape
 * the intended output directory.
 *
 * @param path - The output path to validate
 * @param allowedRoots - Optional list of allowed root directories. If provided,
 *   the resolved path must be within one of these roots.
 * @throws If the path is unsafe
 */
export function assertSafeOutputPath(path: string, allowedRoots?: string[]): void {
  if (!path || typeof path !== 'string') {
    throw new Error('Output path is required.');
  }

  const normalized = normalize(path);

  // Reject paths with traversal segments
  if (normalized.includes('..')) {
    throw new Error(`Unsafe output path: directory traversal detected in "${path}".`);
  }

  // If allowed roots are specified, resolved path must be within one of them
  if (allowedRoots?.length) {
    const resolved = resolve(normalized);
    const withinRoot = allowedRoots.some(root => {
      const normalizedRoot = resolve(root);
      return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep);
    });
    if (!withinRoot) {
      throw new Error(`Unsafe output path: "${path}" is outside allowed directories.`);
    }
  }
}

/**
 * Expand an IPv6 address (with optional :: abbreviation) to full 8-group
 * colon-separated hex form. Returns null for invalid input.
 */
function expandIPv6(ip: string): string | null {
  let normalized = ip;

  // Handle embedded IPv4 literal at end (e.g., 64:ff9b::192.168.1.1)
  const v4Match = normalized.match(/^(.+:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4Match) {
    const octets = v4Match[2].split('.').map(Number);
    if (octets.some(o => o > 255)) return null;
    const hexHi = ((octets[0] << 8) | octets[1]).toString(16).padStart(4, '0');
    const hexLo = ((octets[2] << 8) | octets[3]).toString(16).padStart(4, '0');
    normalized = v4Match[1] + hexHi + ':' + hexLo;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;  // multiple :: is invalid

  if (halves.length === 2) {
    const left = halves[0] !== '' ? halves[0].split(':') : [];
    const right = halves[1] !== '' ? halves[1].split(':') : [];
    const needed = 8 - left.length - right.length;
    if (needed < 0) return null;
    const groups = [...left, ...Array(needed).fill('0'), ...right];
    if (groups.length !== 8) return null;
    return groups.map(g => g.padStart(4, '0')).join(':');
  }

  const groups = normalized.split(':');
  if (groups.length !== 8) return null;
  return groups.map(g => g.padStart(4, '0')).join(':');
}

/**
 * Convert two 16-bit hex group strings to a dotted-decimal IPv4 string.
 */
function hexToIPv4(hiHex: string, loHex: string): string {
  const hi = parseInt(hiHex, 16);
  const lo = parseInt(loHex, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/**
 * Attempt to extract an IPv4 address embedded in an IPv6 transition address.
 * Handles: IPv4-mapped (::ffff:), NAT64 (64:ff9b::/96, 64:ff9b:1::/48),
 * 6to4 (2002::/16), and Teredo (2001:0000::/32).
 *
 * Returns:
 *   - The embedded IPv4 string if found
 *   - null if the address is not a known transition format
 *   - '' (empty string) on parse error — callers MUST treat this as internal (fail closed)
 */
function extractEmbeddedIPv4(lower: string): string | null {
  // IPv4-mapped: ::ffff:a.b.c.d (most common transition form)
  if (lower.startsWith('::ffff:')) {
    return lower.slice(7);
  }

  // For NAT64, 6to4, and Teredo we need to fully expand the address
  const expanded = expandIPv6(lower);
  if (expanded === null) return '';  // fail closed on invalid IPv6

  const groups = expanded.split(':');
  if (groups.length !== 8) return '';  // fail closed

  // NAT64 well-known prefix: 64:ff9b::/96
  // Expanded form: 0064:ff9b:0000:0000:0000:0000:wwxx:yyzz → IPv4 = ww.xx.yy.zz
  if (
    groups[0] === '0064' && groups[1] === 'ff9b' &&
    groups[2] === '0000' && groups[3] === '0000' &&
    groups[4] === '0000' && groups[5] === '0000'
  ) {
    return hexToIPv4(groups[6], groups[7]);
  }

  // NAT64 local-use prefix: 64:ff9b:1::/48
  // Expanded form: 0064:ff9b:0001:xxxx:xxxx:xxxx:wwxx:yyzz → IPv4 = ww.xx.yy.zz
  if (groups[0] === '0064' && groups[1] === 'ff9b' && groups[2] === '0001') {
    return hexToIPv4(groups[6], groups[7]);
  }

  // 6to4 prefix: 2002::/16
  // Expanded form: 2002:aabb:ccdd:xxxx:xxxx:xxxx:xxxx:xxxx → IPv4 = aa.bb.cc.dd
  if (groups[0] === '2002') {
    return hexToIPv4(groups[1], groups[2]);
  }

  // Teredo prefix: 2001:0000::/32
  // Expanded form: 2001:0000:...:...:...:...:~ww~xx:~yy~zz
  // Client IPv4 is in the last 32 bits XOR'd with 0xFFFFFFFF
  if (groups[0] === '2001' && groups[1] === '0000') {
    const hiXored = (parseInt(groups[6], 16) ^ 0xffff).toString(16).padStart(4, '0');
    const loXored = (parseInt(groups[7], 16) ^ 0xffff).toString(16).padStart(4, '0');
    return hexToIPv4(hiXored, loXored);
  }

  return null;  // not a known transition format
}

/**
 * Check whether an IP address string is internal/private/loopback.
 */
function isInternalIP(ip: string): boolean {
  // IPv4
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  if (ip === '0.0.0.0') return true;

  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fe80:')) return true;  // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;  // ULA

  // IPv6 transition addresses: NAT64, 6to4, Teredo, IPv4-mapped
  const embedded = extractEmbeddedIPv4(lower);
  if (embedded !== null) {
    if (embedded === '') return true;  // parse error — fail closed
    return isInternalIP(embedded);
  }

  return false;
}

/**
 * Check whether a URL targets a loopback or private/internal network address.
 * Synchronous hostname-based check. Used to prevent SSRF attacks.
 */
export function isInternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Fail closed: treat unparseable URLs as internal/blocked
    return true;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Direct hostname checks
  // Note: URL.hostname strips IPv6 brackets, so [::1] becomes ::1
  if (hostname === 'localhost') return true;

  // Check if hostname is an IP literal
  if (isInternalIP(hostname)) return true;

  // .local, .internal, .localhost TLDs
  if (hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.localhost')) {
    return true;
  }

  return false;
}

/**
 * Async version that also resolves DNS to catch rebinding attacks
 * where a public hostname resolves to an internal IP.
 */
export async function isInternalUrlResolved(url: string): Promise<boolean> {
  // First do the fast synchronous check
  if (isInternalUrl(url)) return true;

  // Then resolve DNS to catch rebinding
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }

  try {
    const { address } = await lookup(parsed.hostname);
    if (isInternalIP(address)) return true;
  } catch {
    // DNS resolution failed — fail closed
    return true;
  }

  return false;
}
