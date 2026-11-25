import { EventEmitter } from 'node:events';

import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';

import { clearNetworkRequests, createCdpNetworkLog } from './cdp-network-log.js';
import { ensurePageState } from './page-utils.js';

function fixture() {
  const log = createCdpNetworkLog();
  const state = ensurePageState(new EventEmitter() as unknown as Page);
  const attach = (sessionId: string, type: string, targetId: string, parent?: string) => {
    log.receive({
      method: 'Target.attachedToTarget',
      sessionId: parent,
      params: { sessionId, targetInfo: { type, targetId } },
    });
  };
  const request = (sessionId: string, requestId: string, url: string, redirectResponse?: { status: number }) => {
    log.receive({
      method: 'Network.requestWillBeSent',
      sessionId,
      params: { requestId, request: { method: 'GET', url }, type: 'XHR', redirectResponse },
    });
  };
  const event = (method: string, sessionId: string, requestId: string, detail: Record<string, unknown>) => {
    log.receive({ method, sessionId, params: { requestId, ...detail } });
  };
  attach('main', 'page', 'tab');
  return { log, state, attach, request, event };
}

describe('network metadata from the existing CDP transport', () => {
  it('correlates redirects and cross-session completions, isolates pages, and ignores auxiliary sessions', () => {
    const { log, state, attach, request, event } = fixture();
    attach('other', 'page', 'other-tab');
    attach('helper', 'page', 'tab');
    attach('child', 'iframe', 'inner', 'main');
    request('other', 'a', 'other');
    request('helper', 'a', 'duplicate');
    request('main', 'z', 'data:,ignored');
    request('main', 'a', 'first');
    request('child', 'a', 'second', { status: 302 });
    log.bind('tab', state);
    event('Network.responseReceived', 'main', 'a', { response: { status: 204 } });
    event('Network.loadingFailed', 'child', 'a', { errorText: 'net::ERR_ABORTED' });
    expect(state.requests).toMatchObject([
      { id: 'r1', url: 'first', status: 302, ok: false },
      { id: 'r2', url: 'second', status: 204, ok: true, resourceType: 'xhr' },
    ]);
    log.receive({ method: 'Target.detachedFromTarget', params: { sessionId: 'child' } });
    request('child', 'b', 'detached');
    expect(state.requests).toHaveLength(2);
  });
  it('bounds failure text and evicts pending entries, including when callers clear the log', () => {
    const { log, state, request, event } = fixture();
    log.bind('tab', state);
    const long = 'x'.repeat(2047) + '😀'.repeat(10);
    request('main', 'a', long);
    event('Network.loadingFailed', 'main', 'a', { errorText: long });
    expect(state.requests[0]).toMatchObject({ url: long, ok: false, failureText: 'x'.repeat(2047) });
    request('main', 'b', 'before-clear');
    const old = state.requests[1];
    clearNetworkRequests(state);
    event('Network.responseReceived', 'main', 'b', { response: { status: 200 } });
    expect(old.status).toBeUndefined();
    request('main', 'c', 'oldest');
    const evicted = state.requests[0];
    for (let i = 0; i < 550; i++) request('main', String(i), 'example');
    expect(state.requests).toHaveLength(501);
    event('Network.responseReceived', 'main', 'c', { response: { status: 201 } });
    expect(evicted.status).toBeUndefined();
    expect(state.nextRequestId).toBe(553);
  });
});
