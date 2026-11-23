import { chromium, type Browser, type ConnectOverCDPTransport } from 'playwright-core';

import { cdpMessageText, closeCdpSocket, openPinnedCdpSocket, type CdpEndpoint } from './cdp-network.js';
import { UnresponsiveCdpTargetError } from './errors.js';

const MAX_DIAGNOSTIC_TARGETS = 3;
const MAX_DIAGNOSTIC_TARGET_ID_CHARS = 128;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isConnectTimeout(error: unknown): boolean {
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('timeout') || message.includes('timed out');
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
  const attachedPageTargets = new Map<string, string>();
  const pendingSessionCommands = new Map<number, { sessionId: string; sentAt: number }>();
  let initializing = true;
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
      const command = record(message);
      const id = command?.id;
      const sessionId = command?.sessionId;
      if (initializing && typeof id === 'number' && id > 0 && typeof sessionId === 'string' && sessionId !== '')
        pendingSessionCommands.set(id, { sessionId, sentAt: Date.now() });
      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        if (typeof id === 'number') pendingSessionCommands.delete(id);
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
      if (typeof message.id === 'number') pendingSessionCommands.delete(message.id);
      if (initializing && message.method === 'Target.attachedToTarget') {
        const params = record(message.params);
        const target = record(params?.targetInfo);
        if (
          typeof params?.sessionId === 'string' &&
          params.sessionId !== '' &&
          typeof target?.targetId === 'string' &&
          target.targetId !== '' &&
          target.targetId.length <= MAX_DIAGNOSTIC_TARGET_ID_CHARS &&
          target.type === 'page'
        )
          attachedPageTargets.set(params.sessionId, target.targetId);
      } else if (initializing && message.method === 'Target.detachedFromTarget') {
        const detached = record(message.params)?.sessionId;
        if (typeof detached === 'string' && detached !== '') {
          attachedPageTargets.delete(detached);
          for (const [id, command] of pendingSessionCommands)
            if (command.sessionId === detached) pendingSessionCommands.delete(id);
        }
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
    const browser = await chromium.connectOverCDP(transport, { timeout: Math.max(1, deadline - Date.now()) });
    initializing = false;
    attachedPageTargets.clear();
    pendingSessionCommands.clear();
    return browser;
  } catch (error) {
    close();
    if (isConnectTimeout(error)) {
      // The handshake shares this deadline, so a target is blamed only for a command it held for half the attempt.
      const heldSince = Date.now() - Math.max(1, opts.timeoutMs) / 2;
      const unresponsive = [
        ...new Set(
          [...pendingSessionCommands.values()]
            .filter((command) => command.sentAt <= heldSince)
            .flatMap((command) => attachedPageTargets.get(command.sessionId) ?? []),
        ),
      ].slice(0, MAX_DIAGNOSTIC_TARGETS);
      if (unresponsive.length > 0) throw new UnresponsiveCdpTargetError(unresponsive);
    }
    throw error;
  }
}
