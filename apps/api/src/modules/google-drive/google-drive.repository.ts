import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  googleDriveAttachments,
  googleDriveFolders,
  projects,
  storageConnections,
  workItems,
} from '../../common/database/schema.js';
import type {
  GoogleDriveAttachmentRow,
  StorageConnectionRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { StorageMode } from './storage-mode.repository.js';
import { DRIVE_MY_DRIVE_NAME } from './google-drive.google.js';

/**
 * The data half of Google Drive storage. Every query carries
 * `organization_id = context.organizationId`; `organization_id` is never taken from input.
 */

export const DRIVE_PROVIDER = 'google_drive';

/** 0236. Widened with OneDrive; the one-mode-per-organization rule lives in `storage-mode.ts`. */
export type { StorageMode };
export type ConnectionStatus = 'connected' | 'error' | 'disconnected';

export interface SaveConnectionInput {
  readonly accountEmail: string | null;
  readonly refreshTokenEnc: string;
  readonly rootFolderId: string;
  readonly connectedByUserId: string;
}

export interface InsertAttachmentInput {
  readonly workItemId: string;
  readonly driveFileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly webViewLink: string | null;
  readonly attachedByUserId: string;
}

/** V2. A TManage-made Drive folder and the project it belongs to now. */
export interface KnownDriveFolder {
  readonly driveFolderId: string;
  readonly rootFolderId: string;
  /** The project folder's project, or the work-item folder's item's project (null: item gone). */
  readonly projectId: string | null;
}

/** V2. The fields of a work item the read check needs. */
export type AttachedItem = Pick<
  WorkItemRow,
  'organizationId' | 'projectId' | 'audience' | 'state' | 'deletedAt'
>;

/** NV10. One of a project's own TManage folders, for the server-side file list. */
export interface ProjectDriveFolder {
  readonly driveFolderId: string;
  readonly kind: 'project' | 'work_item';
  /** The project's name or the work item's title (TManage's, not Google's). */
  readonly name: string;
  /** The work item the folder belongs to (null for the project folder), for the read check. */
  readonly item: AttachedItem | null;
}

export class GoogleDriveRepository {
  async findConnection(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<StorageConnectionRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(storageConnections)
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          eq(storageConnections.provider, DRIVE_PROVIDER),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Connect (or reconnect): one row per organization and provider, upserted. */
  async saveConnected(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: SaveConnectionInput,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    const existing = await this.findConnection(runner, context);
    const fields = {
      status: 'connected',
      accountEmail: input.accountEmail,
      refreshTokenEnc: input.refreshTokenEnc,
      rootFolderId: input.rootFolderId,
      sharedDriveId: null,
      sharedDriveName: null,
      // 0238. A (re)connect puts the root at the top of My Drive.
      locationName: DRIVE_MY_DRIVE_NAME,
      lastErrorCode: null,
      connectedByUserId: input.connectedByUserId,
      connectedAt: sql`current_timestamp(3)`,
      disconnectedAt: null,
      updatedAt: sql`current_timestamp(3)`,
    } as const;
    if (existing) {
      await db
        .update(storageConnections)
        .set(fields)
        .where(
          and(
            eq(storageConnections.organizationId, context.organizationId),
            eq(storageConnections.id, existing.id),
          ),
        );
      return;
    }
    await db.insert(storageConnections).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      provider: DRIVE_PROVIDER,
      storageMode: 'tmanage',
      createdAt: sql`current_timestamp(3)`,
      ...fields,
    });
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
    patch: Partial<{
      storageMode: StorageMode;
      status: ConnectionStatus;
      refreshTokenEnc: string | null;
      rootFolderId: string | null;
      sharedDriveId: string | null;
      sharedDriveName: string | null;
      locationName: string | null;
      lastErrorCode: string | null;
      disconnectedAt: Date | null;
    }>,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(storageConnections)
      .set({ ...patch, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          eq(storageConnections.id, connectionId),
        ),
      );
  }

  async projectName(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<string | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.organizationId, context.organizationId), eq(projects.id, projectId)))
      .limit(1);
    return rows[0]?.name;
  }

  async findFolder(
    runner: TenantQueryRunner,
    context: TenantContext,
    key: { rootFolderId: string; subjectKind: 'project' | 'work_item'; subjectId: string },
  ): Promise<string | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: googleDriveFolders.driveFolderId })
      .from(googleDriveFolders)
      .where(
        and(
          eq(googleDriveFolders.organizationId, context.organizationId),
          eq(googleDriveFolders.rootFolderId, key.rootFolderId),
          eq(googleDriveFolders.subjectKind, key.subjectKind),
          eq(googleDriveFolders.subjectId, key.subjectId),
        ),
      )
      .limit(1);
    return rows[0]?.id;
  }

  async insertFolder(
    runner: TenantQueryRunner,
    context: TenantContext,
    key: { rootFolderId: string; subjectKind: 'project' | 'work_item'; subjectId: string },
    driveFolderId: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(googleDriveFolders)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        ...key,
        driveFolderId,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  /**
   * V2. Which of `driveFolderIds` are TManage's own project or work-item folders (under any root
   * this organization has used), each with the project it belongs to.
   */
  async findKnownFolders(
    runner: TenantQueryRunner,
    context: TenantContext,
    driveFolderIds: readonly string[],
  ): Promise<readonly KnownDriveFolder[]> {
    if (driveFolderIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select({
        driveFolderId: googleDriveFolders.driveFolderId,
        rootFolderId: googleDriveFolders.rootFolderId,
        subjectKind: googleDriveFolders.subjectKind,
        subjectId: googleDriveFolders.subjectId,
        itemProjectId: workItems.projectId,
      })
      .from(googleDriveFolders)
      .leftJoin(
        workItems,
        and(
          eq(workItems.organizationId, googleDriveFolders.organizationId),
          eq(workItems.id, googleDriveFolders.subjectId),
          eq(googleDriveFolders.subjectKind, 'work_item'),
        ),
      )
      .where(
        and(
          eq(googleDriveFolders.organizationId, context.organizationId),
          inArray(googleDriveFolders.driveFolderId, [...driveFolderIds]),
        ),
      );
    return rows.map((row) => ({
      driveFolderId: row.driveFolderId,
      rootFolderId: row.rootFolderId,
      projectId: row.subjectKind === 'project' ? row.subjectId : (row.itemProjectId ?? null),
    }));
  }

  /**
   * NV10. The project's own TManage folders under `rootFolderId`: its project folder, and the
   * work-item folders of items that are in this project now (a moved item's folder follows the
   * item; a deleted item's folder is left out). These are the only folders a project-scoped person
   * may list through the server.
   */
  async listProjectFolders(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    rootFolderId: string,
  ): Promise<readonly ProjectDriveFolder[]> {
    const db = tenantDrizzle(runner);
    const projectRows = await db
      .select({ driveFolderId: googleDriveFolders.driveFolderId, name: projects.name })
      .from(googleDriveFolders)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, googleDriveFolders.organizationId),
          eq(projects.id, googleDriveFolders.subjectId),
        ),
      )
      .where(
        and(
          eq(googleDriveFolders.organizationId, context.organizationId),
          eq(googleDriveFolders.rootFolderId, rootFolderId),
          eq(googleDriveFolders.subjectKind, 'project'),
          eq(googleDriveFolders.subjectId, projectId),
        ),
      )
      .limit(1);
    const itemRows = await db
      .select({
        driveFolderId: googleDriveFolders.driveFolderId,
        name: workItems.title,
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        audience: workItems.audience,
        state: workItems.state,
        deletedAt: workItems.deletedAt,
      })
      .from(googleDriveFolders)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, googleDriveFolders.organizationId),
          eq(workItems.id, googleDriveFolders.subjectId),
        ),
      )
      .where(
        and(
          eq(googleDriveFolders.organizationId, context.organizationId),
          eq(googleDriveFolders.rootFolderId, rootFolderId),
          eq(googleDriveFolders.subjectKind, 'work_item'),
          eq(workItems.projectId, projectId),
          isNull(workItems.deletedAt),
        ),
      )
      .orderBy(asc(workItems.title))
      .limit(500);
    return [
      ...projectRows.map((row) => ({
        driveFolderId: row.driveFolderId,
        kind: 'project' as const,
        name: row.name,
        item: null,
      })),
      ...itemRows.map((row) => ({
        driveFolderId: row.driveFolderId,
        kind: 'work_item' as const,
        name: row.name,
        item: {
          organizationId: row.organizationId,
          projectId: row.projectId,
          audience: row.audience,
          state: row.state,
          deletedAt: row.deletedAt,
        },
      })),
    ];
  }

  /** V2. Which of `driveFolderIds` are a TManage root folder this organization has used. */
  async knownRootsAmong(
    runner: TenantQueryRunner,
    context: TenantContext,
    driveFolderIds: readonly string[],
  ): Promise<readonly string[]> {
    if (driveFolderIds.length === 0) return [];
    const fromFolders = await tenantDrizzle(runner)
      .selectDistinct({ id: googleDriveFolders.rootFolderId })
      .from(googleDriveFolders)
      .where(
        and(
          eq(googleDriveFolders.organizationId, context.organizationId),
          inArray(googleDriveFolders.rootFolderId, [...driveFolderIds]),
        ),
      );
    const fromConnection = await tenantDrizzle(runner)
      .select({ id: storageConnections.rootFolderId })
      .from(storageConnections)
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          inArray(storageConnections.rootFolderId, [...driveFolderIds]),
        ),
      );
    return [...fromFolders, ...fromConnection]
      .map((row) => row.id)
      .filter((id): id is string => typeof id === 'string');
  }

  /**
   * V2. Every work item (in this organization) the Drive file is or was attached to, detached
   * links included: the attach check refuses a file already linked where the caller cannot read.
   */
  async attachedItemsForFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    driveFileId: string,
  ): Promise<readonly AttachedItem[]> {
    return tenantDrizzle(runner)
      .select({
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        audience: workItems.audience,
        state: workItems.state,
        deletedAt: workItems.deletedAt,
      })
      .from(googleDriveAttachments)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, googleDriveAttachments.organizationId),
          eq(workItems.id, googleDriveAttachments.workItemId),
        ),
      )
      .where(
        and(
          eq(googleDriveAttachments.organizationId, context.organizationId),
          eq(googleDriveAttachments.driveFileId, driveFileId),
        ),
      );
  }

  async listAttachments(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly GoogleDriveAttachmentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(googleDriveAttachments)
      .where(
        and(
          eq(googleDriveAttachments.organizationId, context.organizationId),
          eq(googleDriveAttachments.workItemId, workItemId),
          isNull(googleDriveAttachments.removedAt),
          // PA-03 (0245): a soft-deleted attachment leaves the list.
          isNull(googleDriveAttachments.deletedAt),
        ),
      )
      .orderBy(asc(googleDriveAttachments.id));
  }

  async insertAttachment(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertAttachmentInput,
  ): Promise<GoogleDriveAttachmentRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(googleDriveAttachments).values({
      id,
      organizationId: context.organizationId,
      ...input,
      createdAt: sql`current_timestamp(3)`,
    });
    const rows = await db
      .select()
      .from(googleDriveAttachments)
      .where(
        and(
          eq(googleDriveAttachments.organizationId, context.organizationId),
          eq(googleDriveAttachments.id, id),
        ),
      )
      .limit(1);
    return rows[0] as GoogleDriveAttachmentRow;
  }

  /** Soft detach; returns how many rows changed (0 = absent, foreign or already removed). */
  async removeAttachment(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    attachmentId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(googleDriveAttachments)
      .set({ removedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(googleDriveAttachments.organizationId, context.organizationId),
          eq(googleDriveAttachments.workItemId, workItemId),
          eq(googleDriveAttachments.id, attachmentId),
          isNull(googleDriveAttachments.removedAt),
        ),
      );
    return result[0].affectedRows;
  }
}
