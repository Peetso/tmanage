import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileFolderRow, ProjectRow } from '../../common/database/schema.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { FileFoldersRepository } from './folders.repository.js';
import { usableScanStatus } from './file-download.service.js';
import { mayDeleteFile } from './file-delete.service.js';
import type { UsableScanStatus } from './file-download.service.js';
import { effectiveDownloadScanPolicyOn } from '../tenancy/download-scan-policy.js';
import type { ScannerPresence } from '../tenancy/download-scan-policy.js';
import { OrgSettingsRepository } from '../tenancy/org-settings.repository.js';

/**
 * x332's application service — file folders (Files module).
 *
 * Two objects, one table (see `0198_file_folders.sql`): a **folder** the project owns, and a
 * **membership** filing an existing file asset into a folder. Organisational grouping over the file
 * assets FILE-001 already stores — it moves no bytes. The rules that matter live here, the way
 * `FileTagsService` (x270) places them:
 *
 * ## Resolve project, folder AND file, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `projectId`, `folderId` or `fileId` in its path; each is read first, scoped to
 * the acting tenant. A cross-tenant id simply does not resolve, and the answer is the same 404 an
 * absent id gives — before `authorize()` is ever asked and before any write. This is the engine trap
 * of migration 0198 (three composite foreign keys) enforced a second time in code.
 *
 * ## The files module's own capability, coarse; the row decision is the service's
 *
 * Managing folders is gated on `file.upload` (create / delete / move) and reading on `file.download`
 * — the same doors the upload and download surfaces use (x205 / x270). The row-level write is
 * authorized against the resolved project (a folder is an internal overlay) or the resolved file's
 * project + audience (a move), so a caller who may see a project but not manage its files is refused
 * (403), and one in another tenant never gets that far (404).
 */

const READ_CAPABILITY = 'file.download';
const WRITE_CAPABILITY = 'file.upload';

/** One folder — paired Exact in `e2e/contracts` with the web `FileFolder`. */
export interface FileFolderView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly createdAt: string;
}

/** A file's placement — its folder, or `null` at root. Paired with the web `FileFolderPlacement`. */
export interface FileFolderPlacementView {
  readonly fileId: string;
  readonly folderId: string | null;
}

/** FIX3 item 11 (FIL-01). One row of the Files hub: a ready file of one project. */
export interface ProjectFileView {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly audience: string;
  readonly purpose: string;
  readonly versionNo: number | null;
  readonly updatedAt: string;
  /** FIX4 item 1b. `clean` (scanned), or `not_scanned` (usable, labelled, under the owner's policy). */
  readonly scanStatus: UsableScanStatus;
  /** FIX5 item 5. Whether the caller may delete this file (uploader, project manager, owner/admin). */
  readonly canDelete: boolean;
}

/** FIX3 item 11: the hub shows the newest files; more than this is a search, not a list. */
export const PROJECT_FILES_LIMIT = 200;
/** Fix lane C. The workspace list's default page, and how many project pages it walks at most. */
export const WORKSPACE_FILES_DEFAULT = 50;
const WORKSPACE_PROJECT_PAGES = 25;

