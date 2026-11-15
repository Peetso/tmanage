import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { buildCatalogServer, CATALOG_SERVER_NAME, CATALOG_SERVER_VERSION } from './catalog.js';
import type { Catalog, CatalogRuntime } from './catalog.js';
import { serverIdentity } from './server-identity.js';
import { serveMcpRequest } from './transports/http.js';

const SITE = 'https://tmanage.example.com';
const EMPTY: Catalog = { profile: 'compact', tools: [], resources: [], prompts: [] };
/** Never called: `initialize` runs no tool and reads no resource. */
const RUNTIME = {} as CatalogRuntime;

/**
 * POST a JSON body through node:http, not fetch(). listen(0) takes a port from the OS dynamic
 * range, which on Windows can start at 1024 and so hand out a port on the fetch spec's blocked list
 * (6000, 6665, 10080, ...) — undici then throws "bad port" before sending anything. node:http has
 * no such list (same fix as transports/wave9-s7-http-auth.test.ts).
 */
function postJson(port: number, body: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
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
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** POST one JSON-RPC `initialize` to a stateless MCP endpoint and return the parsed reply. */
async function initializeOverHttp(siteUrl: string | undefined): Promise<Record<string, unknown>> {
  const http = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      void serveMcpRequest(buildCatalogServer(EMPTY, RUNTIME, siteUrl), req, res, JSON.parse(raw), {
        enableJsonResponse: true,
      });
    });
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  try {
    const { port } = http.address() as AddressInfo;
    const response = await postJson(
      port,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    );
    expect(response.status).toBe(200);
    return JSON.parse(response.text) as Record<string, unknown>;
  } finally {
    await new Promise<void>((done) => http.close(() => done()));
  }
}

describe('serverInfo carries the TManage icon (Claude connector)', () => {
  it('sends title, websiteUrl and the PNG + SVG icons on the wire in the initialize result', async () => {
    const reply = await initializeOverHttp(`${SITE}/`);
    const result = reply['result'] as { serverInfo: Record<string, unknown> };
    expect(result.serverInfo).toEqual({
      name: CATALOG_SERVER_NAME,
      version: CATALOG_SERVER_VERSION,
      title: 'TManage',
      websiteUrl: `${SITE}/`,
      icons: [
        { src: `${SITE}/brand/tmanage-icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
        { src: `${SITE}/brand/tmanage-maskable.svg`, mimeType: 'image/svg+xml', sizes: ['any'] },
      ],
    });
  });

  it('sends no icon URL when no public site URL is configured', async () => {
    const reply = await initializeOverHttp(undefined);
    const result = reply['result'] as { serverInfo: Record<string, unknown> };
    expect(result.serverInfo).toEqual({
      name: CATALOG_SERVER_NAME,
      version: CATALOG_SERVER_VERSION,
      title: 'TManage',
    });
  });

  it('uses only the origin of the site URL and ignores a non-http one', () => {
    expect(serverIdentity('n', '1', 'https://app.example.com/api/').icons?.[0]?.src).toBe(
      'https://app.example.com/brand/tmanage-icon-512.png',
    );
    expect(serverIdentity('n', '1', 'javascript:alert(1)').icons).toBeUndefined();
    expect(serverIdentity('n', '1', 'not a url').websiteUrl).toBeUndefined();
  });
});
