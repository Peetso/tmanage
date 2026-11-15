import { createHash } from 'node:crypto';
import { authorize, uuidv7 } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { WorkItemCloudFolderRow, WorkItemRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import type { FilesService } from '../files/files.service.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type {
  CloudFolderDrive,
  CloudFolderPage,
  CloudFolderProvider,
  CloudFolderRef,
} from './cloud-folder-drive.js';
import { MAX_FOLDERS_PER_ITEM, type CloudFoldersRepository } from './cloud-folders.repository.js';

/**
 * FIX6 C3 — a live Google Drive or OneDrive folder on a work item.
 *
 * A member who may update the work item attaches one of the company drive's folders; TManage
 * keeps the provider's ids and the folder's name, never a token or a link. Everyone who may read
 * the item sees the folder's children live, read with the company connection. A client sees the
 * folder in the portal only while the work item is client-visible, and connects nothing.
 *
 * Every child that is listed in a subfolder or opened is proven on the server to sit inside the
 * attached folder (the provider service walks its parents up, at most 20 levels); an id outside
 * it, another organization's folder and a removed attachment are the same 404 an unknown id gives.
 */

/**
 * C3b. Opening a file never streams the drive's bytes to the browser: the file becomes a checked
 * TManage copy by the upload's own path (file safety, quota, verifier, scanner, previews), once per
 * project, drive item and modified time, and the person opens that copy in the normal viewer. A
 * client reaches it there only while the folder stays on a client-visible work item
 * (`FileClientRelation`, `cloud_folder`).
 */
export interface CloudFolderOpenView {
  readonly fileId: string;
  /** False when an earlier copy of the same unchanged file was reused. */
  readonly imported: boolean;
}

/** The audiences a client may ever see (the portal's own rule). */
const CLIENT_AUDIENCES: readonly string[] = ['client_visible', 'client_action_required'];

export type CloudFolderSource =
  | { readonly provider: 'google_drive'; readonly folderId: string }
  | { readonly provider: 'onedrive'; readonly driveId: string; readonly itemId: string };

export interface CloudFolderView {
  readonly id: string;
  readonly provider: CloudFolderProvider;
  readonly name: string;
  readonly createdAt: string;
}

export interface CloudFolderListInput {
  readonly parentId: string | null;
  readonly pageToken: string | null;
}

export interface CloudFoldersDeps {
  readonly database: TenantDatabase;
  readonly folders: CloudFoldersRepository;
  readonly workItems: Pick<WorkItemsRepository, 'findById'>;
  readonly drives: Readonly<Record<CloudFolderProvider, CloudFolderDrive>>;
  readonly files: Pick<FilesService, 'importMaxBytes' | 'importForFolderRead'>;
  readonly assets: Pick<FileAssetsRepository, 'findById'>;
  readonly audit: AuditService | null;
  readonly now?: () => Date;
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

export class CloudFoldersService {
  constructor(private readonly deps: CloudFoldersDeps) {}

  // ── Members ────────────────────────────────────────────────────────────────

