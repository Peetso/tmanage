import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { inboxRules } from '../../common/database/schema.js';
import type {
  InboxRuleCategory,
  InboxRuleMatchType,
  InboxRuleRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/** The columns a new rule is inserted with; identity and `created_at` are filled by the store. */
export interface NewInboxRule {
  readonly matchType: InboxRuleMatchType;
  readonly matchValue: string;
  readonly category: InboxRuleCategory;
  readonly position: number;
}

/**
 * INBOX-001 inbox routing rules store — read one member's rules, add one, look one up, remove one, and
 * nothing else (module Inbox, x301).
 *
 * Every method that lists or removes names a membership. There is no `list(context)` that returns a
 * studio's rules: a rule is one member's, and a method without a `membershipId` parameter would be the
 * one place that rule could be dropped — the same shape `home_widget_prefs` and `notification_kind_prefs`
 * take for their per-membership reads. {@link findById} is the deliberate exception: it is scoped by
 * `(organization, id)` only, so the controller can tell a rule that belongs to another member (404,
 * refuse) apart from one that never existed (204, idempotent) without ever revealing the other member's
 * rule. The application validates `match_type` and `category` against the allowlist before an insert;
 * this store persists what it is given.
 */
export class InboxRulesRepository {
  /** A member's rules in this studio, ordered by `position` (lowest first) then `id` for a stable tie-break. */
  async listForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<readonly InboxRuleRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(inboxRules)
      .where(
        and(
          eq(inboxRules.organizationId, context.organizationId),
          eq(inboxRules.membershipId, membershipId),
        ),
      )
      .orderBy(asc(inboxRules.position), asc(inboxRules.id));
  }

  /** Create a rule for this member. Returns the stored row. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    rule: NewInboxRule,
  ): Promise<InboxRuleRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(inboxRules)
      .values({
        id,
        organizationId: context.organizationId,
        membershipId,
        matchType: rule.matchType,
        matchValue: rule.matchValue,
        category: rule.category,
        position: rule.position,
        createdAt: sql`current_timestamp(3)`,
      });
    const rows = await tenantDrizzle(runner)
      .select()
      .from(inboxRules)
      .where(and(eq(inboxRules.organizationId, context.organizationId), eq(inboxRules.id, id)))
      .limit(1);
    return rows[0]!;
  }

  /**
   * One rule by `(organization, id)`, membership-agnostic. Scoped to the tenant only, so the
   * controller can resolve the rule *before* it authorizes the caller against it — a rule that
   * belongs to another member is a 404, never a delete.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<InboxRuleRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(inboxRules)
      .where(and(eq(inboxRules.organizationId, context.organizationId), eq(inboxRules.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Remove this member's rule by id. Scoped by membership as well as id, so a caller can never delete
   * another member's rule even by guessing its id. Returns the number of rows removed.
   */
  async deleteForMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    id: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .delete(inboxRules)
      .where(
        and(
          eq(inboxRules.organizationId, context.organizationId),
          eq(inboxRules.membershipId, membershipId),
          eq(inboxRules.id, id),
        ),
      );
    return result[0].affectedRows;
  }
}
