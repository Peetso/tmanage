import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileAssets, fileVersions, storageMigrationJobs } from '../../common/database/schema.js';
import type { StorageMigrationJobRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ProviderBackend, ProviderObjectRef } from '../files/provider-objects.js';

/** One local, promoted, clean version the move job may copy, with what the copy needs. */
export interface MoveCandidate {
  readonly id: string;
  readonly organizationId: string;
  readonly fileAssetId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly contentHash: string;
  readonly storageBackend: string;
  readonly providerFileId: string | null;
  readonly storageConnectionId: string | null;
}

/** A number of file versions and their bytes. */
export interface FileFigures {
  readonly files: number;
  readonly bytes: number;
}

/** What TManage still holds for a company, and how much of it a move would copy. */
export interface LocalFigures extends FileFigures {
  readonly movable: number;
}

/** What one moved, failed or skipped file adds to a job row. */
export interface JobAdvance {
  readonly moved: number;
  readonly failed: number;
  readonly skipped: number;
  readonly movedBytes: number;
  readonly cursorVersionId: string;
  readonly pendingObjectKey: string | null;
}

const LIVE = ['queued', 'running'] as const;

/**
 * 57-13b. Data access for the "Move to Drive" job. Every tenant query carries the acting
 * tenant's `organization_id`; the one cross-tenant read (which companies have a live job) runs
 * through `bootstrapRead` and returns organization ids only.
 */
