import { and, desc, eq, gt } from 'drizzle-orm';
import { pendingAiActions, users } from '../../common/database/schema.js';
import type { PendingAiActionRow } from '../../common/database/schema.js';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Data access for `pending_ai_actions` (0209, MCP connector S10). Every query carries
 * `organization_id = context.organizationId`, and every member-facing read also names the
 * membership and the user, so a member reaches only their own pending actions (`T-APR-02`).
 *
 * The decision is one guarded UPDATE — `WHERE status = 'pending' AND expires_at > now` — so of two
 * concurrent approvals exactly one changes a row; the other sees `0` and does nothing (`T-APR-03`).
 */

export interface InsertPendingAiActionInput {
  readonly id: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly opId: string;
  readonly args: Record<string, unknown>;
  readonly argsSha256: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/** A pending action plus the requesting member's name and address, for the approve page. */
export interface PendingAiActionWithMember {
  readonly row: PendingAiActionRow;
  readonly memberName: string;
  readonly memberEmail: string;
}

export class PendingAiActionsRepository {
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertPendingAiActionInput,
  ): Promise<void> {
    await tenantDrizzle(runner).insert(pendingAiActions).values({
      id: input.id,
      organizationId: context.organizationId,
      membershipId: input.membershipId,
      userId: input.userId,
      clientId: input.clientId,
      clientName: input.clientName,
      opId: input.opId,
      argsJson: input.args,
      argsSha256: input.argsSha256,
      status: 'pending',
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
    });
  }

  /** One of the member's own pending actions, with the member's name and email. */
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: { readonly membershipId: string; readonly userId: string },
    id: string,
  ): Promise<PendingAiActionWithMember | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ row: pendingAiActions, memberName: users.displayName, memberEmail: users.email })
      .from(pendingAiActions)
      .innerJoin(users, eq(users.id, pendingAiActions.userId))
      .where(
        and(
          eq(pendingAiActions.organizationId, context.organizationId),
          eq(pendingAiActions.membershipId, owner.membershipId),
          eq(pendingAiActions.userId, owner.userId),
          eq(pendingAiActions.id, id),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * The member's own actions still waiting for a decision (pending and not expired), newest
   * first, at most `limit` — the "AI actions" list and the waiting badge (55-15p).
   */
  async listOwnPending(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: { readonly membershipId: string; readonly userId: string },
    now: Date,
    limit: number,
  ): Promise<PendingAiActionWithMember[]> {
    return tenantDrizzle(runner)
      .select({ row: pendingAiActions, memberName: users.displayName, memberEmail: users.email })
      .from(pendingAiActions)
      .innerJoin(users, eq(users.id, pendingAiActions.userId))
      .where(
        and(
          eq(pendingAiActions.organizationId, context.organizationId),
          eq(pendingAiActions.membershipId, owner.membershipId),
          eq(pendingAiActions.userId, owner.userId),
          eq(pendingAiActions.status, 'pending'),
          gt(pendingAiActions.expiresAt, now),
        ),
      )
      .orderBy(desc(pendingAiActions.createdAt))
      .limit(limit);
  }

  /**
   * Move a live pending action to `approved` or `declined`. Returns the rows changed: `1` for
   * the one decision that won, `0` when it was already decided, expired, or not this member's.
   */
  async decide(
    runner: TenantQueryRunner,
    context: TenantContext,
    owner: { readonly membershipId: string; readonly userId: string },
    id: string,
    status: 'approved' | 'declined',
    now: Date,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(pendingAiActions)
      .set({ status, decidedAt: now })
      .where(
        and(
          eq(pendingAiActions.organizationId, context.organizationId),
          eq(pendingAiActions.membershipId, owner.membershipId),
          eq(pendingAiActions.userId, owner.userId),
          eq(pendingAiActions.id, id),
          eq(pendingAiActions.status, 'pending'),
          gt(pendingAiActions.expiresAt, now),
        ),
      );
    return result[0].affectedRows;
  }

  /** Record what the approved op returned; `failed` when it did not succeed. */
  async recordResult(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    result: { readonly status: number; readonly body: unknown },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(pendingAiActions)
      .set({
        status: result.status >= 400 ? 'failed' : 'approved',
        resultStatus: result.status,
        resultJson: result.body,
      })
      .where(
        and(
          eq(pendingAiActions.organizationId, context.organizationId),
          eq(pendingAiActions.id, id),
          eq(pendingAiActions.status, 'approved'),
        ),
      );
  }
}
