import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  InboxRuleCategory,
  InboxRuleMatchType,
  InboxRuleRow,
} from '../../common/database/schema.js';
import type { NotificationsRepository } from './notifications.repository.js';
import type { InboxRulesRepository, NewInboxRule } from './rules.repository.js';

/** One rule as the routes exchange it — the stored row without tenant identity. */
export interface InboxRuleView {
  readonly id: string;
  readonly matchType: InboxRuleMatchType;
  readonly matchValue: string;
  readonly category: InboxRuleCategory;
  readonly position: number;
}

/** One candidate notification's resolved category: the first rule that fired, or `null` if none did. */
export interface ResolvedCategory {
  readonly notificationId: string;
  readonly category: InboxRuleCategory | null;
}

/** How many of the caller's most recent notifications the resolve helper considers in one call. */
export const RESOLVE_CANDIDATE_LIMIT = 100;

function toView(row: InboxRuleRow): InboxRuleView {
  return {
    id: row.id,
    matchType: row.matchType,
    matchValue: row.matchValue,
    category: row.category,
    position: row.position,
  };
}

/**
 * INBOX-001 per-user inbox routing rules (x301, module Inbox).
 *
 * The whole surface is self-scoped: every method acts on `principal.membershipId`, resolved from the
 * authenticated membership and never from a path or body, so a caller only ever lists, adds, removes
 * and applies their own rules. Rules are applied **read-side** by {@link resolve}: it reads the
 * caller's own notifications (recipient-scoped) and returns the first matching rule's category per
 * candidate — nothing is ever written back to `notifications`.
 *
 * Validation of the closed `match_type`/`category` allowlists is the controller's; this service
 * scopes and stores. {@link remove} resolves the rule by `(tenant, id)` *before* it authorizes the
 * caller against it: a rule that belongs to another member is a 404 (never revealed, never deleted),
 * a rule that never existed is an idempotent 204, and the caller's own rule is deleted membership-scoped.
 */
export class InboxRulesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly rules: InboxRulesRepository,
    private readonly notifications: NotificationsRepository,
  ) {}

  /** The caller's rules, ordered by position. */
  async list(context: TenantContext, principal: Principal): Promise<readonly InboxRuleView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.rules.listForMembership(runner, context, principal.membershipId),
    );
    return rows.map(toView);
  }

  /** Add a rule for the caller. The subject is always the authenticated membership. */
  async create(
    context: TenantContext,
    principal: Principal,
    rule: NewInboxRule,
  ): Promise<InboxRuleView> {
    const row = await this.database.transaction(context, (tx) =>
      this.rules.insert(tx, context, principal.membershipId, rule),
    );
    return toView(row);
  }

  /**
   * Resolve the caller's most recent notifications against the caller's rules: for each candidate, the
   * category of the first rule (lowest position) whose matched field equals its value, or `null` if no
   * rule fired. Read-only — no write to `notifications`.
   */
  async resolve(
    context: TenantContext,
    principal: Principal,
  ): Promise<readonly ResolvedCategory[]> {
    return this.database.read(context, async (runner) => {
      const rules = await this.rules.listForMembership(runner, context, principal.membershipId);
      const candidates = await this.notifications.listForRecipient(
        runner,
        context,
        principal.userId,
        { limit: RESOLVE_CANDIDATE_LIMIT },
      );
      return candidates.map((notification) => ({
        notificationId: notification.id,
        category: firstMatch(rules, notification),
      }));
    });
  }

  /**
   * Remove the caller's rule by id. Resolves the rule by `(tenant, id)` before authorizing:
   * - the rule is the caller's own → delete it, 204;
   * - the rule exists but belongs to another member → 404 (never deleted, never revealed);
   * - the rule never existed → idempotent 204.
   *
   * Returns whether a rule that exists but is not the caller's was found, so the controller can raise
   * the 404 without a second read.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    id: string,
  ): Promise<{ readonly outcome: 'deleted' | 'absent' | 'forbidden' }> {
    return this.database.transaction(context, async (tx) => {
      const existing = await this.rules.findById(tx, context, id);
      if (existing && existing.membershipId !== principal.membershipId) {
        return { outcome: 'forbidden' as const };
      }
      const removed = await this.rules.deleteForMembership(tx, context, principal.membershipId, id);
      return { outcome: removed > 0 ? ('deleted' as const) : ('absent' as const) };
    });
  }
}

/** The category of the first rule (already position-ordered) that matches the notification, else null. */
function firstMatch(
  rules: readonly InboxRuleRow[],
  notification: { readonly type: string; readonly objectType: string },
): InboxRuleCategory | null {
  for (const rule of rules) {
    const field = rule.matchType === 'type' ? notification.type : notification.objectType;
    if (field === rule.matchValue) return rule.category;
  }
  return null;
}