  async list(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly CloudFolderView[]> {
    return this.deps.database.read(context, async (runner) => {
      await this.memberItem(runner, context, principal, workItemId, 'work.read');
      return (await this.deps.folders.listForItem(runner, context, workItemId)).map(toView);
    });
  }

  async attach(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    source: CloudFolderSource,
  ): Promise<CloudFolderView> {
    const item = await this.deps.database.read(context, (runner) =>
      this.memberItem(runner, context, principal, workItemId, 'work.update'),
    );
    const ref: CloudFolderRef =
      source.provider === 'google_drive'
        ? { driveId: null, folderId: source.folderId }
        : { driveId: source.driveId, folderId: source.itemId };
    // The drive is asked outside any transaction; the row is written in a short one of its own.
    const { name } = await this.deps.drives[source.provider].describeFolder(
      context,
      principal,
      item.projectId,
      ref,
    );
    const row: WorkItemCloudFolderRow = {
      id: uuidv7(),
      organizationId: context.organizationId,
      projectId: item.projectId,
      workItemId,
      provider: source.provider,
      externalDriveId: ref.driveId,
      externalFolderId: ref.folderId,
      name,
      attachedByUserId: context.userId,
      createdAt: this.now(),
      removedAt: null,
      removedByUserId: null,
    };
    await this.deps.database.transaction(context, async (tx) => {
      const existing = await this.deps.folders.listForItem(tx, context, workItemId);
      if (existing.length >= MAX_FOLDERS_PER_ITEM) {
        throw new ApiError(409, 'conflict', 'This work item already has the most folders it can');
      }
      const same = existing.find(
        (f) =>
          f.provider === row.provider &&
          f.externalDriveId === row.externalDriveId &&
          f.externalFolderId === row.externalFolderId,
      );
      if (same) throw new ApiError(409, 'conflict', 'This folder is already on the work item');
      await this.deps.folders.insert(tx, context, row);
      await this.record(tx, context, 'work_item.cloud_folder_attached', row);
    });
    return toView(row);
  }

  async remove(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    folderId: string,
  ): Promise<void> {
    await this.deps.database.transaction(context, async (tx) => {
      await this.memberItem(tx, context, principal, workItemId, 'work.update');
      const row = await this.deps.folders.findLive(tx, context, workItemId, folderId);
      if (!row) throw notFound();
      await this.deps.folders.markRemoved(tx, context, row.id, this.now());
      await this.record(tx, context, 'work_item.cloud_folder_removed', row);
    });
  }

  async children(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    folderId: string,
    input: CloudFolderListInput,
  ): Promise<CloudFolderPage> {
    const row = await this.deps.database.read(context, async (runner) => {
      await this.memberItem(runner, context, principal, workItemId, 'work.read');
      return this.liveFolder(runner, context, workItemId, folderId);
    });
    return this.drive(row).listFolder(context, refOf(row), input);
  }

  async open(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    folderId: string,
    childId: string,
  ): Promise<CloudFolderOpenView> {
    const row = await this.deps.database.read(context, async (runner) => {
      await this.memberItem(runner, context, principal, workItemId, 'work.read');
      return this.liveFolder(runner, context, workItemId, folderId);
    });
    return this.checkedCopy(context, principal, row, childId);
  }

  // ── Clients (portal) ───────────────────────────────────────────────────────

  async portalList(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<readonly CloudFolderView[]> {
    return this.deps.database.read(context, async (runner) => {
      await this.clientItem(runner, context, principal, workItemId);
      return (await this.deps.folders.listForItem(runner, context, workItemId)).map(toView);
    });
  }

  async portalChildren(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    folderId: string,
    input: CloudFolderListInput,
  ): Promise<CloudFolderPage> {
    const row = await this.deps.database.read(context, async (runner) => {
      await this.clientItem(runner, context, principal, workItemId);
      return this.liveFolder(runner, context, workItemId, folderId);
    });
    return this.drive(row).listFolder(context, refOf(row), input);
  }

  async portalOpen(
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    folderId: string,
    childId: string,
  ): Promise<CloudFolderOpenView> {
    const row = await this.deps.database.read(context, async (runner) => {
      await this.clientItem(runner, context, principal, workItemId);
      return this.liveFolder(runner, context, workItemId, folderId);
    });
    return this.checkedCopy(context, principal, row, childId);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * C3b. The descendant check comes first (`inspectChild` is a 404 outside the folder); then an
   * earlier copy of the same unchanged file is reused, or the file is fetched and imported through
   * the upload's checks and remembered under its modified time.
   */
  private async checkedCopy(
    context: TenantContext,
    principal: Principal,
    row: WorkItemCloudFolderRow,
    childId: string,
  ): Promise<CloudFolderOpenView> {
    const drive = this.drive(row);
    const ref = refOf(row);
    const child = await drive.inspectChild(context, ref, childId);
    if (child.isFolder) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'itemId', message: 'must be a file' },
      ]);
    }
    // Without a modified time there is nothing to tell versions apart: always a fresh copy.
    const key =
      child.modifiedTime === null
        ? null
        : {
            projectId: row.projectId,
            provider: row.provider,
            externalItemId: child.id,
            modifiedTime: child.modifiedTime.slice(0, 40),
          };
    if (key) {
      const reused = await this.deps.database.read(context, async (runner) => {
        const known = await this.deps.folders.findImport(runner, context, key);
        if (!known) return null;
        const asset = await this.deps.assets.findById(runner, context, known.fileAssetId);
        return asset && asset.deletedAt == null && asset.projectId === row.projectId
          ? asset.id
          : null;
      });
      if (reused) return { fileId: reused, imported: false };
    }
    const maxBytes = await this.deps.files.importMaxBytes(context);
    const fetched = await drive.fetchFromFolder(context, ref, child.id, maxBytes);
    const copy = await this.deps.files.importForFolderRead(context, principal, {
      projectId: row.projectId,
      fileName: fetched.name,
      mimeType: fetched.mimeType,
      bytes: fetched.bytes,
      objectId: null,
    });
    if (key) {
      await this.deps.database.transaction(context, (tx) =>
        this.deps.folders.recordImport(tx, context, key, {
          cloudFolderId: row.id,
          fileAssetId: copy.file.id,
          at: this.now(),
        }),
      );
    }
    return { fileId: copy.file.id, imported: true };
  }

