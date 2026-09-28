import { chmod, link, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  resolveExistingPathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
  resolveWritablePathWithinRoot,
} from './security.js';

let workspace: string;
let root: string;
let outside: string;

beforeEach(async () => {
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'bc-confinement-')));
  root = join(workspace, 'root');
  outside = join(workspace, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(join(root, 'file.txt'), 'allowed');
  await writeFile(join(outside, 'secret.txt'), 'outside');
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const resolvers = {
  writable: (rootDir: string, requestedPath: string) =>
    resolveWritablePathWithinRoot({ rootDir, requestedPath, scopeLabel: 'fixture' }),
  existing: (rootDir: string, requestedPath: string) =>
    resolveExistingPathsWithinRoot({ rootDir, requestedPaths: [requestedPath], scopeLabel: 'fixture' }),
  strict: (rootDir: string, requestedPath: string) =>
    resolveStrictExistingPathsWithinRoot({ rootDir, requestedPaths: [requestedPath], scopeLabel: 'fixture' }),
};

describe.each(Object.entries(resolvers))('%s confined paths', (_name, resolve) => {
  it('accepts a regular file and preserves canonical user-root aliases', async () => {
    expect((await resolve(root, 'file.txt')).ok).toBe(true);
    const alias = join(workspace, 'root-alias');
    await symlink(root, alias);
    expect((await resolve(alias, 'file.txt')).ok).toBe(true);
    expect((await resolve(alias, join(alias, 'file.txt'))).ok).toBe(true);
    expect((await resolve(alias, join(root, 'file.txt'))).ok).toBe(_name !== 'writable');
  });

  it('rejects directories as file targets', async () => {
    await mkdir(join(root, 'directory'));
    expect((await resolve(root, 'directory')).ok).toBe(false);
  });

  it('rejects a final symlink even when its referent is inside the root', async () => {
    await symlink(join(root, 'file.txt'), join(root, 'linked.txt'));
    expect((await resolve(root, 'linked.txt')).ok).toBe(false);
    expect((await resolve(root, 'file.txt')).ok).toBe(true);
    const alias = join(workspace, 'root-alias');
    await symlink(root, alias);
    expect((await resolve(alias, join(alias, 'linked.txt'))).ok).toBe(false);
  });

  it('rejects hardlinked files, then accepts the same inode after the alias is removed', async () => {
    await link(join(root, 'file.txt'), join(outside, 'alias.txt'));
    expect((await resolve(root, 'file.txt')).ok).toBe(false);
    await unlink(join(outside, 'alias.txt'));
    expect((await resolve(root, 'file.txt')).ok).toBe(true);
  });

  it('rejects a traversed directory symlink and a missing intermediate escape', async () => {
    await symlink(outside, join(root, 'escape'));
    expect((await resolve(root, 'escape/secret.txt')).ok).toBe(false);
    expect((await resolve(root, 'escape/missing/leaf.txt')).ok).toBe(false);
  });

  it('rejects a non-directory ancestor instead of treating it as missing', async () => {
    expect((await resolve(root, 'file.txt/missing/leaf.txt')).ok).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)('rejects inaccessible existing ancestors', async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o000);
    try {
      expect((await resolve(root, 'locked/missing/leaf.txt')).ok).toBe(false);
    } finally {
      await chmod(locked, 0o700);
    }
  });
});

describe('missing confined paths', () => {
  it('allows a missing leaf for writable and existing resolvers, but not strict reads', async () => {
    expect((await resolvers.writable(root, 'new.txt')).ok).toBe(true);
    expect((await resolvers.existing(root, 'new.txt')).ok).toBe(true);
    expect((await resolvers.strict(root, 'new.txt')).ok).toBe(false);
  });

  it('allows missing intermediate directories only for the existing-path fallback', async () => {
    expect((await resolvers.existing(root, 'missing/subdir/new.txt')).ok).toBe(true);
    expect((await resolvers.writable(root, 'missing/subdir/new.txt')).ok).toBe(false);
    expect((await resolvers.strict(root, 'missing/subdir/new.txt')).ok).toBe(false);
    const alias = join(workspace, 'root-alias');
    await symlink(root, alias);
    expect((await resolvers.existing(alias, join(alias, 'missing/subdir/new.txt'))).ok).toBe(true);
    expect((await resolvers.existing(alias, join(outside, 'missing/subdir/new.txt'))).ok).toBe(false);
  });

  it('requires a directory root', async () => {
    for (const resolve of Object.values(resolvers)) {
      expect((await resolve(join(root, 'file.txt'), 'new.txt')).ok).toBe(false);
    }
  });
});
