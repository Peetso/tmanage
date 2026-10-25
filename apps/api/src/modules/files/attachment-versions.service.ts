import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AttachmentVersionRow, FileAssetRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import { AttachmentVersionsRepository } from './attachment-versions.repository.js';
import { fileAvailabilityFor } from '../work/item-files.service.js';
import type { FileAvailability } from '../work/item-files.service.js';

/**
 * C7 (0228, audit gap 12) — version history for plain attachments.
 *
 * The deliverable model, for a file that is not a deliverable: version 1 is the attachment's own
 * file asset (the one the work item, request or document links to); "Upload new version" uploads
 * a new asset through the normal pipeline — verified and scanned like every upload — and records
 * it as version N of that root. Nothing here serves bytes: every version is downloaded through
 * `GET …/files/:fileAssetId/content` by its own asset id, so the owner's scan policy and the
 * per-asset authorization apply to a previous version exactly as to the current one.
 *
 * The rules, in order, the way `FileTagsService` places them:
 *
 * - Resolve the asset tenant-scoped **before** authorizing; an asset of another tenant, or one
 *   the caller may not read, is the same 404 an absent id gives.
 * - Studio members only; the client portal has its own file list.
 * - Reading needs `file.download` on the root's project and audience; adding needs `file.upload`.
 * - The new asset must be a different, usable file of the same project and purpose, not already
 *   in any chain, so a version can never move a file between projects or kinds.
 * - Only plain-attachment purposes take versions — never a chat message file or the org logo.
 */

export const ATTACHMENT_VERSIONS_SERVICE = Symbol.for('tmanage.AttachmentVersionsService');

const READ_CAPABILITY: Capability = 'file.download';
const WRITE_CAPABILITY: Capability = 'file.upload';
const MAX_NOTE = 2_000;

/** The purposes a plain attachment is uploaded under: work item, request and document files. */
const VERSIONABLE_PURPOSES: ReadonlySet<string> = new Set([
  'deliverable',
  'request_attachment',
  'document',
]);

/** One version of an attachment. Version 1 is the root asset. */
export interface AttachmentVersionView {
  readonly versionNo: number;
  readonly fileAssetId: string;
  readonly fileName: string;
  readonly availability: FileAvailability;
  readonly note: string | null;
  /** Who uploaded it; for version 1, the asset's owner. */
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly current: boolean;
}

export interface AttachmentHistoryView {
  readonly rootFileAssetId: string;
  /** Newest first. Always at least version 1. */
  readonly versions: readonly AttachmentVersionView[];
}

export interface AddAttachmentVersionInput {
  readonly fileAssetId: string;
  readonly note: string | null;
}

