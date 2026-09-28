import { EventEmitter } from 'node:events';

import type { Request, Route } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';
import type * as SecurityModule from '../security.js';
import type { SsrfPolicy } from '../types.js';

const mocks = vi.hoisted(() => ({ page: vi.fn(), locator: vi.fn(), state: vi.fn() }));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionModule>()),
  getPageForTargetId: mocks.page,
  getRestoredPageForTarget: mocks.page,
  refLocator: mocks.locator,
  ensurePageState: mocks.state,
}));
vi.mock('../security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SecurityModule>()),
  resolveStrictExistingPathsWithinRoot: (opts: { requestedPaths: string[] }) =>
    Promise.resolve({ ok: true, paths: opts.requestedPaths }),
}));

import { downloadViaPlaywright, waitForDownloadViaPlaywright } from './download.js';
import {
  hoverViaPlaywright,
  scrollIntoViewViaPlaywright,
  setInputFilesViaPlaywright,
  armFileUploadViaPlaywright,
  clickViaPlaywright,
  typeViaPlaywright,
  selectOptionViaPlaywright,
  dragViaPlaywright,
  uploadViaPlaywright,
} from './interaction.js';
import { waitForViaPlaywright } from './wait.js';

type RouteHandler = (route: Route, request: Request) => Promise<void>;

function fixture(afterDispatch?: () => Promise<void>, chooserOnly = false) {
  let handler: RouteHandler | undefined;
  const frame = {};
  const sent = vi.fn().mockResolvedValue(undefined);
  const fulfill = vi.fn().mockResolvedValue(undefined);
  const request = {
    url: () => 'http://169.254.169.254/latest/meta-data/',
    frame: () => frame,
    isNavigationRequest: () => true,
    resourceType: () => 'document',
  } as unknown as Request;
  const route = {
    fallback: sent,
    continue: sent,
    fulfill,
    abort: vi.fn().mockResolvedValue(undefined),
  } as unknown as Route;
  const dispatch = async () => {
    if (handler) await handler(route, request);
    else await sent();
    await afterDispatch?.();
  };
  const chooser = { setFiles: dispatch, element: () => null };
  const page = Object.assign(new EventEmitter(), {
    url: () => 'about:blank',
    mainFrame: () => frame,
    route: (_pattern: string, value: RouteHandler) => {
      handler = value;
      return Promise.resolve();
    },
    unroute: vi.fn(() => {
      handler = undefined;
      return Promise.resolve();
    }),
    waitForFunction: dispatch,
    evaluateHandle: () => Promise.resolve({ dispose: () => Promise.resolve() }),
    waitForEvent: () => Promise.resolve(chooser),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  });
  const locator = {
    hover: dispatch,
    waitFor: vi.fn().mockResolvedValue(undefined),
    evaluate: dispatch,
    setInputFiles: dispatch,
    elementHandle: () => Promise.resolve(null),
    click: chooserOnly ? () => Promise.resolve() : dispatch,
    dblclick: dispatch,
    fill: dispatch,
    selectOption: dispatch,
    dragTo: dispatch,
  };
  mocks.page.mockResolvedValue(page);
  mocks.locator.mockReturnValue(locator);
  mocks.state.mockReturnValue({
    armIdUpload: 0,
    nextArmIdUpload: 0,
    armIdDownload: 0,
    nextArmIdDownload: 0,
    downloadWaiterDepth: 0,
  });
  return { page, sent, fulfill, dispatch };
}

const options = (ssrfPolicy?: SsrfPolicy) => ({ cdpUrl: 'http://localhost:9222', targetId: 'target', ssrfPolicy });
const actions = {
  hover: (policy?: SsrfPolicy) => hoverViaPlaywright({ ...options(policy), ref: 'e1' }),
  scroll: (policy?: SsrfPolicy) => scrollIntoViewViaPlaywright({ ...options(policy), ref: 'e1' }),
  upload: (policy?: SsrfPolicy) =>
    setInputFilesViaPlaywright({ ...options(policy), ref: 'e1', paths: ['/validated/file.txt'] }),
  chooser: async (policy?: SsrfPolicy) => {
    const { done } = await armFileUploadViaPlaywright({ ...options(policy), paths: ['/validated/file.txt'] });
    await done;
  },
  predicate: (policy?: SsrfPolicy) => waitForViaPlaywright({ ...options(policy), fn: () => true }),
};

