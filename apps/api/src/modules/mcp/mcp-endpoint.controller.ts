import {
  AI_PLATFORM_RIGHTS,
  aiPlatformRightsProvider,
  type AiPlatformRights,
} from './platform-rights.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Controller,
  Delete,
  Get,
  Inject,
  Logger,
  Module,
  Optional,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { buildCatalogServer, serveMcpRequest } from '@tmanage/mcp-server';
import type { CatalogProfile } from '@tmanage/mcp-server';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { NoTenant } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { CORRELATION_HEADER } from '../../common/http/correlation.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
import { API_CONFIG, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { RequestAdmission } from '../../common/http/rate-limiter.js';
import { argsSha256, INTERNAL_GRANT_HEADER, internalGrants } from './internal-grant.js';
import type { InternalGrantPayload } from './internal-grant.js';
import {
  AI_ACCESS_SWITCHES,
  aiAccessSwitchesProvider,
  aiPlatformDisabledError,
  aiWorkspaceDisabledError,
} from '../oauth/ai-access.js';
import type { AiAccessSwitches } from '../oauth/ai-access.js';
import { requiredScopeFor } from '../oauth/scopes.js';
import { PAT_SCOPES, grantCoversOp, liveMcpSurface, opsCalledBy } from './catalog-runtime.js';
import {
  MCP_OAUTH_AUTHENTICATOR,
  McpOAuthAuthenticator,
  mcpInsufficientScope,
  mcpOAuthAccessFor,
  type McpOAuthAccess,
  mcpResourceUri,
  mcpUnauthenticated,
} from './mcp-auth.js';
import { mcpBodyShapeRefusal } from './mcp-body-shape.js';
import { DatabaseMcpWorkspaceResolver, MCP_WORKSPACE_RESOLVER } from './mcp-workspace.js';
import { DatabaseMcpCallAuditor, MCP_CALL_AUDITOR, auditedRuntime } from './mcp-call-audit.js';
import type { McpCallAuditor } from './mcp-call-audit.js';
import type { McpWorkspaceResolver } from './mcp-workspace.js';
import { PENDING_AI_ACTIONS_SERVICE } from './pending-actions.service.js';
import type { PendingAiActionsService } from './pending-actions.service.js';

/**
 * **Hosted MCP endpoint — `POST /mcp` (Streamable HTTP, stateless).**
 *
 * Claude, ChatGPT and any MCP assistant connect to `https://<workspace host>/mcp` and sign in with
 * an OAuth access token from `/oauth/token` (the browser consent flow, plan §4.1) or a personal
 * access token (CLIs, Claude Code) as `Authorization: Bearer <token>`. No separate service runs.
 *
 * ## Scoped exactly like the REST API, because it IS the REST API
 *
 * 1. `SessionAuthGuard` authenticates the Bearer token before this handler runs. A refusal on
 *    `/mcp` carries `WWW-Authenticate: Bearer resource_metadata=…` so a client can find the
 *    authorization server. A browser cookie is not a way in.
 * 2. The tools are the S5 catalogue for the caller's grant — filtered by its scopes (a PAT keeps
 *    every scope) and the member's capabilities — and a call outside the scopes answers 403
 *    `insufficient_scope` before anything runs (T-SCP-01).
 * 3. Every tool call is an ordinary API request made in-process (`fastify.inject`) under a
 *    one-time internal grant, in the token's own workspace. It passes the full guard chain again —
 *    the one-organization binding (`TenantContextGuard`), capability and object checks — so a
 *    tool can do exactly what the member can do over REST, and nothing more.
 *
 * ## Rate limited, and the token is never logged
 *
 * Each token gets {@link MCP_MAX_REQUESTS_PER_WINDOW} MCP requests per minute, keyed by the token's
 * id (never its value). Nothing here logs a header; the token travels only in the in-process
 * request's `authorization` header.
 */

/** MCP requests one personal access token may make per window. */
export const MCP_MAX_REQUESTS_PER_WINDOW = 120;
export const MCP_WINDOW_MS = 60_000;

/** The in-process request base. Never dialled: requests are injected, not sent. */
export const IN_PROCESS_BASE_URL = 'http://tmanage.internal';

interface InjectResponse {
  readonly statusCode: number;
  readonly body: string;
  readonly headers: Record<string, unknown>;
}

/** The part of the Fastify instance this endpoint uses. */
export interface InjectCapable {
  inject(options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    payload?: string;
  }): Promise<InjectResponse>;
}

