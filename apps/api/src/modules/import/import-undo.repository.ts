import { and, eq, inArray, isNull } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { documents, projectPhases, workItems } from '../../common/database/schema.js';
import { softDeleteValues } from '../../common/database/content-retention.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { ImportedEntityType } from './basecamp-commit.js';

/**
 * R23-e (54-24) — the import undo's own writes and reads, tenant-scoped like every repository.
 *
 * - `remove` soft-deletes one imported document (`deleted_reason 'import_undo'`, the PA-03
 *   restore window from `softDeleteValues`). `DocumentsRepository` has no delete and the docs
 *   module is not edited by this slice, so the one UPDATE lives here.
 * - `projectIdsOf` reads the project of every created entity, so the service can authorize the
 *   undo per project before any write (the receipt rows do not carry a project id).
 */
export class ImportUndoRepository {
  async remove(runner: TenantQueryRunner, context: TenantContext, documentId: string) {
    const values = await softDeleteValues(runner, context.userId, 'import_undo');
    await tenantDrizzle(runner)
      .update(documents)
      .set(values)
      .where(
        and(
          eq(documents.organizationId, context.organizationId),
          eq(documents.id, documentId),
          isNull(documents.deletedAt),
        ),
      );
  }

  /**
   * The given entities that still exist in the acting tenant, each with its project id — the
   * service authorizes per project and undoes only what is still there (an entity purged or
   * hard-deleted since the commit is skipped, never a 500).
   */
  async locate(
    runner: TenantQueryRunner,
    context: TenantContext,
    entities: readonly ImportedEntity[],
  ): Promise<readonly LocatedEntity[]> {
    const db = tenantDrizzle(runner);
    const ids = (type: ImportedEntityType) =>
      entities.filter((e) => e.type === type).map((e) => e.id);
    const projectById = new Map<string, string>();
    const docIds = ids('document');
    if (docIds.length > 0) {
      const rows = await db
        .select({ id: documents.id, projectId: documents.projectId })
        .from(documents)
        .where(
          and(eq(documents.organizationId, context.organizationId), inArray(documents.id, docIds)),
        );
      rows.forEach((r) => projectById.set(`document:${r.id}`, r.projectId));
    }
    const itemIds = ids('work_item');
    if (itemIds.length > 0) {
      const rows = await db
        .select({ id: workItems.id, projectId: workItems.projectId })
        .from(workItems)
        .where(
          and(eq(workItems.organizationId, context.organizationId), inArray(workItems.id, itemIds)),
        );
      rows.forEach((r) => projectById.set(`work_item:${r.id}`, r.projectId));
    }
    const phaseIds = ids('phase');
    if (phaseIds.length > 0) {
      const rows = await db
        .select({ id: projectPhases.id, projectId: projectPhases.projectId })
        .from(projectPhases)
        .where(
          and(
            eq(projectPhases.organizationId, context.organizationId),
            inArray(projectPhases.id, phaseIds),
          ),
        );
      rows.forEach((r) => projectById.set(`phase:${r.id}`, r.projectId));
    }
    return entities.flatMap((entity) => {
      const projectId = projectById.get(`${entity.type}:${entity.id}`);
      return projectId === undefined ? [] : [{ ...entity, projectId }];
    });
  }
}

export interface ImportedEntity {
  readonly type: ImportedEntityType;
  readonly id: string;
}

export interface LocatedEntity extends ImportedEntity {
  readonly projectId: string;
}
