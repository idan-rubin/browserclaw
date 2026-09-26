import { mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_UPLOAD_DIR } from '../security.js';

import { awaitUploadWithAbort, resolveUploadFiles } from './upload-files.js';

describe('upload file resolution', () => {
  let directory: string;
  beforeEach(async () => {
    await mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
    directory = await realpath(await mkdtemp(join(DEFAULT_UPLOAD_DIR, 'payload-test-')));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('preserves local paths by default and sends bytes only with explicit remote opt-in', async () => {
    const path = join(directory, 'report.txt');
    await writeFile(path, 'hello upload');
    expect(await resolveUploadFiles({ paths: [path] })).toEqual([path]);
    const files = await resolveUploadFiles({ paths: [path], browserFilesystemLocal: false });
    expect(files).toEqual([
      {
        name: 'report.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello upload'),
        lastModifiedMs: (await stat(path)).mtimeMs,
      },
    ]);
  });

  it('uses real byte sniffing over a misleading image extension', async () => {
    const path = join(directory, 'image.jpg');
    const png = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082',
      'hex',
    );
    await writeFile(path, png);
    const files = await resolveUploadFiles({ paths: [path], browserFilesystemLocal: false });
    expect(files[0]).toMatchObject({ name: 'image.jpg', mimeType: 'image/png', buffer: png });
  });

  it('rejects the aggregate 50MiB boundary before loading sparse files into memory', async () => {
    const paths = [join(directory, 'one.bin'), join(directory, 'two.bin')];
    for (const path of paths) {
      const file = await open(path, 'w');
      try {
        await file.truncate(25 * 1024 * 1024);
      } finally {
        await file.close();
      }
    }
    await expect(resolveUploadFiles({ paths, browserFilesystemLocal: false })).rejects.toThrow('less than 50 MiB');
    expect(await resolveUploadFiles({ paths })).toEqual(paths);
  });

  it('retains path confinement and cancellation in remote mode', async () => {
    await expect(resolveUploadFiles({ paths: ['/etc/hosts'], browserFilesystemLocal: false })).rejects.toThrow();
    const path = join(directory, 'safe.txt');
    await writeFile(path, 'safe');
    const controller = new AbortController();
    controller.abort(new Error('upload cancelled'));
    await expect(
      resolveUploadFiles({ paths: [path], browserFilesystemLocal: false, signal: controller.signal }),
    ).rejects.toThrow('upload cancelled');
    expect(await resolveUploadFiles({ paths: [path], browserFilesystemLocal: false })).toHaveLength(1);
  });

  it('interrupts a pending acquisition and consumes a late rejection', async () => {
    const controller = new AbortController();
    let rejectWork: (error: Error) => void = () => undefined;
    const work = new Promise<never>((_, reject) => {
      rejectWork = reject;
    });
    const result = awaitUploadWithAbort(work, controller.signal);
    controller.abort(new Error('cancel acquisition'));
    await expect(result).rejects.toThrow('cancel acquisition');
    rejectWork(new Error('late acquisition failure'));
    await Promise.resolve();
  });
});