  /**
   * The work item for a member: no relation is a 404 (its existence is a secret); a reader who
   * may not update it gets a 403 on attach and remove.
   */
  private async memberItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
    capability: Extract<Capability, 'work.read' | 'work.update'>,
  ): Promise<WorkItemRow> {
    const row = await this.deps.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null) throw notFound();
    const read = authorize({ principal, capability: 'work.read', resource: resourceOf(row) });
    if (!read.allowed) throw notFound();
    if (capability === 'work.update') {
      const write = authorize({ principal, capability, resource: resourceOf(row) });
      if (!write.allowed) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, write.code);
      }
    }
    return row;
  }

  /**
   * The work item for a client: it must be client-visible (`client_visible` or
   * `client_action_required`) and in a project this client may read. Anything else is a 404.
   */
  private async clientItem(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    workItemId: string,
  ): Promise<WorkItemRow> {
    const row = await this.deps.workItems.findById(runner, context, workItemId);
    if (!row || row.deletedAt !== null || !CLIENT_AUDIENCES.includes(row.audience)) {
      throw notFound();
    }
    const verdict = authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: context.organizationId,
        projectId: row.projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    });
    if (!verdict.allowed) throw notFound();
    return row;
  }

  private async liveFolder(
    runner: TenantQueryRunner,
    context: TenantContext,
    workItemId: string,
    folderId: string,
  ): Promise<WorkItemCloudFolderRow> {
    const row = await this.deps.folders.findLive(runner, context, workItemId, folderId);
    if (!row) throw notFound();
    return row;
  }

  private drive(row: WorkItemCloudFolderRow): CloudFolderDrive {
    return this.deps.drives[row.provider];
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /** Provider and a digest of the folder id (never a token), in the same transaction. */
  private async record(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: 'work_item.cloud_folder_attached' | 'work_item.cloud_folder_removed',
    row: WorkItemCloudFolderRow,
  ): Promise<void> {
    if (!this.deps.audit) return;
    await this.deps.audit.record(tx, context, {
      action,
      objectId: row.workItemId,
      result: 'allowed',
      metadata: {
        provider: row.provider,
        external_id_sha256: createHash('sha256').update(row.externalFolderId).digest('hex'),
        cloud_folder_id: row.id,
      },
    });
  }
}

function refOf(row: WorkItemCloudFolderRow): CloudFolderRef {
  return { driveId: row.externalDriveId, folderId: row.externalFolderId };
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

function toView(row: WorkItemCloudFolderRow): CloudFolderView {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  };
}
