import { extname, posix, resolve, win32 } from 'node:path';

const MAX_FILE_NAME_LENGTH = 200;
const INVALID_FILE_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g;
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CLOCK$',
  'CONIN$',
  'CONOUT$',
  ...['COM', 'LPT'].flatMap((prefix) =>
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '¹', '²', '³'].map((suffix) => prefix + suffix),
  ),
]);

function isWindowsSeparator(value: string, offset: number): boolean {
  return value[offset] === '/' || value[offset] === '\\';
}

function hasWindowsDrivePrefix(value: string, offset = 0): boolean {
  const letter = value.charCodeAt(offset) | 0x20;
  return letter >= 0x61 && letter <= 0x7a && value[offset + 1] === ':';
}

function hasWindowsNamespacePrefix(value: string): boolean {
  return (
    (value[2] === '.' || value[2] === '?') &&
    isWindowsSeparator(value, 0) &&
    isWindowsSeparator(value, 1) &&
    isWindowsSeparator(value, 3)
  );
}

function rootedWindowsDriveColonIndex(value: string): number {
  const colon = hasWindowsDrivePrefix(value)
    ? 1
    : hasWindowsNamespacePrefix(value) && hasWindowsDrivePrefix(value, 4)
      ? 5
      : -1;
  return colon >= 0 && isWindowsSeparator(value, colon + 1) ? colon : -1;
}

function windowsSegmentsClimbAbove(segments: string[]): boolean {
  let depth = 0;
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    let parentLike = true;
    for (const character of segment) {
      if (character !== '.' && character !== ' ') {
        parentLike = false;
        break;
      }
    }
    depth += parentLike ? -1 : 1;
    if (depth < 0) return true;
  }
  return false;
}

function asciiLowercase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0x20));
}

function trimWindowsTrailingSeparators(value: string, minimumLength: number): string {
  let end = value.length;
  while (end > minimumLength && value[end - 1] === '\\') end--;
  return value.slice(0, end);
}

function windowsShareOrDeviceRoot(value: string): string | undefined | null {
  if (!isWindowsSeparator(value, 0) || !isWindowsSeparator(value, 1)) return;
  const spelled = value.replaceAll('/', '\\');
  if (!hasWindowsNamespacePrefix(spelled))
    return asciiLowercase(trimWindowsTrailingSeparators(win32.parse(spelled).root, 0));
  const segments = spelled.slice(4).split('\\');
  const head = asciiLowercase(segments[0] ?? '');
  const authority = head === 'unc' ? segments.slice(0, 3) : segments.slice(0, 1);
  if (
    head === 'globalroot' ||
    head === 'global' ||
    authority.length < (head === 'unc' ? 3 : 1) ||
    authority.some((segment) => segment === '' || /[. ]$/.test(segment)) ||
    windowsSegmentsClimbAbove(segments.slice(authority.length))
  )
    return null;
  if (rootedWindowsDriveColonIndex(value) === 5) return;
  return asciiLowercase(
    head === 'unc' ? `\\\\${authority[1]}\\${authority[2]}` : `${spelled.slice(0, 4)}${authority[0]}`,
  );
}

function isExactlyUnderWindowsPath(trusted: string, value: string): boolean {
  const root = trimWindowsTrailingSeparators(trusted.replaceAll('/', '\\'), 1);
  const candidate = value.replaceAll('/', '\\');
  if (candidate !== root && !candidate.startsWith(root.endsWith('\\') ? root : `${root}\\`)) return false;
  return !windowsSegmentsClimbAbove(candidate.slice(root.length).split('\\'));
}

/** Reject foreign Windows shares before even metadata access can contact their hosts. */
export function isForeignWindowsShareOrDevicePath(
  value: string,
  trustedPaths: string[],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  const key = windowsShareOrDeviceRoot(value);
  if (key === undefined) return false;
  return !trustedPaths.some(
    (trusted) =>
      (key !== null && windowsShareOrDeviceRoot(trusted) === key) || isExactlyUnderWindowsPath(trusted, value),
  );
}

/** Reject alternate data streams and drive-relative aliases only on Windows. */
export function hasWindowsPathAlias(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'win32') return false;
  const firstColon = value.indexOf(':');
  return (
    firstColon !== -1 && (firstColon !== rootedWindowsDriveColonIndex(value) || value.includes(':', firstColon + 1))
  );
}

