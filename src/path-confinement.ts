import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import { hasWindowsPathAlias, pathForWindowsFilesystem } from './file-safety.js';

function assertCanonicalContainment(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (hasWindowsPathAlias(candidate) || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Path escapes root via symlink');
  }
}

/** Path validation is not an open-file capability: callers still reopen the returned filename. */
export async function assertConfinedFilePath(
  root: string,
  target: string,
  missing: 'reject' | 'leaf' | 'any',
): Promise<void> {
  assertCanonicalContainment(root, target);
  const rootStat = await lstat(pathForWindowsFilesystem(root));
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Root is not a directory');
  assertCanonicalContainment(root, await realpath(pathForWindowsFilesystem(root)));

  const segments = relative(root, target).split(sep);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const final = index === segments.length - 1;
    let stat;
    try {
      stat = await lstat(pathForWindowsFilesystem(current));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (missing === 'any' || (missing === 'leaf' && final)) return;
      throw new Error('Path does not exist');
    }
    if (stat.isSymbolicLink()) throw new Error('Path contains a symbolic link (symlink)');
    if (!final && !stat.isDirectory()) throw new Error('Path ancestor is not a directory');
    if (final && !stat.isFile()) throw new Error('Path is not a regular file');
    if (final && stat.nlink > 1) throw new Error('Path is a hardlinked file');
    assertCanonicalContainment(root, await realpath(pathForWindowsFilesystem(current)));
  }
}
