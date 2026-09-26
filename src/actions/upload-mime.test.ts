import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sniff: vi.fn() }));
vi.mock('file-type', () => ({ fileTypeFromBuffer: mocks.sniff }));
import { detectUploadMime } from './upload-mime.js';

describe('bounded upload MIME inference', () => {
  it('limits dependency sniffing to 1MiB and keeps the original buffer intact', async () => {
    mocks.sniff.mockResolvedValue({ mime: 'image/png' });
    const buffer = Buffer.alloc(2 * 1024 * 1024, 7);
    expect(await detectUploadMime(buffer, 'misleading.jpg')).toBe('image/png');
    expect(mocks.sniff.mock.lastCall?.[0]).toHaveLength(1024 * 1024);
    expect(buffer).toHaveLength(2 * 1024 * 1024);
  });

  it('uses ZIP document hints but does not disguise a ZIP as an image', async () => {
    mocks.sniff.mockResolvedValue({ mime: 'application/zip' });
    expect(await detectUploadMime(Buffer.from('zip'), 'document.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(await detectUploadMime(Buffer.from('zip'), 'image.png')).toBe('application/zip');
  });

  it('preserves audio container hints and falls back for unsupported formats', async () => {
    mocks.sniff.mockResolvedValue({ mime: 'video/mp4' });
    expect(await detectUploadMime(Buffer.from('mp4'), 'audio.m4a')).toBe('audio/x-m4a');
    mocks.sniff.mockRejectedValue(new Error('short input'));
    expect(await detectUploadMime(Buffer.from('text'), 'settings.yml')).toBe('application/yaml');
    expect(await detectUploadMime(Buffer.from('caff'), 'recording.unknown')).toBe('audio/x-caf');
    expect(await detectUploadMime(Buffer.from('unknown'), 'unknown.bin')).toBe('application/octet-stream');
  });
});
