import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadStream } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiConnectorFallbacksController,
  BRIDGE_TARBALL_NAME,
} from './ai-connector-fallbacks.controller.js';
import type { AiConnectorFallbacksOptions } from './ai-connector-fallbacks.controller.js';
import { PAT_SECURITY_SCHEME } from '../ai-actions/openapi.js';

/** A fake Fastify reply that records the fluent calls the controller makes. */
class FakeReply {
  statusCode: number | undefined;
  contentType: string | undefined;
  readonly headers: Record<string, string> = {};
  payload: unknown;
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  type(contentType: string): this {
    this.contentType = contentType;
    return this;
  }
  header(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }
  send(payload: unknown): unknown {
    this.payload = payload;
    return payload;
  }
}

function controller(options: AiConnectorFallbacksOptions): AiConnectorFallbacksController {
  return new AiConnectorFallbacksController(options);
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AiConnectorFallbacksController — GET /openapi/ai.json', () => {
  it('serves the generated document with the configured base URL as the server', () => {
    const doc = controller({
      baseUrl: 'https://tmanage.example.com/api',
      bridgeTarballPath: undefined,
    }).openApiDocument() as Record<string, unknown>;
    expect(doc['openapi']).toBe('3.1.1');
    expect(doc['servers']).toEqual([{ url: 'https://tmanage.example.com/api' }]);
    expect(
      (
        (doc['components'] as Record<string, unknown>)['securitySchemes'] as Record<string, unknown>
      )[PAT_SECURITY_SCHEME],
    ).toBeDefined();
  });
});

describe('AiConnectorFallbacksController — GET /downloads/tmanage-mcp.tgz', () => {
  it('answers 503 with guidance when no bridge tarball is configured', async () => {
    const reply = new FakeReply();
    await controller({ baseUrl: 'http://localhost', bridgeTarballPath: undefined }).bridgeTarball(
      reply as never,
    );
    expect(reply.statusCode).toBe(503);
    expect((reply.payload as { error: string }).error).toBe('bridge_unavailable');
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('answers 503 when the configured path does not exist', async () => {
    const reply = new FakeReply();
    await controller({
      baseUrl: 'http://localhost',
      bridgeTarballPath: join(tmpdir(), 'tmanage-does-not-exist.tgz'),
    }).bridgeTarball(reply as never);
    expect(reply.statusCode).toBe(503);
  });

  it('streams the tarball with gzip type and an attachment disposition when present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tmanage-bridge-'));
    tmpDirs.push(dir);
    const path = join(dir, 'bridge.tgz');
    writeFileSync(path, Buffer.from('not-really-a-tarball-but-a-real-file'));

    const reply = new FakeReply();
    await controller({ baseUrl: 'http://localhost', bridgeTarballPath: path }).bridgeTarball(
      reply as never,
    );

    expect(reply.statusCode).toBe(200);
    expect(reply.contentType).toBe('application/gzip');
    expect(reply.headers['content-disposition']).toBe(
      `attachment; filename="${BRIDGE_TARBALL_NAME}"`,
    );
    expect(reply.headers['content-length']).toBe('36');
    expect(reply.payload).toBeInstanceOf(ReadStream);
    // Drain the stream while the file still exists, so its deferred open completes here rather
    // than racing the temp-dir cleanup in afterEach (and we confirm it streams the real bytes).
    const stream = reply.payload as ReadStream;
    const bytes = await new Promise<number>((resolve, reject) => {
      let total = 0;
      stream.on('data', (chunk: Buffer | string) => {
        total += chunk.length;
      });
      stream.on('end', () => resolve(total));
      stream.on('error', reject);
    });
    expect(bytes).toBe(36);
  });
});
