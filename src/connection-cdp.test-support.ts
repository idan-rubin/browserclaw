import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketServer, type VerifyClientCallbackAsync } from 'ws';

import { cdpMessageText } from './cdp-network.js';

/** Minimal real CDP transport for connection lifecycle tests; no browser process. */
export async function startConnectionCdpServer(
  opts: {
    listGate?: Promise<void>;
    onList?: () => void;
    contextlessTarget?: boolean | { sessionId?: string };
    targetSocket?: 'page' | 'browser';
    attachGate?: Promise<void>;
    onAttach?: () => void;
    handshakeStatuses?: readonly number[];
    commandFailures?: readonly { method: string; message: string; sessionOnly?: boolean }[];
  } = {},
) {
  const frames: Record<string, unknown>[] = [];
  const authSeen: string[] = [];
  let connections = 0;
  let handshakes = 0;
  const commandFailures = [...(opts.commandFailures ?? [])];
  const server = createServer((req, res) => {
    authSeen.push(req.headers.authorization ?? '');
    const port = (server.address() as AddressInfo).port;
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/json/list') === true) {
      opts.onList?.();
      void Promise.resolve(opts.listGate).then(() => {
        res.end(
          JSON.stringify([
            {
              id: 'T1',
              webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/${opts.targetSocket ?? 'page'}/T1`,
            },
          ]),
        );
      });
      return;
    }
    res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${String(port)}/devtools/browser/fake` }));
  });
  const verifyClient: VerifyClientCallbackAsync = (_info, done) => {
    const status = opts.handshakeStatuses?.[handshakes];
    handshakes += 1;
    if (status !== undefined && status !== 101) done(false, status);
    else done(true);
  };
  const sockets = new WebSocketServer({ server, verifyClient });
  sockets.on('connection', (socket, request) => {
    authSeen.push(request.headers.authorization ?? '');
    connections += 1;
    socket.on('message', (raw) => {
      const message = JSON.parse(cdpMessageText(raw)) as Record<string, unknown>;
      frames.push(message);
      if (
        commandFailures[0]?.method === message.method &&
        (commandFailures[0].sessionOnly !== true || typeof message.sessionId === 'string')
      ) {
        const failure = commandFailures.shift();
        socket.send(
          JSON.stringify({
            id: message.id,
            sessionId: message.sessionId,
            error: { code: -32000, message: failure?.message },
          }),
        );
        return;
      }
      if (message.method === 'Target.attachToTarget') {
        opts.onAttach?.();
        void Promise.resolve(opts.attachGate).then(() => {
          socket.send(JSON.stringify({ id: message.id, result: { sessionId: 'termination-session' } }));
        });
        return;
      }
      if (
        opts.contextlessTarget !== undefined &&
        opts.contextlessTarget !== false &&
        message.method === 'Target.setAutoAttach'
      ) {
        socket.send(
          JSON.stringify({
            method: 'Target.attachedToTarget',
            params: {
              ...(opts.contextlessTarget === true ? { sessionId: 'contextless' } : opts.contextlessTarget),
              targetInfo: { type: 'page', targetId: 'transient' },
            },
          }),
        );
      }
      const result =
        message.method === 'Browser.getVersion'
          ? {
              product: 'Chrome/150.0.0.0',
              userAgent: 'HeadlessChrome/150.0.0.0',
              revision: 'test',
              protocolVersion: '1.3',
            }
          : message.method === 'Target.attachToBrowserTarget'
            ? { sessionId: 'metadata-session' }
            : message.method === 'Target.getTargetInfo'
              ? { targetInfo: { targetId: 'T1', type: 'page', title: 'Test', url: 'https://example.com/' } }
              : {};
      socket.send(JSON.stringify({ id: message.id, sessionId: message.sessionId, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    httpUrl: `http://127.0.0.1:${String(port)}`,
    frames,
    authSeen,
    get connections() {
      return connections;
    },
    get handshakes() {
      return handshakes;
    },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        sockets.close(() => {
          resolve();
        });
      });
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
