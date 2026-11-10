import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { FILES_USER_DELETE_REASON } from '../../common/database/content-retention.js';
import type { FileAssetRow, ProjectRow, UploadPurpose } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';

/**
 * FIX5 item 5 (live bug B-N5) — delete an uploaded file, and undo it.
 *
 * `DELETE …/files/:fileId` is the 0245 soft delete with the platform's restore window
 * (`contentPurgeDays`); `POST …/files/:fileId/restore` undoes it inside that window. A deleted file
 * leaves the Files hub, every message and work item it was attached to, and the download gate
 * (content, previews, review) answers 404 for it — the message, doc or work item itself stays.
 *
 * ## Who may delete
 *
 * An internal member, on a file they can read, who is either
 * - the **uploader** (`owner_user_id`) and still holds `file.upload` on the file's project, or
 * - holds **`file.delete`** on it: the organization owner / admin, a workspace admin, or a
 *   manager of the file's project (the role ceiling and the project scope are `authorize()`'s).
 *
 * Anyone else who can see the file gets 403; a caller who cannot see it gets the same 404 an
 * unknown id gives. A file a deliverable version points at is not deleted from here: it may be
 * what a client approved, so it follows the deliverable's own lifecycle. The `deliverable` purpose
 * on its own does not mean that: every internal project upload (chat, work items, docs) uses it,
 * so only a file named by a `deliverable_versions` row is held back.
 * Restore follows the same rule. Both are idempotent: deleting a deleted file, or restoring a
 * file that is not deleted, changes nothing and still answers success.
 */

export const FILE_DELETE_SERVICE = Symbol.for('tmanage.FileDeleteService');

/**
 * The uploads a person can delete from Files: project uploads (chat, work items, docs, which use
 * the `deliverable` purpose), and request and doc attachments.
 */
export const DELETABLE_FILE_PURPOSES: readonly UploadPurpose[] = [
  'deliverable',
  'message_attachment',
  'request_attachment',
  'request_message',
  'document',
];

/** The file fields the delete decision reads. */
export type DeletableFile = Pick<
  FileAssetRow,
  'organizationId' | 'projectId' | 'audience' | 'clientOrganizationId' | 'ownerUserId' | 'purpose'
>;

function fileResource(file: DeletableFile, projectArchived: boolean) {
  return {
    organizationId: file.organizationId,
    projectId: file.projectId,
    audience: file.audience,
    clientOrganizationId: file.clientOrganizationId,
    lifecycle: projectArchived ? ('archived' as const) : ('active' as const),
  };
}

/**
 * May this principal delete this file? The one rule the routes, the Files hub's `canDelete` and
 * the viewer's `capabilities.canDelete` share.
 *
 * - `boundToReview` says whether the file is under review or approval (a deliverable version
 *   names it, or a review decision was made on it); a caller that does not know passes nothing,
 *   which refuses rather than risk deleting what a client approved.
 * - Security review L8: the caller must be able to read the file (`file.download`, which is
 *   project-relation gated), checked here, so a future caller cannot forget it and turn a
 *   `manager` role into a cross-project delete.
 */
export function mayDeleteFile(
  principal: Principal,
  file: DeletableFile,
  projectArchived: boolean,
  boundToReview = true,
): boolean {
  if (principal.kind !== 'internal') return false;
  if (!DELETABLE_FILE_PURPOSES.includes(file.purpose)) return false;
  if (boundToReview) return false;
  const resource = fileResource(file, projectArchived);
  if (!authorize({ principal, capability: 'file.download', resource }).allowed) return false;
  if (authorize({ principal, capability: 'file.delete', resource }).allowed) return true;
  return (
    file.ownerUserId === principal.userId &&
    authorize({ principal, capability: 'file.upload', resource }).allowed
  );
}

/** The deleted file's fields the restore decision reads. */
export type RestorableFile = DeletableFile &
  Pick<FileAssetRow, 'deletedByUserId' | 'deletedReason'>;

