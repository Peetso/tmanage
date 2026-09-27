import { and, asc, eq, like } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { glossaryTerms } from '../../common/database/schema.js';
import type { GlossaryTermRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Org glossary of terms (x263) — a studio's shared vocabulary of terms and their definitions. It owns
 * the term insert, the definition update, the delete, the tenant-scoped lookup by id, and the
 * alphabetical list (optionally prefix-filtered). It honours `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link AddTermInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes the resolve-then-write on one
 * connection inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context). */
export interface AddTermInput {
  readonly term: string;
  readonly definition: string;
}

/** A glossary list is bounded — a studio's vocabulary is small, and the list carries full definitions. */
const MAX_TERMS_LISTED = 500;

/** A prefix query may contain the LIKE metacharacters `%` and `_`; they are escaped to match literally. */
function escapeLikePrefix(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class GlossaryRepository {
  /** Fetch one term by id, scoped to the acting tenant, or null. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<GlossaryTermRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(glossaryTerms)
      .where(
        and(eq(glossaryTerms.organizationId, context.organizationId), eq(glossaryTerms.id, id)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Fetch one term by its text, scoped to the acting tenant, or null. The match is case-insensitive
   * (the column's collation), so this is the pre-read the service uses to turn a duplicate add or
   * rename into a 409 before it writes. The `(organization_id, term)` unique key is the backstop.
   */
  async findByTerm(
    runner: TenantQueryRunner,
    context: TenantContext,
    term: string,
  ): Promise<GlossaryTermRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(glossaryTerms)
      .where(
        and(eq(glossaryTerms.organizationId, context.organizationId), eq(glossaryTerms.term, term)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert a term. The `(organization_id, term)` unique key (case-insensitive collation) is the guard
   * against a duplicate: the caller (the service) catches the collision and maps it to a 409. Returns
   * the inserted row.
   */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: AddTermInput,
  ): Promise<GlossaryTermRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    const now = new Date();
    await db.insert(glossaryTerms).values({
      id,
      organizationId: context.organizationId,
      term: input.term,
      definition: input.definition,
      createdAt: now,
      updatedAt: now,
    });
    const inserted = await this.findById(runner, context, id);
    return inserted as GlossaryTermRow;
  }

  /**
   * Update a term's `term` and/or `definition`, scoped to the acting tenant. The tenant is immutable
   * (BEFORE UPDATE trigger); a term rename that collides with another term raises the unique key,
   * which the service maps to 409. Returns the updated row, or null if no row matched (the service
   * resolves it before calling, so a null here is only a concurrent delete).
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    fields: { readonly term?: string; readonly definition?: string },
  ): Promise<GlossaryTermRow | null> {
    const db = tenantDrizzle(runner);
    await db
      .update(glossaryTerms)
      .set({
        ...(fields.term !== undefined ? { term: fields.term } : {}),
        ...(fields.definition !== undefined ? { definition: fields.definition } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(glossaryTerms.organizationId, context.organizationId), eq(glossaryTerms.id, id)),
      );
    return this.findById(runner, context, id);
  }

  /** Remove a term, scoped to the acting tenant. Idempotent (no row → no-op). */
  async remove(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(glossaryTerms)
      .where(
        and(eq(glossaryTerms.organizationId, context.organizationId), eq(glossaryTerms.id, id)),
      );
  }

  /**
   * List the studio's terms, alphabetically, id breaking ties. An optional `prefix` filters to terms
   * whose text begins with it (case-insensitive, the column's collation); LIKE metacharacters in the
   * prefix are escaped to match literally. Bounded.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    prefix?: string,
  ): Promise<readonly GlossaryTermRow[]> {
    const db = tenantDrizzle(runner);
    const predicate =
      prefix !== undefined && prefix !== ''
        ? and(
            eq(glossaryTerms.organizationId, context.organizationId),
            like(glossaryTerms.term, `${escapeLikePrefix(prefix)}%`),
          )
        : eq(glossaryTerms.organizationId, context.organizationId);
    return db
      .select()
      .from(glossaryTerms)
      .where(predicate)
      .orderBy(asc(glossaryTerms.term), asc(glossaryTerms.id))
      .limit(MAX_TERMS_LISTED);
  }
}
