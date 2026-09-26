import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { decisionLocks } from '../../common/database/schema.js';
import type { DecisionLockRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The decision-locks repository — SEC / Decisions (x150), following the `decision_supersessions`
 * (0038) append-only pattern exactly.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, as the sibling
 * repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context, so a
 *    caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateDecisionLockInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/**
 * Thrown when the unique key `uq_decision_locks_org_decision` refuses a second lock on a decision.
 * The service maps it to a 409 (a re-lock is a no-op conflict), so this is the engine-level backstop
 * beneath the service's own read-then-insert re-lock check.
 */
export class DuplicateDecisionLockError extends Error {
  constructor(readonly decisionId: string) {
    super(`Decision ${decisionId} is already locked`);
    this.name = 'DuplicateDecisionLockError';
  }
}

/** MySQL's duplicate-key errno, raised by `uq_decision_locks_org_decision`. */
const ER_DUP_ENTRY = 1062;

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    (error as { errno?: unknown }).errno === ER_DUP_ENTRY
  );
}

/** Note what is absent: `organizationId`. It is taken from the context, never from a body. */
export interface CreateDecisionLockInput {
  readonly decisionId: string;
  /** The person locking the decision — the service passes `context.userId`. */
  readonly lockedBy: string;
}

export class DecisionLocksRepository {
  /**
   * Fetch a decision's lock, within the acting tenant, or `null` if it is not locked.
   *
   * No `findByDecisionId(id)` without a context: on MySQL that would return another customer's row.
   * The service reads this before a mutating decision write (to refuse a write to a locked decision)
   * and before a lock (to refuse a re-lock), so both decisions rest on a tenant-scoped read.
   */
  async findByDecisionId(
    runner: TenantQueryRunner,
    context: TenantContext,
    decisionId: string,
  ): Promise<DecisionLockRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(decisionLocks)
      .where(
        and(
          eq(decisionLocks.organizationId, context.organizationId),
          eq(decisionLocks.decisionId, decisionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a decision lock, and read it back.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The decision is *not*
   * checked to belong to the tenant here: `fk_decision_locks_decision_tenant` is a composite foreign
   * key including `organization_id`, so the database refuses a decision of another tenant. (The
   * service resolves the decision tenant-scoped first, so a missing/cross-tenant id is a 404 rather
   * than the 500 that foreign key would otherwise surface.) A second lock on the same decision is
   * refused by `uq_decision_locks_org_decision` and surfaces as {@link DuplicateDecisionLockError}.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDecisionLockInput,
  ): Promise<DecisionLockRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    try {
      await db.insert(decisionLocks).values({
        id,
        // From the context. Not from `input` — there is no such field.
        organizationId: context.organizationId,
        decisionId: input.decisionId,
        lockedBy: input.lockedBy,
        lockedAt: sql`current_timestamp(3)`,
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) throw new DuplicateDecisionLockError(input.decisionId);
      throw error;
    }

    // Read back rather than reconstruct: the row now carries a server-generated `locked_at`.
    const row = await this.findByDecisionId(runner, context, input.decisionId);
    if (!row)
      throw new Error(`decision lock for ${input.decisionId} vanished immediately after insert`);
    return row;
  }
}
