import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { from, switchMap, type Observable } from 'rxjs';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { requestState } from '../../common/http/request-state.js';
import type { RequestState } from '../../common/http/request-state.js';
import { API_CONFIG } from '../../common/http/tokens.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import {
  callNeedsConfirm,
  callNeedsConfirmWithState,
  findOpByRoute,
  neverByKey,
  routeKey,
} from './registry/index.js';
import type { AiActionOp, StoredFieldLookup } from './registry/index.js';
import type { NeverReason } from './registry/types.js';
import { STORED_AUDIENCE_RESOLVER } from './stored-audience.repository.js';
import type { StoredAudienceResolver } from './stored-audience.repository.js';
import { mcpBodyShapeRefusal } from '../mcp/mcp-body-shape.js';
import { approvalUrl } from '../mcp/pending-actions.js';
import { PENDING_AI_ACTIONS_SERVICE } from '../mcp/pending-actions.service.js';
import type { PendingAiActionsService } from '../mcp/pending-actions.service.js';
import { expiryInWords } from './approval-lifetime.js';

/**
 * **Bound-token confirm gate — audit run 1, NV01 and F11 (defence in depth).**
 *
 * The AI action registry classifies some operations `confirm`: invitations, role and session
 * changes, security settings, client sharing and the like must be approved by the member, in
 * TManage, outside the model. The hosted `/mcp` runtime has always honoured that, but the same
 * REST routes are reachable directly with a personal access token (the OpenAPI / GPT Actions
 * channel), and there they ran at once — `POST …/invitations` issued the invite and returned its
 * token, while the OpenAPI document promised a `202` approval link.
 *
 * This interceptor closes that channel on the server, for every route, without each controller
 * having to remember it:
 *
 * - **Personal access token, confirm-class op** → the handler does NOT run. The request is frozen
 *   as a pending AI action (the same row and approve page the MCP connector uses) and the answer
 *   is `202` with `{ status: 'approval_required', approval_id, approval_url, expires_at }`. When
 *   the request cannot be frozen (no approval page configured, arguments the op's strict schema
 *   refuses), it is refused `403` instead. Either way nothing has happened.
 * - **AI connector internal grant, confirm-class op** → runs only when the grant was minted by the
 *   approve page (`grantId` `approval:…`, set server-side by `PendingAiActionsService`); any other
 *   inner call is refused `403`. The MCP runtime already refuses these before injecting; this is
 *   the second, route-level check.
 * - **Any bound token, tenant route listed in `NEVER`** → refused `403`. (`@NoTenant()` routes are
 *   gated for bound tokens by `TenantContextGuard`'s allowlist.)
 * - **Cookie sessions** are untouched: a person in the app approves by acting.
 *
 * - **Conditionally confirm-class ops** (`confirmWhen`, audit run 2 N07): a `write` op whose call
 *   reaches a client — a client-audience work item, a client meeting attendee — is treated as a
 *   confirm op for that call; the same op with internal arguments stays an everyday write.
 * - **Stored-state rule** (`confirmWhenStored`, audit run 3 M01): a `write` op on a work item the
 *   client already sees (stored audience outside `internal`) is confirm-class for that call too,
 *   even when it only renames or re-dates the item. The audience is read tenant-scoped through
 *   {@link StoredAudienceResolver}; a row that does not exist leaves the call to the handler's 404.
 *
 * The route is resolved from the handler's own Nest metadata, never from the request URL, so a
 * crafted path cannot pick a different classification.
 */

const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';
const METHOD_NAMES = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];

/**
 * What a personal-access-token request is attributed to on the approve page when the token has no
 * name to show (a token always has one; this is the floor, never the usual answer).
 */
export const PAT_CLIENT_NAME = 'Personal access token';

/** The name a frozen PAT action waits under: the token's own name, as its member gave it. */
export function patClientName(state: Pick<RequestState, 'personalAccessToken'>): string {
  const name = state.personalAccessToken?.name?.trim();
  return name === undefined || name === '' ? PAT_CLIENT_NAME : name;
}

function pathOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/** The registry route key (`METHOD /path`, joined exactly as the registry extractor joins it). */
export function registryRouteOf(
  context: ExecutionContext,
): { readonly method: string; readonly path: string } | undefined {
  const handler = context.getHandler() as unknown;
  const controller = context.getClass() as unknown;
  if (typeof handler !== 'function') return undefined;
  const methodIndex = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
  if (typeof methodIndex !== 'number') return undefined;
  const method = METHOD_NAMES[methodIndex];
  if (method === undefined) return undefined;
  const base =
    typeof controller === 'function' ? pathOf(Reflect.getMetadata(PATH_METADATA, controller)) : '';
  const sub = pathOf(Reflect.getMetadata(PATH_METADATA, handler));
  const path = `/${[base, sub].filter((s) => s !== '').join('/')}`.replace(/\/+/g, '/');
  return { method, path };
}

const refused = (auditCode: string): ApiError =>
  new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, auditCode);

/**
 * 60-10: a call on the agent contract (NEVER reason `agent_contract`) by an AI employee's agent
 * key that the agent gate admitted. All three facts are server-made: the reason from the registry,
 * the agent flag from the token row (`SessionAuthGuard`), the stamp from `TenantContextGuard`.
 */
function isAgentContractCall(state: RequestState, reason: NeverReason): boolean {
  return (
    reason === 'agent_contract' &&
    state.personalAccessToken?.agent === true &&
    state.tenant?.aiEmployee !== undefined
  );
}

interface RequestLike {
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
}

interface ReplyLike {
  status(code: number): unknown;
}

