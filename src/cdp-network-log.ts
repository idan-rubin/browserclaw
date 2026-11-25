import type { Browser } from 'playwright-core';

import type { NetworkRequest, PageState } from './types.js';
import { truncateUtf16Safe } from './utf16.js';

interface TargetLog {
  targetId: string;
  sessionId: string;
  state: Pick<PageState, 'requests' | 'nextRequestId'>;
  pending: Map<string, NetworkRequest>;
  requestKeys: WeakMap<NetworkRequest, string>;
}

const pendingByState = new WeakMap<PageState, Map<string, NetworkRequest>>();

export function clearNetworkRequests(state: PageState): void {
  state.requests = [];
  pendingByState.get(state)?.clear();
}

function resourceType(value: unknown): string {
  switch (value) {
    case 'Document':
    case 'Stylesheet':
    case 'Image':
    case 'Media':
    case 'Font':
    case 'Script':
    case 'TextTrack':
    case 'XHR':
    case 'Fetch':
    case 'EventSource':
    case 'WebSocket':
    case 'Manifest':
    case 'Ping':
      return (value as string).toLowerCase();
    case 'CSPViolationReport':
      return 'cspreport';
    default:
      return 'other';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function setResponse(request: NetworkRequest | undefined, response: unknown): void {
  const status = record(response)?.status;
  if (request && typeof status === 'number') {
    request.status = status;
    request.ok = status === 0 || (status >= 200 && status < 300);
  }
}

/** Observe Chromium's existing Playwright sessions without creating remote request handles. */
export function createCdpNetworkLog() {
  const targets = new Map<string, TargetLog>();
  const sessions = new Map<string, { log: TargetLog; parent?: string }>();

  function detach(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    if (session.log.sessionId === sessionId) targets.delete(session.log.targetId);
    for (const [id, child] of sessions) {
      if (child.parent === sessionId) detach(id);
    }
  }

  return {
    receive(message: Record<string, unknown>): void {
      const { method, sessionId } = message;
      if (
        method !== 'Target.attachedToTarget' &&
        method !== 'Target.detachedFromTarget' &&
        method !== 'Network.requestWillBeSent' &&
        method !== 'Network.responseReceived' &&
        method !== 'Network.loadingFailed' &&
        method !== 'Network.loadingFinished'
      )
        return;
      const params = record(message.params);
      if (!params) return;
      if (method === 'Target.attachedToTarget') {
        const id = params.sessionId;
        const info = record(params.targetInfo);
        const targetId = info?.targetId;
        if (typeof id !== 'string' || !id || typeof targetId !== 'string' || !targetId) return;
        if (info.type === 'page' && !targets.has(targetId)) {
          const log: TargetLog = {
            targetId,
            sessionId: id,
            state: { requests: [], nextRequestId: 0 },
            pending: new Map(),
            requestKeys: new WeakMap(),
          };
          targets.set(targetId, log);
          sessions.set(id, { log });
        } else if ((info.type === 'iframe' || info.type === 'worker') && typeof sessionId === 'string') {
          const parent = sessions.get(sessionId);
          if (parent) sessions.set(id, { log: parent.log, parent: sessionId });
        }
        return;
      }
      if (method === 'Target.detachedFromTarget') {
        if (typeof params.sessionId === 'string') detach(params.sessionId);
        return;
      }
      const log = typeof sessionId === 'string' ? sessions.get(sessionId)?.log : undefined;
      const id = params.requestId;
      if (!log || typeof id !== 'string' || !id) return;
      const previous = log.pending.get(id);
      if (method === 'Network.requestWillBeSent') {
        const request = record(params.request);
        if (
          typeof request?.url !== 'string' ||
          !request.url ||
          request.url.startsWith('data:') ||
          typeof request.method !== 'string' ||
          !request.method
        )
          return;
        setResponse(previous, params.redirectResponse);
        const row: NetworkRequest = {
          id: 'r' + String(++log.state.nextRequestId),
          timestamp: new Date().toISOString(),
          method: request.method,
          url: request.url,
          resourceType: resourceType(params.type),
        };
        log.state.requests.push(row);
        log.pending.set(id, row);
        log.requestKeys.set(row, id);
        if (log.state.requests.length > 550) {
          for (const evicted of log.state.requests.splice(0, 50)) {
            const key = log.requestKeys.get(evicted);
            if (key !== undefined && log.pending.get(key) === evicted) log.pending.delete(key);
          }
        }
      } else if (method === 'Network.responseReceived') {
        setResponse(previous, params.response);
      } else {
        // A 204 navigation completes successfully even when Chromium reports its load as aborted.
        if (method === 'Network.loadingFailed' && previous && previous.status !== 204) {
          const failure =
            typeof params.errorText === 'string' && params.errorText !== '' ? params.errorText : params.blockedReason;
          previous.failureText =
            typeof failure === 'string' && failure !== '' ? truncateUtf16Safe(failure, 2048) : undefined;
          previous.ok = false;
        }
        log.pending.delete(id);
      }
    },
    bind(targetId: string, state: PageState): void {
      const log = targets.get(targetId);
      if (!log || log.state === state) return;
      state.requests = log.state.requests;
      state.nextRequestId = log.state.nextRequestId;
      log.state = state;
      pendingByState.set(state, log.pending);
    },
    clear(): void {
      for (const log of targets.values()) log.pending.clear();
      sessions.clear();
      targets.clear();
    },
  };
}

export const cdpNetworkLogs = new WeakMap<Browser, ReturnType<typeof createCdpNetworkLog>>();
