import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { DynamicModule, OnApplicationBootstrap, Provider } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Principal } from '@tmanage/domain';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { Ctx, CurrentPrincipal, Public, RequireCapability } from '../../common/http/decorators.js';
import {
  clientAddressKey,
  createFixedWindowLimiter,
  type RequestAdmission,
} from '../../common/http/rate-limiter.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { API_CONFIG, AUDIT_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { AuditService } from '../audit/audit.service.js';
import {
  SCIM_BASE_PATH,
  SCIM_CONTENT_TYPE,
  ScimError,
  resourceTypes,
  schemas,
  serviceProviderConfig,
} from './scim-protocol.js';
import {
  ScimService,
  type ScimCaller,
  type ScimKeyCreatedView,
  type ScimSettingsView,
} from './scim.service.js';

/** DI tokens, co-located with the slice (ADR-0003). */
export const SCIM_SERVICE = Symbol.for('tmanage.ScimService');
export const SCIM_ADMISSION = Symbol.for('tmanage.ScimAdmission');

/** Two windows: per client address before the key is looked at, and per key after. */
export interface ScimAdmission {
  readonly address: RequestAdmission;
  readonly key: RequestAdmission;
}

interface RequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}

/** Fastify's reply, as far as these routes use it. */
export interface ScimReply {
  status(code: number): ScimReply;
  header(name: string, value: string): ScimReply;
  send(payload?: string): unknown;
}

/**
 * 54-16 — the owner's provisioning keys, beside company sign-in. `org.security.manage` at the
 * route, the company owner in the service. Withheld from the AI action registry like SSO.
 *
 * - `GET    …/security/scim` — whether keys are possible (SSO set up), the base URL, live keys.
 * - `POST   …/security/scim/keys` `{name}` — a new key; the secret is in this answer only.
 * - `DELETE …/security/scim/keys/:keyId` — revoke one.
 */
@Controller('v1/organizations/:orgSlug/security/scim')
export class ScimSettingsController {
  constructor(@Inject(SCIM_SERVICE) private readonly service: ScimService) {}

  @Get()
  @RequireCapability('org.security.manage')
  read(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ScimSettingsView> {
    return this.service.settings(context, principal);
  }

  @Post('keys')
  @HttpCode(201)
  @RequireCapability('org.security.manage')
  create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: unknown,
  ): Promise<ScimKeyCreatedView> {
    return this.service.createKey(context, principal, body);
  }

  @Delete('keys/:keyId')
  @RequireCapability('org.security.manage')
  revoke(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('keyId') keyId: string,
  ): Promise<ScimSettingsView> {
    return this.service.revokeKey(context, principal, keyId);
  }
}

type Work = (caller: ScimCaller) => Promise<{ readonly status: number; readonly body?: unknown }>;

/**
 * 54-16 — the SCIM 2.0 service provider (RFC 7644) under `/v1/scim/v2`. Public to the session
 * guards: the bearer key is the only credential and names the organization. Every answer, errors
 * included, is `application/scim+json`. Unknown, revoked and other-organization keys all answer
 * the same 401; a resource of another organization is the same 404 as a missing one.
 */
@Controller('v1/scim/v2')
@Public()
export class ScimController {
  constructor(
    @Inject(SCIM_SERVICE) private readonly service: ScimService,
    @Inject(SCIM_ADMISSION) private readonly admission: ScimAdmission,
  ) {}

  @Get('ServiceProviderConfig')
  config(@Req() request: RequestLike, @Res() reply: ScimReply): Promise<unknown> {
    return this.run(request, reply, async () => ({
      status: 200,
      body: serviceProviderConfig(this.service.baseUrl()),
    }));
  }

  @Get('ResourceTypes')
  types(@Req() request: RequestLike, @Res() reply: ScimReply): Promise<unknown> {
    return this.run(request, reply, async () => {
      const list = resourceTypes(this.service.baseUrl());
      return {
        status: 200,
        body: { schemas: [SCIM_LIST], totalResults: list.length, Resources: list },
      };
    });
  }

  @Get('Schemas')
  schemaList(@Req() request: RequestLike, @Res() reply: ScimReply): Promise<unknown> {
    return this.run(request, reply, async () => {
      const list = schemas(this.service.baseUrl());
      return {
        status: 200,
        body: { schemas: [SCIM_LIST], totalResults: list.length, Resources: list },
      };
    });
  }