describe('new mutation navigation guard call sites', () => {
  it.each(Object.keys(actions) as (keyof typeof actions)[])(
    '%s blocks a document before dispatch and allows explicit private opt-in',
    async (name) => {
      const blocked = fixture();
      await expect(actions[name]()).rejects.toThrow();
      expect(blocked.sent).not.toHaveBeenCalled();
      expect(blocked.fulfill).toHaveBeenCalledWith({ status: 204, body: '' });
      const control = fixture();
      await actions[name]({ dangerouslyAllowPrivateNetwork: true });
      expect(control.sent).toHaveBeenCalled();
      expect(control.fulfill).not.toHaveBeenCalled();
    },
  );

  it('guards the explicit download click before any network request', async () => {
    const blocked = fixture();
    await expect(
      downloadViaPlaywright({ ...options(), ref: 'e1', path: '/tmp/bc-never-written.bin', timeoutMs: 1000 }),
    ).rejects.toThrow();
    expect(blocked.sent).not.toHaveBeenCalled();
    expect(blocked.fulfill).toHaveBeenCalledWith({ status: 204, body: '' });
  });

  it('allows the same download click with private opt-in and publishes its payload', async () => {
    const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'bc-guard-download-'));
    const path = join(directory, 'payload.txt');
    const control = fixture();
    try {
      const pending = downloadViaPlaywright({
        ...options({ dangerouslyAllowPrivateNetwork: true }),
        ref: 'e1',
        path,
        timeoutMs: 3000,
      });
      await vi.waitFor(() => {
        expect(control.sent).toHaveBeenCalled();
      });
      control.page.emit('download', {
        url: () => 'http://169.254.169.254/file',
        suggestedFilename: () => 'payload.txt',
        saveAs: (tempPath: string) => writeFile(tempPath, 'payload'),
      });
      await expect(pending).resolves.toMatchObject({ path });
      expect(await readFile(path, 'utf8')).toBe('payload');
      expect(control.fulfill).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a download waiter immediately on policy denial rather than its full timeout', async () => {
    const blocked = fixture();
    const pending = waitForDownloadViaPlaywright({ ...options(), path: '/tmp/bc-never-written.bin', timeoutMs: 30000 });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => {
      expect(blocked.page.listenerCount('download')).toBe(1);
    });
    await blocked.dispatch();
    await rejected;
    expect(blocked.sent).not.toHaveBeenCalled();
    expect(blocked.fulfill).toHaveBeenCalledWith({ status: 204, body: '' });
    expect(blocked.page.listenerCount('download')).toBe(0);
  });
});

const cancellableActions = {
  click: (signal: AbortSignal) => clickViaPlaywright({ ...options(), ref: 'e1', signal }),
  doubleClick: (signal: AbortSignal) => clickViaPlaywright({ ...options(), ref: 'e1', doubleClick: true, signal }),
  delayedClick: (signal: AbortSignal) => clickViaPlaywright({ ...options(), ref: 'e1', delayMs: 1, signal }),
  hover: (signal: AbortSignal) => hoverViaPlaywright({ ...options(), ref: 'e1', signal }),
  type: (signal: AbortSignal) => typeViaPlaywright({ ...options(), ref: 'e1', text: 'value', signal }),
  select: (signal: AbortSignal) => selectOptionViaPlaywright({ ...options(), ref: 'e1', values: ['value'], signal }),
  drag: (signal: AbortSignal) => dragViaPlaywright({ ...options(), startRef: 'e1', endRef: 'e2', signal }),
  scroll: (signal: AbortSignal) => scrollIntoViewViaPlaywright({ ...options(), ref: 'e1', signal }),
  atomicUpload: (signal: AbortSignal) =>
    uploadViaPlaywright({ ...options(), ref: 'e1', paths: ['/validated/file.txt'], signal }),
};

describe('native mutation cancellation and navigation policy precedence', () => {
  const cases = (Object.keys(cancellableActions) as (keyof typeof cancellableActions)[]).map((name) => ({
    name,
    chooserOnly: false,
  }));
  cases.push({ name: 'atomicUpload', chooserOnly: true });
  it.each(cases)(
    '$name retains its guard and policy error when native work ignores cancellation (chooserOnly=$chooserOnly)',
    async ({ name, chooserOnly }) => {
      const controller = new AbortController();
      let finishNative!: () => void;
      const native = new Promise<void>((resolve) => {
        finishNative = resolve;
      });
      let nativeStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        nativeStarted = resolve;
      });
      const blocked = fixture(async () => {
        controller.abort(new Error('caller cancelled'));
        nativeStarted();
        await native;
      }, chooserOnly);
      const pending = cancellableActions[name](controller.signal);
      const settled = vi.fn();
      void pending.then(settled, settled);
      const rejected = expect(pending).rejects.toThrow(/private|blocked|link-local/i);
      await started;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(blocked.sent).not.toHaveBeenCalled();
      expect(blocked.fulfill).toHaveBeenCalledOnce();
      expect(blocked.page.unroute).toHaveBeenCalledTimes(chooserOnly ? 1 : 0);
      expect(settled).not.toHaveBeenCalled();
      finishNative();
      await rejected;
      expect(blocked.page.unroute).toHaveBeenCalledTimes(chooserOnly ? 2 : 1);
    },
  );
});