/** The op's arguments as the registry detail names them: path params plus the body (or query). */
function argsOf(op: AiActionOp, request: RequestLike): Record<string, unknown> {
  const params = { ...(request.params ?? {}) };
  delete params['orgSlug'];
  const payload =
    op.method === 'GET'
      ? (request.query ?? {})
      : typeof request.body === 'object' && request.body !== null && !Array.isArray(request.body)
        ? (request.body as Record<string, unknown>)
        : {};
  return { ...payload, ...params };
}

@Injectable()
export class BoundTokenConfirmInterceptor implements NestInterceptor {
  constructor(
    @Optional()
    @Inject(PENDING_AI_ACTIONS_SERVICE)
    private readonly approvals?: Pick<PendingAiActionsService, 'request'>,
    @Optional()
    @Inject(API_CONFIG)
    private readonly config: Pick<ApiConfig, 'webPublicUrl'> = {},
    @Optional()
    @Inject(STORED_AUDIENCE_RESOLVER)
    private readonly storedAudience?: StoredAudienceResolver | null,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<RequestLike & object>();
    const state = requestState(request);
    const scheme = state?.authScheme;
    if (state === undefined || (scheme !== 'personal_access_token' && scheme !== 'ai_grant')) {
      return next.handle();
    }
    const route = registryRouteOf(context);
    if (route === undefined) return next.handle();

    const never =
      state.tenant === undefined ? undefined : neverByKey.get(routeKey(route.method, route.path));
    if (never !== undefined) {
      // 60-10: the agent contract is NEVER for the AI connector, but it is exactly what an AI
      // employee's agent key exists for. Only that key, stamped by the agent gate, gets through;
      // any other bound token on these routes is refused like every NEVER route.
      if (isAgentContractCall(state, never.reason)) return next.handle();
      throw refused('bound_token_never_route');
    }
    const op = findOpByRoute(route.method, route.path);
    if (op === undefined) return next.handle();
    // N07: a `write` op whose arguments reach a client (`confirmWhen`) is confirm-class for this
    // call, on the same pending/approval path as a `confirm` op.
    const args = argsOf(op, request);
    if (callNeedsConfirm(op, args)) return this.confirmClass(context, next, state, op, request);
    if (op.confirmWhenStored === undefined) return next.handle();
    // M01: the same op on a row the client already sees is confirm-class too (stored state).
    return from(callNeedsConfirmWithState(op, args, this.lookupFor(state))).pipe(
      switchMap((needs) =>
        needs ? this.confirmClass(context, next, state, op, request) : next.handle(),
      ),
    );
  }

  /** The stored-field lookup for this request's tenant, or none when no resolver is wired. */
  private lookupFor(state: RequestState): StoredFieldLookup | undefined {
    const resolver = this.storedAudience;
    const tenant = state.tenant;
    if (resolver === undefined || resolver === null || tenant === undefined) return undefined;
    return async (resource, id) =>
      resource === 'work_item' ? resolver.workItemAudience(tenant, id) : undefined;
  }

  /** A confirm-class call: refuse the inner grant, or freeze the PAT's request for approval. */
  private confirmClass(
    context: ExecutionContext,
    next: CallHandler,
    state: RequestState,
    op: AiActionOp,
    request: RequestLike,
  ): Observable<unknown> {
    const scheme = state.authScheme;
    // GHSA-mrhx-c7xc-m3w5: a PAT confirm-class call freezes its arguments through the op's zod
    // schema (`freezeConfirmAction`), so its body gets the same shape cap as `POST /mcp` first.
    const shape =
      scheme === 'personal_access_token' ? mcpBodyShapeRefusal(request.body) : undefined;
    if (shape !== undefined) {
      throw new ApiError(
        400,
        'validation_failed',
        'The request is too large to process',
        undefined,
        `mcp_body_${shape}`,
      );
    }

    if (scheme === 'ai_grant') {
      if (state.aiGrant?.grantId.startsWith('approval:') === true) return next.handle();
      throw refused('ai_grant_confirm_without_approval');
    }
    const reply = context.switchToHttp().getResponse<ReplyLike>();
    return from(this.pending(state, op, request, reply));
  }

  /** Freeze the PAT's confirm-class request for approval and answer 202; or refuse 403. */
  private async pending(
    state: RequestState,
    op: AiActionOp,
    request: RequestLike,
    reply: ReplyLike,
  ): Promise<Record<string, unknown>> {
    const tenant = state.tenant;
    const session = state.session;
    const orgSlug = request.params?.['orgSlug'];
    const webOrigin = this.config.webPublicUrl;
    if (
      this.approvals === undefined ||
      tenant === undefined ||
      session === undefined ||
      typeof orgSlug !== 'string' ||
      webOrigin === undefined ||
      webOrigin === ''
    ) {
      throw refused('approval_required');
    }
    let created;
    try {
      created = await this.approvals.request(
        {
          organizationId: tenant.organizationId,
          membershipId: tenant.membershipId,
          userId: tenant.userId,
          clientId: session.sessionId,
          clientName: patClientName(state),
        },
        op.id,
        argsOf(op, request),
        state.correlationId,
      );
    } catch {
      throw refused('approval_required');
    }
    // Nest applies the route's default status (201 for a POST) when it writes the body; keep this
    // reply at 202 for this one request so the answer says "accepted, not done".
    reply.status(202);
    Object.defineProperty(reply, 'status', { value: () => reply, configurable: true });
    return {
      status: 'approval_required',
      approval_id: created.id,
      approval_url: approvalUrl(webOrigin, orgSlug, created.id),
      expires_at: created.expiresAt.toISOString(),
      expires_in_words: expiryInWords(created.expiresAt, new Date()),
    };
  }
}
