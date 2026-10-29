import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  onedriveAttachments,
  onedriveFolders,
  projects,
  storageConnections,
  workItems,
} from '../../common/database/schema.js';
import type {
  OneDriveAttachmentRow,
  StorageConnectionRow,
  WorkItemRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of OneDrive storage (0236). Every query carries
 * `organization_id = context.organizationId`; `organization_id` is never taken from input. The
 * connection is the organization's `storage_connections` row with `provider = 'onedrive'`.
 */

export const ONEDRIVE_PROVIDER = 'onedrive';

export type ConnectionStatus = 'connected' | 'error' | 'disconnected';

export interface SaveConnectionInput {
  readonly accountEmail: string | null;
  readonly refreshTokenEnc: string;
  readonly driveId: string;
  readonly driveName: string;
  readonly rootItemId: string;
  readonly grantedScopes: string | null;
  readonly connectedByUserId: string;
}

export interface InsertAttachmentInput {
  readonly workItemId: string;
  readonly driveId: string;
  readonly itemId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number | null;
  readonly webUrl: string | null;
  readonly attachedByUserId: string;
}

export interface FolderKey {
  readonly rootItemId: string;
  readonly subjectKind: 'project' | 'work_item';
  readonly subjectId: string;
}

/** A TManage-made folder and the project it belongs to now (null: its item is gone). */
export interface KnownOneDriveFolder {
  readonly itemId: string;
  readonly projectId: string | null;
}

/** The fields of a work item the read check needs. */
export type AttachedItem = Pick<
  WorkItemRow,
  'organizationId' | 'projectId' | 'audience' | 'state' | 'deletedAt'
>;

/** NV10. One of a project's own TManage folders, for the server-side file list. */
export interface ProjectOneDriveFolder {
  readonly itemId: string;
  readonly kind: 'project' | 'work_item';
  readonly name: string;
  readonly item: AttachedItem | null;
}

export type ConnectionPatch = Partial<{
  status: ConnectionStatus;
  refreshTokenEnc: string | null;
  rootFolderId: string | null;
  onedriveDriveId: string | null;
  onedriveDriveName: string | null;
  sharedDriveId: string | null;
  sharedDriveName: string | null;
  grantedScopes: string | null;
  lastErrorCode: string | null;
  storageMode: 'tmanage';
  disconnectedAt: Date | null;
}>;

export class OneDriveRepository {
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
          eq(storageConnections.provider, ONEDRIVE_PROVIDER),
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
      rootFolderId: input.rootItemId,
      onedriveDriveId: input.driveId,
      onedriveDriveName: input.driveName,
      // `shared_drive_name` holds a SharePoint library's label; a (re)connect starts at My files.
      sharedDriveId: null,
      sharedDriveName: null,
      grantedScopes: input.grantedScopes,
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
      provider: ONEDRIVE_PROVIDER,
      storageMode: 'tmanage',
      createdAt: sql`current_timestamp(3)`,
      ...fields,
    });
  }

  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
    patch: ConnectionPatch,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(storageConnections)
      .set({ ...patch, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          eq(storageConnections.id, connectionId),
          eq(storageConnections.provider, ONEDRIVE_PROVIDER),
        ),
      );
  }

  /**
   * Store the refresh token Microsoft rotated to. Only on a row that still holds one and is not
   * disconnected: a disconnect racing a refresh must never get the secret written back.
   */
  async storeRotatedToken(
    runner: TenantQueryRunner,
    context: TenantContext,
    connectionId: string,
    refreshTokenEnc: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(storageConnections)
      .set({ refreshTokenEnc, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          eq(storageConnections.id, connectionId),
          eq(storageConnections.provider, ONEDRIVE_PROVIDER),
          ne(storageConnections.status, 'disconnected'),
          isNotNull(storageConnections.refreshTokenEnc),
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
    key: FolderKey,
  ): Promise<string | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({ id: onedriveFolders.itemId })
      .from(onedriveFolders)
      .where(
        and(
          eq(onedriveFolders.organizationId, context.organizationId),
          eq(onedriveFolders.rootItemId, key.rootItemId),
          eq(onedriveFolders.subjectKind, key.subjectKind),
          eq(onedriveFolders.subjectId, key.subjectId),
        ),
      )
      .limit(1);
    return rows[0]?.id;
  }

  async insertFolder(
    runner: TenantQueryRunner,
    context: TenantContext,
    key: FolderKey,
    folder: { driveId: string; itemId: string },
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(onedriveFolders)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        ...key,
        ...folder,
        createdAt: sql`current_timestamp(3)`,
      });
  }

  /** Whether `itemId` (in `driveId`) is one of this organization's TManage folders, and whose. */
  async findKnownFolder(
    runner: TenantQueryRunner,
    context: TenantContext,
    driveId: string,
    itemId: string,
  ): Promise<KnownOneDriveFolder | undefined> {
    const rows = await tenantDrizzle(runner)
      .select({
        itemId: onedriveFolders.itemId,
        subjectKind: onedriveFolders.subjectKind,
        subjectId: onedriveFolders.subjectId,
        itemProjectId: workItems.projectId,
      })
      .from(onedriveFolders)
      .leftJoin(
        workItems,
        and(
          eq(workItems.organizationId, onedriveFolders.organizationId),
          eq(workItems.id, onedriveFolders.subjectId),
          eq(onedriveFolders.subjectKind, 'work_item'),
        ),
      )
      .where(
        and(
          eq(onedriveFolders.organizationId, context.organizationId),
          eq(onedriveFolders.driveId, driveId),
          eq(onedriveFolders.itemId, itemId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return undefined;
    return {
      itemId: row.itemId,
      projectId: row.subjectKind === 'project' ? row.subjectId : (row.itemProjectId ?? null),
    };
  }

  /** Whether `itemId` is a TManage root this organization has used (in a folder row or now). */
  async isKnownRoot(
    runner: TenantQueryRunner,
    context: TenantContext,
    itemId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const fromFolders = await db
      .select({ id: onedriveFolders.id })
      .from(onedriveFolders)
      .where(
        and(
          eq(onedriveFolders.organizationId, context.organizationId),
          eq(onedriveFolders.rootItemId, itemId),
        ),
      )
      .limit(1);
    if (fromFolders.length > 0) return true;
    const fromConnection = await db
      .select({ id: storageConnections.id })
      .from(storageConnections)
      .where(
        and(
          eq(storageConnections.organizationId, context.organizationId),
          eq(storageConnections.provider, ONEDRIVE_PROVIDER),
          eq(storageConnections.rootFolderId, itemId),
        ),
      )
      .limit(1);
    return fromConnection.length > 0;
  }

  /**
   * NV10. The project's own TManage folders under `rootItemId`: its project folder, and the
   * work-item folders of items that are in this project now (a deleted item's folder is left out).
   */
  async listProjectFolders(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    rootItemId: string,
  ): Promise<readonly ProjectOneDriveFolder[]> {
    const db = tenantDrizzle(runner);
    const projectRows = await db
      .select({ itemId: onedriveFolders.itemId, name: projects.name })
      .from(onedriveFolders)
      .innerJoin(
        projects,
        and(
          eq(projects.organizationId, onedriveFolders.organizationId),
          eq(projects.id, onedriveFolders.subjectId),
        ),
      )
      .where(
        and(
          eq(onedriveFolders.organizationId, context.organizationId),
          eq(onedriveFolders.rootItemId, rootItemId),
          eq(onedriveFolders.subjectKind, 'project'),
          eq(onedriveFolders.subjectId, projectId),
        ),
      )
      .limit(1);
    const itemRows = await db
      .select({
        itemId: onedriveFolders.itemId,
        name: workItems.title,
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        audience: workItems.audience,
        state: workItems.state,
        deletedAt: workItems.deletedAt,
      })
      .from(onedriveFolders)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, onedriveFolders.organizationId),
          eq(workItems.id, onedriveFolders.subjectId),
        ),
      )
      .where(
        and(
          eq(onedriveFolders.organizationId, context.organizationId),
          eq(onedriveFolders.rootItemId, rootItemId),
          eq(onedriveFolders.subjectKind, 'work_item'),
          eq(workItems.projectId, projectId),
          isNull(workItems.deletedAt),
        ),
      )
      .orderBy(asc(workItems.title))
      .limit(500);
    return [
      ...projectRows.map((row) => ({
        itemId: row.itemId,
        kind: 'project' as const,
        name: row.name,
        item: null,
      })),
      ...itemRows.map((row) => ({
        itemId: row.itemId,
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

  /** Every work item the file is or was attached to (detached links included). */
  async attachedItemsForFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    driveId: string,
    itemId: string,
  ): Promise<readonly AttachedItem[]> {
    return tenantDrizzle(runner)
      .select({
        organizationId: workItems.organizationId,
        projectId: workItems.projectId,
        audience: workItems.audience,
        state: workItems.state,
        deletedAt: workItems.deletedAt,
      })
      .from(onedriveAttachments)
      .innerJoin(
        workItems,
        and(
          eq(workItems.organizationId, onedriveAttachments.organizationId),
          eq(workItems.id, onedriveAttachments.workItemId),
        ),
      )
      .where(
        and(
          eq(onedriveAttachments.organizationId, context.organizationId),
          eq(onedriveAttachments.driveId, driveId),
          eq(onedriveAttachments.itemId, itemId),
        ),
      );
  }

  async listAttachments(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
  ): Promise<readonly OneDriveAttachmentRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(onedriveAttachments)
      .where(
        and(
          eq(onedriveAttachments.organizationId, context.organizationId),
          eq(onedriveAttachments.workItemId, workItemId),
          isNull(onedriveAttachments.removedAt),
          // PA-03 (0245): a soft-deleted attachment leaves the list.
          isNull(onedriveAttachments.deletedAt),
        ),
      )
      .orderBy(asc(onedriveAttachments.id));
  }

  async insertAttachment(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertAttachmentInput,
  ): Promise<OneDriveAttachmentRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(onedriveAttachments).values({
      id,
      organizationId: context.organizationId,
      ...input,
      createdAt: sql`current_timestamp(3)`,
    });
    const rows = await db
      .select()
      .from(onedriveAttachments)
      .where(
        and(
          eq(onedriveAttachments.organizationId, context.organizationId),
          eq(onedriveAttachments.id, id),
        ),
      )
      .limit(1);
    return rows[0] as OneDriveAttachmentRow;
  }

  /** Soft detach; returns how many rows changed (0 = absent, foreign or already removed). */
  async removeAttachment(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    attachmentId: string,
  ): Promise<number> {
    const result = await tenantDrizzle(runner)
      .update(onedriveAttachments)
      .set({ removedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(onedriveAttachments.organizationId, context.organizationId),
          eq(onedriveAttachments.workItemId, workItemId),
          eq(onedriveAttachments.id, attachmentId),
          isNull(onedriveAttachments.removedAt),
        ),
      );
    return result[0].affectedRows;
  }
}
