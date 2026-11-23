import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import { isDriveId } from '../google-drive/google-drive.google.js';
import { isGraphId } from '../onedrive/onedrive.graph.js';
import type {
  CloudImportService,
  CloudSource,
  WorkItemCloudImportView,
} from './cloud-import.service.js';
import type { ImportedFileView } from './files.service.js';
import { inlineFile } from './inline-file.js';

/**
 * FIX6 C1 — adding a picked Google Drive or OneDrive file as a checked TManage copy.
 *
 * - `POST …/work-items/:workItemId/drive-files` `{fileId}` and `…/onedrive-files`
 *   `{driveId, itemId}`: import, then attach the copy to the work item (`work.update`).
 * - `POST …/deliverables/:deliverableId/drive-files` and `…/onedrive-files`: import the copy for
 *   the deliverable's next version (`deliverable.create`); the browser adds the version once the
 *   checks have passed, as for an upload.
 *
 * The body names provider ids only, checked against the providers' id shapes; a URL is never
 * accepted, so nothing the browser sends decides which host the server talks to.
 */
export const CLOUD_IMPORT_SERVICE = Symbol.for('tmanage.CloudImportService');

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

export function driveSource(body: { readonly fileId?: unknown } | undefined): CloudSource {
  if (!isDriveId(body?.fileId)) throw invalid('fileId', 'must be a Drive file id');
  return { provider: 'google_drive', fileId: body.fileId };
}

export function oneDriveSource(
  body: { readonly driveId?: unknown; readonly itemId?: unknown } | undefined,
): CloudSource {
  if (!isGraphId(body?.driveId)) throw invalid('driveId', 'must be a OneDrive drive id');
  if (!isGraphId(body.itemId)) throw invalid('itemId', 'must be a OneDrive item id');
  return { provider: 'onedrive', driveId: body.driveId, itemId: body.itemId };
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId')
export class WorkItemCloudImportController {
  constructor(@Inject(CLOUD_IMPORT_SERVICE) private readonly imports: CloudImportService) {}

  @Post('drive-files')
  @HttpCode(201)
  @RequireCapability('work.update')
  async fromDrive(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly fileId?: unknown },
  ): Promise<WorkItemCloudImportView> {
    return this.imports.importToWorkItem(context, principal, workItemId, driveSource(body));
  }

  /**
   * Fix lane C (2026-11-23, G5). Add a small file sent inline: `{name, mimeType, contentBase64}`,
   * at most {@link INLINE_FILE_MAX_BYTES} decoded, a type from {@link INLINE_FILE_TYPES}. Goes
   * through the upload's own checks and is attached to the work item (`work.update`).
   */
  @Post('inline-files')
  @HttpCode(201)
  @RequireCapability('work.update')
  async fromInline(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body()
    body: {
      readonly name?: unknown;
      readonly mimeType?: unknown;
      readonly contentBase64?: unknown;
    },
  ): Promise<WorkItemCloudImportView> {
    return this.imports.importInlineToWorkItem(context, principal, workItemId, inlineFile(body));
  }

  @Post('onedrive-files')
  @HttpCode(201)
  @RequireCapability('work.update')
  async fromOneDrive(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: { readonly driveId?: unknown; readonly itemId?: unknown },
  ): Promise<WorkItemCloudImportView> {
    return this.imports.importToWorkItem(context, principal, workItemId, oneDriveSource(body));
  }
}

@Controller('v1/organizations/:orgSlug/deliverables/:deliverableId')
export class DeliverableCloudImportController {
  constructor(@Inject(CLOUD_IMPORT_SERVICE) private readonly imports: CloudImportService) {}

  @Post('drive-files')
  @HttpCode(201)
  @RequireCapability('deliverable.create')
  async fromDrive(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
    @Body() body: { readonly fileId?: unknown },
  ): Promise<ImportedFileView> {
    return this.imports.importForDeliverable(context, principal, deliverableId, driveSource(body));
  }

  @Post('onedrive-files')
  @HttpCode(201)
  @RequireCapability('deliverable.create')
  async fromOneDrive(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('deliverableId') deliverableId: string,
    @Body() body: { readonly driveId?: unknown; readonly itemId?: unknown },
  ): Promise<ImportedFileView> {
    return this.imports.importForDeliverable(
      context,
      principal,
      deliverableId,
      oneDriveSource(body),
    );
  }
}
