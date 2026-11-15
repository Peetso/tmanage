import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config.js';
import type { McpServerConfig } from '../config.js';
import { createHttpHandler } from './http.js';

/**
 * Wave 9 S7 / audit F04: the standalone Streamable HTTP listener must never lend the operator's
 * TMANAGE_TOKEN to a peer that sent no credential, and must refuse a foreign Host header.
 */

const OPERATOR_TOKEN = 'tmanage_pat_operator_secret_value';
let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function start(token: string | undefined): Promise<{ port: number }> {
  server = createServer();
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const config: McpServerConfig = {
    apiUrl: 'http://127.0.0.1:9/api',
    token,
    transport: 'http',
    httpPort: port,
    httpHost: '127.0.0.1',
    orgSlug: undefined,
    allowedHosts: [`127.0.0.1:${port}`, `localhost:${port}`],
  };
  const handler = createHttpHandler(config);
  server.on('request', (req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  return { port };
}

const listTools = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

interface Reply {
  readonly status: number;
  text(): Promise<string>;
}

/**
 * POST through node:http, not fetch(). listen(0) takes a port from the OS dynamic range, which on
 * Windows can start at 1024 and so hand out a port on the fetch spec's blocked list (6000, 6665,
 * 10080, ...) — undici then throws "bad port" before sending anything. node:http has no such list.
 * The reply resolves as soon as its status line arrives: a 413 answers before the body is fully
 * sent, and a socket error the server causes after that answer is not the client's failure.
 */
function post(
  port: number,
  headers: Record<string, string>,
  body: string = listTools,
): Promise<Reply> {
  return new Promise<Reply>((resolve, reject) => {
    let answered = false;
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        const text = new Promise<string>((done, fail) => {
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
          res.on('error', fail);
        });
        // A reset after the answer must not surface as an unhandled rejection.
        text.catch(() => undefined);
        resolve({ status: res.statusCode ?? 0, text: () => text });
      },
    );
    req.on('error', (error) => {
      if (!answered) reject(error);
    });
    req.end(body);
  });
}

describe('F04 — MCP HTTP transport requires a bearer on every request', () => {
  it('refuses a header-less request with 401 even when TMANAGE_TOKEN is set', async () => {
    const { port } = await start(OPERATOR_TOKEN);
    const res = await post(port, {});
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('tools');
  });

  it('refuses a foreign Host header with 403 (DNS rebinding)', async () => {
    const { port } = await start(undefined);
    const raw = await new Promise<number>((resolve, reject) => {
      // fetch() cannot override Host, so use node:http directly.
      import('node:http').then(({ request }) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path: '/mcp',
            method: 'POST',
            headers: {
              host: 'attacker.example:80',
              authorization: 'Bearer tmanage_pat_member',
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end(listTools);
      }, reject);
    });
    expect(raw).toBe(403);
  });

  it('serves a request that carries its own bearer token', async () => {
    const { port } = await start(undefined);
    const res = await post(port, { authorization: 'Bearer tmanage_pat_member' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('list_projects');
  });

  it('refuses an oversized body from a token holder with 413 (M02)', async () => {
    const { port } = await start(undefined);
    const res = await post(
      port,
      { authorization: 'Bearer tmanage_pat_member' },
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { pad: 'a'.repeat(1_048_577) },
      }),
    );
    expect(res.status).toBe(413);
  });
});

describe('F04 — config refuses the operator token on a network listener', () => {
  const base = { TMANAGE_API_URL: 'https://app.example.com/api', TMANAGE_MCP_TRANSPORT: 'http' };

  it('throws when TMANAGE_TOKEN is set with a non-loopback host', () => {
    expect(() =>
      loadConfig({ ...base, TMANAGE_TOKEN: OPERATOR_TOKEN, TMANAGE_MCP_HTTP_HOST: '0.0.0.0' }),
    ).toThrow(ConfigError);
  });

  it('accepts a non-loopback host without a token, with extra allowed hosts', () => {
    const config = loadConfig({
      ...base,
      TMANAGE_MCP_HTTP_HOST: '0.0.0.0',
      TMANAGE_MCP_ALLOWED_HOSTS: 'mcp.example.com',
    });
    expect(config.allowedHosts).toEqual(['0.0.0.0:8787', 'mcp.example.com']);
  });

  it('allows the loopback aliases on a loopback bind', () => {
    const config = loadConfig({ ...base, TMANAGE_MCP_HTTP_PORT: '9000' });
    expect(config.allowedHosts).toEqual(
      expect.arrayContaining(['127.0.0.1:9000', 'localhost:9000', '[::1]:9000']),
    );
  });
});
