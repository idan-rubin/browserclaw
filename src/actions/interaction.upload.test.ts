import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Connection from '../connection.js';

import { armFileUploadViaPlaywright, setInputFilesViaPlaywright, uploadViaPlaywright } from './interaction.js';
import type * as UploadFiles from './upload-files.js';

const mocks = vi.hoisted(() => ({ page: vi.fn(), restored: vi.fn(), locator: vi.fn(), files: vi.fn() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof Connection>()),
  getPageForTargetId: mocks.page,
  getRestoredPageForTarget: mocks.restored,
  refLocator: mocks.locator,
}));
vi.mock('./upload-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof UploadFiles>()),
  resolveUploadFiles: mocks.files,
}));
vi.mock('./navigation.js', () => ({
  assertInteractionNavigationCompletedSafely: (opts: { action: () => Promise<unknown> }) => opts.action(),
}));

function fixture() {
  const events: string[] = [];
  const setFiles = vi.fn().mockResolvedValue(undefined);
  const chooser = { setFiles, element: () => null };
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, {
    url: () => 'about:blank',
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
    waitForEvent: (_name: string, opts: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        events.push('listener');
        const cleanup = () => {
          emitter.off('filechooser', complete);
          opts.signal.removeEventListener('abort', abort);
        };
        const complete = () => {
          cleanup();
          resolve(chooser);
        };
        const abort = () => {
          cleanup();
          reject(new Error('chooser cancelled'));
        };
        emitter.once('filechooser', complete);
        opts.signal.addEventListener('abort', abort, { once: true });
      }),
  });
  const click = vi.fn(() => {
    events.push('click');
    expect(emitter.listenerCount('filechooser')).toBe(1);
    emitter.emit('filechooser');
    return Promise.resolve();
  });
  mocks.page.mockResolvedValue(page as unknown as Page);
  mocks.locator.mockReturnValue({ click });
  mocks.files.mockResolvedValue(['/validated/file.txt']);
  return { events, setFiles, emitter, click, page };
}

describe('atomic upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['ordinary', 'unrelated abort', 'matching abort'] as const)(
    'preserves direct file setter errors during cancellation: %s',
    async (kind) => {
      const control = fixture();
      const controller = new AbortController();
      const reason = new Error('caller cancelled');
      const error = new Error('native file setter failed', {
        cause: kind === 'matching abort' ? reason : new Error('other'),
      });
      if (kind !== 'ordinary') error.name = 'AbortError';
      const elementHandle = vi.fn();
      mocks.restored.mockResolvedValue(control.page);
      mocks.locator.mockReturnValue({
        setInputFiles: () => {
          controller.abort(reason);
          return Promise.reject(error);
        },
        elementHandle,
      });
      await expect(
        setInputFilesViaPlaywright({ cdpUrl: 'test', ref: 'e1', paths: ['file.txt'], signal: controller.signal }),
      ).rejects.toBe(kind === 'matching abort' ? reason : error);
      expect(elementHandle).not.toHaveBeenCalled();
    },
  );

  it('registers the chooser before clicking and reuses its page for the entire operation', async () => {
    const control = fixture();
    await uploadViaPlaywright({ cdpUrl: 'test', ref: 'e1', paths: ['file.txt'], browserFilesystemLocal: false });
    expect(control.events).toEqual(['listener', 'click']);
    expect(mocks.page).toHaveBeenCalledOnce();
    expect(mocks.restored).not.toHaveBeenCalled();
    expect(mocks.files).toHaveBeenCalledWith(expect.objectContaining({ browserFilesystemLocal: false }));
    expect(control.setFiles).toHaveBeenCalledWith(['/validated/file.txt'], expect.anything());
    const options: unknown = control.setFiles.mock.calls[0]?.[1];
    expect(options).toHaveProperty('signal', expect.any(AbortSignal));
  });

  it('cancels the armed chooser immediately when the click fails', async () => {
    const blocked = fixture();
    blocked.click.mockRejectedValue(new Error('click failed'));
    await expect(
      uploadViaPlaywright({ cdpUrl: 'test', ref: 'e1', paths: ['file.txt'], timeoutMs: 30000 }),
    ).rejects.toThrow('click failed');
    expect(blocked.emitter.listenerCount('filechooser')).toBe(0);
    expect(blocked.setFiles).not.toHaveBeenCalled();
  });

  it('cancels page acquisition without installing a late listener', async () => {
    const control = fixture();
    let resolvePage: (page: unknown) => void = () => undefined;
    mocks.page.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    const controller = new AbortController();
    const pending = uploadViaPlaywright({ cdpUrl: 'test', ref: 'e1', paths: ['file.txt'], signal: controller.signal });
    controller.abort(new Error('cancel before page'));
    await expect(pending).rejects.toThrow('cancel before page');
    resolvePage(control.emitter);
    await Promise.resolve();
    expect(control.events).toEqual([]);
    expect(control.setFiles).not.toHaveBeenCalled();
  });

  it('includes page acquisition in the atomic operation deadline', async () => {
    const control = fixture();
    mocks.page.mockReturnValue(new Promise(() => undefined));
    vi.useFakeTimers();
    try {
      const rejected = expect(
        uploadViaPlaywright({ cdpUrl: 'test', ref: 'e1', paths: ['file.txt'], timeoutMs: 500 }),
      ).rejects.toThrow('Timeout 500ms');
      await vi.advanceTimersByTimeAsync(500);
      await rejected;
      expect(control.events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])('rejects an older late lookup when the newer upload has completed=%s', async (completed) => {
    const control = fixture();
    let resolveOlder!: (page: unknown) => void;
    mocks.page.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
    );
    const options = { cdpUrl: 'test', paths: ['file.txt'] };
    const older = armFileUploadViaPlaywright(options);
    const olderRejected = expect(older).rejects.toThrow('superseded');
    const newer = await armFileUploadViaPlaywright(options);
    if (completed) {
      control.emitter.emit('filechooser');
      await newer.done;
    }
    resolveOlder(control.page);
    await olderRejected;
    // The stale request neither registers nor cancels the newer chooser.
    expect(control.events).toEqual(['listener']);
    if (!completed) {
      expect(control.emitter.listenerCount('filechooser')).toBe(1);
      control.emitter.emit('filechooser');
      await newer.done;
    }
    expect(control.setFiles).toHaveBeenCalledOnce();
  });

  it('keeps reordered uploads on different pages independent', async () => {
    const first = fixture();
    const second = fixture();
    let resolveFirst!: (page: unknown) => void;
    mocks.page.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mocks.page.mockResolvedValueOnce(second.page);
    const older = armFileUploadViaPlaywright({ cdpUrl: 'test', targetId: 'first', paths: ['file.txt'] });
    const newer = await armFileUploadViaPlaywright({ cdpUrl: 'test', targetId: 'second', paths: ['file.txt'] });
    resolveFirst(first.page);
    const firstArmed = await older;
    expect(first.emitter.listenerCount('filechooser')).toBe(1);
    expect(second.emitter.listenerCount('filechooser')).toBe(1);
    first.emitter.emit('filechooser');
    second.emitter.emit('filechooser');
    await Promise.all([firstArmed.done, newer.done]);
    expect(first.setFiles).toHaveBeenCalledOnce();
    expect(second.setFiles).toHaveBeenCalledOnce();
  });
});