function isBareWindowsNamespaceDrive(value: string): boolean {
  return value.length === 6 && hasWindowsNamespacePrefix(value) && hasWindowsDrivePrefix(value, 4);
}

/** Node may strip the root separator from an admitted namespaced drive root. */
export function resolvePathPreservingWindowsRoot(base: string, ...segments: string[]): string {
  if (
    process.platform === 'win32' &&
    segments.length === 0 &&
    base.length === 7 &&
    rootedWindowsDriveColonIndex(base) === 5
  ) {
    return base.replaceAll('/', '\\');
  }
  const resolved = resolve(base, ...segments);
  if (
    process.platform === 'win32' &&
    isBareWindowsNamespaceDrive(resolved) &&
    !hasWindowsPathAlias(base) &&
    !segments.some((segment) => hasWindowsPathAlias(segment))
  )
    return `${resolved}\\`;
  return resolved;
}

/** Node's Windows filesystem layer drops the separator from namespaced drive roots. */
export function pathForWindowsFilesystem(value: string): string {
  if (process.platform !== 'win32' || rootedWindowsDriveColonIndex(value) !== 5) return value;
  if (value.length === 7) return `${value[4]}:\\`;
  const resolved = resolve(value);
  return isBareWindowsNamespaceDrive(resolved) && !hasWindowsPathAlias(value) ? `${resolved[4]}:\\` : value;
}

function truncateFileName(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const truncated = value.slice(0, limit);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

function suffixWindowsReservedDeviceName(fileName: string): string {
  const extensionIndex = fileName.indexOf('.');
  const stemEnd = extensionIndex < 0 ? fileName.length : extensionIndex;
  let deviceEnd = stemEnd;
  while (deviceEnd > 0 && (fileName[deviceEnd - 1] === ' ' || fileName[deviceEnd - 1] === '.')) deviceEnd--;
  if (!WINDOWS_RESERVED_DEVICE_NAMES.has(fileName.slice(0, deviceEnd).toUpperCase())) return fileName;
  return `${fileName.slice(0, stemEnd)}_${fileName.slice(stemEnd)}`;
}

function sanitizeFileNameCandidate(fileName: string): string | undefined {
  let base = fileName.trim();
  if (base.includes('/')) base = posix.basename(base);
  if (base.includes('\\') || hasWindowsDrivePrefix(base)) base = win32.basename(base);
  base = base.replace(INVALID_FILE_NAME_CHARACTERS, '').trim();
  if (!base || base === '.' || base === '..') return;
  base = truncateFileName(base, MAX_FILE_NAME_LENGTH);
  const safeBase = suffixWindowsReservedDeviceName(base);
  // The safety suffix must survive the length cap, even for padded device names.
  return safeBase.length > MAX_FILE_NAME_LENGTH
    ? suffixWindowsReservedDeviceName(truncateFileName(base, MAX_FILE_NAME_LENGTH - 1))
    : safeBase;
}

export function sanitizeUntrustedFileName(fileName: string, fallbackName: string): string {
  return sanitizeFileNameCandidate(fileName) ?? sanitizeFileNameCandidate(fallbackName) ?? 'file';
}

function maxNormalizedUtf8Bytes(value: string): number {
  return Math.max(
    Buffer.byteLength(value, 'utf8'),
    Buffer.byteLength(value.normalize('NFC'), 'utf8'),
    Buffer.byteLength(value.normalize('NFD'), 'utf8'),
  );
}

/** Fit the whole temporary component, preserving an extension when space permits. */
export function fitFileNameToPortableComponent(params: { prefix: string; fileName: string; suffix: string }): string {
  const limit = 255;
  if (maxNormalizedUtf8Bytes(`${params.prefix}${params.fileName}${params.suffix}`) <= limit) return params.fileName;
  if (maxNormalizedUtf8Bytes(`${params.prefix}${params.suffix}`) > limit) return params.fileName;
  const extension = extname(params.fileName);
  const tail = maxNormalizedUtf8Bytes(`${params.prefix}${extension}${params.suffix}`) <= limit ? extension : '';
  const stem = tail === '' ? params.fileName : params.fileName.slice(0, -tail.length);
  const points = Array.from(stem);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    const candidate = `${params.prefix}${points.slice(0, length).join('')}${tail}${params.suffix}`;
    if (maxNormalizedUtf8Bytes(candidate) <= limit) low = length;
    else high = length - 1;
  }
  return `${points.slice(0, low).join('')}${tail}`;
}
