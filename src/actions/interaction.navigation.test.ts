import type * as DnsModule from 'node:dns/promises';
import { EventEmitter } from 'node:events';

import type { Page, Request, Route } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ConnectionModule from '../connection.js';
import type * as SecurityModule from '../security.js';
import type { SsrfPolicy } from '../types.js';

const mocks = vi.hoisted(() => ({ page: vi.fn(), locator: vi.fn(), state: vi.fn(), lookup: vi.fn() }));
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof DnsModule>()),
  lookup: mocks.lookup,
}));
vi.mock('../connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ConnectionModule>()),
  getPageForTargetId: mocks.page,
  getRestoredPageForTarget: mocks.page,
  refLocator: mocks.locator,
  ensurePageState: mocks.state,
  tryTerminateExecutionForPage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../security.js', async (importOriginal) => ({
  ...(await importOriginal<typeof SecurityModule>()),
  resolveStrictExistingPathsWithinRoot: (opts: { requestedPaths: string[] }) =>
    Promise.resolve({ ok: true, paths: opts.requestedPaths }),
}));

import { downloadViaPlaywright, waitForDownloadViaPlaywright } from './download.js';
import { evaluateViaPlaywright } from './evaluate.js';
import {
  hoverViaPlaywright,
  scrollIntoViewViaPlaywright,
  setInputFilesViaPlaywright,
  armFileUploadViaPlaywright,
  clickViaPlaywright,
  typeViaPlaywright,
  selectOptionViaPlaywright,
  dragViaPlaywright,
  fillFormViaPlaywright,
  mouseClickViaPlaywright,
  uploadViaPlaywright,
} from './interaction.js';
import { withPageNavigationRequestGuard } from './navigation.js';
import { waitForViaPlaywright } from './wait.js';

afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

type RouteHandler = (route: Route, request: Request) => Promise<void>;

function fixture(
  afterDispatch?: () => Promise<void>,
  chooserOnly = false,
  requestUrl = 'http://169.254.169.254/latest/meta-data/',
) {
  let handler: RouteHandler | undefined;
  const frame = {};
  const sent = vi.fn().mockResolvedValue(undefined);
  const fulfill = vi.fn().mockResolvedValue(undefined);
  const request = {
    url: () => requestUrl,
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
    url: (): string => 'about:blank',
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
    mouse: { click: dispatch },
    evaluate: dispatch,
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
  return { page, locator, sent, fulfill, dispatch };
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

describe('interaction policy preflight cancellation', () => {
  const preflightActions = {
    ...cancellableActions,
    fill: (signal: AbortSignal) =>
      fillFormViaPlaywright({ ...options(), fields: [{ ref: 'e1', type: 'text', value: 'value' }], signal }),
    mouse: (signal: AbortSignal) => mouseClickViaPlaywright({ ...options(), x: 1, y: 2, signal }),
    evaluate: (signal: AbortSignal) => evaluateViaPlaywright({ ...options(), fn: '() => 42', signal }),
    evaluateRef: (signal: AbortSignal) => evaluateViaPlaywright({ ...options(), ref: 'e1', fn: '() => 42', signal }),
  };

  it.each(Object.keys(preflightActions) as (keyof typeof preflightActions)[])(
    '%s cancels stalled DNS before dispatch and removes its route',
    async (name) => {
      const { page, locator, sent } = fixture();
      page.url = () => `https://${name.toLowerCase()}.preflight.example/`;
      let finishLookup!: (addresses: { address: string; family: number }[]) => void;
      const lookup = new Promise((resolve) => {
        finishLookup = resolve;
      });
      mocks.lookup.mockReturnValue(lookup);
      const controller = new AbortController();
      const reason = new Error('cancel stalled preflight');
      const pending = preflightActions[name](controller.signal);
      const settled = vi.fn();
      void pending.then(settled, settled);
      try {
        await vi.waitFor(() => {
          expect(mocks.lookup).toHaveBeenCalled();
        });
        controller.abort(reason);
        await vi.waitFor(() => {
          expect(settled).toHaveBeenCalledWith(reason);
        });
        await expect(pending).rejects.toBe(reason);
        await vi.waitFor(() => {
          expect(page.unroute).toHaveBeenCalledOnce();
        });
      } finally {
        finishLookup([{ address: '93.184.216.34', family: 4 }]);
        await pending.catch(() => undefined);
      }
      expect(sent).not.toHaveBeenCalled();
      // All fake native mutations dispatch through the same sent callback.
      expect(locator.waitFor).not.toHaveBeenCalled();
      mocks.lookup.mockClear();
    },
  );

  it('dispatches normally after an uncancelled DNS preflight', async () => {
    const { page, sent } = fixture(undefined, false, 'https://allowed.preflight.example/next');
    page.url = () => 'https://allowed.preflight.example/';
    mocks.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const controller = new AbortController();
    await hoverViaPlaywright({ ...options(), ref: 'e1', signal: controller.signal });
    expect(mocks.lookup).toHaveBeenCalled();
    expect(sent).toHaveBeenCalled();
  });

  it('cancels the reread current URL check before dispatch', async () => {
    const { page } = fixture();
    let url = 'https://first.preflight.example/';
    page.url = () => url;
    let finishLookup!: (addresses: { address: string; family: number }[]) => void;
    mocks.lookup
      .mockImplementationOnce(() => {
        url = 'https://second.preflight.example/';
        return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishLookup = resolve;
          }),
      );
    const controller = new AbortController();
    const reason = new Error('cancel second preflight');
    const action = vi.fn().mockResolvedValue(undefined);
    const pending = withPageNavigationRequestGuard({
      ...options(),
      page: page as unknown as Page,
      action,
      signal: controller.signal,
    });
    const settled = vi.fn();
    void pending.then(settled, settled);
    try {
      await vi.waitFor(() => {
        expect(mocks.lookup).toHaveBeenCalledTimes(2);
      });
      controller.abort(reason);
      await vi.waitFor(() => {
        expect(settled).toHaveBeenCalledWith(reason);
      });
      await expect(pending).rejects.toBe(reason);
      expect(page.unroute).toHaveBeenCalledOnce();
    } finally {
      finishLookup([{ address: '93.184.216.34', family: 4 }]);
      await pending.catch(() => undefined);
    }
    expect(action).not.toHaveBeenCalled();
  });

  it('cancels the evaluator explicit-policy check before installing an input guard', async () => {
    const { page, sent } = fixture();
    page.url = () => 'https://explicit-evaluate.preflight.example/';
    let finishLookup!: (addresses: { address: string; family: number }[]) => void;
    mocks.lookup.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLookup = resolve;
        }),
    );
    const controller = new AbortController();
    const reason = new Error('cancel evaluator preflight');
    const pending = evaluateViaPlaywright({ ...options({}), fn: '() => 42', signal: controller.signal });
    const settled = vi.fn();
    void pending.then(settled, settled);
    try {
      await vi.waitFor(() => {
        expect(mocks.lookup).toHaveBeenCalledOnce();
      });
      controller.abort(reason);
      await vi.waitFor(() => {
        expect(settled).toHaveBeenCalledWith(reason);
      });
      await expect(pending).rejects.toBe(reason);
    } finally {
      finishLookup([{ address: '93.184.216.34', family: 4 }]);
      await pending.catch(() => undefined);
    }
    expect(sent).not.toHaveBeenCalled();
    expect(page.unroute).not.toHaveBeenCalled();
  });
});

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
