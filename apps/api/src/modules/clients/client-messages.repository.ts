import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { portalClientMessages } from '../../common/database/schema.js';
import type { PortalClientMessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * SEC / Client portal messages (x322) — the storage half. Append-only, tenant- and client-org-scoped,
 * following `ProjectUpdateCommentsRepository` (0084): `TenantContext` is the scoping parameter on
 * every method, there is no `organizationId` on any input (it comes from the context), and every read
 * and write is bound to `(organization_id, …)` so a caller in the wrong tenant sees nothing. The
 * repository holds no policy — the service decides who may read or write — and offers no update or
 * delete, mirroring the withheld privilege in `users.sql` and the 0190 append-only trigger.
 */

/** The largest message page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_CLIENT_MESSAGE_PAGE = 500;

/** The insert shape. Note the absence of `organizationId` — it comes from the context. */
export interface CreateClientMessageInput {
  readonly clientOrgScopeId: string;
  readonly authorUserId: string;
  readonly subject: string;
  readonly body: string;
}

export class ClientMessagesRepository {
  /** One client-org scope's messages, created-at (then id) ascending, bounded to one page. */
  async listForScope(
    runner: TenantQueryRunner,
    context: TenantContext,
    clientOrgScopeId: string,
  ): Promise<readonly PortalClientMessageRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(portalClientMessages)
      .where(
        and(
          eq(portalClientMessages.organizationId, context.organizationId),
          eq(portalClientMessages.clientOrgScopeId, clientOrgScopeId),
        ),
      )
      .orderBy(asc(portalClientMessages.createdAt), asc(portalClientMessages.id))
      .limit(MAX_CLIENT_MESSAGE_PAGE);
  }

  /** One message, scoped to the tenant; `null` if absent. */
  async findMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<PortalClientMessageRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(portalClientMessages)
      .where(
        and(
          eq(portalClientMessages.organizationId, context.organizationId),
          eq(portalClientMessages.id, messageId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Append a message. `organization_id` comes from the context, never `input`. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateClientMessageInput,
  ): Promise<PortalClientMessageRow> {
    const id = uuidv7();

    await tenantDrizzle(runner)
      .insert(portalClientMessages)
      .values({
        id,
        organizationId: context.organizationId,
        clientOrgScopeId: input.clientOrgScopeId,
        authorUserId: input.authorUserId,
        subject: input.subject,
        body: input.body,
        createdAt: sql`current_timestamp(3)`,
      });

    // Read back rather than reconstruct: the row now carries the server-generated timestamp.
    const created = await this.findMessage(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('portal client message vanished immediately after insert');
    }
    return created;
  }
}
