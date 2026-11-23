import { createHash } from 'node:crypto';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FetchedCloudFile } from '../../common/storage/cloud-fetch.js';
import type { AuditService } from '../audit/audit.service.js';
import type { DeliverablesRepository } from '../approvals/deliverables.repository.js';
import type { GoogleDriveService } from '../google-drive/google-drive.service.js';
import type { OneDriveService } from '../onedrive/onedrive.service.js';
import type { ItemFileView, WorkItemFilesService } from '../work/item-files.service.js';
import type { FilesService, ImportedFileView } from './files.service.js';

/**
 * FIX6 C1. A picked Google Drive or OneDrive file becomes a checked TManage copy: the server
 * fetches the bytes with the company's own connection and stores them through the upload's own
 * path (file safety, quota, verifier, scanner, previews). A client then opens the copy in the
 * normal viewer under the normal sharing rules, with nothing of their own connected and without
 * ever being sent to Google or Microsoft. The person adding it uploads nothing.
 *
 * Order, each step refusing before the next: the target (work item `work.update`, or deliverable
 * `deliverable.create`), then `file.upload` on its project, and only then the drive. No URL from
 * the browser is ever fetched: only provider ids, resolved through the stored connection.
 * Removing the file later is the ordinary file removal; the drive is never touched.
 */

export type CloudSource =
  | { readonly provider: 'google_drive'; readonly fileId: string }
  | { readonly provider: 'onedrive'; readonly driveId: string; readonly itemId: string };

export interface WorkItemCloudImportView extends ImportedFileView {
  readonly attachment: ItemFileView;
}

export interface CloudImportDeps {
  readonly database: TenantDatabase;
  readonly files: Pick<FilesService, 'preflightImport' | 'importFetched'>;
  readonly workItemFiles: Pick<WorkItemFilesService, 'requireWritable' | 'attach'>;
  readonly deliverables: Pick<DeliverablesRepository, 'findById'>;
  readonly googleDrive: Pick<GoogleDriveService, 'fetchForImport'>;
  readonly oneDrive: Pick<OneDriveService, 'fetchForImport'>;
  readonly audit: AuditService | null;
}

export class CloudImportService {
  constructor(private readonly deps: CloudImportDeps) {}

  /** Import the picked file and attach the copy to the work item. */
  async importToWorkItem(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    source: CloudSource,
  ): Promise<WorkItemCloudImportView> {
    const { projectId } = await this.deps.workItemFiles.requireWritable(
      context,
      principal,
      workItemId,
    );
    const { fetched, imported } = await this.importInto(
      context,
      principal,
      projectId,
      source,
      null,
    );
    const attachment = await this.deps.workItemFiles.attach(context, principal, workItemId, {
      fileAssetId: imported.file.id,
    });
    await this.record(context, 'work_item.drive_file_imported', fetched, imported, {
      work_item_id: workItemId,
    });
    return { ...imported, attachment };
  }

  /**
   * Fix lane C (2026-11-23, G5). A small file whose bytes came inline (base64, decoded and capped by
   * the controller) becomes a checked TManage copy by the very same path as a picked drive file —
   * the work item's `work.update`, then `file.upload` on its project and the company's own size cap
   * (`preflightImport`), then file safety, quota, the verifier, the scanner and the previews
   * (`importFetched`) — and is attached to the work item. No URL is ever fetched.
   */
  async importInlineToWorkItem(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    file: { readonly name: string; readonly mimeType: string; readonly bytes: Buffer },
  ): Promise<WorkItemCloudImportView> {
    const { projectId } = await this.deps.workItemFiles.requireWritable(
      context,
      principal,
      workItemId,
    );
    const { maxBytes } = await this.deps.files.preflightImport(context, principal, projectId);
    if (file.bytes.length > maxBytes) {
      throw new ApiError(400, 'validation_failed', 'The file is larger than this company allows.', [
        { field: 'contentBase64', message: `must decode to ${String(maxBytes)} bytes or fewer` },
      ]);
    }
    const imported = await this.deps.files.importFetched(context, principal, {
      projectId,
      fileName: file.name,
      mimeType: file.mimeType,
      bytes: file.bytes,
      objectId: null,
    });
    const attachment = await this.deps.workItemFiles.attach(context, principal, workItemId, {
      fileAssetId: imported.file.id,
    });
    if (this.deps.audit) {
      const audit = this.deps.audit;
      await this.deps.database.transaction(context, (tx) =>
        audit.record(tx, context, {
          action: 'work_item.inline_file_uploaded',
          objectId: imported.file.id,
          result: 'allowed',
          metadata: {
            work_item_id: workItemId,
            size_bytes: file.bytes.length,
            mime_type: file.mimeType,
          },
        }),
      );
    }
    return { ...imported, attachment };
  }

  /**
   * Import the picked file for the deliverable's next version. The copy is bound to the
   * deliverable; the browser adds the version once the checks have passed, exactly as it does for
   * an uploaded file (a version may only name a usable file).
   */
  async importForDeliverable(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
    source: CloudSource,
  ): Promise<ImportedFileView> {
    const projectId = await this.deliverableProject(context, principal, deliverableId);
    const { fetched, imported } = await this.importInto(
      context,
      principal,
      projectId,
      source,
      deliverableId,
    );
    await this.record(context, 'deliverable.drive_version_imported', fetched, imported, {
      deliverable_id: deliverableId,
    });
    return imported;
  }

  private async importInto(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    source: CloudSource,
    objectId: string | null,
  ): Promise<{ readonly fetched: FetchedCloudFile; readonly imported: ImportedFileView }> {
    const { maxBytes } = await this.deps.files.preflightImport(context, principal, projectId);
    const fetched =
      source.provider === 'google_drive'
        ? await this.deps.googleDrive.fetchForImport(
            context,
            principal,
            projectId,
            source.fileId,
            maxBytes,
          )
        : await this.deps.oneDrive.fetchForImport(
            context,
            principal,
            projectId,
            { driveId: source.driveId, itemId: source.itemId },
            maxBytes,
          );
    const imported = await this.deps.files.importFetched(context, principal, {
      projectId,
      fileName: fetched.name,
      mimeType: fetched.mimeType,
      bytes: fetched.bytes,
      objectId,
    });
    return { fetched, imported };
  }

  /** The deliverable's project, for a person who may add its versions; anything else is a 404. */
  private async deliverableProject(
    context: TenantContext,
    principal: Principal,
    deliverableId: string,
  ): Promise<string> {
    const row = await this.deps.database.read(context, (runner) =>
      this.deps.deliverables.findById(runner, context, deliverableId),
    );
    if (!row || row.deletedAt !== null) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const verdict = authorize({
      principal,
      capability: 'deliverable.create',
      resource: {
        organizationId: context.organizationId,
        projectId: row.projectId,
        audience: 'client_visible',
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, verdict.code);
    }
    return row.projectId;
  }

  /** Provider and a digest of the external id (ids may not fit audit values); never a token. */
  private async record(
    context: TenantContext,
    action: 'work_item.drive_file_imported' | 'deliverable.drive_version_imported',
    fetched: FetchedCloudFile,
    imported: ImportedFileView,
    target: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    const audit = this.deps.audit;
    await this.deps.database.transaction(context, (tx) =>
      audit.record(tx, context, {
        action,
        objectId: imported.file.id,
        result: 'allowed',
        metadata: {
          provider: fetched.provider,
          external_id_sha256: createHash('sha256').update(fetched.externalId).digest('hex'),
          ...target,
        },
      }),
    );
  }
}