export class AttachmentVersionsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly projects: ProjectsRepository,
    private readonly audit?: AuditService,
    private readonly versions: AttachmentVersionsRepository = new AttachmentVersionsRepository(),
  ) {}

  async list(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
  ): Promise<AttachmentHistoryView> {
    requireInternal(principal);
    return this.database.read(context, async (runner) => {
      const root = await this.resolveRoot(runner, context, principal, fileAssetId);
      return this.history(runner, context, root);
    });
  }

  async add(
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
    input: AddAttachmentVersionInput,
  ): Promise<AttachmentHistoryView> {
    requireInternal(principal);
    if (input.note !== null && input.note.length > MAX_NOTE) {
      throw invalid('note', `must be at most ${MAX_NOTE} characters`);
    }
    try {
      return await this.database.transaction(context, async (tx) => {
        const root = await this.resolveRoot(tx, context, principal, fileAssetId);
        await this.requireCapability(tx, context, principal, root, WRITE_CAPABILITY);

        const candidate = await this.assets.findById(tx, context, input.fileAssetId);
        const usable =
          candidate !== null &&
          candidate.id !== root.id &&
          candidate.projectId === root.projectId &&
          candidate.purpose === root.purpose &&
          fileAvailabilityFor(candidate.status) !== 'unavailable' &&
          (await this.versions.findInvolving(tx, context, candidate.id)) === null;
        if (!usable || candidate === null) {
          throw new ApiError(422, 'validation_failed', 'That file cannot be a new version', [
            { field: 'fileAssetId', message: 'must be a new file of the same project and kind' },
          ]);
        }

        const existing = await this.versions.listForRoot(tx, context, root.id);
        const versionNo = Math.max(1, ...existing.map((row) => row.versionNo)) + 1;
        const created = await this.versions.create(tx, context, {
          projectId: root.projectId,
          rootFileAssetId: root.id,
          fileAssetId: candidate.id,
          versionNo,
          note: input.note,
          createdByUserId: principal.userId,
        });
        await this.audit?.record(tx, context, {
          action: 'file_asset.version_added',
          objectId: root.id,
          result: 'allowed',
          metadata: {
            project_id: root.projectId,
            purpose: root.purpose,
            file_asset_id: candidate.id,
            attachment_version_id: created.id,
            version_no: versionNo,
          },
        });
        return this.history(tx, context, root);
      });
    } catch (error) {
      // Two uploads raced for the same number: the unique key refused the loser.
      if (isDuplicateKeyError(error)) {
        throw new ApiError(409, 'conflict', 'Someone else just added a version. Try again');
      }
      throw error;
    }
  }

  /** The asset, resolved to its chain's root, tenant-scoped and readable — or the one 404. */
  private async resolveRoot(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    fileAssetId: string,
  ): Promise<FileAssetRow> {
    const named = await this.assets.findById(runner, context, fileAssetId);
    if (!named) throw notFound();
    const link = await this.versions.findInvolving(runner, context, named.id);
    const root =
      link && link.rootFileAssetId !== named.id
        ? await this.assets.findById(runner, context, link.rootFileAssetId)
        : named;
    if (!root || !VERSIONABLE_PURPOSES.has(root.purpose)) throw notFound();
    if (!(await this.allowed(runner, context, principal, root, READ_CAPABILITY))) {
      throw notFound();
    }
    return root;
  }

  private async history(
    runner: TenantQueryRunner,
    context: TenantContext,
    root: FileAssetRow,
  ): Promise<AttachmentHistoryView> {
    const rows = await this.versions.listForRoot(runner, context, root.id);
    const later: { row: AttachmentVersionRow; asset: FileAssetRow }[] = [];
    for (const row of rows) {
      const asset = await this.assets.findById(runner, context, row.fileAssetId);
      if (asset) later.push({ row, asset });
    }
    const all: Omit<AttachmentVersionView, 'current'>[] = [
      {
        versionNo: 1,
        fileAssetId: root.id,
        fileName: root.name,
        availability: fileAvailabilityFor(root.status),
        note: null,
        createdByUserId: root.ownerUserId,
        createdAt: root.createdAt.toISOString(),
      },
      ...later.map(({ row, asset }) => ({
        versionNo: row.versionNo,
        fileAssetId: asset.id,
        fileName: asset.name,
        availability: fileAvailabilityFor(asset.status),
        note: row.note,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
      })),
    ];
    const newestFirst = all.sort((a, b) => b.versionNo - a.versionNo);
    return {
      rootFileAssetId: root.id,
      versions: newestFirst.map((view, index) => ({ ...view, current: index === 0 })),
    };
  }

  private async requireCapability(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    file: FileAssetRow,
    capability: Capability,
  ): Promise<void> {
    const verdict = authorize({
      principal,
      capability,
      resource: await this.resourceOf(runner, context, file),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private async allowed(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    file: FileAssetRow,
    capability: Capability,
  ): Promise<boolean> {
    return authorize({
      principal,
      capability,
      resource: await this.resourceOf(runner, context, file),
    }).allowed;
  }

  private async resourceOf(runner: TenantQueryRunner, context: TenantContext, file: FileAssetRow) {
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

function requireInternal(principal: Principal): void {
  if (principal.kind !== 'internal') {
    throw new ApiError(
      403,
      'forbidden',
      MESSAGES.forbidden,
      undefined,
      'not_an_internal_principal',
    );
  }
}

function notFound(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound);
}

function invalid(field: string, message: string): ApiError {
  return new ApiError(400, 'validation_failed', 'The request body is invalid', [
    { field, message },
  ]);
}

function isDuplicateKeyError(error: unknown): boolean {
  const marks = (candidate: unknown): boolean =>
    typeof candidate === 'object' &&
    candidate !== null &&
    ((candidate as { errno?: number }).errno === 1062 ||
      (candidate as { code?: string }).code === 'ER_DUP_ENTRY');
  if (marks(error)) return true;
  return typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause);
}
