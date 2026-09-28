import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface FakeCdpOptions {
  requireAuthorization?: string;
  versionWsUrl?: (port: number) => string;
  listTargets?: (port: number) => unknown[];
  stallOnBrowserClose?: boolean;
  browserProcessId?: number;
}

export interface FakeCdpServer {
  port: number;
  httpUrl: string;
  authSeen: string[];
  frames: Record<string, unknown>[];
  readonly upgrades: number;
  stall(): void;
  close(): Promise<void>;
}

function decodeTextFrame(buf: Buffer): string | undefined {
  if (buf.length < 2 || (buf[0] & 0x0f) !== 0x1) return undefined;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    return undefined;
  }
  const mask = masked ? buf.subarray(offset, offset + 4) : undefined;
  if (masked) offset += 4;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return payload.toString('utf8');
}

export async function startFakeCdpServer(opts: FakeCdpOptions = {}): Promise<FakeCdpServer> {
  let stalled = false;
  const stalledResponses: ServerResponse[] = [];
  const authSeen: string[] = [];
  const frames: Record<string, unknown>[] = [];
  let upgrades = 0;
  const upgraded = new Set<Socket>();
  const authorized = (req: IncomingMessage): boolean =>
    opts.requireAuthorization === undefined || req.headers.authorization === opts.requireAuthorization;

  const server = createHttpServer((req, res) => {
    authSeen.push(req.headers.authorization ?? '');
    if (!authorized(req)) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (stalled) {
      stalledResponses.push(res);
      return;
    }
    const port = (server.address() as AddressInfo).port;
    const path = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    if (path.startsWith('/json/version')) {
      const wsUrl = (opts.versionWsUrl ?? ((p) => `ws://127.0.0.1:${String(p)}/devtools/browser/fake`))(port);
      res.end(JSON.stringify({ Browser: 'fake/1.0', webSocketDebuggerUrl: wsUrl }));
      return;
    }
    if (path.startsWith('/json/list')) {
      res.end(JSON.stringify((opts.listTargets ?? (() => []))(port)));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    authSeen.push(req.headers.authorization ?? '');
    socket.on('error', () => undefined);
    if (!authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    upgrades += 1;
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const accept = createHash('sha1')
      .update(`${String(req.headers['sec-websocket-key'])}${WS_GUID}`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', (chunk: Buffer) => {
      if ((chunk[0] & 0x0f) === 0x8) {
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      const text = decodeTextFrame(chunk);
      if (text === undefined) return;
      try {
        const frame = JSON.parse(text) as Record<string, unknown>;
        frames.push(frame);
        if (frame.method === 'SystemInfo.getProcessInfo' && opts.browserProcessId !== undefined) {
          const payload = Buffer.from(
            JSON.stringify({ id: frame.id, result: { processInfo: [{ type: 'browser', id: opts.browserProcessId }] } }),
          );
          socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
        }
        if (opts.stallOnBrowserClose === true && frame.method === 'Browser.close') stalled = true;
      } catch (err) {
        console.warn(`[fake-cdp] non-JSON text frame: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    httpUrl: `http://127.0.0.1:${String(port)}`,
    authSeen,
    frames,
    get upgrades() {
      return upgrades;
    },
    stall: () => {
      stalled = true;
    },
    close: async () => {
      for (const res of stalledResponses) res.destroy();
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

export interface TcpSink {
  port: number;
  readonly connections: number;
  release(): void;
  close(): Promise<void>;
}

export async function startTcpSink(): Promise<TcpSink> {
  const held = new Set<Socket>();
  let released = false;
  let connections = 0;
  const server = createTcpServer((socket) => {
    connections += 1;
    socket.on('error', () => undefined);
    if (released) {
      socket.destroy();
      return;
    }
    held.add(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const release = (): void => {
    released = true;
    for (const socket of held) socket.destroy();
    held.clear();
  };
  return {
    port,
    get connections() {
      return connections;
    },
    release,
    close: async () => {
      release();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
