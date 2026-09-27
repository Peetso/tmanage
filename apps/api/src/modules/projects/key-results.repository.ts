import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { objectiveKeyResults } from '../../common/database/schema.js';
import type { ObjectiveKeyResultRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The key-results repository — PROJ / module 8 (x207), following the `project-objectives` /
 * `objective-work-links` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the sibling
 * repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`; there is no overload without a context, so a caller that never established a
 *    tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateKeyResultInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the guard
 *    (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export class KeyResultNotFoundError extends Error {
  constructor(readonly keyResultId: string) {
    // No organization id in the message: a not-found must not let a probe for another tenant's key
    // result tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Key result ${keyResultId} was not found`);
    this.name = 'KeyResultNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreateKeyResultInput {
  readonly objectiveId: string;
  readonly title: string;
  readonly targetValue: number;
  readonly currentValue: number;
  readonly unit: string;
  /** The person who created the key result — the service passes `context.userId`. */
  readonly createdBy: string;
}

/** The body columns an inline edit may change. All optional: an edit sets the ones it names. */
export interface UpdateKeyResultInput {
  readonly title?: string;
  readonly targetValue?: number;
  readonly currentValue?: number;
  readonly unit?: string;
}

export interface ListKeyResultsOptions {
  /** Required: this slice lists one objective's key results, never a whole tenant's. */
  readonly objectiveId: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class KeyResultsRepository {
  /**
   * List one objective's key results, within the acting tenant, in creation order.
   *
   * Both `organization_id` and `objective_id` predicates are present. The order is
   * `created_at ASC, id ASC`: a key-results list reads oldest-first, and `id` (UUIDv7, ≈ creation
   * order) is the deterministic tiebreaker so two created in the same millisecond still have a stable,
   * repeatable order.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListKeyResultsOptions,
  ): Promise<readonly ObjectiveKeyResultRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    return db
      .select()
      .from(objectiveKeyResults)
      .where(
        and(
          eq(objectiveKeyResults.organizationId, context.organizationId),
          eq(objectiveKeyResults.objectiveId, options.objectiveId),
        ),
      )
      .orderBy(asc(objectiveKeyResults.createdAt), asc(objectiveKeyResults.id))
      .limit(limit);
  }

  /**
   * Fetch one key result by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    keyResultId: string,
  ): Promise<ObjectiveKeyResultRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(objectiveKeyResults)
      .where(
        and(
          eq(objectiveKeyResults.organizationId, context.organizationId),
          eq(objectiveKeyResults.id, keyResultId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    keyResultId: string,
  ): Promise<ObjectiveKeyResultRow> {
    const found = await this.findById(runner, context, keyResultId);
    if (!found) throw new KeyResultNotFoundError(keyResultId);
    return found;
  }

  /**
   * Create a key result.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert commits.
   * `organization_id` comes from the context, never from `input`. The objective is not checked to belong
   * to the tenant here: the composite foreign key `fk_objective_key_results_objective_tenant` includes
   * `organization_id`, so the database refuses an objective from another tenant. (The service *does*
   * resolve the objective first, but to map an unknown id to 404 rather than a foreign-key 500.)
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateKeyResultInput,
  ): Promise<ObjectiveKeyResultRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(objectiveKeyResults).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      objectiveId: input.objectiveId,
      title: input.title,
      targetValue: input.targetValue,
      currentValue: input.currentValue,
      unit: input.unit,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries server-generated timestamps.
    return this.requireById(runner, context, id);
  }

  /**
   * Update a key result's body within the acting tenant, and read it back.
   *
   * Only the body columns the edit names are written, plus `updated_at`; the `0087` column-pinning
   * trigger refuses every identity column, and `users.sql` grants the runtime credential UPDATE for
   * exactly this. The predicate carries both `organization_id` and `id`, so a cross-tenant id updates
   * nothing.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    keyResultId: string,
    input: UpdateKeyResultInput,
  ): Promise<ObjectiveKeyResultRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(objectiveKeyResults)
      .set({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.targetValue === undefined ? {} : { targetValue: input.targetValue }),
        ...(input.currentValue === undefined ? {} : { currentValue: input.currentValue }),
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(objectiveKeyResults.organizationId, context.organizationId),
          eq(objectiveKeyResults.id, keyResultId),
        ),
      );
    return this.requireById(runner, context, keyResultId);
  }
}
