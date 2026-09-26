import { and, desc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { decisions } from '../../common/database/schema.js';
import type { DecisionRow } from '../../common/database/schema.js';
import type { DECISION_STATUSES } from '../../common/database/schema.js';
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

    await db.insert(decisions).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      meetingId: input.meetingId ?? null,
      title: input.title,
      statement: input.statement,
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
}
