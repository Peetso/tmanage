import { Controller, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { FileAssetRow, FileVersionRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import {
  FILES_SERVICE,
  FILE_ASSETS_REPOSITORY,
  TENANT_DATABASE,
} from '../../common/http/tokens.js';
import { listBlockedFiles } from './blocked-files.repository.js';
import type { BlockedFileRow } from './blocked-files.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { FilesService } from './files.service.js';

/**
 * 56-06 · Blocked files (Figma 578:32859, "Blocked files · EN/AR") — the owner's queue of uploads
 * the safety check refused (`file_assets.status = 'rejected'`): malware found, a type the company
 * does not allow, a type that does not match the bytes, a checksum that did not match.
 *
 * - `GET  .../admin/file-safety/blocked` — the queue, newest first, metadata only (never a key or
 *   the bytes): name, extension, detected type, reason code, uploader name, size, when.
 * - `POST .../admin/file-safety/blocked/:fileId/delete` — delete the blocked bytes now instead of
 *   waiting for the retention window: the same `FilesService.purge` the FILE-003 job runs, so the
 *   provider delete, the quota give-back, the outbox event and the audit row are the job's own.
 *
 * There is no "release": `rejected` is terminal in the upload state machine (`23-ERD` §10) and the
 * 0019 trigger refuses `ready` without a clean version, so a refused file is never served. The
 * screen tells the owner to ask for a safe copy instead.
 *
 * Both routes sit behind `org.security.manage` (owners), tenant-scoped by `@Ctx()`.
 */

export interface BlockedFileView {
  readonly id: string;
  readonly name: string;
  readonly extension: string;
  readonly detectedMimeType: string | null;
  readonly declaredMimeType: string | null;
  readonly sizeBytes: number | null;
  readonly reason: string;
  readonly uploadedBy: string | null;
  readonly blockedAt: string;
}

export interface BlockedFilesPage {
  readonly files: readonly BlockedFileView[];
}

const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The file's own extension, upper-case, `''` when it has none (a dot-file is not an extension). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toUpperCase();
}

export function toBlockedFileView(row: BlockedFileRow): BlockedFileView {
  return {
    id: row.id,
    name: row.name,
    extension: fileExtension(row.name),
    detectedMimeType: row.detectedMimeType,
    declaredMimeType: row.declaredMimeType,
    sizeBytes: row.sizeBytes,
    reason: row.rejectionCode ?? 'unknown',
    uploadedBy: row.uploaderName,
    blockedAt: row.updatedAt.toISOString(),
  };
}

/**
 * May this asset be purged by hand? Only a refused, not-yet-purged, not-deleted asset whose newest
 * version never left quarantine — the same rule `listPurgeable` holds the job to, so a promoted
 * object can never be removed through this route.
 */
export function isPurgeableBlocked(
  asset: FileAssetRow,
  version: FileVersionRow | null,
): version is FileVersionRow {
  return (
    asset.status === 'rejected' &&
    asset.purgedAt === null &&
    asset.deletedAt === null &&
    version !== null &&
    version.trustZone === 'quarantine'
  );
}

@Controller('v1/organizations/:orgSlug/admin/file-safety/blocked')
export class BlockedFilesController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(FILE_ASSETS_REPOSITORY) private readonly assets: FileAssetsRepository,
    @Inject(FILES_SERVICE) private readonly files: FilesService,
  ) {}

  @Get()
  @RequireCapability('org.security.manage')
  async list(@Ctx() context: TenantContext): Promise<BlockedFilesPage> {
    const rows = await this.database.read(context, (runner) => listBlockedFiles(runner, context));
    return { files: rows.map(toBlockedFileView) };
  }

  @Post(':fileId/delete')
  @RequireCapability('org.security.manage')
  @HttpCode(204)
  async remove(@Ctx() context: TenantContext, @Param('fileId') fileId: string): Promise<void> {
    if (!ID_SHAPE.test(fileId)) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const found = await this.database.read(context, (runner) =>
      this.assets.findWithLatestVersion(runner, context, fileId),
    );
    if (found === null || !isPurgeableBlocked(found.asset, found.version)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    // Idempotent: a concurrent job pass that took it first leaves `purged: false`, still a 204.
    await this.files.purge(context, found.asset, found.version);
  }
}
