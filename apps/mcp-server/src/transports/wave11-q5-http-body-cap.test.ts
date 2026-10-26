import { createServer, request } from 'node:http';
import type { OutgoingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '../config.js';
import { buildServerForToken } from '../server.js';
import {
  MCP_MAX_ARRAY_ITEMS,
  MCP_MAX_BODY_BYTES,
  MCP_MAX_DEPTH,
  MCP_MAX_JSON_VALUES,
  MCP_MAX_OBJECT_KEYS,
  mcpBodyShapeRefusal,
} from './body-shape.js';
import { createHttpHandler, serveMcpRequest } from './http.js';
import type { HttpHandlerDeps } from './http.js';

/**
 * Wave 11 Q5 / audit run 3 M02: the standalone Streamable HTTP listener caps a body's size
 * (1 MiB, 413) and shape (the API's mcp-body-shape rules, 400) after the Bearer check and before
 * the SDK — and its zod parse — ever sees it.
 */

const TOKEN = 'Bearer tmanage_pat_member';
let server: Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  server = undefined;
});

async function start(): Promise<{
  port: number;
  serve: ReturnType<typeof vi.fn<HttpHandlerDeps['serve']>>;
  build: ReturnType<typeof vi.fn<HttpHandlerDeps['buildServer']>>;
}> {
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const config: McpServerConfig = {
    apiUrl: 'http://127.0.0.1:9/api',
    token: undefined,
    transport: 'http',
    httpPort: port,
    httpHost: '127.0.0.1',
    orgSlug: undefined,
    allowedHosts: [`127.0.0.1:${port}`],
  };
  const serve = vi.fn<HttpHandlerDeps['serve']>(serveMcpRequest);
  const build = vi.fn<HttpHandlerDeps['buildServer']>(buildServerForToken);
  const handler = createHttpHandler(config, { serve, buildServer: build });
  server.on('request', (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return { port, serve, build };
}

/**
 * POST raw bytes with node:http. `chunked` leaves out content-length so only the streaming
 * counter can stop the body. Resolves on the response; a write error after the server closed
 * the connection on purpose is not a failure.
 */
function post(
  port: number,
  body: Buffer | string,
  options: { chunked?: boolean; authorization?: string } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (options.authorization !== undefined) headers['authorization'] = options.authorization;
    if (!options.chunked) headers['content-length'] = Buffer.byteLength(body);
    let answered = false;
    const req = request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers },
      (res) => {
        answered = true;
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }),
        );
        res.on('error', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }),
        );
      },
    );
    req.on('error', (error) => {
      if (!answered) reject(error);
    });
    if (options.chunked) {
      // Several writes so the server sees the body in pieces.
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const step = 64 * 1024;
      for (let offset = 0; offset < buffer.length; offset += step) {
        req.write(buffer.subarray(offset, offset + step));
      }
      req.end();
    } else {
      req.end(body);
    }
  });
}

function rpc(params: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
}

/** A valid JSON body of exactly `bytes` bytes. */
function bodyOfBytes(bytes: number): string {
  const head = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"';
  const tail = '"}}';
  return head + 'a'.repeat(bytes - head.length - tail.length) + tail;
}

function nested(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i += 1) value = [value];
  return value;
}

