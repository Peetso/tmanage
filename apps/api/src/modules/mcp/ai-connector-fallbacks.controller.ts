import { createReadStream, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 *    deploy-time artifact: deploy/hostinger/build.mjs packs `@tmanage/mcp-server` into the
 *    bundle's `downloads/tmanage-mcp.tgz`, and the route streams that file by default (see
 *    `defaultBridgeTarballPath`; `TMANAGE_MCP_BRIDGE_PATH` still overrides it). It answers 503 with
 *    guidance when the tarball is not on this host rather than pretending to serve it.
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
  /** Absolute path to the prebuilt bridge tarball, or `undefined` when there is none. */
  readonly bridgeTarballPath: string | undefined;
}

/** The download name the bridge tarball is served under (what `npx` fetches). */
export const BRIDGE_TARBALL_NAME = 'tmanage-mcp.tgz';

/** The bundle folder the deploy build writes the tarball into (apps/server `DOWNLOADS_DIR`). */
export const BRIDGE_DOWNLOADS_DIR = 'downloads';

export interface BridgePathInputs {
  /** This module's file URL (`import.meta.url`). */
  readonly moduleUrl: string;
  /** The process working directory. */
  readonly cwd: string;
  /** Whether a path is an existing regular file. */
  readonly isFile: (path: string) => boolean;
}

/**
 * The bundled tarball the API serves when `TMANAGE_MCP_BRIDGE_PATH` is unset, or `undefined`.
 *
 * In the Hostinger bundle this module is installed (copied, `install-links`) at
 * `<bundle>/node_modules/@tmanage/api/dist/...`, and the deploy build writes
 * `<bundle>/downloads/tmanage-mcp.tgz`. The bundle root is therefore the folder that holds the
 * outermost `node_modules`; the working directory is the fallback for any other layout. Only these
 * exact paths are ever considered — nothing under downloads/ but the one tarball is read.
 */
export function defaultBridgeTarballPath(inputs: BridgePathInputs): string | undefined {
  const candidates: string[] = [];
  const modulePath = fileURLToPath(inputs.moduleUrl);
  const marker = `${sep}node_modules${sep}`;
  const at = modulePath.indexOf(marker);
  if (at > 0)
    candidates.push(join(modulePath.slice(0, at), BRIDGE_DOWNLOADS_DIR, BRIDGE_TARBALL_NAME));
  candidates.push(resolve(inputs.cwd, BRIDGE_DOWNLOADS_DIR, BRIDGE_TARBALL_NAME));
  return candidates.find((path) => inputs.isFile(path));
}

/** `TMANAGE_MCP_BRIDGE_PATH` when set, else the bundled tarball (`defaultBridgeTarballPath`). */
export function resolveBridgeTarballPath(
  env: Record<string, string | undefined>,
  inputs: BridgePathInputs,
): string | undefined {
  return env['TMANAGE_MCP_BRIDGE_PATH']?.trim() || defaultBridgeTarballPath(inputs);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

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
            'The TManage MCP stdio bridge tarball is not available on this server. Deploy a bundle ' +
            'built with deploy/hostinger/build.mjs (it ships downloads/tmanage-mcp.tgz), or set ' +
            'TMANAGE_MCP_BRIDGE_PATH to a tarball packed with `pnpm --filter @tmanage/mcp-server pack`.',
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
        bridgeTarballPath: resolveBridgeTarballPath(process.env, {
          moduleUrl: import.meta.url,
          cwd: process.cwd(),
          isFile,
        }),
      }),
    };
    return {
      module: AiConnectorFallbacksModule,
      providers: [options],
      controllers: [AiConnectorFallbacksController],
    };
  }
}
