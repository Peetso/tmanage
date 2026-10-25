import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  conversations,
  decisions,
  directConversations,
  directMessages,
  memberships,
  messages,
  users,
} from '../../common/database/schema.js';
import type { DecisionRow } from '../../common/database/schema.js';
import type { DECISION_AUDIENCES, DECISION_STATUSES } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The decisions repository — DEC-01 (x113), following the `meetings`/`documents` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` and the `TenantContext`. There is no overload without a context, so a
 *    caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateDecisionInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** The decision status set, mirroring the `0037` `ENUM`. */
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** A15 (0225). Who a decision is visible to, mirroring the `decisions.audience` ENUM. */
export type DecisionAudience = (typeof DECISION_AUDIENCES)[number];

/** A15. The chat message a decision came from, as the detail page's Source card draws it. */
export interface DecisionSourceMessage {
  /** F3. `channel` — a project channel message; `direct` — a direct message (COL-10). */
  readonly kind: 'channel' | 'direct';
  readonly messageId: string;
  /** The channel's id, or the direct conversation's id for a direct message. */
  readonly conversationId: string;
  /** The channel's name; empty for a direct message, which has none. */
  readonly channelName: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: Date;
}

export class DecisionNotFoundError extends Error {
  constructor(readonly decisionId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe
    // for another tenant's decision tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Decision ${decisionId} was not found`);
    this.name = 'DecisionNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreateDecisionInput {
  readonly projectId: string;
  /** Optional link to the meeting the decision was taken in. */
  readonly meetingId?: string | null;
  readonly title: string;
  readonly statement: string;
  readonly status: DecisionStatus;
  /** The person who took the decision — the service passes `context.userId`. */
  readonly decidedBy: string;
  /** A point in time, stored as a UTC instant (the column is `DATETIME(3)`). */
  readonly decidedAt: Date;
  /** A15 (0225). Optional "Why we decided this". */
  readonly rationale?: string | null;
  /** A15 (0225). The chat message it came from — already resolved in-tenant by the service. */
  readonly sourceMessageId?: string | null;
  /** A15 (0225). Defaults to `internal`. */
  readonly audience?: DecisionAudience;
}

/** A15. The fields the detail page's Edit may change (the 0038 trigger pins the rest). */
export interface UpdateDecisionDetailsInput {
  readonly rationale?: string | null;
  readonly audience?: DecisionAudience;
}

export interface ListDecisionsOptions {
  /** Required: this slice lists one project's register, never a whole tenant's. */
  readonly projectId: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class DecisionsRepository {
  /**
   * List one project's decisions, within the acting tenant, most recently decided first.
   *
   * Both `organization_id` and `project_id` predicates are present. The order is
   * `decided_at DESC, id DESC`: `decided_at` is what DEC-01 asks the register to read by, and `id`
   * (UUIDv7, ≈ creation order) is the deterministic tiebreaker so two decisions taken in the same
   * millisecond still have a stable, repeatable order.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListDecisionsOptions,
  ): Promise<readonly DecisionRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.organizationId, context.organizationId),
          eq(decisions.projectId, options.projectId),
        ),
      )
      .orderBy(desc(decisions.decidedAt), desc(decisions.id))
      .limit(limit);
  }

  /**
   * Fetch one decision by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
  ): Promise<DecisionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(decisions)
      .where(
        and(eq(decisions.organizationId, context.organizationId), eq(decisions.id, decisionId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
  ): Promise<DecisionRow> {
    const found = await this.findById(runner, context, decisionId);
    if (!found) throw new DecisionNotFoundError(decisionId);
    return found;
  }

  /**
   * Create a decision.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The project (and, when
   * present, the meeting) is not checked to belong to the tenant here: the composite foreign keys
   * `fk_decisions_project_tenant` and `fk_decisions_meeting_tenant` include `organization_id`, so
   * the database refuses a project or meeting from another tenant — a service-layer check would
   * duplicate a guarantee that already cannot be bypassed. (The service *does* resolve the project
   * first, but to map an unknown id to 404 rather than to a foreign-key 500 — see the service.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDecisionInput,
  ): Promise<DecisionRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    // A15 (0225). The next register number of this tenant, read inside the caller's transaction;
    // `uq_decisions_org_number` refuses a concurrent duplicate rather than storing two DEC-014s.
    const [highest] = await db
      .select({ value: sql<number | null>`MAX(${decisions.number})` })
      .from(decisions)
      .where(eq(decisions.organizationId, context.organizationId));
    const number = Number(highest?.value ?? 0) + 1;

    await db.insert(decisions).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      meetingId: input.meetingId ?? null,
      number,
      title: input.title,
      statement: input.statement,
      rationale: input.rationale ?? null,
      sourceMessageId: input.sourceMessageId ?? null,
      audience: input.audience ?? 'internal',
      status: input.status,
      decidedBy: input.decidedBy,
      decidedAt: input.decidedAt,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries a server-generated `created_at`.
    return this.requireById(runner, context, id);
  }

  /**
   * Move a decision to a new lifecycle status within the acting tenant, and read it back.
   *
   * DEC-01-b (x117). This is the only mutation the register has: the `0038` column-pinning trigger
   * refuses every column but `status`, and `users.sql` grants the runtime credential UPDATE for
   * exactly this. The predicate carries both `organization_id` and `id`, so a cross-tenant id
   * updates nothing. The *transition* is guarded in the service (an illegal one is a 409 with no
   * write); this method writes the status the service already decided is legal.
   */
  async updateStatus(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
    status: DecisionStatus,
  ): Promise<DecisionRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(decisions)
      .set({ status })
      .where(
        and(eq(decisions.organizationId, context.organizationId), eq(decisions.id, decisionId)),
      );
    return this.requireById(runner, context, decisionId);
  }

