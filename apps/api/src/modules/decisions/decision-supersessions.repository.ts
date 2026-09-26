import { and, desc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { decisionSupersessions } from '../../common/database/schema.js';
import type { DecisionSupersessionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * DEC-01-b / DEC-02 (x117). The supersede-chain edge repository, following the decisions/meetings
 * pattern (`25-AUTHORIZATION-AND-TENANT-ISOLATION` §6): every method's first two parameters are the
 * `TenantQueryRunner` and the `TenantContext`, the tenant comes from the context and never the DTO,
 * and the tenant predicate is on every statement so a forgotten one throws rather than leaking.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** No `organizationId` field — it is taken from the context, never from a request body. */
export interface CreateDecisionSupersessionInput {
  /** The decision being superseded. */
  readonly decisionId: string;
  /** The decision that supersedes it. */
  readonly supersededByDecisionId: string;
  /** The person recording the supersession — the service passes `context.userId`. */
  readonly createdBy: string;
}

export class DecisionSupersessionsRepository {
  /**
   * Record a supersession edge within the acting tenant.
   *
   * The id is generated here (UUIDv7) so a command knows it before the insert commits.
   * `organization_id` comes from the context. The composite foreign keys on both decision ends
   * already refuse a decision from another tenant, and the unique `(organization_id, decision_id)`
   * refuses a second edge for the same superseded decision; the service resolves both ids first so
   * an unknown one is a 404 rather than a foreign-key 500.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDecisionSupersessionInput,
  ): Promise<DecisionSupersessionRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(decisionSupersessions).values({
      id,
      organizationId: context.organizationId,
      decisionId: input.decisionId,
      supersededByDecisionId: input.supersededByDecisionId,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    const rows = await db
      .select()
      .from(decisionSupersessions)
      .where(
        and(
          eq(decisionSupersessions.organizationId, context.organizationId),
          eq(decisionSupersessions.id, id),
        ),
      )
      .limit(1);
    // The row was just inserted in this transaction; the read-back carries the server `created_at`.
    return rows[0] as DecisionSupersessionRow;
  }

  /**
   * The edge by which this decision was superseded, if any — at most one (the unique key), so this
   * answers DEC-02's "superseded by".
   */
  async findSupersededBy(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
  ): Promise<DecisionSupersessionRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(decisionSupersessions)
      .where(
        and(
          eq(decisionSupersessions.organizationId, context.organizationId),
          eq(decisionSupersessions.decisionId, decisionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * The edges where this decision is the superseder — the decisions it supersedes (DEC-02's
   * "supersedes"), most recently recorded first.
   */
  async listSupersedes(
    runner: TenantQueryRunner,
    context: TenantContext,
    supersededByDecisionId: string,
  ): Promise<readonly DecisionSupersessionRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(decisionSupersessions)
      .where(
        and(
          eq(decisionSupersessions.organizationId, context.organizationId),
          eq(decisionSupersessions.supersededByDecisionId, supersededByDecisionId),
        ),
      )
      .orderBy(desc(decisionSupersessions.createdAt), desc(decisionSupersessions.id));
  }
}