describe('M02 — size cap: more than 1 MiB is refused 413 before the SDK', () => {
  it('refuses a 1 MiB + 1 byte body declared by content-length', async () => {
    const { port, serve, build } = await start();
    const body = bodyOfBytes(MCP_MAX_BODY_BYTES + 1);
    expect(Buffer.byteLength(body)).toBe(MCP_MAX_BODY_BYTES + 1);
    const res = await post(port, body, { authorization: TOKEN });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toEqual({ error: 'Request body too large.' });
    expect(serve).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('refuses a 1 MiB + 1 byte chunked body (no content-length) by counting bytes', async () => {
    const { port, serve, build } = await start();
    const res = await post(port, bodyOfBytes(MCP_MAX_BODY_BYTES + 1), {
      chunked: true,
      authorization: TOKEN,
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.text)).toEqual({ error: 'Request body too large.' });
    expect(serve).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('destroys the request when far past the cap, and still never calls the SDK', async () => {
    const { port, serve, build } = await start();
    const outcome = await post(port, bodyOfBytes(3 * MCP_MAX_BODY_BYTES), {
      authorization: TOKEN,
    }).then(
      (res) => res.status,
      (error: NodeJS.ErrnoException) => error.code,
    );
    // Either the 413 got out before the reset, or the reset came first; never the SDK.
    expect([413, 'ECONNRESET', 'EPIPE', 'ECONNABORTED']).toContain(outcome);
    expect(serve).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('checks the Bearer first: an oversized body without a token is 401', async () => {
    const { port, serve } = await start();
    const res = await post(port, bodyOfBytes(MCP_MAX_BODY_BYTES + 1));
    expect(res.status).toBe(401);
    expect(serve).not.toHaveBeenCalled();
  });

  it('lets exactly 1 MiB through the size cap', async () => {
    const { port, serve } = await start();
    const res = await post(port, bodyOfBytes(MCP_MAX_BODY_BYTES), { authorization: TOKEN });
    expect(res.status).not.toBe(413);
    expect(serve).toHaveBeenCalledTimes(1);
  });
});

describe('M02 — shape cap: a body past the mcp-body-shape rules is refused 400 before the SDK', () => {
  const cases: ReadonlyArray<[string, unknown]> = [
    ['1,001 array items', { arguments: { ids: Array.from({ length: 1_001 }, () => 1) } }],
    [
      '20,001 values',
      {
        arguments: {
          lists: Array.from({ length: 21 }, () => Array.from({ length: 1_000 }, () => 1)),
        },
      },
    ],
    ['depth 33', { arguments: nested(33) }],
    [
      '1,001 object keys',
      { arguments: Object.fromEntries(Array.from({ length: 1_001 }, (_, i) => [`k${i}`, 1])) },
    ],
  ];

  for (const [name, params] of cases) {
    it(`refuses ${name} with 400 and never calls the SDK`, async () => {
      const { port, serve, build } = await start();
      const body = rpc(params);
      expect(Buffer.byteLength(body)).toBeLessThan(MCP_MAX_BODY_BYTES);
      const res = await post(port, body, { authorization: TOKEN });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text)).toEqual({ error: 'Request body is too large to process.' });
      expect(serve).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    });
  }

  it('the walk refuses exactly past each cap (local copy of the API rules)', () => {
    expect(MCP_MAX_ARRAY_ITEMS).toBe(1_000);
    expect(MCP_MAX_OBJECT_KEYS).toBe(1_000);
    expect(MCP_MAX_JSON_VALUES).toBe(20_000);
    expect(MCP_MAX_DEPTH).toBe(32);
    expect(mcpBodyShapeRefusal(Array.from({ length: 1_000 }, () => 1))).toBeUndefined();
    expect(mcpBodyShapeRefusal(Array.from({ length: 1_001 }, () => 1))).toBe('array_too_long');
    expect(mcpBodyShapeRefusal(nested(32))).toBeUndefined();
    expect(mcpBodyShapeRefusal(nested(33))).toBe('too_deep');
    expect(
      mcpBodyShapeRefusal(Array.from({ length: 21 }, () => Array.from({ length: 1_000 }, () => 1))),
    ).toBe('too_many_values');
  });
});

describe('M02 — a normal JSON-RPC body still reaches the SDK', () => {
  it('serves tools/list through serveMcpRequest', async () => {
    const { port, serve, build } = await start();
    const res = await post(
      port,
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      { authorization: TOKEN },
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('list_projects');
    expect(build).toHaveBeenCalledTimes(1);
    expect(serve).toHaveBeenCalledTimes(1);
  });
});
