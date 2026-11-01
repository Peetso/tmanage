import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  clientMemberships,
  conversationMemberships,
  conversations,
} from '../../common/database/schema.js';
import type {
  ConversationMemberRole,
  ConversationMembershipRow,
  ConversationRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** R7 slice 3: the group fields an admin may change. Absent means "leave as it is". */
export interface GroupSettingsPatch {
  readonly name?: string;
  readonly description?: string | null;
  readonly photoFileAssetId?: string | null;
  readonly onlyAdminsCanSend?: boolean;
}

/**
 * R7 slice 3 — the storage half of group management: settings, member roles and the invite token.
 *
 * Every statement names the tenant from the context and the conversation by id; the policy (who is
 * an admin, whether the row is a group) is the service's. Membership insert and delete reuse
 * `ConversationsRepository`, which already owns the idempotent add and the counted remove.
 */
export class GroupSettingsRepository {
  /** Apply a settings patch and move `version`, so a concurrent rename elsewhere sees the change. */
  async updateSettings(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    patch: GroupSettingsPatch,
  ): Promise<void> {
    const values: Record<string, unknown> = { version: sql`${conversations.version} + 1` };
    if (patch.name !== undefined) values['name'] = patch.name;
    if (patch.description !== undefined) values['description'] = patch.description;
    if (patch.photoFileAssetId !== undefined) values['photoFileAssetId'] = patch.photoFileAssetId;
    if (patch.onlyAdminsCanSend !== undefined) {
      values['onlyAdminsCanSend'] = patch.onlyAdminsCanSend ? 1 : 0;
    }
    await tenantDrizzle(runner)
      .update(conversations)
      .set(values)
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.id, conversationId),
        ),
      );
  }

  /** Returns whether a membership row changed. */
  async setRole(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    userId: string,
    role: ConversationMemberRole,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(conversationMemberships)
      .set({ role })
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(conversationMemberships.conversationId, conversationId),
          eq(conversationMemberships.userId, userId),
        ),
      );
    return result[0].affectedRows > 0;
  }

  /** Members oldest first — the order "promote the oldest member" reads. */
  async listMembersOldestFirst(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<readonly ConversationMembershipRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(conversationMemberships)
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(conversationMemberships.conversationId, conversationId),
        ),
      )
      .orderBy(asc(conversationMemberships.createdAt), asc(conversationMemberships.id));
  }

  async setInviteToken(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
    token: string | null,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(conversations)
      .set({ inviteToken: token })
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.id, conversationId),
        ),
      );
  }

  /** The live group a token opens, within this tenant only; null for anything else. */
  async findGroupByInviteToken(
    runner: TenantQueryRunner,
    context: TenantContext,
    token: string,
  ): Promise<ConversationRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(conversations)
      .where(
        and(
          eq(conversations.organizationId, context.organizationId),
          eq(conversations.inviteToken, token),
          eq(conversations.kind, 'group'),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row && row.archivedAt === null ? row : null;
  }

  /** Which of `userIds` hold a live client membership in this tenant (the "Client" chip). */
  async clientUserIds(
    runner: TenantQueryRunner,
    context: TenantContext,
    userIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await tenantDrizzle(runner)
      .select({ userId: clientMemberships.userId })
      .from(clientMemberships)
      .where(
        and(
          eq(clientMemberships.organizationId, context.organizationId),
          inArray(clientMemberships.userId, [...userIds]),
          eq(clientMemberships.status, 'active'),
        ),
      );
    return new Set(rows.map((row) => row.userId));
  }

  async countMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
    conversationId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)` })
      .from(conversationMemberships)
      .where(
        and(
          eq(conversationMemberships.organizationId, context.organizationId),
          eq(conversationMemberships.conversationId, conversationId),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }
}
