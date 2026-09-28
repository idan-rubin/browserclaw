import type { CDPSession, Locator, Page } from 'playwright-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureNativeRoleSnapshot } from './native-capture.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function captureFixture(attach?: Promise<CDPSession>, documentRead?: Promise<unknown>) {
  const attributes = new Set<string>();
  let disposed = false;
  const element = {
    setAttribute: (name: string) => {
      attributes.add(name);
    },
    removeAttribute: (name: string) => {
      attributes.delete(name);
    },
  };
  const dispose = vi.fn(() => {
    disposed = true;
    return Promise.resolve();
  });
  const evaluate = vi.fn((fn: (node: typeof element, arg: string) => unknown, arg: string) => {
    if (disposed) return Promise.reject(new Error('Handle is disposed'));
    return Promise.resolve(fn(element, arg));
  });
  let firstDocument = true;
  const send = vi.fn((method: string): Promise<unknown> => {
    if (method === 'DOM.getDocument') {
      if (firstDocument && documentRead) {
        firstDocument = false;
        return documentRead;
      }
      return Promise.resolve({ root: { backendNodeId: 1 } });
    }
    if (method === 'DOM.performSearch') return Promise.resolve({ searchId: 'search', resultCount: 1 });
    if (method === 'DOM.getSearchResults') return Promise.resolve({ nodeIds: [1] });
    if (method === 'DOM.describeNode') return Promise.resolve({ node: { backendNodeId: 1 } });
    if (method.startsWith('Accessibility.') && method !== 'Accessibility.enable') {
      return Promise.resolve({ nodes: [{ nodeId: 'root', backendDOMNodeId: 1, role: { value: 'generic' } }] });
    }
    if (method === 'DOM.resolveNode') return Promise.resolve({ object: { objectId: 'root' } });
    return Promise.resolve({});
  });
  const detach = vi.fn().mockResolvedValue(undefined);
  const session = { send, detach } as unknown as CDPSession;
  const page = { context: () => ({ newCDPSession: () => attach ?? Promise.resolve(session) }) } as unknown as Page;
  const locator = { elementHandle: () => Promise.resolve({ evaluate, dispose }) } as unknown as Locator;
  const capture = () =>
    captureNativeRoleSnapshot({ page, locator, remaining: () => 20, assertCurrent: () => undefined });
  return { capture, attributes, dispose, evaluate, detach, session };
}

describe('native capture root lifetime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a timed-out callback root alive until its marker cleanup settles', async () => {
    vi.useFakeTimers();
    const documentRead = deferred<unknown>();
    const fixture = captureFixture(undefined, documentRead.promise);
    const rejected = expect(fixture.capture()).rejects.toThrow('Page CDP operation timed out');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(fixture.attributes.size).toBe(1);
    expect(fixture.dispose).not.toHaveBeenCalled();
    expect(fixture.detach).toHaveBeenCalledOnce();
    documentRead.resolve({ root: { backendNodeId: 1 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.attributes.size).toBe(0);
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('disposes immediately if session attachment times out before callback entry', async () => {
    vi.useFakeTimers();
    const attached = deferred<CDPSession>();
    const fixture = captureFixture(attached.promise);
    const rejected = expect(fixture.capture()).rejects.toThrow('Page CDP operation timed out');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.evaluate).not.toHaveBeenCalled();
    attached.resolve(fixture.session);
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.detach).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('control: successful capture removes its marker before disposing the root', async () => {
    const fixture = captureFixture();
    await expect(fixture.capture()).resolves.toMatchObject({ refs: {} });
    expect(fixture.attributes.size).toBe(0);
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.detach).toHaveBeenCalledOnce();
  });
});
