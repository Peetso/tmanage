import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ReadStream } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiConnectorFallbacksController,
  BRIDGE_TARBALL_NAME,
  defaultBridgeTarballPath,
  resolveBridgeTarballPath,
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

describe('the default bridge tarball path (no TMANAGE_MCP_BRIDGE_PATH)', () => {
  /** A bundle laid out as deploy/hostinger/build.mjs writes it and npm installs it. */
  function bundle(withTarball: boolean): { root: string; moduleUrl: string } {
    const root = mkdtempSync(join(tmpdir(), 'tmanage-bundle-'));
    tmpDirs.push(root);
    const moduleDir = join(root, 'node_modules', '@tmanage', 'api', 'dist', 'modules', 'mcp');
    mkdirSync(moduleDir, { recursive: true });
    if (withTarball) {
      mkdirSync(join(root, 'downloads'));
      writeFileSync(join(root, 'downloads', BRIDGE_TARBALL_NAME), 'tgz');
    }
    const moduleUrl = pathToFileURL(join(moduleDir, 'ai-connector-fallbacks.controller.js')).href;
    return { root, moduleUrl };
  }
  const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

  it('resolves to the bundle root downloads/tmanage-mcp.tgz, whatever the working directory', () => {
    const { root, moduleUrl } = bundle(true);
    const path = defaultBridgeTarballPath({ moduleUrl, cwd: tmpdir(), isFile });
    expect(path).toBe(join(root, 'downloads', BRIDGE_TARBALL_NAME));
  });

  it('falls back to <cwd>/downloads/tmanage-mcp.tgz outside node_modules', () => {
    const { root } = bundle(true);
    const moduleUrl = pathToFileURL(join(root, 'apps', 'api', 'dist', 'x.js')).href;
    expect(defaultBridgeTarballPath({ moduleUrl, cwd: root, isFile })).toBe(
      join(root, 'downloads', BRIDGE_TARBALL_NAME),
    );
  });

  it('is undefined when the bundle has no tarball, so the route answers 503', async () => {
    const { root, moduleUrl } = bundle(false);
    const path = defaultBridgeTarballPath({ moduleUrl, cwd: root, isFile });
    expect(path).toBeUndefined();
    const reply = new FakeReply();
    await controller({ baseUrl: 'http://localhost', bridgeTarballPath: path }).bridgeTarball(
      reply as never,
    );
    expect(reply.statusCode).toBe(503);
  });

  it('serves the bundled tarball with no environment variable set', async () => {
    const { root, moduleUrl } = bundle(true);
    const path = resolveBridgeTarballPath({}, { moduleUrl, cwd: root, isFile });
    const reply = new FakeReply();
    await controller({ baseUrl: 'http://localhost', bridgeTarballPath: path }).bridgeTarball(
      reply as never,
    );
    expect(reply.statusCode).toBe(200);
    // Drain before afterEach removes the bundle (the stream opens lazily).
    const text = await new Promise<string>((done, fail) => {
      let body = '';
      const stream = reply.payload as ReadStream;
      stream.on('data', (chunk: Buffer | string) => (body += chunk.toString()));
      stream.on('end', () => done(body));
      stream.on('error', fail);
    });
    expect(text).toBe('tgz');
  });

  it('lets TMANAGE_MCP_BRIDGE_PATH override the bundled default', () => {
    const { moduleUrl } = bundle(true);
    expect(
      resolveBridgeTarballPath(
        { TMANAGE_MCP_BRIDGE_PATH: ' /srv/bridge.tgz ' },
        { moduleUrl, cwd: tmpdir(), isFile },
      ),
    ).toBe('/srv/bridge.tgz');
  });

  it('considers only the exact tarball path, never another file under downloads/', () => {
    const { root, moduleUrl } = bundle(false);
    mkdirSync(join(root, 'downloads'));
    writeFileSync(join(root, 'downloads', 'other.tgz'), 'x');
    const seen: string[] = [];
    defaultBridgeTarballPath({
      moduleUrl,
      cwd: root,
      isFile: (p) => {
        seen.push(p);
        return false;
      },
    });
    expect(seen.every((p) => p.endsWith(join('downloads', BRIDGE_TARBALL_NAME)))).toBe(true);
  });
});