/** One redacted record of an inner tool call, for the audit trail (architecture B6). */
export interface McpCallRecord {
  readonly opId: string;
  /** A SHA-256 of the call's inputs. Never the inputs themselves, a body, or a token. */
  readonly argsSha256: string;
  readonly status: number;
  readonly latencyMs: number;
}

export interface InProcessFetchOptions {
  /** Mint a one-time internal grant for one inner call, named by its op id. */
  readonly mintGrant: (opId: string) => string;
  /** Threaded onto each inner inject so its audit rows tie back to the MCP request. */
  readonly correlationId: string;
  /** Called once per inner call with the redacted record. */
  readonly onCall?: (record: McpCallRecord) => void;
}

/**
 * A `fetch` that answers from this API in-process. The MCP API client is written against
 * `fetch`; this hands its requests to `fastify.inject`, so they go through the same router,
 * guards and filters as a network request — without leaving the process.
 *
 * **The AI client's credential is never forwarded (architecture B1/B3).** Whatever `Authorization`
 * the API client set is stripped, and a one-time internal grant nonce is carried in its place.
 * The inner inject therefore reaches the REST guard chain with no bearer token at all (`T-B3-03`),
 * and `SessionAuthGuard` turns the nonce back into the principal the outer request already proved.
 * Each inner call is recorded through {@link InProcessFetchOptions.onCall} with only its op id, an
 * args hash, the status and the latency — never a token or a body (architecture B6).
 */
export function inProcessFetch(app: InjectCapable, options: InProcessFetchOptions): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const method = (init?.method ?? 'GET').toUpperCase();
    const opId = `${method} ${url.pathname}`;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    // B1/B3. Drop the client's own credential and stand in a single-use internal grant. `Headers`
    // has already lower-cased the key, so this removes whatever the API client set.
    delete headers['authorization'];
    headers[INTERNAL_GRANT_HEADER] = options.mintGrant(opId);
    headers[CORRELATION_HEADER] = options.correlationId;

    const body = typeof init?.body === 'string' ? init.body : undefined;
    const startedAt = Date.now();
    const response = await app.inject({
      method,
      url: `${url.pathname}${url.search}`,
      headers,
      ...(body !== undefined ? { payload: body } : {}),
    });
    options.onCall?.({
      opId,
      // A hash of the call's inputs — the path, the query and the parsed body — so two identical
      // calls hash alike, with nothing sensitive recorded.
      argsSha256: argsSha256({
        path: url.pathname,
        search: url.search,
        body: body !== undefined ? safeJson(body) : null,
      }),
      status: response.statusCode,
      latencyMs: Date.now() - startedAt,
    });

    const contentType = response.headers['content-type'];
    return new Response(
      response.statusCode === 204 || response.body.length === 0 ? null : response.body,
      {
        status: response.statusCode,
        headers: {
          'content-type': typeof contentType === 'string' ? contentType : 'application/json',
        },
      },
    );
  }) as typeof fetch;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1];
}

interface FastifyRequestLike {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
  readonly raw: IncomingMessage;
}

interface FastifyReplyLike {
  readonly raw: ServerResponse;
  hijack(): void;
  status(code: number): FastifyReplyLike;
  header(name: string, value: string): FastifyReplyLike;
  send(payload: unknown): unknown;
}

/** `?tools=full` on the MCP URL picks the full profile (plan §3); anything else is compact. */
function toolsProfile(raw: IncomingMessage | undefined): CatalogProfile {
  const url = typeof raw?.url === 'string' ? raw.url : '/';
  return new URL(url, IN_PROCESS_BASE_URL).searchParams.get('tools') === 'full'
    ? 'full'
    : 'compact';
}

/**
 * ADR-0015 F1/F2: the step-up binding an `/mcp` request's inner calls carry, or `undefined`. A
 * personal access token never has one; an OAuth grant only with `tmanage:platform` recorded at
 * consent and only before the end of its own platform window.
 */
export function platformBindingOf(
  isPat: boolean,
  oauth: Pick<McpOAuthAccess, 'platform'> | undefined,
  now: number,
): { readonly stepUpSessionId: string; readonly until: number } | undefined {
  if (isPat || oauth?.platform === undefined) return undefined;
  return oauth.platform.until > now ? oauth.platform : undefined;
}

@NoTenant()
@Controller('mcp')
export class McpEndpointController {
  private readonly admit: RequestAdmission = createFixedWindowLimiter({
    windowMs: MCP_WINDOW_MS,
    max: MCP_MAX_REQUESTS_PER_WINDOW,
  });