  @Get('Users')
  listUsers(
    @Query() query: Record<string, unknown>,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 200,
      body: await this.service.listUsers(c, query),
    }));
  }

  @Get('Users/:id')
  getUser(
    @Param('id') id: string,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 200,
      body: await this.service.getUser(c, id),
    }));
  }

  @Post('Users')
  createUser(
    @Body() body: unknown,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 201,
      body: await this.service.createUser(c, body),
    }));
  }

  @Put('Users/:id')
  replaceUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 200,
      body: await this.service.replaceUser(c, id, body),
    }));
  }

  @Patch('Users/:id')
  patchUser(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 200,
      body: await this.service.patchUser(c, id, body),
    }));
  }

  @Delete('Users/:id')
  deleteUser(
    @Param('id') id: string,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => {
      await this.service.deleteUser(c, id);
      return { status: 204 };
    });
  }

  @Get('Groups')
  listGroups(
    @Query() query: Record<string, unknown>,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 200,
      body: await this.service.listGroups(c, query),
    }));
  }

  @Get('Groups/:id')
  getGroup(
    @Param('id') id: string,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 200,
      body: await this.service.getGroup(c, id),
    }));
  }

  @Post('Groups')
  createGroup(
    @Body() body: unknown,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 201,
      body: await this.service.createGroup(c, body),
    }));
  }

  @Put('Groups/:id')
  replaceGroup(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 200,
      body: await this.service.replaceGroup(c, id, body),
    }));
  }

  @Patch('Groups/:id')
  patchGroup(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => ({
      status: 200,
      body: await this.service.patchGroup(c, id, body),
    }));
  }

  @Delete('Groups/:id')
  deleteGroup(
    @Param('id') id: string,
    @Req() r: RequestLike,
    @Res() reply: ScimReply,
  ): Promise<unknown> {
    return this.run(r, reply, async (c) => {
      await this.service.deleteGroup(c, id);
      return { status: 204 };
    });
  }

  /** Rate limits, then the key, then the work; a {@link ScimError} becomes the SCIM error body. */
  private async run(request: RequestLike, reply: ScimReply, work: Work): Promise<unknown> {
    const send = (status: number, body?: unknown) => {
      reply.status(status).header('content-type', `${SCIM_CONTENT_TYPE}; charset=utf-8`);
      return body === undefined ? reply.send() : reply.send(JSON.stringify(body));
    };
    try {
      if (!this.admission.address(clientAddressKey(request.ip))) {
        throw new ScimError(429, 'Too many requests. Try again later.');
      }
      const correlationId = requireRequestState(request).correlationId;
      const caller = await this.service.authenticate(
        request.headers['authorization'],
        correlationId,
      );
      if (!this.admission.key(caller.keyId))
        throw new ScimError(429, 'Too many requests. Try again later.');
      const result = await work(caller);
      return send(result.status, result.body);
    } catch (error) {
      if (error instanceof ScimError) {
        if (error.status === 401) reply.header('www-authenticate', 'Bearer realm="tmanage-scim"');
        return send(error.status, error.body());
      }
      throw error;
    }
  }
}

const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

/** The path of a request URL, without its query or fragment. */
export function isScimPath(url: string | undefined): boolean {
  if (typeof url !== 'string') return false;
  const end = url.search(/[?#]/u);
  const path = end === -1 ? url : url.slice(0, end);
  return path === SCIM_BASE_PATH || path.startsWith(`${SCIM_BASE_PATH}/`);
}

interface JsonParseCapable {
  hasContentTypeParser(contentType: string): boolean;
  addContentTypeParser(
    contentType: string,
    options: { parseAs: 'string' },
    handler: (
      request: { readonly url?: string; readonly is404?: boolean },
      body: string,
      done: (error: Error | null, value?: unknown) => void,
    ) => void,
  ): void;
}

/**
 * Providers send `application/scim+json` (RFC 7644 §3.1), which Fastify does not parse. This
 * registers a JSON parser for that type at boot, scoped to `/v1/scim/v2` (415 everywhere else),
 * the `OAuthFormBodyParser` pattern. Idempotent; a standalone application context does nothing.
 */
@Injectable()
export class ScimBodyParser implements OnApplicationBootstrap {
  constructor(@Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost) {}

  onApplicationBootstrap(): void {
    const adapter = this.adapterHost.httpAdapter as
      HttpAdapterHost['httpAdapter'] | null | undefined;
    if (adapter == null) return;
    const instance = adapter.getInstance<JsonParseCapable>();
    if (instance.hasContentTypeParser(SCIM_CONTENT_TYPE)) return;
    instance.addContentTypeParser(
      SCIM_CONTENT_TYPE,
      { parseAs: 'string' },
      (request, body, done) => {
        if (request.is404 === true) {
          done(null, {});
          return;
        }
        if (!isScimPath(request.url)) {
          done(new UnsupportedMediaTypeException());
          return;
        }
        try {
          done(null, body === '' ? {} : (JSON.parse(body) as unknown));
        } catch {
          done(null, { __invalidJson: true });
        }
      },
    );
  }
}

/** Always registered: without SSO no key can be created, so every SCIM call answers 401. */
@Module({})
export class ScimModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: SCIM_SERVICE,
      inject: [TENANT_DATABASE, AUDIT_SERVICE, API_CONFIG],
      useFactory: (database: TenantDatabase, audit: AuditService, config: ApiConfig) =>
        new ScimService({ database, audit, webPublicUrl: config.webPublicUrl ?? '' }),
    };
    const admission: Provider = {
      provide: SCIM_ADMISSION,
      useFactory: (): ScimAdmission => ({
        address: createFixedWindowLimiter({ windowMs: 60 * 1000, max: 600 }),
        key: createFixedWindowLimiter({ windowMs: 60 * 1000, max: 300 }),
      }),
    };
    return {
      module: ScimModule,
      providers: [service, admission, ScimBodyParser],
      controllers: [ScimSettingsController, ScimController],
    };
  }
}
