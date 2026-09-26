import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hasWindowsPathAlias, pathForWindowsFilesystem } from './file-safety.js';

function identityChanged(): Error {
  return new Error('Chrome profile JSON staging identity changed');
}

/** Preserve every observed identity bit, including partially known Windows receipts. */
function inspectIdentity(inspect: () => fs.BigIntStats, expected?: fs.BigIntStats): fs.BigIntStats {
  let knownDev = expected?.dev;
  let knownIno = expected?.ino;
  if (
    expected &&
    (typeof knownDev !== 'bigint' ||
      typeof knownIno !== 'bigint' ||
      (process.platform === 'win32' && (knownDev === 0n || knownIno === 0n)))
  )
    throw identityChanged();
  for (let attempt = 0; attempt < 2; attempt++) {
    const stat = inspect();
    if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') throw identityChanged();
    let complete = true;
    if (process.platform === 'win32' && stat.dev === 0n) complete = false;
    else {
      if (knownDev !== undefined && knownDev !== stat.dev) throw identityChanged();
      knownDev = stat.dev;
    }
    if (process.platform === 'win32' && stat.ino === 0n) complete = false;
    else {
      if (knownIno !== undefined && knownIno !== stat.ino) throw identityChanged();
      knownIno = stat.ino;
    }
    if (complete) return stat;
  }
  throw identityChanged();
}

function assertRegularFile(stat: fs.BigIntStats): fs.BigIntStats {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Chrome profile JSON must be a regular file');
  return stat;
}

function isUnsafeProfileReadPath(filePath: string): boolean {
  if (process.platform === 'win32') {
    const normalized = filePath.replaceAll('/', '\\');
    if (normalized.startsWith('\\\\.\\') || /^\\\\\?\\GLOBALROOT\\Device\\/i.test(normalized)) return true;
    let end = normalized.length;
    while (end > 0 && normalized[end - 1] === '\\') end--;
    const basename = normalized.slice(0, end).slice(normalized.slice(0, end).lastIndexOf('\\') + 1);
    let stem = basename.split(/[.:]/, 1)[0];
    while (stem.endsWith(' ') || stem.endsWith('.')) stem = stem.slice(0, -1);
    return /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|(?:COM|LPT)[1-9¹²³])$/i.test(stem);
  }
  const normalized = path.resolve(filePath);
  return (
    /^\/dev\/(?:zero|random|urandom|full|stdin|stdout|stderr|tty|console)$/.test(normalized) ||
    normalized === '/dev/fd' ||
    normalized.startsWith('/dev/fd/') ||
    /^\/proc\/(?:self|thread-self|\d+)\/fd(?:\/|$)/.test(normalized)
  );
}

/** Read profile objects through the admitted descriptor; malformed or unsafe files remain a cache miss. */
export function readProfileJson(filePath: string): Record<string, unknown> | null {
  try {
    if (hasWindowsPathAlias(filePath) || isUnsafeProfileReadPath(filePath)) return null;
    const before = inspectIdentity(() => assertRegularFile(fs.lstatSync(filePath, { bigint: true })));
    const constants: Partial<typeof fs.constants> = fs.constants;
    const flags =
      fs.constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const fd = fs.openSync(filePath, flags);
    try {
      const opened = inspectIdentity(() => assertRegularFile(fs.fstatSync(fd, { bigint: true })), before);
      inspectIdentity(() => assertRegularFile(fs.lstatSync(filePath, { bigint: true })), opened);
      const parsed: unknown = JSON.parse(fs.readFileSync(fd).toString('utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function admitProfilePath(value: string): string {
  let admitted = value;
  if (process.platform === 'win32' && !path.isAbsolute(value) && /^[a-z]:/i.test(value)) {
    admitted = `${path.resolve(value.slice(0, 2))}${path.sep}${value.slice(2)}`;
  }
  if (hasWindowsPathAlias(admitted)) throw new Error('Chrome profile path uses a Windows filesystem namespace alias');
  return admitted;
}

function trySyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(pathForWindowsFilesystem(directory), 'r');
    fs.fsyncSync(fd);
  } catch {
    // Some platforms/filesystems do not support syncing directories.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* Directory descriptor cleanup is best effort. */
      }
    }
  }
}

/** Atomically replace a profile document without exposing partially written JSON. */
export function writeProfileJson(pathname: string, data: Record<string, unknown>): void {
  const filePath = admitProfilePath(pathname);
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  const directory = path.dirname(filePath);
  fs.mkdirSync(pathForWindowsFilesystem(directory), { recursive: true, mode: 0o700 });
  // Preserve literal parents so staging and publication follow the same symlinks.
  const stagingPath = path.format({ ...path.parse(filePath), base: `.browserclaw-profile-${randomUUID()}.tmp` });
  const fd = fs.openSync(stagingPath, 'wx', 0o600);
  let identity: fs.BigIntStats | undefined;
  const ownsPath = (candidate: string): boolean => {
    if (!identity) return false;
    try {
      const actual = inspectIdentity(() => assertRegularFile(fs.lstatSync(candidate, { bigint: true })), identity);
      return actual.nlink === 1n;
    } catch {
      return false;
    }
  };
  const assertOwned = (candidate: string): void => {
    const opened = inspectIdentity(() => assertRegularFile(fs.fstatSync(fd, { bigint: true })), identity);
    if (opened.nlink > 1n) throw identityChanged();
    if (!ownsPath(candidate)) throw new Error('Chrome profile JSON staging identity changed');
  };
  try {
    identity = inspectIdentity(() => fs.fstatSync(fd, { bigint: true }));
    fs.writeFileSync(fd, payload);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    assertOwned(stagingPath);
    // A failed atomic replacement must leave the old profile document intact.
    fs.renameSync(stagingPath, filePath);
    assertOwned(filePath);
    trySyncDirectory(directory);
    assertOwned(filePath);
  } finally {
    try {
      if (ownsPath(stagingPath)) fs.unlinkSync(stagingPath);
    } finally {
      fs.closeSync(fd);
    }
  }
}
