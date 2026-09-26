import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documentTemplateVariables } from '../../common/database/schema.js';
import type { DocumentTemplateVariableRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * DOC-04 (x130). The document-template-variables repository, following the
 * `document-templates`/`document-versions` pattern. It owns the tenant-scoped variable rows a
 * template declares.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * templates repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateDocumentTemplateVariableInput}
 *    has no `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 */

/** The value kinds a variable can declare, mirroring the `type` enum in `schema.ts`. */
export type DocumentTemplateVariableType = 'text' | 'date' | 'number';

/**
 * A template already declares this key. The service maps it to a 409 — a template cannot declare the
 * same key twice, and the `(organization_id, template_id, key)` unique index is the engine backstop.
 */
export class DocumentTemplateVariableKeyConflictError extends Error {
  constructor(readonly key: string) {
    // No organization id in the message, for the reason the templates not-found gives (spec §4).
    super(`A variable with key ${key} already exists on this template`);
    this.name = 'DocumentTemplateVariableKeyConflictError';
  }
}

/**
 * What the service creates. No `organizationId` (from the context), so a request body cannot choose
 * the tenant it writes into. `templateId` is resolved tenant-scoped by the service before this runs.
 */
export interface CreateDocumentTemplateVariableInput {
  readonly templateId: string;
  readonly key: string;
  readonly label: string;
  readonly type: DocumentTemplateVariableType;
  readonly required: boolean;
}

export interface ListDocumentTemplateVariablesOptions {
  /** Keyset pagination. Cursors are keys, and the walk is over `(organization_id, template_id, key)`. */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class DocumentTemplateVariablesRepository {
  /**
   * List a template's variables, key-ascending, within the acting tenant.
   *
   * Both the tenant predicate and a deterministic order are present: `key` ascending is the stable
   * order the unique index provides, and it pages without repeats. Bounded to `MAX_PAGE_SIZE`.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    options: ListDocumentTemplateVariablesOptions = {},
  ): Promise<readonly DocumentTemplateVariableRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(documentTemplateVariables.organizationId, context.organizationId),
      eq(documentTemplateVariables.templateId, templateId),
    ];
    if (options.after) predicates.push(gt(documentTemplateVariables.key, options.after));

    return db
      .select()
      .from(documentTemplateVariables)
      .where(and(...predicates))
      .orderBy(asc(documentTemplateVariables.key))
      .limit(limit);
  }

  /**
   * Fetch one variable by id, within the acting tenant and scoped to its template.
   *
   * No unscoped `findById(id)`: on MySQL that would return another customer's row. A cross-tenant or
   * cross-template id resolves to null here, which is what the service turns into a 404 before any
   * delete.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    variableId: string,
  ): Promise<DocumentTemplateVariableRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(documentTemplateVariables)
      .where(
        and(
          eq(documentTemplateVariables.organizationId, context.organizationId),
          eq(documentTemplateVariables.templateId, templateId),
          eq(documentTemplateVariables.id, variableId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a variable.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. A key already declared on the template is a
   * {@link DocumentTemplateVariableKeyConflictError} — checked tenant- and template-scoped before the
   * insert, with the unique index as the engine backstop against a race. The row is read back so the
   * server-generated `created_at` is the one returned.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDocumentTemplateVariableInput,
  ): Promise<DocumentTemplateVariableRow> {
    const db = tenantDrizzle(runner);

    const existing = await db
      .select({ id: documentTemplateVariables.id })
      .from(documentTemplateVariables)
      .where(
        and(
          eq(documentTemplateVariables.organizationId, context.organizationId),
          eq(documentTemplateVariables.templateId, input.templateId),
          eq(documentTemplateVariables.key, input.key),
        ),
      )
      .limit(1);
    if (existing[0]) throw new DocumentTemplateVariableKeyConflictError(input.key);

    const id = uuidv7();
    await db.insert(documentTemplateVariables).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      templateId: input.templateId,
      key: input.key,
      label: input.label,
      type: input.type,
      required: input.required,
      createdAt: sql`current_timestamp(3)`,
    });

    const created = await this.findById(runner, context, input.templateId, id);
    if (!created) {
      // The row was just inserted in this transaction; a null read is a real fault, not a not-found.
      throw new Error(`document_template_variables ${id} not found after insert`);
    }
    return created;
  }

  /**
   * Delete one variable, tenant- and template-scoped. Returns whether a row was removed so the
   * service can tell a real delete from a no-op (a cross-tenant id matches nothing here).
   */
  async deleteById(
    runner: TenantQueryRunner,
    context: TenantContext,
    templateId: string,
    variableId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(documentTemplateVariables)
      .where(
        and(
          eq(documentTemplateVariables.organizationId, context.organizationId),
          eq(documentTemplateVariables.templateId, templateId),
          eq(documentTemplateVariables.id, variableId),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
