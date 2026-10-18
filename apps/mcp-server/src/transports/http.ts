import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildServerForToken } from '../server.js';
import type { McpServerConfig } from '../config.js';

/**
 * Run the server over Streamable HTTP — the transport remote clients such as ChatGPT's
 * developer-mode connectors use.
 *
 * The endpoint is stateless: a fresh server and transport are built per request
 * (`sessionIdGenerator: undefined`), which is the SDK's documented shape for a horizontally
 * scalable remote server and avoids any cross-request session state.
 *
 * Each request authenticates with its own token. A client that sends `Authorization: Bearer
 * <token>` acts as that token's member, so one server serves many members, each as themselves;
 * a request without the header falls back to the env `TMANAGE_TOKEN`, if one is set. A request
 * with neither is refused 401 before any TManage call is made.
 */
const MCP_PATH = '/mcp';

export function createHttpHandler(config: McpServerConfig) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `Not found. The MCP endpoint is ${MCP_PATH}.` }));
      return;
    }

    const token = bearerToken(req) ?? config.token;
    if (!token) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Missing token. Send Authorization: Bearer <personal access token>, or set ' +
            'TMANAGE_TOKEN on the server.',
        }),
      );
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body is not valid JSON.' }));
      return;
    }

    await serveMcpRequest(buildServerForToken(config, token), req, res, body);
  };
}

/**
 * Answer one Streamable HTTP request with a fresh, stateless server. Shared by this package's own
 * listener and by the TManage API's hosted `/mcp` endpoint, which builds the server against an
 * in-process API client and has already authenticated the caller.
 *
 * `enableJsonResponse` answers a POST with one JSON body instead of an SSE stream — every tool
 * here returns a single result, and a plain JSON response passes through proxies unchanged.
 */
export async function serveMcpRequest(
  server: McpServer,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  options: { readonly enableJsonResponse?: boolean } = {},
): Promise<void> {
  // `sessionIdGenerator: undefined` is the SDK's documented stateless mode. The two casts
  // below bridge this workspace's `exactOptionalPropertyTypes: true` and the SDK's option and
  // Transport types, which are not authored with that flag — the values are exactly what the
  // SDK expects at runtime.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: options.enableJsonResponse ?? false,
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return undefined;
  return JSON.parse(raw);
}
