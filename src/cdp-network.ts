import http from 'node:http';
import https from 'node:https';

import WebSocket, { type RawData } from 'ws';

import { getHeadersWithAuth, resolveCdpEndpointPin, stripUrlCredentials } from './security.js';
import type { PinnedHostname, SsrfPolicy } from './types.js';

const MAX_REDIRECTS = 10;
const JSON_MAX_BYTES = 16 * 1024 * 1024;

export interface CdpEndpoint {
  url: string;
  lookup?: PinnedHostname['lookup'];
}

export function cdpMessageText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return (Buffer.isBuffer(raw) ? raw : Buffer.from(raw)).toString('utf8');
}

let nextCommandId = 1;
export async function sendCdpCommand(
  socket: WebSocket,
  method: string,
  params?: object,
  sessionId?: string,
  timeoutMs = 1500,
): Promise<Record<string, unknown>> {
  const id = nextCommandId++;
  return await new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error('CDP socket closed'));
    };
    const onMessage = (raw: RawData): void => {
      try {
        const message = JSON.parse(cdpMessageText(raw)) as {
          id?: number;
          result?: Record<string, unknown>;
          error?: unknown;
        };
        if (message.id !== id) return;
        cleanup();
        if (message.error !== undefined) reject(new Error(`CDP command ${method} failed`));
        else resolve(message.result ?? {});
      } catch {
        /* A malformed frame cannot fulfill this command. */
      }
    };
    const timer = setTimeout(
      () => {
        cleanup();
        reject(new Error(`CDP command ${method} timed out`));
      },
      Math.max(1, timeoutMs),
    );
    socket.on('message', onMessage);
    socket.once('close', onClose);
    try {
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

interface CdpRequestOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrfPolicy;
  configuredUrl?: string;
  lookup?: PinnedHostname['lookup'];
}

function authority(url: string): string {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  return `${secure ? 'tls' : 'plain'}://${parsed.hostname}:${parsed.port || (secure ? '443' : '80')}`;
}

function checkedRedirect(original: string, location: string): string {
  const redirected = new URL(location, original).toString();
  if (authority(original) !== authority(redirected)) throw new Error('CDP redirect changed authority');
  return redirected;
}

/** A single deadline includes DNS, redirects and all body bytes, not only headers. */
export async function fetchCdpJson(url: string, opts: CdpRequestOptions): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort(new Error('CDP HTTP request timed out'));
    },
    Math.max(1, opts.timeoutMs),
  );
  try {
    let current = url;
    const headers = getHeadersWithAuth(url, opts.headers);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      controller.signal.throwIfAborted();
      const pin =
        opts.lookup ??
        (
          await resolveCdpEndpointPin(
            current,
            opts.ssrfPolicy,
            opts.configuredUrl !== undefined ? { source: 'discovered', configuredUrl: opts.configuredUrl } : undefined,
            controller.signal,
          )
        )?.lookup;
      controller.signal.throwIfAborted();
      const parsed = new URL(stripUrlCredentials(current));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        throw new Error('CDP HTTP endpoint requires HTTP(S)');
      const result = await new Promise<{ location: string } | { data: unknown }>((resolve, reject) => {
        const request = (parsed.protocol === 'https:' ? https : http).request(
          parsed,
          {
            method: 'GET',
            headers,
            lookup: pin,
            agent: false,
            signal: controller.signal,
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400 && response.headers.location !== undefined) {
              response.destroy();
              resolve({ location: response.headers.location });
              return;
            }
            if (status < 200 || status >= 300) {
              response.destroy();
              reject(new Error(`CDP HTTP ${String(status)}`));
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            response.on('data', (chunk: Buffer) => {
              total += chunk.length;
              if (total > JSON_MAX_BYTES) {
                response.destroy(new Error(`CDP JSON response exceeds ${String(JSON_MAX_BYTES)} bytes`));
                return;
              }
              chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('end', () => {
              try {
                resolve({
                  data: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown,
                });
              } catch (cause) {
                reject(new Error('CDP malformed JSON response', { cause }));
              }
            });
            response.on('aborted', () => {
              reject(new Error('CDP response aborted'));
            });
          },
        );
        request.on('error', reject);
        request.end();
      });
      if ('data' in result) return result.data;
      current = checkedRedirect(current, result.location);
    }
    throw new Error('CDP HTTP redirect limit exceeded');
  } finally {
    clearTimeout(timer);
  }
}

export function closeCdpSocket(socket: WebSocket): void {
  socket.close();
  const timer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, 100);
  timer.unref();
}

/** Follow only same-authority redirects, checking before constructing the next socket. */
export async function openPinnedCdpSocket(
  endpoint: CdpEndpoint,
  opts: { timeoutMs: number; headers?: Record<string, string>; playwrightDefaults?: boolean },
): Promise<WebSocket> {
  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  let current = endpoint.url;
  const headers = getHeadersWithAuth(current, opts.headers);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('CDP WebSocket handshake timed out');
    const parsed = new URL(current);
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('CDP socket requires WS(S)');
    const result = await new Promise<WebSocket | { location: string }>((resolve, reject) => {
      const socket = new WebSocket(stripUrlCredentials(current), {
        headers,
        lookup: endpoint.lookup,
        handshakeTimeout: remaining,
        followRedirects: false,
        maxPayload: opts.playwrightDefaults === true ? 256 * 1024 * 1024 : JSON_MAX_BYTES,
        perMessageDeflate:
          opts.playwrightDefaults === true
            ? {
                clientNoContextTakeover: true,
                zlibDeflateOptions: { level: 3 },
                zlibInflateOptions: { chunkSize: 10240 },
                threshold: 10240,
              }
            : false,
      });
      socket.on('error', reject);
      socket.once('open', () => {
        resolve(socket);
      });
      socket.once('close', () => {
        reject(new Error('CDP socket closed'));
      });
      socket.once('unexpected-response', (request, response) => {
        const location = response.headers.location;
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400 && location !== undefined) resolve({ location });
        else reject(new Error(`CDP WebSocket HTTP ${String(status)}`));
        request.destroy();
        response.destroy();
        socket.terminate();
      });
    });
    if (result instanceof WebSocket) return result;
    current = checkedRedirect(current, result.location);
  }
  throw new Error('CDP WebSocket redirect limit exceeded');
}
