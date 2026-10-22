import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { requestMessages } from '../../common/database/schema.js';
import type { RequestMessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Request messages — the storage half of the client <-> studio thread (0212, audit gap 4).
 *
 * `RequestCommentsRepository`'s shape: `TenantContext` scopes every read and write, no input type
 * carries an `organizationId`, and there is no policy here. Append-only: insert and read, no update
 * or delete — mirroring the INSERT-only grant in `users.sql` and the 0212 trigger.
 */

/** The largest page a single read returns. */
export const MAX_REQUEST_MESSAGE_PAGE = 500;

export interface CreateRequestMessageInput {
  readonly requestId: string;
  readonly authorMembershipId: string;
  readonly authorKind: 'internal' | 'client';
  readonly body: string;
  readonly clientVisible: boolean;
}

export class RequestMessagesRepository {
  /**
   * The request's messages, oldest first. `clientVisibleOnly` is a query predicate — the client
   * read never selects a team-only row, rather than dropping it after the fact.
   */
  async listForRequest(
    runner: TenantQueryRunner,
    context: TenantContext,
    requestId: string,
    clientVisibleOnly: boolean,
  ): Promise<readonly RequestMessageRow[]> {
    const scope = and(
      eq(requestMessages.organizationId, context.organizationId),
      eq(requestMessages.requestId, requestId),
    );
    return tenantDrizzle(runner)
      .select()
      .from(requestMessages)
      .where(clientVisibleOnly ? and(scope, eq(requestMessages.clientVisible, true)) : scope)
      .orderBy(asc(requestMessages.createdAt), asc(requestMessages.id))
      .limit(MAX_REQUEST_MESSAGE_PAGE);
  }

  /** Append a message; the server timestamp is read back rather than reconstructed. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateRequestMessageInput,
  ): Promise<RequestMessageRow> {
    const id = uuidv7();
    const db = tenantDrizzle(runner);
    await db.insert(requestMessages).values({
      id,
      organizationId: context.organizationId,
      requestId: input.requestId,
      authorMembershipId: input.authorMembershipId,
      authorKind: input.authorKind,
      body: input.body,
      clientVisible: input.clientVisible,
      createdAt: sql`current_timestamp(3)`,
    });
    const rows = await db
      .select()
      .from(requestMessages)
      .where(
        and(eq(requestMessages.organizationId, context.organizationId), eq(requestMessages.id, id)),
      )
      .limit(1);
    const created = rows[0];
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('request message vanished immediately after insert');
    }
    return created;
  }
}
