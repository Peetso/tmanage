import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documents } from '../../common/database/schema.js';
import type { DocumentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The documents repository — DOC-01 (x91), following the `projects`/`meetings` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * projects repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` for the current unit of work and the `TenantContext`. There is no
 *    overload without a context, so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateDocumentInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through
 *    the guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state, so a
 * command composes several writes on one connection inside one transaction that
 * `TenantDatabase.transaction()` owns.
 */

export class DocumentNotFoundError extends Error {
  constructor(readonly documentId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe
    // for another tenant's document tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Document ${documentId} was not found`);
    this.name = 'DocumentNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for
 * a request body to populate and no code path that could prefer one over the other.
 */
export interface CreateDocumentInput {
  readonly projectId: string;
  readonly title: string;
  readonly body: string;
  /** The person creating the document — the service passes `context.userId`. */
  readonly createdByUserId: string;
}

export interface ListDocumentsOptions {
  /** Required: this slice lists one project's documents, never a whole tenant's. */
  readonly projectId: string;
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class DocumentsRepository {
  /**
   * List one project's documents, within the acting tenant.
   *
   * Both `organization_id` and `project_id` predicates are present. Keyset rather than offset
   * pagination on `id`, the way the projects repository walks pages: `(organization_id, id)` is
   * a key the schema carries, and UUIDv7 ids sort in creation order so the walk is chronological
   * without a second sort column.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListDocumentsOptions,
  ): Promise<readonly DocumentRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(documents.organizationId, context.organizationId),
      eq(documents.projectId, options.projectId),
    ];
    if (options.after) predicates.push(gt(documents.id, options.after));

    return db
      .select()
      .from(documents)
      .where(and(...predicates))
      .orderBy(asc(documents.id))
      .limit(limit);
  }

  /**
   * Fetch one document by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row,
   * which is why ADR-0001 exists and this signature has no unscoped form.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
  ): Promise<DocumentRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(documents)
      .where(
        and(eq(documents.organizationId, context.organizationId), eq(documents.id, documentId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
  ): Promise<DocumentRow> {
    const found = await this.findById(runner, context, documentId);
    if (!found) throw new DocumentNotFoundError(documentId);
    return found;
  }

  /**
   * Create a document.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The project is *not*
   * checked to belong to the tenant here: `fk_documents_project_tenant` is a composite foreign
   * key including `organization_id`, so the database refuses a project from another tenant — a
   * service-layer check would duplicate a guarantee that already cannot be bypassed.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateDocumentInput,
  ): Promise<DocumentRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(documents).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      title: input.title,
      body: input.body,
      createdByUserId: input.createdByUserId,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries server-generated timestamps, and
    // returning a hand-assembled object would let the two disagree.
    return this.requireById(runner, context, id);
  }

  /**
   * B4. Rename a document, optimistically: the `WHERE` names the `updated_at` the caller last
   * saw, so a second writer who saved in between matches no row and the method returns `false`
   * rather than overwriting. `updated_at` is set explicitly so the row always moves — the next
   * writer's expected value is stale even when only the title changed. The 0030 immutability
   * trigger permits it (only `title`/`body` are editable).
   */
  async rename(
    runner: TenantQueryRunner,
    context: TenantContext,
    documentId: string,
    expectedUpdatedAt: Date,
    title: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(documents)
      .set({
        title,
        updatedAt: sql`current_timestamp(3)`,
        // F2 (0227): the editor names who renamed it when another writer's rename conflicts.
        titleUpdatedByUserId: context.userId,
      })
      .where(
        and(
          eq(documents.organizationId, context.organizationId),
          eq(documents.id, documentId),
          eq(documents.updatedAt, expectedUpdatedAt),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
