import { extname } from 'node:path';

const SNIFF_MAX_BYTES = 1024 * 1024;
const MIME_BY_EXTENSION: Readonly<Partial<Record<string, string>>> = {
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.aifc': 'audio/aiff',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m2a': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
  '.opus': 'audio/opus',
  '.m4a': 'audio/x-m4a',
  '.m4b': 'audio/mp4',
  '.caf': 'audio/x-caf',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.xls': 'application/vnd.ms-excel',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'text/xml',
  '.css': 'text/css',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.ini': 'text/plain',
  '.js': 'text/javascript',
  '.log': 'text/plain',
  '.tsv': 'text/tab-separated-values',
};
const MIME_SYNONYMS: Readonly<Partial<Record<string, string>>> = {
  'image/apng': 'image/png',
  'text/yaml': 'application/yaml',
  'application/x-yaml': 'application/yaml',
  'application/xml': 'text/xml',
  'video/vnd.avi': 'video/x-msvideo',
  'video/matroska': 'video/x-matroska',
};

/** Bytes win over extensions, except useful ZIP/opaque container and ambiguous audio hints. */
export async function detectUploadMime(buffer: Buffer, filePath: string): Promise<string> {
  const extensionMime = MIME_BY_EXTENSION[extname(filePath).toLowerCase()];
  let sniffed: string | undefined;
  try {
    const { fileTypeFromBuffer } = await import('file-type');
    const detected = await fileTypeFromBuffer(buffer.subarray(0, SNIFF_MAX_BYTES));
    if (detected) sniffed = MIME_SYNONYMS[detected.mime] ?? detected.mime;
  } catch {
    // Truncated/unsupported formats fall back to the filename, not failed uploads.
  }
  if (sniffed === undefined && buffer.toString('ascii', 0, 4) === 'caff') sniffed = 'audio/x-caf';
  let inferred = sniffed ?? extensionMime;
  if (
    sniffed === 'application/zip' &&
    extensionMime?.startsWith('application/vnd.openxmlformats-officedocument.') === true
  ) {
    inferred = extensionMime;
  } else if (
    sniffed === 'application/octet-stream' &&
    extensionMime !== undefined &&
    !extensionMime.startsWith('image/')
  ) {
    inferred = extensionMime;
  }
  if (inferred === 'video/mp4' && (extensionMime === 'audio/x-m4a' || extensionMime === 'audio/mp4'))
    return extensionMime;
  return inferred ?? 'application/octet-stream';
}