export class FileFoldersService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly projects: ProjectsRepository,
    private readonly folders: FileFoldersRepository = new FileFoldersRepository(),
    /** FIX4 item 1b. The configured scanner; absent reads as none (`allow_labeled`). */
    private readonly scanner?: ScannerPresence,
    private readonly settings: OrgSettingsRepository = new OrgSettingsRepository(),
  ) {}

  /** A project's folders, name-ascending. Behind `file.download` on the resolved project. */
  async listFolders(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly FileFolderView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableProject(runner, context, principal, projectId);
      const rows = await this.folders.listFolders(runner, context, projectId);
      return rows.map(toFolderView);
    });
  }

  /**
   * FIX3 item 11 (FIL-01 Files hub). A project's ready files for an internal member, newest change
   * first, so every file is reachable from one place and opens in its viewer. Behind
   * `file.download` on the resolved project; a client principal is refused (404) — clients see
   * their files through the portal, whose relation rules this list does not apply.
   */
  async listProjectFiles(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<readonly ProjectFileView[]> {
    if (principal.kind !== 'internal') throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.database.read(context, async (runner) => {
      const project = await this.readableProject(runner, context, principal, projectId);
      const rows = await this.assets.listReadyForProject(
        runner,
        context,
        projectId,
        PROJECT_FILES_LIMIT,
      );
      return this.toFileViews(runner, context, principal, rows, new Map([[project.id, project]]));
    });
  }

  /**
   * Fix lane C (2026-11-23, G5 "show me all files"). Every ready file in every project this
   * internal member may read (`file.download` per project, as {@link listProjectFiles}), newest
   * change first, at most `limit` (1–{@link PROJECT_FILES_LIMIT}, default 50). The readable
   * projects are decided first and the files are read for those projects only, so a member with
   * a few projects still gets a full page. A client principal is 404 (the portal is their door).
   */
  async listWorkspaceFiles(
    context: TenantContext,
    principal: Principal,
    limit: number = WORKSPACE_FILES_DEFAULT,
  ): Promise<readonly ProjectFileView[]> {
    if (principal.kind !== 'internal') throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), PROJECT_FILES_LIMIT);
    return this.database.read(context, async (runner) => {
      const readable = new Map<string, ProjectRow>();
      let after: string | undefined;
      for (let page = 0; page < WORKSPACE_PROJECT_PAGES; page += 1) {
        const rows = await this.projects.list(runner, context, {
          includeArchived: true,
          limit: PROJECT_FILES_LIMIT,
          ...(after === undefined ? {} : { after }),
        });
        for (const project of rows) {
          const verdict = authorize({
            principal,
            capability: READ_CAPABILITY,
            resource: this.projectResource(project),
          });
          if (verdict.allowed) readable.set(project.id, project);
        }
        if (rows.length < PROJECT_FILES_LIMIT) break;
        after = rows[rows.length - 1]?.id;
      }
      if (readable.size === 0) return [];
      const rows = await this.assets.listReadyForProjects(
        runner,
        context,
        [...readable.keys()],
        bounded,
      );
      return this.toFileViews(runner, context, principal, rows, readable);
    });
  }

  /** The list projection shared by the project and workspace lists. */
  private async toFileViews(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    rows: Awaited<ReturnType<FileAssetsRepository['listReadyForProject']>>,
    projects: ReadonlyMap<string, ProjectRow>,
  ): Promise<readonly ProjectFileView[]> {
    const bound = await this.assets.reviewBoundIds(
      runner,
      context,
      rows.map(({ asset }) => asset.id),
    );
    const effective = await effectiveDownloadScanPolicyOn(
      runner,
      context,
      this.scanner,
      this.settings,
    );
    return rows
      .flatMap(({ asset, version }) => {
        const scanStatus = usableScanStatus(asset.status, version, effective);
        return scanStatus === null ? [] : [{ asset, version, scanStatus }];
      })
      .map(({ asset, version, scanStatus }) => ({
        id: asset.id,
        projectId: asset.projectId,
        name: asset.name,
        mimeType: version?.detectedMimeType ?? null,
        sizeBytes: version?.sizeBytes ?? null,
        audience: asset.audience,
        purpose: asset.purpose,
        versionNo: version?.versionNo ?? null,
        updatedAt: asset.updatedAt.toISOString(),
        scanStatus,
        canDelete: mayDeleteFile(
          principal,
          asset,
          (projects.get(asset.projectId)?.archivedAt ?? null) !== null,
          bound.has(asset.id),
        ),
      }));
  }

  /** A folder's contents (the files filed into it). Behind `file.download`. */
  async listFolderContents(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    folderId: string,
  ): Promise<readonly FileFolderPlacementView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableProject(runner, context, principal, projectId);
      const folder = await this.folders.findFolder(runner, context, folderId);
      if (!folder || folder.projectId !== projectId) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      const rows = await this.folders.listFolderContents(runner, context, folderId);
      return rows
        .map(toPlacementView)
        .filter((view): view is FileFolderPlacementView => view !== null);
    });
  }

  /** Create a folder in a project. Behind `file.upload`. Blank name → 400; duplicate → 409. */
  async create(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    name: unknown,
  ): Promise<FileFolderView> {
    const clean = requiredName(name);
    return this.database.transaction(context, async (tx) => {
      const project = await this.resolveProject(tx, context, projectId);
      await this.requireWrite(principal, project);

      const clash = await this.folders.findFolderByName(tx, context, projectId, clean);
      if (clash) {
        throw new ApiError(409, 'conflict', 'A folder with this name already exists');
      }
      const row = await this.folders.createFolder(
        tx,
        context,
        projectId,
        clean,
        principal.membershipId,
      );
      return toFolderView(row);
    });
  }

  /** Delete an empty folder. Behind `file.upload`. A non-empty folder → 409; success is 204. */
  async delete(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    folderId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const project = await this.resolveProject(tx, context, projectId);
      await this.requireWrite(principal, project);

      const folder = await this.folders.findFolder(tx, context, folderId);
      if (!folder || folder.projectId !== projectId) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }
      if (await this.folders.folderHasContents(tx, context, folderId)) {
        throw new ApiError(409, 'conflict', 'The folder is not empty');
      }
      await this.folders.deleteFolder(tx, context, folderId);
    });
  }

  /**
   * File a file into a folder, or back to root (`folderId` null). Behind `file.upload`. Idempotent:
   * re-filing moves the membership row in place. A cross-tenant file or folder id → 404, no write.
   */
  async move(
    context: TenantContext,
    principal: Principal,
    fileId: string,
    folderId: string | null,
  ): Promise<FileFolderPlacementView> {
    // F41. A folder is the studio's internal overlay: a client principal never files (or un-files)
    // anything, whatever the file's audience — the same 404 an absent id gives, before any read.
    if (principal.kind !== 'internal') {
      throw new ApiError(
        404,
        'not_found',
        MESSAGES.notFound,
        undefined,
        'not_an_internal_principal',
      );
    }
    return this.database.transaction(context, async (tx) => {
      // Resolve the file, tenant-scoped, and authorize the write against it — before any write.
      const file = await this.readableFile(tx, context, principal, fileId);
      await this.requireWriteOnFile(tx, context, principal, file);

      if (folderId === null) {
        await this.folders.deleteMembership(tx, context, fileId);
        return { fileId, folderId: null };
      }

      // The target folder is resolved scoped to the tenant AND to the file's project; a cross-tenant,
      // unknown or other-project folder id does not resolve and is a 404, before any write.
      const folder = await this.folders.findFolder(tx, context, folderId);
      if (!folder || folder.projectId !== file.projectId) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }

      const existing = await this.folders.findMembership(tx, context, fileId);
      const row = existing
        ? await this.folders.updateMembership(tx, context, fileId, folderId)
        : await this.folders.createMembership(tx, context, fileId, folderId);
      return { fileId, folderId: row.folderId };
    });
  }

  /**
   * Read a project, tenant-scoped, and refuse a caller who may not read its files. The 404 for
   * "no relation" is produced here, before any write, and is the same 404 an absent id gives.
   */
  private async readableProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectRow> {
    const project = await this.resolveProject(runner, context, projectId);
    const verdict = authorize({
      principal,
      capability: READ_CAPABILITY,
      resource: this.projectResource(project),
    });
    if (!verdict.allowed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return project;
  }

  private async resolveProject(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
  ): Promise<ProjectRow> {
    const project = await this.projects.findById(runner, context, projectId);
    if (!project) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return project;
  }

  private async requireWrite(principal: Principal, project: ProjectRow): Promise<void> {
    const verdict = authorize({
      principal,
      capability: WRITE_CAPABILITY,
      resource: this.projectResource(project),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  /** A folder is an internal overlay on a project, never a client-visible surface. */
  private projectResource(project: ProjectRow) {
    return {
      organizationId: project.organizationId,
      projectId: project.id,
      audience: 'internal' as const,
      clientOrganizationId: null,
      lifecycle: project.archivedAt !== null ? ('archived' as const) : ('active' as const),
    };
  }

  private async readableFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    fileId: string,
  ): Promise<FileAssetRow> {
    const row = await this.assets.findById(runner, context, fileId);
    if (!row || !(await this.mayReadFile(runner, context, principal, row))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private async requireWriteOnFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    file: FileAssetRow,
  ): Promise<void> {
    const verdict = authorize({
      principal,
      capability: WRITE_CAPABILITY,
      resource: await this.fileResource(runner, context, file),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private async mayReadFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    file: FileAssetRow,
  ): Promise<boolean> {
    return authorize({
      principal,
      capability: READ_CAPABILITY,
      resource: await this.fileResource(runner, context, file),
    }).allowed;
  }

  private async fileResource(
    runner: TenantQueryRunner,
    context: TenantContext,
    file: FileAssetRow,
  ) {
    const project = await this.projects.findById(runner, context, file.projectId);
    return {
      organizationId: file.organizationId,
      projectId: file.projectId,
      audience: file.audience,
      clientOrganizationId: file.clientOrganizationId,
      lifecycle:
        project && project.archivedAt !== null ? ('archived' as const) : ('active' as const),
    };
  }
}

function toFolderView(row: FileFolderRow): FileFolderView {
  return {
    id: row.id,
    projectId: row.projectId ?? '',
    name: row.name ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

function toPlacementView(row: FileFolderRow): FileFolderPlacementView | null {
  if (row.fileId === null) return null;
  return { fileId: row.fileId, folderId: row.folderId };
}

function requiredName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be a non-empty string' },
    ]);
  }
  const name = raw.trim();
  if (name.length > 120) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'name', message: 'must be 120 characters or fewer' },
    ]);
  }
  return name;
}
