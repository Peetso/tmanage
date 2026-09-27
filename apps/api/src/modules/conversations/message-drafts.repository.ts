import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { conversationMessageDrafts } from '../../common/database/schema.js';
import type { ConversationMessageDraftRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * x251's storage half — a member's unsent composer draft for one conversation.
 *
 * `BillingProfileRepository`'s shape: `TenantContext` as the scoping parameter, no
 * `organizationId` on any input, an upsert against a unique key that read-backs the persisted
 * row. What is specific here is that the key is `(organization_id, conversation_id,
 * membership_id)` and the membership is always the acting context's — every query below carries
 * `context.membershipId`, so a caller can only ever reach their own draft. The conversation's
 * existence and the caller's right to write it are decided in the service before any of this
 * runs; this file is scoped queries and nothing else.
 */

export interface UpsertMessageDraftInput {
  readonly conversationId: string;
  readonly membershipId: string;
  /** `{ "body": "<composer text>" }`, validated by the controller and stored whole. */
  readonly bodyJson: unknown;
}

export class MessageDraftsRepository {
  /** The acting member's draft for one conversation, or null when none has been saved. */
  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    membershipId: string,
  ): Promise<ConversationMessageDraftRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversationMessageDrafts)
      .where(
        and(
          eq(conversationMessageDrafts.organizationId, context.organizationId),
          eq(conversationMessageDrafts.conversationId, conversationId),
          eq(conversationMessageDrafts.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Save or replace the acting member's draft. Idempotent by
   * `uq_conversation_message_drafts_identity`, so a second save updates in place and a lost
   * update is not expressible.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertMessageDraftInput,
  ): Promise<ConversationMessageDraftRow> {
    await tenantDrizzle(runner)
      .insert(conversationMessageDrafts)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        conversationId: input.conversationId,
        membershipId: input.membershipId,
        bodyJson: input.bodyJson,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          bodyJson: input.bodyJson,
          updatedAt: sql`current_timestamp(3)`,
        },
      });

    // Read back so the server clock and the persisted row are what is returned, never a
    // hand-assembled guess. Tenant- and membership-scoped, so it cannot cross a boundary.
    const saved = await this.find(runner, context, input.conversationId, input.membershipId);
    return saved as ConversationMessageDraftRow;
  }

  /**
   * Clear the acting member's draft. Returns whether a row was removed, so the caller can tell a
   * no-op from a clear — though the route answers 204 either way, because "make sure there is no
   * draft" is idempotent.
   */
  async remove(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    membershipId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(conversationMessageDrafts)
      .where(
        and(
          eq(conversationMessageDrafts.organizationId, context.organizationId),
          eq(conversationMessageDrafts.conversationId, conversationId),
          eq(conversationMessageDrafts.membershipId, membershipId),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
