import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  googleDriveAttachments,
  googleDriveFolders,
  projects,
  storageConnections,
} from '../../common/database/schema.js';
import type {
  GoogleDriveAttachmentRow,
  StorageConnectionRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The data half of Google Drive storage. Every query carries
 * `organization_id = context.organizationId`; `organization_id` is never taken from input.
 */

export const DRIVE_PROVIDER = 'google_drive';

export type StorageMode = 'tmanage' | 'google_drive';
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
