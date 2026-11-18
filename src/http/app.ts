import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AppError, toAppError } from '../domain/errors.ts';
import { route } from './router.ts';
import type { Clock } from './router.ts';

const MAX_BODY_BYTES = 16 * 1024;

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the request body as application/json.');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Drain oversized requests without retaining their content or destroying the response socket.
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'JSON body must not exceed 16 KiB.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  }
}

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

export function createApp(db: DatabaseSync, options: { clock?: Clock; logError?: (error: unknown, requestId: string) => void } = {}) {
  const server = createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader('x-request-id', requestId);
    try {
      const method = request.method ?? 'GET';
      const body = ['POST', 'PATCH', 'PUT'].includes(method) ? await readJson(request) : undefined;
      const result = route(db, { method, url: request.url ?? '/', body }, options.clock);
      send(response, result.status, result.body, result.headers);
    } catch (error) {
      const failure = toAppError(error);
      if (failure.status === 500) (options.logError ?? ((error, requestId) => console.error({ requestId, error })))(error, requestId);
      const headers: Record<string, string> = {};
      if (failure.status === 503) headers['retry-after'] = '1';
      if (failure.status === 405) headers.allow = failure.message.replace('Allowed methods: ', '').replace(/\.$/, '');
      send(response, failure.status, { error: { code: failure.code, message: failure.message, requestId } }, headers);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