/**
 * Security review M1. May this principal undo this file's delete? Only a member's own delete from
 * Files, chat or the viewer ({@link FILES_USER_DELETE_REASON}) is undone here; a platform takedown
 * or any other removal is restored only from where it was made. Within that, the person who
 * deleted it, or a holder of `file.delete` on its project (a project manager, the owner, an admin)
 * may restore — never an uploader whose file someone else removed.
 */
export function mayRestoreFile(
  principal: Principal,
  file: RestorableFile,
  projectArchived: boolean,
  boundToReview = true,
): boolean {
  if (file.deletedReason !== FILES_USER_DELETE_REASON) return false;
  if (!mayDeleteFile(principal, file, projectArchived, boundToReview)) return false;
  if (principal.kind !== 'internal') return false;
  if (file.deletedByUserId === principal.userId) return true;
  return authorize({
    principal,
    capability: 'file.delete',
    resource: fileResource(file, projectArchived),
  }).allowed;
}

export class FileDeleteService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly projects: ProjectsRepository,
    private readonly audit?: AuditService,
  ) {}

  /** `DELETE …/files/:fileId` — soft delete, idempotent. */
  async softDelete(context: TenantContext, principal: Principal, fileId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const { asset } = await this.requireDeletable(tx, context, principal, fileId, 'delete');
      const deleted = await this.assets.softDelete(tx, context, asset.id);
      if (!deleted) return; // Already deleted: nothing changes, still a success.
      await this.audit?.record(tx, context, {
        action: 'file_asset.deleted',
        objectId: asset.id,
        result: 'allowed',
        metadata: { project_id: asset.projectId, purpose: asset.purpose },
      });
    });
  }

  /** `POST …/files/:fileId/restore` — undo within the restore window, idempotent. */
  async restore(context: TenantContext, principal: Principal, fileId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const { asset } = await this.requireDeletable(tx, context, principal, fileId, 'restore');
      if (asset.deletedAt === null) return; // Not deleted: nothing to undo.
      const restored = await this.assets.restore(tx, context, asset.id);
      if (!restored) {
        // Deleted, but its restore window has passed (or its bytes are gone): it cannot come back.
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'restore_window_passed');
      }
      await this.audit?.record(tx, context, {
        action: 'file_asset.restored',
        objectId: asset.id,
        result: 'allowed',
        metadata: { project_id: asset.projectId, purpose: asset.purpose },
      });
    });
  }

  /**
   * Resolve the file tenant-scoped (a deleted one too — restore needs it), locked for the rest of
   * the transaction (security review L2: a deliverable version attaching it takes the same lock),
   * hide it from a caller who may not read it (404), then refuse one who may read but not delete
   * — or, for a restore, not undo this particular delete (M1) — with 403.
   */
  private async requireDeletable(
    runner: Parameters<FileAssetsRepository['findById']>[0],
    context: TenantContext,
    principal: Principal,
    fileId: string,
    mode: 'delete' | 'restore',
  ): Promise<{ readonly asset: FileAssetRow; readonly project: ProjectRow }> {
    if (principal.kind !== 'internal') throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const asset = await this.assets.findByIdForUpdate(runner, context, fileId);
    if (!asset || asset.purgedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    const project = await this.projects.findById(runner, context, asset.projectId);
    if (!project) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const archived = project.archivedAt !== null;
    const bound = (await this.assets.reviewBoundIds(runner, context, [asset.id])).has(asset.id);
    const readable = authorize({
      principal,
      capability: 'file.download',
      resource: fileResource(asset, archived),
    }).allowed;
    if (!readable) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const allowed =
      mode === 'restore' && asset.deletedAt !== null
        ? mayRestoreFile(principal, asset, archived, bound)
        : mayDeleteFile(principal, asset, archived, bound);
    if (!allowed) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        mode === 'restore' ? 'file_restore_not_allowed' : 'file_delete_not_allowed',
      );
    }
    return { asset, project };
  }
}
