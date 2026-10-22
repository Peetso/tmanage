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
import { buildServer, createHttpApiClient, serveMcpRequest } from '@tmanage/mcp-server';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { NoTenant } from '../../common/http/decorators.js';
import { requireRequestState } from '../../common/http/request-state.js';
import { CORRELATION_HEADER } from '../../common/http/correlation.js';
import { createFixedWindowLimiter } from '../../common/http/rate-limiter.js';
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

/**
 * **Hosted MCP endpoint — `POST /mcp` (Streamable HTTP, stateless).**
 *
 * Claude, ChatGPT and any MCP assistant connect to `https://<workspace host>/mcp` and sign in with
 * a personal access token as `Authorization: Bearer <token>` — the token the AI assistant page
 * creates. No separate service runs: the `@tmanage/mcp-server` tools are served from this API.
 *
 * ## Scoped exactly like the REST API, because it IS the REST API
 *
 * 1. `SessionAuthGuard` authenticates the Bearer token before this handler runs (unknown, revoked
 *    or expired → the same 401 as every route). This handler then refuses anything that is not a
 *    personal-access-token request — a browser cookie is not a way in.
 * 2. Every tool call is an ordinary API request made in-process (`fastify.inject`) with the
 *    caller's own Bearer header. It passes the full guard chain again — authentication, the
 *    token's one-organization binding (`TenantContextGuard`), capability and object checks — so a
 *    tool can do exactly what the token's member can do over REST, in the token's organization,
 *    and nothing more. There is no second permission model to drift.
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
const IN_PROCESS_BASE_URL = 'http://tmanage.internal';

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
  ) {}

  @Post()
  async handle(@Req() request: FastifyRequestLike, @Res() reply: FastifyReplyLike): Promise<void> {
    const state = requireRequestState(request);
    const token = bearerToken(request.headers['authorization']);
    // A cookie session is not a way into the MCP endpoint: only a personal access token, which
    // `SessionAuthGuard` has already verified (unknown, revoked and expired tokens never get here).
    if (state.authScheme !== 'personal_access_token' || !state.session || token === undefined) {
      throw new ApiError(
        401,
        'unauthenticated',
        MESSAGES.unauthenticated,
        undefined,
        'mcp_requires_personal_access_token',
      );
    }
    // S11 kill switches, read on every request (cached under a second): the platform switch
    // answers 503, a workspace whose owner turned AI off answers 403.
    if (this.aiAccess) {
      if (!(await this.aiAccess.platformOn(state.correlationId))) throw aiPlatformDisabledError();
      const organizationId = state.personalAccessToken?.organizationId;
      if (
        organizationId === undefined ||
        !(await this.aiAccess.organizationOn(organizationId, state.correlationId))
      ) {
        throw aiWorkspaceDisabledError();
      }
    }
    // Keyed by the token row's id (`pat:<id>`), never by the token itself.
    if (!this.admit(state.session.sessionId)) {
      throw new ApiError(429, 'rate_limited', MESSAGES.rateLimited, undefined, 'mcp_rate_limited');
    }

    // The principal the outer request proved — the one every inner call will act as. Captured now,
    // before the transport takes over the reply, so the grant minter below can run per inner call.
    const binding = state.personalAccessToken;
    const principal: Omit<InternalGrantPayload, 'opId'> = {
      grantId: state.session.sessionId,
      userId: state.session.userId,
      // Bound by `SessionAuthGuard` on the PAT path; the outer check above guarantees it is set.
      membershipId: binding?.membershipId ?? '',
      organizationId: binding?.organizationId ?? '',
      clientId: state.session.sessionId,
      clientName: 'AI assistant',
    };

    const client = createHttpApiClient({
      baseUrl: IN_PROCESS_BASE_URL,
      token,
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
    });
    // From here the MCP transport writes the response itself.
    reply.hijack();
    await serveMcpRequest(buildServer(client), request.raw, reply.raw, request.body, {
      enableJsonResponse: true,
    });
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
      providers: [aiAccessSwitchesProvider],
      controllers: [McpEndpointController],
    };
  }
}
