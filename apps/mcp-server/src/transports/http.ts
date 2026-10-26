import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServerForToken } from '../server.js';
import type { McpServerConfig } from '../config.js';
import { MCP_MAX_BODY_BYTES, mcpBodyShapeRefusal } from './body-shape.js';

/**
 * Run the server over Streamable HTTP — the transport remote clients such as ChatGPT's
 * developer-mode connectors use.
 *
 * The endpoint is stateless: a fresh server and transport are built per request
 * (`sessionIdGenerator: undefined`), which is the SDK's documented shape for a horizontally
 * scalable remote server and avoids any cross-request session state.
 *
 * Each request authenticates with its own token. A client that sends `Authorization: Bearer
 * <token>` acts as that token's member, so one server serves many members, each as themselves.
 * There is no anonymous fallback: a request without the header is refused 401 before any TManage
 * call is made, even when `TMANAGE_TOKEN` is set (that token is for stdio only). A request whose
 * `Host` header is not one of `config.allowedHosts` is refused 403 (DNS-rebinding protection),
 * and the SDK transport enforces the same list.
 *
 * After the Bearer check the body is capped before the SDK (and its zod parse) sees it (audit run
 * 3, M02): more than {@link MCP_MAX_BODY_BYTES} is refused 413 without reading the rest, and a body
 * past the shape caps in `./body-shape.ts` is refused 400. Neither builds a server.
 */
const MCP_PATH = '/mcp';

/** The two steps the handler hands an accepted request to; a test may observe them. */
export interface HttpHandlerDeps {
  readonly buildServer: typeof buildServerForToken;
  readonly serve: typeof serveMcpRequest;
}

export function createHttpHandler(config: McpServerConfig, deps: Partial<HttpHandlerDeps> = {}) {
  const buildServer = deps.buildServer ?? buildServerForToken;
  const serve = deps.serve ?? serveMcpRequest;
  const allowedHosts = new Set(config.allowedHosts.map((h) => h.toLowerCase()));
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
    if (!allowedHosts.has(host)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Host not allowed.' }));
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${MCP_PATH}.` }));
      return;
    }

    const token = bearerToken(req);
    if (!token) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer',
      });
      res.end(
        JSON.stringify({
          error: 'Missing token. Send Authorization: Bearer <personal access token>.',
        }),
      );
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        // Nothing past the cap is kept. The connection closes after the answer; the rest of the
        // body is discarded (never buffered) for a bounded moment so the client can read the 413,
        // then the request is destroyed.
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: 'Request body too large.' }));
        discardThenDestroy(req);
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body is not valid JSON.' }));
      return;
    }

    if (mcpBodyShapeRefusal(body) !== undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body is too large to process.' }));
      return;
    }

    await serve(buildServer(config, token), req, res, body, {
      allowedHosts: config.allowedHosts,
    });
  };
}

/**
 * Answer one Streamable HTTP request with a fresh, stateless server. Shared by this package's own
 * listener and by the TManage API's hosted `/mcp` endpoint, which builds the server against an
 * in-process API client and has already authenticated the caller.
 *
 * `enableJsonResponse` answers a POST with one JSON body instead of an SSE stream — every tool
 * here returns a single result, and a plain JSON response passes through proxies unchanged.
 * `allowedHosts`, when given, turns on the SDK's DNS-rebinding protection for that host list
 * (this package's standalone listener passes it; the hosted API endpoint has its own edge).
 */
export async function serveMcpRequest(
  server: McpServer,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  options: {
    readonly enableJsonResponse?: boolean;
    readonly allowedHosts?: readonly string[];
  } = {},
): Promise<void> {
  // `sessionIdGenerator: undefined` is the SDK's documented stateless mode. The two casts
  // below bridge this workspace's `exactOptionalPropertyTypes: true` and the SDK's option and
  // Transport types, which are not authored with that flag — the values are exactly what the
  // SDK expects at runtime.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: options.enableJsonResponse ?? false,
    ...(options.allowedHosts !== undefined
      ? { enableDnsRebindingProtection: true, allowedHosts: [...options.allowedHosts] }
      : {}),
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
  await transport.handleRequest(req, res, body);
}

/** Start listening. Returns the Node HTTP server so a caller (or a test) can close it. */
export async function runHttp(config: McpServerConfig): Promise<ReturnType<typeof createServer>> {
  const handler = createHttpHandler(config);
  const httpServer = createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(config.httpPort, config.httpHost, resolve),
  );
  process.stderr.write(
    `tmanage-mcp: Streamable HTTP ready at http://${config.httpHost}:${config.httpPort}${MCP_PATH} ` +
      `(API ${config.apiUrl})\n`,
  );
  return httpServer;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : undefined;
}

/** After a 413, at most this many more bytes are discarded before the request is destroyed. */
const DISCARD_MAX_BYTES = MCP_MAX_BODY_BYTES;
/** After a 413, the request is destroyed this long after the answer at the latest. */
const DISCARD_MAX_MS = 2_000;

/**
 * Read and drop the rest of a refused body so the client sees the 413 instead of a reset, but
 * destroy the request as soon as it sends more than {@link DISCARD_MAX_BYTES} further bytes (or
 * declared that many up front) or takes longer than {@link DISCARD_MAX_MS}. Nothing is buffered.
 */
function discardThenDestroy(req: IncomingMessage): void {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MCP_MAX_BODY_BYTES + DISCARD_MAX_BYTES) {
    req.destroy();
    return;
  }
  let discarded = 0;
  const timer = setTimeout(() => req.destroy(), DISCARD_MAX_MS);
  timer.unref();
  req.on('data', (chunk: Buffer | string) => {
    discarded += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (discarded > DISCARD_MAX_BYTES) {
      clearTimeout(timer);
      req.destroy();
    }
  });
  req.on('close', () => clearTimeout(timer));
  req.resume();
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large.');
  }
}

/**
 * Read the body as JSON, refusing more than {@link MCP_MAX_BODY_BYTES}: a `content-length` past
 * the cap is refused before a byte is read, and a body without one (chunked) stops being read at
 * the first chunk that crosses it. Rejects {@link BodyTooLargeError} for either, a SyntaxError for
 * malformed JSON.
 */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = req.headers['content-length'];
  if (declared !== undefined && Number(declared) > MCP_MAX_BODY_BYTES) {
    req.pause();
    return Promise.reject(new BodyTooLargeError());
  }
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > MCP_MAX_BODY_BYTES) {
        cleanup();
        chunks.length = 0;
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error instanceof Error ? error : new SyntaxError(String(error)));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}
