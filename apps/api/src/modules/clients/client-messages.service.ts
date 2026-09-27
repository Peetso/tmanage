import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { PortalClientMessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ClientOrganizationsRepository } from './client-organizations.repository.js';
import { ClientMessagesRepository } from './client-messages.repository.js';

/**
 * SEC / Client portal messages (x322, module "Client portal") — the client write/read surface and
 * the staff inbound read for an in-app message a client contact posts to the studio.
 *
 * The design mirrors x203 (`project_update_comments`) but inverts its authorship: there the write is
 * internal (`project.manage`) and the client only reads; here the **write is the client's** and the
 * scope is the client organization, not a project.
 *
 * - The **client** routes (`POST`/`GET portal/messages`) are behind `client_projection.read`. The
 *   client-org scope is the caller's own `clientOrganizationId` — never a body or query field — so a
 *   client can only ever post to and read their own thread, and a principal with no client-org scope
 *   (an internal member) is off-client: a 404, resolved before the authorize decision.
 * - The **staff** route (`GET portal/messages/admin`) is behind `client_member.manage`, which no
 *   client role holds — the guard refuses a client with 403 before the handler runs. It names a
 *   `clientOrganizationId`, resolved tenant-scoped **before** anything else, so a cross-tenant scope
 *   id is a 404 with no read.
 *
 * ## Resolve the client-org scope BEFORE authorizing
 *
 * On the client routes the scope is the principal's own client organization; a null scope is a 404
 * (off-client) resolved before `authorize()`. On the staff route the named `clientOrganizationId` is
 * resolved through {@link ClientOrganizationsRepository.findById}, which is tenant-scoped — a
 * cross-tenant id does not resolve and is a 404, so a caller cannot learn which client-org ids are
 * real in another tenant. That order is the trap: the scope is proven inside the acting tenant first,
 * so the read can never surface another client organization's (or another studio's) messages.
 *
 * ## No internal fields to the client
 *
 * {@link ClientMessageView} is built from an explicit allowlist and carries no author identity, no
 * scope id and no tenant id — 25-AUTH-AND-TENANT-ISOLATION §7's rule against projecting the internal
 * record with fields deleted. The staff view carries the author and the scope, because staff read the
 * full record.
 */

/** `portal_client_messages.subject` is `VARCHAR(190)`. */
export const MAX_CLIENT_MESSAGE_SUBJECT_LENGTH = 190;
/** `portal_client_messages.body` is `TEXT`; this bounds a single message to a sane maximum. */
export const MAX_CLIENT_MESSAGE_BODY_LENGTH = 5000;

/**
 * A message as a **client** is shown it — the client projection.
 *
 * No `authorUserId`, no `clientOrgScopeId`, no `organizationId`. Listing the fields means a column
 * added to `portal_client_messages` tomorrow is invisible to a client until someone decides otherwise.
 */
export interface ClientMessageView {
  readonly id: string;
  readonly subject: string;
  readonly body: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/**
 * A message as **staff** are shown it — the full record behind `client_member.manage`.
 *
 * Carries `clientOrganizationId` (which client sent it) and `authorUserId` (which contact). This view
 * never leaves the staff `portal/messages/admin` path.
 */
export interface AdminClientMessageView {
  readonly id: string;
  readonly clientOrganizationId: string;
  readonly authorUserId: string;
  readonly subject: string;
  readonly body: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/** What a client posts. The tenant, the scope and the author come from the session, never the body. */
export interface PostClientMessageInput {
  readonly subject: string;
  readonly body: string;
}

function toClientView(row: PortalClientMessageRow): ClientMessageView {
  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAdminView(row: PortalClientMessageRow): AdminClientMessageView {
  return {
    id: row.id,
    clientOrganizationId: row.clientOrgScopeId,
    authorUserId: row.authorUserId,
    subject: row.subject,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ClientMessagesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly organizations: ClientOrganizationsRepository = new ClientOrganizationsRepository(),
    private readonly messages: ClientMessagesRepository = new ClientMessagesRepository(),
  ) {}

  /**
   * Post a message from the portal — the client half. `client_projection.read`, client only.
   *
   * The scope is the caller's own `clientOrganizationId`, resolved before authorize (a null scope is
   * a 404 — an internal principal is off-client here). The author is `context.userId`, never a body
   * field. A caller the policy denies is a 404, not a 403, so nothing about the scope leaks.
   */
  async post(
    context: TenantContext,
    principal: Principal,
    input: PostClientMessageInput,
  ): Promise<ClientMessageView> {
    const scopeId = this.resolveOwnScope(principal);

    const row = await this.database.transaction(context, (tx) =>
      this.messages.create(tx, context, {
        clientOrgScopeId: scopeId,
        authorUserId: context.userId,
        subject: input.subject,
        body: input.body,
      }),
    );

    return toClientView(row);
  }

  /** The caller's own message thread — `client_projection.read`, client only. */
  async listOwnThread(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly ClientMessageView[]> {
    const scopeId = this.resolveOwnScope(principal);

    const rows = await this.database.read(context, (runner) =>
      this.messages.listForScope(runner, context, scopeId),
    );
    return rows.map(toClientView);
  }

  /**
   * The inbound messages for one client organization — the staff half. `client_member.manage`, which
   * no client role holds.
   *
   * The `clientOrganizationId` is resolved tenant-scoped **before** the read: a cross-tenant or
   * unknown id does not resolve and is a 404, so the read is scoped to the studio tenant and can never
   * surface another studio's messages. Staff see the full record ({@link toAdminView}).
   */
  async listForAdmin(
    context: TenantContext,
    clientOrganizationId: string,
  ): Promise<readonly AdminClientMessageView[]> {
    const scope = await this.database.read(context, (runner) =>
      this.organizations.findById(runner, context, clientOrganizationId),
    );
    if (!scope) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const rows = await this.database.read(context, (runner) =>
      this.messages.listForScope(runner, context, clientOrganizationId),
    );
    return rows.map(toAdminView);
  }

  /**
   * The caller's own client-org scope, proven before any write or read.
   *
   * A null `clientOrganizationId` means the principal is not a client of any client organization (an
   * internal member) — off-client, a 404. `authorize()` then confirms the client may reach their own
   * projection (active membership, tenant, capability ceiling); a denial is a 404, not a 403, so a
   * caller learns nothing from the difference.
   */
  private resolveOwnScope(principal: Principal): string {
    const scopeId = principal.clientOrganizationId;
    if (!scopeId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const permitted = authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId: null,
        audience: 'client_visible',
        clientOrganizationId: scopeId,
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    return scopeId;
  }
}
