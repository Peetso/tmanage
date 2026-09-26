import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documentTemplates } from '../../common/database/schema.js';
import type { DocumentTemplateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The document-templates repository — DOC-04/ADM-06 (x119), following the `documents`/`meetings`
 * pattern. It owns the org-scoped template record a person applies to a project to seed a document.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * documents repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateDocumentTemplateInput} has
 *    no `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 */

export class DocumentTemplateNotFoundError extends Error {
  constructor(readonly templateId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe for
    // another tenant's template tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Document template ${templateId} was not found`);
    this.name = 'DocumentTemplateNotFoundError';
  }
}

/**
 * What the service creates. No `organizationId` (from the context), so a request body cannot choose
 * the tenant it writes into.
 */
export interface CreateDocumentTemplateInput {
  readonly name: string;
  readonly purpose: string;
  readonly body: string;
  /** The person creating the template — the service passes `context.userId`. */
  readonly createdByUserId: string;
}

export interface ListDocumentTemplatesOptions {
  /** Keyset pagination. Cursors are ids, and the walk is over `(organization_id, id)`. */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class DocumentTemplatesRepository {
  /**
   * List a tenant's templates, name-ascending then id, within the acting tenant.
   *
   * Both the tenant predicate and a deterministic order are present: `name` ascending is the
   * gallery's order, with `id` as the tiebreak so two templates that share a name still sort
   * stably and page without repeats. Bounded to `MAX_PAGE_SIZE`.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListDocumentTemplatesOptions = {},
  ): Promise<readonly DocumentTemplateRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [eq(documentTemplates.organizationId, context.organizationId)];
    if (options.after) predicates.push(gt(documentTemplates.id, options.after));

    return db
      .select()
      .from(documentTemplates)
      .where(and(...predicates))
      .orderBy(asc(documentTemplates.name), asc(documentTemplates.id))
      .limit(limit);
  }

  /**
   * Fetch one template by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row, which
   * is why ADR-0001 exists and this signature has no unscoped form. A cross-tenant id resolves to
   * null here, which is what the service turns into a 404 before any apply.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<DocumentTemplateRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(documentTemplates)
      .where(
        and(
          eq(documentTemplates.organizationId, context.organizationId),
          eq(documentTemplates.id, templateId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
  ): Promise<DocumentTemplateRow> {
    const found = await this.findById(runner, context, templateId);
    if (!found) throw new DocumentTemplateNotFoundError(templateId);
    return found;
  }

  /**
   * Create a template.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The row is read back so the server-generated `created_at` is the one
   * returned rather than a hand-assembled guess.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDocumentTemplateInput,
  ): Promise<DocumentTemplateRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(documentTemplates).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      name: input.name,
      purpose: input.purpose,
      body: input.body,
      createdByUserId: input.createdByUserId,
      createdAt: sql`current_timestamp(3)`,
    });

    return this.requireById(runner, context, id);
  }
}
