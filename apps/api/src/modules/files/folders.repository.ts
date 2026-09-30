import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileFolders } from '../../common/database/schema.js';
import type { FileFolderRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * File folders — x332's storage half (Files module).
 *
 * One table serves two row kinds (see `0198_file_folders.sql`, the x270/x294 precedent): a **folder**
 * row carries `project_id` + `name` + `created_by` with `file_id`/`folder_id` NULL; a **membership**
 * row carries `file_id` + `folder_id` with `name`/`project_id`/`created_by` NULL. Every read and
 * write is bound to `(organization_id, …)`, so a caller in the wrong tenant sees nothing rather than
 * a leak, and the repository holds no policy — the service decides who may read or write, and the
 * composite foreign keys of migration 0198 make a cross-tenant project, file or folder id a
 * non-existent pair.
 */

/** The largest folder page a single read returns; mirrors the bounded reads elsewhere. */
export const MAX_FILE_FOLDERS_PAGE = 500;

export class FileFoldersRepository {
  /** The tenant's folder rows for one project, name-ascending, bounded to one page. */
  async listFolders(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    limit: number = MAX_FILE_FOLDERS_PAGE,
  ): Promise<readonly FileFolderRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileFolders)
      .where(
        and(
          eq(fileFolders.organizationId, context.organizationId),
          eq(fileFolders.projectId, projectId),
          isNull(fileFolders.fileId),
        ),
      )
      .orderBy(asc(fileFolders.name), asc(fileFolders.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_FILE_FOLDERS_PAGE));
  }

  /** One folder row, scoped to the tenant; `null` if absent (or if the id names a membership). */
  async findFolder(
    runner: TenantQueryRunner,
    context: TenantContext,
    folderId: string,
  ): Promise<FileFolderRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileFolders)
      .where(
        and(
          eq(fileFolders.organizationId, context.organizationId),
          eq(fileFolders.id, folderId),
          isNull(fileFolders.fileId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** A folder with this name in the project; `null` if the name is free. */
  async findFolderByName(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    name: string,
  ): Promise<FileFolderRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileFolders)
      .where(
        and(
          eq(fileFolders.organizationId, context.organizationId),
          eq(fileFolders.projectId, projectId),
          eq(fileFolders.name, name),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create a folder. Folder rows carry `project_id` + `name` + `created_by`, NULL `file_id`. */
  async createFolder(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    name: string,
    createdBy: string,
  ): Promise<FileFolderRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileFolders)
      .values({
        id,
        organizationId: context.organizationId,
        projectId,
        fileId: null,
        folderId: null,
        name,
        createdBy,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findFolder(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('file folder vanished immediately after insert');
    }
    return created;
  }

  /** Delete a folder row by id, scoped to the tenant. */
  async deleteFolder(
    runner: TenantQueryRunner,
    context: TenantContext,
    folderId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .delete(fileFolders)
      .where(
        and(
          eq(fileFolders.organizationId, context.organizationId),
          eq(fileFolders.id, folderId),
          isNull(fileFolders.fileId),
        ),
      );
  }

  /** The membership rows filed into one folder of this tenant — the folder's contents. */
  async listFolderContents(
    runner: TenantQueryRunner,
    context: TenantContext,
    folderId: string,
    limit: number = MAX_FILE_FOLDERS_PAGE,
  ): Promise<readonly FileFolderRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(fileFolders)
      .where(
        and(
          eq(fileFolders.organizationId, context.organizationId),
          eq(fileFolders.folderId, folderId),
        ),
      )
      .orderBy(asc(fileFolders.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_FILE_FOLDERS_PAGE));
  }

  /** `true` if at least one file is filed into the folder — the non-empty check delete refuses on. */
  async folderHasContents(
    runner: TenantQueryRunner,
    context: TenantContext,
    folderId: string,
  ): Promise<boolean> {
    const rows = await tenantDrizzle(runner)
      .select({ id: fileFolders.id })
      .from(fileFolders)
      .where(
        and(
          eq(fileFolders.organizationId, context.organizationId),
          eq(fileFolders.folderId, folderId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The membership row for one file of this tenant; `null` if the file is at root. */
  async findMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileId: string,
  ): Promise<FileFolderRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(fileFolders)
      .where(
        and(eq(fileFolders.organizationId, context.organizationId), eq(fileFolders.fileId, fileId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** File a file into a folder. Membership rows carry `file_id` + `folder_id`. */
  async createMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileId: string,
    folderId: string,
  ): Promise<FileFolderRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(fileFolders)
      .values({
        id,
        organizationId: context.organizationId,
        projectId: null,
        fileId,
        folderId,
        name: null,
        createdBy: null,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findMembership(runner, context, fileId);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('file folder membership vanished immediately after insert');
    }
    return created;
  }

  /** Re-file a file: move its membership row's `folder_id` in place (idempotent). */
  async updateMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileId: string,
    folderId: string,
  ): Promise<FileFolderRow> {
    await tenantDrizzle(runner)
      .update(fileFolders)
      .set({ folderId })
      .where(
        and(eq(fileFolders.organizationId, context.organizationId), eq(fileFolders.fileId, fileId)),
      );

    const updated = await this.findMembership(runner, context, fileId);
    if (!updated) {
      // Unreachable: the row was resolved before this update was issued.
      throw new Error('file folder membership vanished immediately after update');
    }
    return updated;
  }

  /** File a file back to root: remove its membership row. `true` if a row was removed. */
  async deleteMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileId: string,
  ): Promise<boolean> {
    const existing = await this.findMembership(runner, context, fileId);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(fileFolders)
      .where(
        and(eq(fileFolders.organizationId, context.organizationId), eq(fileFolders.fileId, fileId)),
      );
    return true;
  }
}
