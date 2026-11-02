import { Readable } from 'node:stream';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Optional,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, Public, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { INBOUND_WEBHOOK_LIMITS, Throttle } from '../rate-limits/throttle-policies.js';
import { GithubHooksRepository } from './github-hooks.repository.js';
import { GithubHooksService } from './github-hooks.service.js';
import type {
  GithubHookSecretView,
  GithubHookView,
  GithubHooksDeps,
} from './github-hooks.service.js';

/** Nest token for the service's optional dependencies (tests inject a cipher and a clock). */
export const GITHUB_HOOKS_DEPS = Symbol('tmanage.automations.githubHooksDeps');

/** The largest body the inbound route reads (GitHub caps payloads at 25 MB; we keep 1 MiB). */
export const GITHUB_MAX_BODY_BYTES = 1024 * 1024;
const INBOUND_PATH = /^\/v1\/public\/integrations\/github\/[^/?#]+$/u;

/** `true` for the one URL whose raw body is kept for the HMAC check. */
export function isGithubInboundRoute(url: string | undefined): boolean {
  if (typeof url !== 'string') return false;
  const end = url.search(/[?#]/u);
  return INBOUND_PATH.test(end === -1 ? url : url.slice(0, end));
}

function service(database: TenantDatabase, deps: GithubHooksDeps): GithubHooksService {
  return new GithubHooksService(database, new GithubHooksRepository(), deps);
}

/**
 * R16-e (54-10 Phase 0) — managing pasted GitHub repository webhooks. All routes `org.manage`
 * (stand-in for the plan's `integration.manage`), re-checked with the real `authorize()`:
 *
 * - `POST   …/integrations/github/repo-hooks` — add one; the secret and URL are returned once.
 * - `GET    …/integrations/github/repo-hooks` — list (never the secret).
 * - `DELETE …/integrations/github/repo-hooks/:id` — remove (its delivery ids go with it).
 * - `POST   …/integrations/github/repo-hooks/:id/rotate-secret` — the new secret, once.
 */
@Controller('v1/organizations/:orgSlug/integrations/github')
export class GithubHooksController {
  private readonly service: GithubHooksService;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Optional() @Inject(GITHUB_HOOKS_DEPS) deps: GithubHooksDeps = {},
  ) {
    this.service = service(database, deps);
  }

  @Get('repo-hooks')
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly hooks: readonly GithubHookView[] }> {
    requireOrgManage(principal, context);
    return { hooks: await this.service.list(context) };
  }

  @Post('repo-hooks')
  @RequireCapability('org.manage')
  @HttpCode(201)
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { readonly repoFullName?: unknown; readonly projectIds?: unknown } | undefined,
  ): Promise<GithubHookSecretView> {
    requireOrgManage(principal, context);
    return this.service.create(context, principal, body);
  }

  @Delete('repo-hooks/:id')
  @RequireCapability('org.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<void> {
    requireOrgManage(principal, context);
    await this.service.remove(context, id);
  }

  @Post('repo-hooks/:id/rotate-secret')
  @RequireCapability('org.manage')
  @HttpCode(200)
  rotate(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<GithubHookSecretView> {
    requireOrgManage(principal, context);
    return this.service.rotateSecret(context, id);
  }
}

interface InboundRequest {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly rawBody?: Buffer;
}

interface InboundReply {
  status(code: number): unknown;
}

const header = (request: InboundRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * `POST /v1/public/integrations/github/:hookId` — GitHub's delivery. No session, no tenant in
 * the URL: the hook id resolves the organization. Every answer is bodiless (401 for an unknown
 * hook or a bad signature alike, 202 accepted or replayed, 204 ping, 429 over the hour budget).
 */
@Controller('v1/public/integrations/github')
export class GithubInboundController {
  private readonly service: GithubHooksService;

  constructor(
    @Inject(TENANT_DATABASE) database: TenantDatabase,
    @Optional() @Inject(GITHUB_HOOKS_DEPS) deps: GithubHooksDeps = {},
  ) {
    this.service = service(database, deps);
  }

  @Post(':hookId')
  @Public()
  @Throttle('github_inbound', { ...INBOUND_WEBHOOK_LIMITS, linkParam: 'hookId' })
  async receive(
    @Param('hookId') hookId: string,
    @Req() request: InboundRequest,
    @Res({ passthrough: true }) reply: InboundReply,
  ): Promise<void> {
    const status = await this.service.receive({
      hookId,
      rawBody: request.rawBody,
      signature: header(request, 'x-hub-signature-256'),
      deliveryId: header(request, 'x-github-delivery'),
      event: header(request, 'x-github-event'),
      correlationId: requireRequestState(request).correlationId,
    });
    reply.status(status);
  }
}

interface HookCapable {
  addHook(
    name: 'preParsing',
    hook: (
      request: { readonly url?: string; rawBody?: Buffer },
      reply: unknown,
      payload: NodeJS.ReadableStream,
    ) => Promise<NodeJS.ReadableStream>,
  ): void;
}

/**
 * Keeps the exact request bytes of the GitHub inbound route on `request.rawBody`, because the
 * HMAC is over the bytes GitHub sent, not over a re-serialised object. A `preParsing` hook,
 * registered at boot like `OAuthFormBodyParser`: for every other URL it hands the stream on
 * untouched and reads nothing; for this one it buffers at most {@link GITHUB_MAX_BODY_BYTES}
 * (413 above that) and gives Fastify's own JSON parser a fresh stream of the same bytes. If the
 * hook cannot be registered, the route has no raw body and answers 401: it fails closed.
 */
@Injectable()
export class GithubRawBodyCapture implements OnApplicationBootstrap {
  private readonly logger = new Logger('GithubRawBodyCapture');

  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    const adapter = this.adapterHost.httpAdapter as
      HttpAdapterHost['httpAdapter'] | null | undefined;
    if (adapter == null) return;
    try {
      adapter.getInstance<HookCapable>().addHook('preParsing', captureGithubRawBody);
    } catch (error) {
      this.logger.warn(`GitHub inbound raw-body capture not registered: ${String(error)}`);
    }
  }
}

export async function captureGithubRawBody(
  request: { readonly url?: string; rawBody?: Buffer },
  _reply: unknown,
  payload: NodeJS.ReadableStream,
): Promise<NodeJS.ReadableStream> {
  if (!isGithubInboundRoute(request.url)) return payload;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > GITHUB_MAX_BODY_BYTES) {
      throw Object.assign(new Error('Payload Too Large'), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  request.rawBody = raw;
  const replay = Readable.from([raw], { objectMode: false });
  return Object.assign(replay, { receivedEncodedLength: raw.length });
}

/** The belt-and-braces half of the route's `CapabilityGuard`: a refusal is a plain 403. */
function requireOrgManage(principal: Principal, context: TenantContext): void {
  const verdict = authorize({
    principal,
    capability: 'org.manage',
    resource: {
      organizationId: context.organizationId,
      projectId: null,
      audience: 'internal',
      lifecycle: 'active',
    },
  });
  if (!verdict.allowed) {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'github_hook_manage_denied',
    );
  }
}
