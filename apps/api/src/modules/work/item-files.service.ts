import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { FileAssetRow, WorkItemRow } from '../../common/database/schema.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import { WorkItemFilesRepository } from './item-files.repository.js';
import type { WorkItemFileListRow } from './item-files.repository.js';

/**
 * x205's application service — attach an already-uploaded file to a work item (Work module 7).
 *
 * The audit's gap: Work is built, Files are built, and nothing joins them. This is that join,
 * and it is a *cross-module tenant boundary*, so the order the two ends are resolved in is the
 * whole security of the slice.
 *
 * ## Resolve BOTH ends, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `workItemId` in the path; attach also names a `fileAssetId` in the body.
 * The work item is read first, scoped to the acting tenant, and `authorize()` is asked against
 * *its* project and audience — a cross-tenant (or unrelated) work item is the same 404 an absent
 * id gives, with no write. Attach then resolves the file the same way: a `fileAssetId` from
 * another studio does not resolve under this tenant and is a 404, never a link that attaches
 * another tenant's file. The file must also belong to the *same project* as the work item — a
 * file id of a sibling project the caller has no relation to would otherwise be reachable through
 * a work item they can write; requiring the projects match closes that intra-tenant path, and
 * the caller's `work.update` on the work item's project then governs both ends.
 *
 * ## `authorize()` is the one place the rule is written
 *
 * The list read is gated on `file.download` (reading a work item's attached files is a download
 * concern); attach and detach are gated on `work.update` (a link is a fact about the work item's
 * planning, the posture `work_item_dependencies` carries — the matrix defines no capability of
 * its own). A caller with no relation to the item gets a 404 (its existence is a secret); a
 * caller who may read it but not write it gets a 403 on attach/detach (its existence is not).
 */

/** The client-facing projection of one work-item file attachment. Paired in `e2e/contracts`. */
export interface ItemFileView {
  readonly id: string;
  readonly workItemId: string;
  readonly fileAssetId: string;
  readonly fileName: string;
  readonly attachedByMembershipId: string;
  readonly createdAt: string;
}

export interface AttachFileInput {
  readonly fileAssetId: string;
}

export class WorkItemFilesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly workItems: WorkItemsRepository,
    private readonly fileAssets: FileAssetsRepository,
    private readonly links: WorkItemFilesRepository = new WorkItemFilesRepository(),
  ) {}

  /** The work item's attachments, created-at ascending. Behind `file.download` on the item. */
  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly ItemFileView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableParent(runner, context, principal, workItemId);
      const rows = await this.links.listForWorkItem(runner, context, workItemId);
      return rows.map(toView);
    });
  }

  /** Attach a file to the work item. Behind `work.update` on the item. Idempotent per pair. */
  async attach(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    input: AttachFileInput,
  ): Promise<ItemFileView> {
    return this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);

      // Resolve the file end tenant-scoped: a cross-tenant id does not resolve and is a 404, the
      // same answer an absent id gives, so no probe can tell them apart. It must also belong to
      // the same project as the work item — otherwise a file of a sibling project would be
      // reachable through a work item the caller happens to be able to write.
      const file = await this.resolvableFile(tx, context, parent, input.fileAssetId);

      // Idempotent: attaching a file already attached returns the existing link rather than
      // failing on the unique key. The membership author is fixed by the first attach.
      const existing = await this.links.findByPair(tx, context, workItemId, file.id);
      if (existing) {
        return toView({ ...existing, fileName: file.name });
      }

      const attachedByMembershipId = principal.membershipId;
      if (!attachedByMembershipId) {
        // A `work.update` holder is always an internal member of this studio, so a membership id
        // is present; a principal without one could not have passed the write gate.
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
      }

      const row = await this.links.create(tx, context, {
        workItemId,
        fileAssetId: file.id,
        attachedByMembershipId,
      });
      return toView({ ...row, fileName: file.name });
    });
  }

  /** Detach a file from the work item. Behind `work.update` on the item. */
  async detach(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    linkId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const parent = await this.readableParent(tx, context, principal, workItemId);
      this.requireWrite(principal, parent);
      const removed = await this.links.delete(tx, context, workItemId, linkId);
      if (!removed) {
        // The link does not exist under this tenant / work item — a cross-tenant or absent id is
        // the same 404, with nothing removed.
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
    });
  }

  /**
   * Read the parent work item, tenant-scoped, and refuse a caller who may not read it. The 404
   * for "no relation" is produced here, before any write.
   */
  private async readableParent(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  /**
   * Resolve the file end tenant-scoped and require it belong to the same project as the work
   * item. A cross-tenant, absent or cross-project file id is the same 404 — nothing about the
   * file is revealed to a caller who names one they have no path to.
   */
  private async resolvableFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    parent: WorkItemRow,
    fileAssetId: string,
  ): Promise<FileAssetRow> {
    const file = await this.fileAssets.findById(runner, context, fileAssetId);
    if (!file || file.projectId !== parent.projectId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return file;
  }

  private requireWrite(principal: Principal, parent: WorkItemRow): void {
    const verdict = authorize({
      principal,
      capability: 'work.update',
      resource: resourceOf(parent),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private mayRead(principal: Principal, row: WorkItemRow): boolean {
    return authorize({ principal, capability: 'file.download', resource: resourceOf(row) }).allowed;
  }
}

function resourceOf(row: WorkItemRow) {
  return {
    organizationId: row.organizationId,
    projectId: row.projectId,
    audience: row.audience,
    lifecycle: row.deletedAt
      ? ('soft_deleted' as const)
      : row.state === 'archived'
        ? ('archived' as const)
        : ('active' as const),
  };
}

function toView(row: WorkItemFileListRow): ItemFileView {
  return {
    id: row.id,
    workItemId: row.workItemId,
    fileAssetId: row.fileAssetId,
    fileName: row.fileName,
    attachedByMembershipId: row.attachedByMembershipId,
    createdAt: row.createdAt.toISOString(),
  };
}
