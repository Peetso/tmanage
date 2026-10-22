import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Controller, Get, Inject, Module, Res } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import { Public, NoTenant } from '../../common/http/decorators.js';
import { API_CONFIG } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import { buildAiOpenApiDocument } from '../ai-actions/openapi.js';
import type { OpenApiDocument } from '../ai-actions/openapi.js';

/**
 * **AI connector fallbacks — slice S13 of the TManage AI connector (MCP).**
 *
 * Two public, unauthenticated GET routes for clients that cannot use the hosted `/mcp` endpoint
 * directly (plan §5 "GPT Actions / plain function calling" and "LM Studio … stdio bridge", and the
 * S13 slice):
 *
 *  - `GET /openapi/ai.json` — the OpenAPI 3.1 description of the AI action surface, generated from
 *    the same registry the MCP tool catalog is built from (`ai-actions/openapi.ts`). A GPT Action
 *    or a plain function-calling client reads this and then calls the REST routes with a personal
 *    access token. It covers only the safe and confirm ops; confirm ops document the approval link.
 *  - `GET /downloads/tmanage-mcp.tgz` — the downloadable stdio bridge (`@tmanage/mcp-server`),
 *    packed as an npm tarball, so a local-only client can run it with
 *    `npx -y https://<host>/downloads/tmanage-mcp.tgz` and a `TMANAGE_TOKEN`. The tarball is a
 *    deploy-time artifact (built with `pnpm --filter @tmanage/mcp-server pack`); the route streams
 *    it from the path given by `TMANAGE_MCP_BRIDGE_PATH`, and answers 503 with guidance when it has
 *    not been built on this host rather than pretending to serve it.
 *
 * Both are `@Public()` and `@NoTenant()`: discovery and download happen before any sign-in. The
 * OpenAPI document never exposes a route the registry withholds — `NEVER` entries are not ops, so
 * they can never appear (architecture B3).
 */

/** The DI token for this controller's resolved options. */
export const AI_FALLBACKS_OPTIONS = Symbol.for('tmanage.AiConnectorFallbacksOptions');

export interface AiConnectorFallbacksOptions {
  /** The API's public base URL, emitted as the OpenAPI `servers` entry. */
  readonly baseUrl: string;
  /** Absolute path to the prebuilt bridge tarball, or `undefined` when not configured. */
  readonly bridgeTarballPath: string | undefined;
}

/** The download name the bridge tarball is served under (what `npx` fetches). */
export const BRIDGE_TARBALL_NAME = 'tmanage-mcp.tgz';

interface FastifyReplyLike {
  status(code: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  type(contentType: string): FastifyReplyLike;
  send(payload: unknown): unknown;
}

@NoTenant()
@Controller()
export class AiConnectorFallbacksController {
  constructor(
    @Inject(AI_FALLBACKS_OPTIONS) private readonly options: AiConnectorFallbacksOptions,
  ) {}

  /** The generated OpenAPI 3.1 document. Cacheable; contains no per-caller or secret data. */
  @Get('openapi/ai.json')
  @Public()
  openApiDocument(): OpenApiDocument {
    return buildAiOpenApiDocument({ baseUrl: this.options.baseUrl });
  }

  /** Stream the prebuilt stdio-bridge tarball, or explain why it is not available on this host. */
  @Get('downloads/tmanage-mcp.tgz')
  @Public()
  async bridgeTarball(@Res() reply: FastifyReplyLike): Promise<unknown> {
    const path = this.options.bridgeTarballPath;
    const unavailable = (): unknown =>
      reply
        .status(503)
        .header('cache-control', 'no-store')
        .send({
          error: 'bridge_unavailable',
          message:
            'The TManage MCP stdio bridge tarball is not available on this server. Build it with ' +
            '`pnpm --filter @tmanage/mcp-server pack` and set TMANAGE_MCP_BRIDGE_PATH to the result.',
        });

    if (path === undefined) return unavailable();
    let size: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) return unavailable();
      size = info.size;
    } catch {
      return unavailable();
    }

    return reply
      .status(200)
      .type('application/gzip')
      .header('content-length', String(size))
      .header('content-disposition', `attachment; filename="${BRIDGE_TARBALL_NAME}"`)
      .header('cache-control', 'public, max-age=300')
      .send(createReadStream(path));
  }
}

/** The API's public base URL for the OpenAPI `servers` entry, or a safe local default. */
function publicBaseUrl(config: ApiConfig): string {
  const source = config.apiPublicUrl ?? config.webPublicUrl;
  if (source === undefined || source === '') return 'http://localhost';
  return source.replace(/\/+$/, '');
}

@Module({})
export class AiConnectorFallbacksModule {
  static register(): DynamicModule {
    const options: Provider = {
      provide: AI_FALLBACKS_OPTIONS,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): AiConnectorFallbacksOptions => ({
        baseUrl: publicBaseUrl(config),
        bridgeTarballPath: process.env['TMANAGE_MCP_BRIDGE_PATH']?.trim() || undefined,
      }),
    };
    return {
      module: AiConnectorFallbacksModule,
      providers: [options],
      controllers: [AiConnectorFallbacksController],
    };
  }
}
