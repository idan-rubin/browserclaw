import { chromium, type Browser, type ConnectOverCDPTransport } from 'playwright-core';

import { cdpMessageText, closeCdpSocket, openPinnedCdpSocket, type CdpEndpoint } from './cdp-network.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Public Playwright transport API: our validated DNS pin owns the actual socket. */
export async function connectOverPinnedCdp(
  endpoint: CdpEndpoint,
  opts: { timeoutMs: number; headers?: Record<string, string> },
): Promise<Browser> {
  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  const socket = await openPinnedCdpSocket(endpoint, { ...opts, playwrightDefaults: true });
  let onMessage: ConnectOverCDPTransport['onmessage'];
  let onClose: ConnectOverCDPTransport['onclose'];
  const pending: object[] = [];
  let closeReason: string | undefined;
  let closeNotified = false;
  let nextInternalId = -10_000;
  const pendingResumes = new Map<number, string>();
  const close = (reason = 'CDP socket closed'): void => {
    if (closeReason !== undefined) return;
    closeReason = reason;
    pending.length = 0;
    pendingResumes.clear();
    closeCdpSocket(socket);
  };
  const notifyClose = (reason: string): void => {
    setImmediate(() => {
      closeReason ??= reason;
      if (closeNotified || !onClose) return;
      closeNotified = true;
      onClose(closeReason);
    });
  };
  const scheduleMessage = (message: object): void => {
    setImmediate(() => {
      if (closeReason !== undefined) return;
      if (!onMessage) {
        pending.push(message);
        return;
      }
      try {
        const dispatch = onMessage as (message: object) => unknown;
        void Promise.resolve(dispatch(message)).catch((error: unknown) => {
          close(error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        close(error instanceof Error ? error.message : String(error));
      }
    });
  };
  const transport: ConnectOverCDPTransport = {
    send(message) {
      if (closeReason !== undefined) throw new Error('CDP transport closed');
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        close();
        throw error;
      }
    },
    close,
    get onmessage() {
      return onMessage;
    },
    set onmessage(handler) {
      onMessage = handler;
      if (handler) for (const message of pending.splice(0)) scheduleMessage(message);
    },
    get onclose() {
      return onClose;
    },
    set onclose(handler) {
      onClose = handler;
      if (handler && closeReason !== undefined) notifyClose(closeReason);
    },
  };
  const sendInternal = (method: string, sessionId: string, params?: object): number => {
    const id = nextInternalId--;
    socket.send(JSON.stringify({ id, method, sessionId, params }));
    return id;
  };
  socket.on('message', (raw) => {
    if (closeReason !== undefined) return;
    try {
      const message = record(JSON.parse(cdpMessageText(raw)) as unknown);
      if (!message) {
        close();
        return;
      }
      if (typeof message.id === 'number' && message.id <= -10_000) {
        const sessionId = pendingResumes.get(message.id);
        if (sessionId !== undefined) {
          pendingResumes.delete(message.id);
          socket.send(
            JSON.stringify({ id: nextInternalId--, method: 'Target.detachFromTarget', params: { sessionId } }),
          );
        }
        return;
      }
      if (
        message.method === 'Target.attachedToTarget' &&
        (typeof message.sessionId !== 'string' || message.sessionId === '')
      ) {
        const params = record(message.params);
        const target = record(params?.targetInfo);
        const sessionId = params?.sessionId;
        if (
          target?.type !== 'browser' &&
          (typeof target?.browserContextId !== 'string' || target.browserContextId === '')
        ) {
          if (typeof sessionId === 'string' && sessionId !== '') {
            pendingResumes.set(sendInternal('Runtime.runIfWaitingForDebugger', sessionId), sessionId);
          }
          return;
        }
      }
      scheduleMessage(message);
    } catch {
      close();
    }
  });
  socket.on('close', () => {
    notifyClose('CDP socket closed');
  });
  socket.on('error', (error) => {
    notifyClose(error.message);
  });
  try {
    return await chromium.connectOverCDP(transport, { timeout: Math.max(1, deadline - Date.now()) });
  } catch (error) {
    close();
    throw error;
  }
}