  /**
   * A15. Write the detail page's editable fields — `rationale` and `audience` — and read the row
   * back. The predicate carries both `organization_id` and `id`, so a cross-tenant id updates nothing.
   */
  async updateDetails(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
    input: UpdateDecisionDetailsInput,
  ): Promise<DecisionRow> {
    const changes = {
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.audience !== undefined ? { audience: input.audience } : {}),
    };
    if (Object.keys(changes).length > 0) {
      await tenantDrizzle(runner)
        .update(decisions)
        .set(changes)
        .where(
          and(eq(decisions.organizationId, context.organizationId), eq(decisions.id, decisionId)),
        );
    }
    return this.requireById(runner, context, decisionId);
  }

  /**
   * A15. The display name of a member of this tenant (the "Decided by" row). Read through the
   * membership, so a user id of another tenant resolves to nothing.
   */
  async findMemberName(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ displayName: users.displayName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(eq(memberships.organizationId, context.organizationId), eq(memberships.userId, userId)),
      )
      .limit(1);
    return rows[0]?.displayName ?? null;
  }

  /**
   * A15. A chat message of this tenant **in the given project's channels**, with its channel and
   * author — the decision's Source card, and the create-time check that a `sourceMessageId` belongs
   * to the decision's own project. A deleted message resolves to nothing.
   */
  async findSourceMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    messageId: string,
  ): Promise<DecisionSourceMessage | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        messageId: messages.id,
        conversationId: messages.conversationId,
        channelName: conversations.name,
        authorName: users.displayName,
        body: messages.body,
        createdAt: messages.createdAt,
        deletedAt: messages.deletedAt,
      })
      .from(messages)
      .innerJoin(
        conversations,
        and(
          eq(conversations.organizationId, messages.organizationId),
          eq(conversations.id, messages.conversationId),
        ),
      )
      .innerJoin(users, eq(users.id, messages.authorUserId))
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.id, messageId),
          eq(conversations.projectId, projectId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row || row.deletedAt !== null) return null;
    return {
      kind: 'channel',
      messageId: row.messageId,
      conversationId: row.conversationId,
      channelName: row.channelName,
      authorName: row.authorName,
      body: row.body,
      createdAt: row.createdAt,
    };
  }

  /**
   * F3 (COL-10). A direct message of this tenant, with its conversation's two participants and its
   * author — the Source card of a decision recorded from a direct message. The create-time check
   * that the recorder is one of the two participants is the service's; this read only resolves the
   * message inside the tenant.
   */
  async findSourceDirectMessage(
    runner: TenantQueryRunner,
    context: TenantContext,
    messageId: string,
  ): Promise<
    | (DecisionSourceMessage & {
        readonly participantIds: readonly [string, string];
      })
    | null
  > {
    const rows = await tenantDrizzle(runner)
      .select({
        messageId: directMessages.id,
        conversationId: directMessages.directConversationId,
        authorName: users.displayName,
        body: directMessages.body,
        createdAt: directMessages.createdAt,
        userLowId: directConversations.userLowId,
        userHighId: directConversations.userHighId,
      })
      .from(directMessages)
      .innerJoin(
        directConversations,
        and(
          eq(directConversations.organizationId, directMessages.organizationId),
          eq(directConversations.id, directMessages.directConversationId),
        ),
      )
      .innerJoin(users, eq(users.id, directMessages.authorUserId))
      .where(
        and(
          eq(directMessages.organizationId, context.organizationId),
          eq(directMessages.id, messageId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      kind: 'direct',
      messageId: row.messageId,
      conversationId: row.conversationId,
      channelName: '',
      authorName: row.authorName,
      body: row.body,
      createdAt: row.createdAt,
      participantIds: [row.userLowId, row.userHighId],
    };
  }

  /**
   * F3. Whether a user is an **active** member of this tenant — the "Decided by" a recorder may
   * name. A suspended or removed member, or a user of another tenant, is not.
   */
  async isActiveMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    userId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.userId, userId),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
