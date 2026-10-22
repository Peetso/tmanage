import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ClientRequestRow, RequestMessageRow } from '../../common/database/schema.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { ClientRequestsRepository } from './client-requests.repository.js';
import { audienceOf } from './client-requests.service.js';
import { RequestMessagesRepository } from './request-messages.repository.js';

/**
 * The client <-> studio thread on a client request (0212, audit gap 4) — the application service.
 *
 * Two doors, as `ClientRequestsService` has: the team reads and writes under
 * `client_request.triage` (internal-only), a client under `client_request.submit` on their own
 * request. Each door resolves the request inside the acting tenant FIRST, then asks `authorize()`
 * about that row — an absent, cross-tenant, sibling-client or unshared request is the same 404 with
 * no write. The client door selects `client_visible = 1` only, posts client-visible always, and
 * returns {@link RequestMessageClientView}, which has no staff identity on it. Every post appends
 * `client_request.message_posted.v1` to the outbox in the same transaction (ids only, no body).
 */

/** Injection token, local to this module. */
export const REQUEST_MESSAGES_SERVICE = Symbol('REQUEST_MESSAGES_SERVICE');

/** `request_messages.body` is TEXT; this bounds one message. */
export const MAX_REQUEST_MESSAGE_LENGTH = 5000;

/** The team's projection: every message, with its author and visibility. */
export interface RequestMessageView {
  readonly id: string;
  readonly requestId: string;
  readonly authorMembershipId: string;
  readonly authorKind: 'internal' | 'client';
  readonly body: string;
  readonly clientVisible: boolean;
  readonly createdAt: string;
}

/** The client's projection: client-visible messages only, the studio as one voice. */
export interface RequestMessageClientView {
  readonly id: string;
  readonly requestId: string;
  readonly from: 'studio' | 'client';
  readonly mine: boolean;
  readonly body: string;
  readonly createdAt: string;
}

type Door = 'internal' | 'client';

export class RequestMessagesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly requests: ClientRequestsRepository,
    private readonly messages: RequestMessagesRepository = new RequestMessagesRepository(),
    /** Optional so a unit test can construct the service without one; the app always wires it. */
    private readonly outbox?: OutboxEventsRepository,
  ) {}

  async listForTeam(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<readonly RequestMessageView[]> {
    return this.database.read(context, async (runner) => {
      await this.resolve(runner, context, principal, requestId, 'internal');
      const rows = await this.messages.listForRequest(runner, context, requestId, false);
      return rows.map(toTeamView);
    });
  }

  async postForTeam(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    input: { readonly body: string; readonly clientVisible: boolean },
  ): Promise<RequestMessageView> {
    const row = await this.post(context, principal, requestId, 'internal', input);
    return toTeamView(row);
  }

  async listForClient(
    context: TenantContext,
    principal: Principal,
    requestId: string,
  ): Promise<readonly RequestMessageClientView[]> {
    return this.database.read(context, async (runner) => {
      await this.resolve(runner, context, principal, requestId, 'client');
      const rows = await this.messages.listForRequest(runner, context, requestId, true);
      return rows.map((row) => toClientView(row, principal));
    });
  }

  async postForClient(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    input: { readonly body: string },
  ): Promise<RequestMessageClientView> {
    // A client cannot write a note the client cannot see (also a CHECK in 0212).
    const row = await this.post(context, principal, requestId, 'client', {
      body: input.body,
      clientVisible: true,
    });
    return toClientView(row, principal);
  }

  private async post(
    context: TenantContext,
    principal: Principal,
    requestId: string,
    door: Door,
    input: { readonly body: string; readonly clientVisible: boolean },
  ): Promise<RequestMessageRow> {
    return this.database.transaction(context, async (tx) => {
      const request = await this.resolve(tx, context, principal, requestId, door);
      if (!principal.membershipId) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      }
      const row = await this.messages.create(tx, context, {
        requestId: request.id,
        authorMembershipId: principal.membershipId,
        authorKind: door,
        body: input.body,
        clientVisible: input.clientVisible,
      });
      await this.outbox?.append(tx, context, {
        type: 'client_request.message_posted.v1',
        aggregateId: request.id,
        payload: {
          requestId: request.id,
          messageId: row.id,
          projectId: request.projectId,
          clientOrganizationId: request.clientOrganizationId,
          authorMembershipId: row.authorMembershipId,
          authorKind: door,
          clientVisible: row.clientVisible,
        },
      });
      return row;
    });
  }

  /**
   * Read the request tenant-scoped, then authorize this principal on it through the right door.
   * Absent and not-yours are the same 404, so a caller cannot discover a request by messaging it.
   */
  private async resolve(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    requestId: string,
    door: Door,
  ): Promise<ClientRequestRow> {
    if (door === 'client' && (principal.kind !== 'client' || !principal.clientOrganizationId)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
    const row = await this.requests.findById(runner, context, requestId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const capability: Capability =
      door === 'client' ? 'client_request.submit' : 'client_request.triage';
    const verdict = authorize({
      principal,
      capability,
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        audience: door === 'client' ? audienceOf(row) : 'internal',
        clientOrganizationId: row.clientOrganizationId,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return row;
  }
}

function toTeamView(row: RequestMessageRow): RequestMessageView {
  return {
    id: row.id,
    requestId: row.requestId,
    authorMembershipId: row.authorMembershipId,
    authorKind: row.authorKind,
    body: row.body,
    clientVisible: row.clientVisible,
    createdAt: row.createdAt.toISOString(),
  };
}

function toClientView(row: RequestMessageRow, principal: Principal): RequestMessageClientView {
  return {
    id: row.id,
    requestId: row.requestId,
    from: row.authorKind === 'client' ? 'client' : 'studio',
    mine: row.authorMembershipId === principal.membershipId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}
