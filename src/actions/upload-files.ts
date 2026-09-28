import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { DEFAULT_UPLOAD_DIR, resolveStrictExistingPathsWithinRoot } from '../security.js';

import { detectUploadMime } from './upload-mime.js';

export interface UploadOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Set false to send local file bytes to a browser on another filesystem. Defaults to true. */
  browserFilesystemLocal?: boolean;
}

export interface UploadFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
  lastModifiedMs: number;
}

const PAYLOAD_LIMIT_BYTES = 50 * 1024 * 1024;

async function readPayloadFile(
  path: string,
  remainingBytes: number,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; lastModifiedMs: number }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink > 1)
      throw new Error('Upload path is no longer a single-link regular file.');
    if (metadata.size >= remainingBytes) throw new Error('Remote upload payloads must total less than 50 MiB.');
    // One extra byte detects growth without allowing a post-stat writer to allocate an unbounded payload.
    const buffer = Buffer.alloc(metadata.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, offset, Math.min(1024 * 1024, buffer.length - offset), offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== metadata.size) throw new Error('Upload file changed while its payload was being read; retry.');
    return { buffer: buffer.subarray(0, offset), lastModifiedMs: metadata.mtimeMs };
  } finally {
    await file.close();
  }
}

async function toFilePayloads(paths: string[], signal?: AbortSignal): Promise<UploadFilePayload[]> {
  const stats = await Promise.all(paths.map((path) => stat(path)));
  if (stats.reduce((sum, entry) => sum + entry.size, 0) >= PAYLOAD_LIMIT_BYTES) {
    throw new Error('Remote upload payloads must total less than 50 MiB.');
  }
  const payloads: UploadFilePayload[] = [];
  let bytesRead = 0;
  for (const path of paths) {
    signal?.throwIfAborted();
    const { buffer, lastModifiedMs } = await readPayloadFile(path, PAYLOAD_LIMIT_BYTES - bytesRead, signal);
    bytesRead += buffer.length;
    if (bytesRead >= PAYLOAD_LIMIT_BYTES) throw new Error('Remote upload payloads must total less than 50 MiB.');
    const mimeType = await detectUploadMime(buffer, path);
    signal?.throwIfAborted();
    payloads.push({ name: basename(path), mimeType, buffer, lastModifiedMs });
  }
  return payloads;
}

export async function resolveUploadFiles(
  opts: UploadOptions & { paths: string[] },
): Promise<string[] | UploadFilePayload[]> {
  opts.signal?.throwIfAborted();
  const operation = (async () => {
    const resolved = await resolveStrictExistingPathsWithinRoot({
      rootDir: DEFAULT_UPLOAD_DIR,
      requestedPaths: opts.paths,
      scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
    });
    opts.signal?.throwIfAborted();
    if (!resolved.ok) throw new Error(resolved.error);
    return opts.browserFilesystemLocal === false ? await toFilePayloads(resolved.paths, opts.signal) : resolved.paths;
  })();
  return await awaitUploadWithAbort(operation, opts.signal);
}

export async function awaitUploadWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await operation;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('Upload cancelled', { cause: reason }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
