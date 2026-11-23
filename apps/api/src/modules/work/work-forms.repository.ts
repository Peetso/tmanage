import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { formSubmissions, workForms } from '../../common/database/schema.js';
import type { WorkFormFieldDef, WorkFormRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The work-forms repository — WORK intake forms (x146), following the `document_templates` pattern.
 * It owns the org-scoped form definition a person submits to create a work item.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * document-templates repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateWorkFormInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 */

export class WorkFormNotFoundError extends Error {
  constructor(readonly formId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe for
    // another tenant's form tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Work form ${formId} was not found`);
    this.name = 'WorkFormNotFoundError';
  }
}

/**
 * What the controller creates. No `organizationId` (from the context), so a request body cannot
 * choose the tenant it writes into.
 */
export interface CreateWorkFormInput {
  readonly name: string;
  readonly fields: readonly WorkFormFieldDef[];
  /** The person creating the form — the controller passes `context.userId`. */
  readonly createdBy: string;
}

export interface ListWorkFormsOptions {
  /** Keyset pagination. Cursors are ids, and the walk is over `(organization_id, id)`. */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class WorkFormsRepository {
  /**
   * List a tenant's forms, name-ascending then id, within the acting tenant.
   *
   * Both the tenant predicate and a deterministic order are present: `name` ascending is the list
   * order, with `id` as the tiebreak so two forms that share a name still sort stably and page
   * without repeats. Bounded to `MAX_PAGE_SIZE`.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListWorkFormsOptions = {},
  ): Promise<readonly WorkFormRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [eq(workForms.organizationId, context.organizationId)];
    if (options.after) predicates.push(gt(workForms.id, options.after));

    return db
      .select()
      .from(workForms)
      .where(and(...predicates))
      .orderBy(asc(workForms.name), asc(workForms.id))
      .limit(limit);
  }

  /**
   * Fetch one form by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row. A
   * cross-tenant id resolves to null here, which is what the controller turns into a 404 before any
   * submission-driven write.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    formId: string,
  ): Promise<WorkFormRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(workForms)
      .where(and(eq(workForms.organizationId, context.organizationId), eq(workForms.id, formId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    formId: string,
  ): Promise<WorkFormRow> {
    const found = await this.findById(runner, context, formId);
    if (!found) throw new WorkFormNotFoundError(formId);
    return found;
  }

  /**
   * Create a form.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The row is read back so the server-generated `created_at` is the one
   * returned rather than a hand-assembled guess.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateWorkFormInput,
  ): Promise<WorkFormRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(workForms).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      name: input.name,
      fieldsJson: input.fields,
      createdBy: input.createdBy,
      createdAt: sql`current_timestamp(3)`,
    });

    return this.requireById(runner, context, id);
  }

  /** Fix lane C (2026-11-23). Whether any public submission names this form (it then stays). */
  async hasSubmissions(
    runner: TenantQueryRunner,
    context: TenantContext,
    formId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: formSubmissions.id })
      .from(formSubmissions)
      .where(
        and(
          eq(formSubmissions.organizationId, context.organizationId),
          eq(formSubmissions.formId, formId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Fix lane C. Delete one form row of this tenant (the caller has checked it may go). */
  async delete(runner: TenantQueryRunner, context: TenantContext, formId: string): Promise<void> {
    await tenantDrizzle(runner)
      .delete(workForms)
      .where(and(eq(workForms.organizationId, context.organizationId), eq(workForms.id, formId)));
  }
}
