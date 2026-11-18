// The HTTP server: reads each request's body, routes it to the right surface
// (health, REST v3, GraphQL, MCP, git smart HTTP), and writes the reply. A
// handler that throws answers 500 JSON and the server stays up — a malformed
// request must never take the forge down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { jsonError, type HttpResponse, type RequestContext } from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitResponse } from './gitproto.ts';

/** Requests larger than this are refused with 413 (the suite's largest pack is a few hundred KiB). */
const MAX_BODY_BYTES = 128 * 1024 * 1024;

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

function gitResponseToHttp(response: GitResponse): HttpResponse {
  return { status: response.status, headers: { 'content-type': response.contentType }, body: response.body };
}

function route(ctx: RequestContext): HttpResponse {
  const { pathname } = ctx;
  if (pathname === '/healthz') {
    if (ctx.method !== 'GET') return jsonError(404, 'Not Found');
    return {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: Buffer.from('{"ok": true}', 'utf8'),
    };
  }
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const segments = pathname.slice('/api/v3'.length).split('/').filter((segment) => segment !== '');
    return handleRest({ ...ctx, segments });
  }
  if (pathname === '/api/graphql') return handleGraphQL(ctx);
  if (pathname === '/mcp') return handleMcp(ctx);
  const git = GIT_ROUTE.exec(pathname);
  if (git !== null) {
    const owner = decodeURIComponent(git[1] as string);
    const repoName = decodeURIComponent(git[2] as string);
    const endpoint = git[3] as string;
    const gitProtocol = (ctx.headers['git-protocol'] as string | undefined) ?? null;
    if (endpoint === 'info/refs' && ctx.method === 'GET') {
      return gitResponseToHttp(handleInfoRefs(owner, repoName, ctx.query.get('service'), gitProtocol));
    }
    if (endpoint === 'git-upload-pack' && ctx.method === 'POST') {
      return gitResponseToHttp(handleUploadPack(owner, repoName, ctx.body, gitProtocol));
    }
    if (endpoint === 'git-receive-pack' && ctx.method === 'POST') {
      return gitResponseToHttp(handleReceivePack(owner, repoName, ctx.body));
    }
    return jsonError(404, 'Not Found');
  }
  return jsonError(404, 'Not Found');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejected = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!rejected) {
        rejected = true;
        reject(err);
      }
    });
  });
}

function sendResponse(res: ServerResponse, response: HttpResponse): void {
  res.writeHead(response.status, {
    ...response.headers,
    'content-length': response.body.length,
  });
  res.end(response.body);
}

/** Build the forge's HTTP server. The caller binds it (port 0) and owns its lifetime. */
export function createForgeServer(): Server {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const host = (req.headers['host'] as string | undefined) ?? '127.0.0.1';
        const url = new URL(req.url ?? '/', `http://${host}`);
        const ctx: RequestContext = {
          method: req.method ?? 'GET',
          pathname: url.pathname,
          segments: [],
          query: url.searchParams,
          headers: req.headers as Record<string, string | string[] | undefined>,
          body,
          host,
        };
        sendResponse(res, route(ctx));
      } catch (err) {
        if ((err as Error).message === 'request body too large') {
          sendResponse(res, jsonError(413, 'Request body too large'));
          return;
        }
        // A handler failure must never kill the process: log it, answer 500 and carry on.
        console.error(
          `[forge] handler error for ${req.method ?? 'GET'} ${req.url ?? '/'}: ${err instanceof Error ? err.message : err}`,
        );
        try {
          sendResponse(res, jsonError(500, 'Internal Server Error'));
        } catch {
          // the socket is already gone; nothing left to do
        }
      }
    })();
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 65_000;
  server.on('clientError', (err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return server;
}