export class StorageMoveRepository {
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    row: {
      readonly id: string;
      readonly backend: ProviderBackend;
      readonly storageConnectionId: string;
      readonly requestedByUserId: string;
      readonly total: number;
      readonly totalBytes: number;
      readonly now: Date;
    },
  ): Promise<void> {
    await tenantDrizzle(runner).insert(storageMigrationJobs).values({
      id: row.id,
      organizationId: context.organizationId,
      activeOrganizationId: context.organizationId,
      kind: 'transient_to_provider',
      backend: row.backend,
      storageConnectionId: row.storageConnectionId,
      status: 'queued',
      requestedByUserId: row.requestedByUserId,
      total: row.total,
      totalBytes: row.totalBytes,
      createdAt: row.now,
      updatedAt: row.now,
    });
  }

  /** The company's queued or running job, if any (at most one: `uq_storage_migration_jobs_active`). */
  async findActive(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<StorageMigrationJobRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(storageMigrationJobs)
      .where(
        and(
          eq(storageMigrationJobs.organizationId, context.organizationId),
          eq(storageMigrationJobs.activeOrganizationId, context.organizationId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<StorageMigrationJobRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(storageMigrationJobs)
      .where(
        and(
          eq(storageMigrationJobs.organizationId, context.organizationId),
          eq(storageMigrationJobs.id, id),
        ),
      )
      .limit(1);
    return rows[0];
  }

  async findLatest(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<StorageMigrationJobRow | undefined> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(storageMigrationJobs)
      .where(eq(storageMigrationJobs.organizationId, context.organizationId))
      .orderBy(desc(storageMigrationJobs.createdAt), desc(storageMigrationJobs.id))
      .limit(1);
    return rows[0];
  }

  /** How many versions a new job would move, and their bytes (the job's `total` / `total_bytes`). */
  async measureCandidates(runner: TenantQueryRunner, context: TenantContext): Promise<FileFigures> {
    const rows = await tenantDrizzle(runner)
      .select({
        files: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${fileVersions.sizeBytes}), 0)`,
      })
      .from(fileVersions)
      .innerJoin(
        fileAssets,
        and(
          eq(fileAssets.organizationId, fileVersions.organizationId),
          eq(fileAssets.id, fileVersions.fileAssetId),
        ),
      )
      .where(candidateWhere(context, ''));
    return { files: Number(rows[0]?.files ?? 0), bytes: Number(rows[0]?.bytes ?? 0) };
  }

  /**
   * The company's versions whose bytes are still on TManage's own storage (every file not yet
   * purged), and how many of them a new move would copy: the candidates no larger than
   * `maxFileBytes`.
   */
  async localFigures(
    runner: TenantQueryRunner,
    context: TenantContext,
    maxFileBytes: number,
  ): Promise<LocalFigures> {
    const rows = await tenantDrizzle(runner)
      .select({
        files: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${fileVersions.sizeBytes}), 0)`,
        movable: sql<number>`coalesce(sum(case when ${and(
          eq(fileVersions.trustZone, 'private'),
          eq(fileVersions.scanVerdict, 'clean'),
          isNotNull(fileVersions.contentHash),
          eq(fileAssets.status, 'ready'),
          isNull(fileAssets.deletedAt),
          lte(fileVersions.sizeBytes, maxFileBytes),
        )} then 1 else 0 end), 0)`,
      })
      .from(fileVersions)
      .innerJoin(
        fileAssets,
        and(
          eq(fileAssets.organizationId, fileVersions.organizationId),
          eq(fileAssets.id, fileVersions.fileAssetId),
        ),
      )
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileAssets.organizationId, context.organizationId),
          eq(fileVersions.storageBackend, 'local'),
          isNull(fileAssets.purgedAt),
        ),
      );
    return {
      files: Number(rows[0]?.files ?? 0),
      bytes: Number(rows[0]?.bytes ?? 0),
      movable: Number(rows[0]?.movable ?? 0),
    };
  }

  /** The next candidates after `afterId`, in id order: the resumable cursor. */
  async nextCandidates(
    runner: TenantQueryRunner,
    context: TenantContext,
    afterId: string,
    limit: number,
  ): Promise<readonly MoveCandidate[]> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: fileVersions.id,
        organizationId: fileVersions.organizationId,
        fileAssetId: fileVersions.fileAssetId,
        name: fileAssets.name,
        detectedMimeType: fileVersions.detectedMimeType,
        declaredMimeType: fileVersions.declaredMimeType,
        objectKey: fileVersions.objectKey,
        sizeBytes: fileVersions.sizeBytes,
        contentHash: fileVersions.contentHash,
        storageBackend: fileVersions.storageBackend,
        providerFileId: fileVersions.providerFileId,
        storageConnectionId: fileVersions.storageConnectionId,
      })
      .from(fileVersions)
      .innerJoin(
        fileAssets,
        and(
          eq(fileAssets.organizationId, fileVersions.organizationId),
          eq(fileAssets.id, fileVersions.fileAssetId),
        ),
      )
      .where(candidateWhere(context, afterId))
      .orderBy(asc(fileVersions.id))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organizationId,
      fileAssetId: row.fileAssetId,
      name: row.name,
      mimeType: row.detectedMimeType ?? row.declaredMimeType,
      objectKey: row.objectKey,
      sizeBytes: row.sizeBytes,
      contentHash: row.contentHash ?? '',
      storageBackend: row.storageBackend,
      providerFileId: row.providerFileId,
      storageConnectionId: row.storageConnectionId,
    }));
  }

  /**
   * Point the version at its provider copy — only while it is still `local`, so a second pass
   * (or a concurrent one) flips nothing twice. Answers whether this call flipped it.
   */
  async flip(
    runner: TenantQueryRunner,
    context: TenantContext,
    versionId: string,
    backend: ProviderBackend,
    ref: ProviderObjectRef,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(fileVersions)
      .set({
        storageBackend: backend,
        providerFileId: ref.providerFileId,
        storageConnectionId: ref.connectionId,
      })
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.id, versionId),
          eq(fileVersions.storageBackend, 'local'),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /** Take the job for one pass; a claim older than `staleBefore` is taken over. */
  async claim(
    runner: TenantQueryRunner,
    context: TenantContext,
    jobId: string,
    now: Date,
    staleBefore: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(storageMigrationJobs)
      .set({
        status: 'running',
        claimedAt: now,
        startedAt: sql`coalesce(started_at, ${now})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageMigrationJobs.organizationId, context.organizationId),
          eq(storageMigrationJobs.id, jobId),
          inArray(storageMigrationJobs.status, [...LIVE]),
          or(
            isNull(storageMigrationJobs.claimedAt),
            lt(storageMigrationJobs.claimedAt, staleBefore),
          ),
        ),
      );
    return result[0].affectedRows === 1;
  }

  async advance(
    runner: TenantQueryRunner,
    context: TenantContext,
    jobId: string,
    step: JobAdvance,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(storageMigrationJobs)
      .set({
        moved: sql`moved + ${step.moved}`,
        failed: sql`failed + ${step.failed}`,
        skipped: sql`skipped + ${step.skipped}`,
        movedBytes: sql`moved_bytes + ${step.movedBytes}`,
        cursorVersionId: step.cursorVersionId,
        pendingObjectKey: step.pendingObjectKey,
        claimedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageMigrationJobs.organizationId, context.organizationId),
          eq(storageMigrationJobs.id, jobId),
        ),
      );
  }

  /** The local delete named by `pending_object_key` is confirmed. */
  async clearPending(
    runner: TenantQueryRunner,
    context: TenantContext,
    jobId: string,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(storageMigrationJobs)
      .set({ pendingObjectKey: null, updatedAt: now })
      .where(
        and(
          eq(storageMigrationJobs.organizationId, context.organizationId),
          eq(storageMigrationJobs.id, jobId),
        ),
      );
  }

  /** Done or stopped: the company may start another job. */
  async finish(
    runner: TenantQueryRunner,
    context: TenantContext,
    jobId: string,
    status: 'done' | 'stopped',
    error: string | null,
    now: Date,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(storageMigrationJobs)
      .set({
        status,
        error,
        activeOrganizationId: null,
        claimedAt: null,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageMigrationJobs.organizationId, context.organizationId),
          eq(storageMigrationJobs.id, jobId),
          inArray(storageMigrationJobs.status, [...LIVE]),
        ),
      );
    return result[0].affectedRows === 1;
  }

  /** The pass is over for now; the next one may claim the job at once. */
  async release(
    runner: TenantQueryRunner,
    context: TenantContext,
    jobId: string,
    now: Date,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(storageMigrationJobs)
      .set({ claimedAt: null, updatedAt: now })
      .where(
        and(
          eq(storageMigrationJobs.organizationId, context.organizationId),
          eq(storageMigrationJobs.id, jobId),
        ),
      );
  }

  /** The companies with a queued or running job nobody holds (cross-tenant, ids only). */
  async organizationsWithLiveJobs(
    runner: BootstrapQueryRunner,
    staleBefore: Date,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: storageMigrationJobs.organizationId })
      .from(storageMigrationJobs)
      .where(
        and(
          isNotNull(storageMigrationJobs.activeOrganizationId),
          inArray(storageMigrationJobs.status, [...LIVE]),
          or(
            isNull(storageMigrationJobs.claimedAt),
            lt(storageMigrationJobs.claimedAt, staleBefore),
          ),
        ),
      )
      .orderBy(asc(storageMigrationJobs.organizationId));
    return rows.map((row) => row.organizationId);
  }
}

/** Promoted, clean, hashed, local versions of the company's ready files that are not in the bin. */
function candidateWhere(context: TenantContext, afterId: string) {
  return and(
    eq(fileVersions.organizationId, context.organizationId),
    eq(fileAssets.organizationId, context.organizationId),
    eq(fileVersions.storageBackend, 'local'),
    eq(fileVersions.trustZone, 'private'),
    eq(fileVersions.scanVerdict, 'clean'),
    isNotNull(fileVersions.contentHash),
    eq(fileAssets.status, 'ready'),
    isNull(fileAssets.deletedAt),
    isNull(fileAssets.purgedAt),
    gt(fileVersions.id, afterId),
  );
}