  /** The per-call audit trail (architecture B6 / T-LOG-01). Redacted by construction. */
  private readonly logger = new Logger('McpCall');

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    /** S11: the platform and workspace AI kill switches. Absent only in unit tests. */
    @Optional()
    @Inject(AI_ACCESS_SWITCHES)
    private readonly aiAccess?: AiAccessSwitches,
    /** The token's own workspace (slug + member capabilities). Absent only in unit tests. */
    @Optional()
    @Inject(MCP_WORKSPACE_RESOLVER)
    private readonly workspaces?: McpWorkspaceResolver,
    /** For the challenge URLs (`API_PUBLIC_URL`). Absent only in unit tests. */
    @Optional()
    @Inject(API_CONFIG)
    private readonly config: Pick<ApiConfig, 'apiPublicUrl' | 'webPublicUrl'> = {},
    /** Plan §4.4: one `audit_events` row per tool call. Absent only in unit tests. */
    @Optional()
    @Inject(MCP_CALL_AUDITOR)
    private readonly callAudit?: McpCallAuditor,
    /** S10: where confirm-class calls are frozen for approval. Absent only in unit tests. */
    @Optional()
    @Inject(PENDING_AI_ACTIONS_SERVICE)
    private readonly approvals?: Pick<PendingAiActionsService, 'request' | 'check'>,
    /** ADR-0015 part 2: the account's platform rights. Absent only in unit tests (none listed). */
    @Optional()
    @Inject(AI_PLATFORM_RIGHTS)
    private readonly platformRights?: AiPlatformRights,
  ) {}

  @Post()
  async handle(@Req() request: FastifyRequestLike, @Res() reply: FastifyReplyLike): Promise<void> {
    const state = requireRequestState(request);
    const token = bearerToken(request.headers['authorization']);
    // Two ways in, both already verified by `SessionAuthGuard`: a personal access token (the
    // member's full rights, as for Claude Code), or an OAuth access token for this resource, whose
    // grant narrows what may run. A cookie session is not a way in.
    const oauth = mcpOAuthAccessFor(state);
    const isPat = state.authScheme === 'personal_access_token' && token !== undefined;
    const binding = state.personalAccessToken;
    if (!state.session || binding === undefined || (!isPat && oauth === undefined)) {
      throw mcpUnauthenticated(this.config, 'mcp_requires_bearer_token');
    }
    // S11 kill switches, read on every request (cached under a second): the platform switch
    // answers 503, a workspace whose owner turned AI off answers 403.
    if (this.aiAccess) {
      if (!(await this.aiAccess.platformOn(state.correlationId))) throw aiPlatformDisabledError();
      if (!(await this.aiAccess.organizationOn(binding.organizationId, state.correlationId))) {
        throw aiWorkspaceDisabledError();
      }
    }
    // Keyed by the token row's id (`pat:<id>`) or the grant (`oauth:<id>`), never the token itself.
    if (!this.admit(state.session.sessionId)) {
      throw new ApiError(429, 'rate_limited', MESSAGES.rateLimited, undefined, 'mcp_rate_limited');
    }
    // GHSA-mrhx-c7xc-m3w5: no oversized collection reaches zod (the SDK's message parse or a tool's
    // argument schema). Before the scope walk below, which reads the body too.
    const shape = mcpBodyShapeRefusal(request.body);
    if (shape !== undefined) {
      throw new ApiError(
        400,
        'validation_failed',
        'The request is too large to process',
        undefined,
        `mcp_body_${shape}`,
      );
    }

    // T-SCP-01. A call outside the grant's scopes is refused before anything runs, with the
    // step-up challenge naming the scope to ask for.
    const scopes = oauth?.scopes ?? PAT_SCOPES;
    for (const op of opsCalledBy(request.body)) {
      if (!grantCoversOp(scopes, op)) {
        throw mcpInsufficientScope(this.config, scopes, requiredScopeFor(op.scope) ?? op.scope);
      }
    }

    if (!this.workspaces) throw new Error('McpEndpointController: no workspace resolver');
    const workspace = await this.workspaces.resolve(
      { userId: state.session.userId, ...binding },
      state.correlationId,
    );
    if (workspace === undefined) throw mcpUnauthenticated(this.config, 'mcp_membership_changed');

    // The principal the outer request proved — the one every inner call will act as. Captured now,
    // before the transport takes over the reply, so the grant minter below can run per inner call.
    // ADR-0015 F1/F2: only an OAuth grant holding `tmanage:platform` inside its own window binds
    // the inner calls to the consent's stepped-up browser session; a personal access token never
    // does, so its catalogue lists no platform op and the platform guard refuses its inner calls.
    const platformBinding = platformBindingOf(isPat, oauth, Date.now());
    const platformPermissions =
      platformBinding !== undefined && this.platformRights !== undefined
        ? await this.platformRights.permissionsFor(state.session.userId, state.correlationId)
        : undefined;
    const principal: Omit<InternalGrantPayload, 'opId'> = {
      grantId: oauth?.grantId ?? state.session.sessionId,
      userId: state.session.userId,
      membershipId: binding.membershipId,
      organizationId: binding.organizationId,
      clientId: oauth?.clientId ?? state.session.sessionId,
      clientName: oauth?.clientName ?? 'AI assistant',
      scopes,
      ...(platformBinding !== undefined && platformPermissions !== undefined
        ? {
            stepUpSessionId: platformBinding.stepUpSessionId,
            platformUntil: platformBinding.until,
          }
        : {}),
    };

    const webOrigin = this.config.webPublicUrl;
    const { catalog, runtime } = liveMcpSurface({
      profile: toolsProfile(request.raw),
      scopes,
      capabilities: workspace.capabilities,
      ...(principal.stepUpSessionId !== undefined && platformPermissions !== undefined
        ? { platformPermissions }
        : {}),
      orgSlug: workspace.orgSlug,
      baseUrl: IN_PROCESS_BASE_URL,
      fetch: inProcessFetch(this.adapterHost.httpAdapter.getInstance<InjectCapable>(), {
        // B1/B3. One single-use grant per inner call; the client's token is never forwarded.
        mintGrant: (opId) => internalGrants.mint({ ...principal, opId }),
        correlationId: state.correlationId,
        onCall: (record) =>
          // B6. One redacted line per call: op, args hash, outcome, latency, and the AI client it
          // is attributed to — never a token or a body (T-LOG-01).
          this.logger.log(
            JSON.stringify({
              event: 'mcp.tool_call',
              actorKind: 'ai',
              clientId: principal.clientId,
              correlationId: state.correlationId,
              ...record,
            }),
          ),
      }),
      // S10. A confirm-class call is frozen for the member to approve on the website; without an
      // approve page to link to it is refused instead.
      ...(this.approvals !== undefined && webOrigin !== undefined && webOrigin !== ''
        ? {
            approvals: {
              service: this.approvals,
              requester: principal,
              webOrigin,
              correlationId: state.correlationId,
            },
          }
        : {}),
    });
    // Plan §4.4. One audit event per tool call, attributed to the token's user and AI client:
    // tool, op, outcome, args hash and latency — never the token or an argument value.
    const auditScope = {
      userId: principal.userId,
      organizationId: principal.organizationId,
      membershipId: principal.membershipId,
      clientId: principal.clientId,
      correlationId: state.correlationId,
    };
    const audited = auditedRuntime(runtime, (call) => this.callAudit?.record(auditScope, call));
    // From here the MCP transport writes the response itself.
    reply.hijack();
    await serveMcpRequest(
      // The web origin serves the brand icons the connector shows (`serverInfo.icons`).
      buildCatalogServer(catalog, audited, this.config.webPublicUrl),
      request.raw,
      reply.raw,
      request.body,
      {
        enableJsonResponse: true,
      },
    );
  }

  /** Stateless: no server-sent stream to open and no session to end. */
  @Get()
  methodNotAllowed(@Res() reply: FastifyReplyLike): unknown {
    return reply
      .status(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. Send MCP requests with POST.' },
        id: null,
      });
  }

  @Delete()
  noSessionToEnd(@Res() reply: FastifyReplyLike): unknown {
    return this.methodNotAllowed(reply);
  }
}

@Module({})
export class McpEndpointModule {
  static register(): DynamicModule {
    return {
      module: McpEndpointModule,
      providers: [
        aiAccessSwitchesProvider,
        aiPlatformRightsProvider,
        {
          provide: MCP_WORKSPACE_RESOLVER,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) => new DatabaseMcpWorkspaceResolver(database),
        },
        {
          // Exported so the global `SessionAuthGuard` can accept OAuth access tokens on /mcp.
          provide: MCP_OAUTH_AUTHENTICATOR,
          inject: [TENANT_DATABASE, API_CONFIG],
          useFactory: (database: TenantDatabase, config: ApiConfig) =>
            new McpOAuthAuthenticator(database, mcpResourceUri(config)),
        },
        {
          provide: MCP_CALL_AUDITOR,
          inject: [TENANT_DATABASE],
          useFactory: (database: TenantDatabase) => new DatabaseMcpCallAuditor(database),
        },
      ],
      exports: [MCP_OAUTH_AUTHENTICATOR],
      controllers: [McpEndpointController],
    };
  }
}
