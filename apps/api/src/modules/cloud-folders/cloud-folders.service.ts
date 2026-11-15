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
import type { FetchedCloudFile } from '../../common/storage/cloud-fetch.js';
import type { AuditService } from '../audit/audit.service.js';
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

/** A file opened from a live folder is read into memory once, so it is capped well below RAM. */
export const FOLDER_FILE_MAX_BYTES = 25 * 1024 * 1024;

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
  ): Promise<FetchedCloudFile> {
    const row = await this.deps.database.read(context, async (runner) => {
      await this.memberItem(runner, context, principal, workItemId, 'work.read');
      return this.liveFolder(runner, context, workItemId, folderId);
    });
    return this.drive(row).fetchFromFolder(context, refOf(row), childId, FOLDER_FILE_MAX_BYTES);
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
  ): Promise<FetchedCloudFile> {
    const row = await this.deps.database.read(context, async (runner) => {
      await this.clientItem(runner, context, principal, workItemId);
      return this.liveFolder(runner, context, workItemId, folderId);
    });
    return this.drive(row).fetchFromFolder(context, refOf(row), childId, FOLDER_FILE_MAX_BYTES);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

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
