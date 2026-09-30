import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileCommentRow } from '../../common/database/schema.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { FileCommentsRepository } from './comments.repository.js';

/**
 * x333's application service — file comments (Files module).
 *
 * In-app discussion on a file asset: a member comments, the thread lists oldest-first, and a member
 * may delete their own comment. Two rules matter and both live here, the way `FileTagsService`
 * (x270) places them for file tags:
 *
 * ## Resolve the file, tenant-scoped, BEFORE authorizing or writing
 *
 * Every route names a `fileId` in the path. The file asset is read first, scoped to the acting
 * tenant — a cross-tenant or unknown `file_asset_id` simply does not resolve, and the answer is the
 * same 404 an absent id gives, before `authorize()` is ever asked and before any insert or delete.
 * That is the Known trap: never a foreign-key 500 reached by an org-wide caller who would pass the
 * relation check regardless.
 *
 * ## The capability is the files module's, relation-gated by the file's audience
 *
 * The route guard asks the coarse `file.download` (read) / `file.upload` (write) — the same caps the
 * download and upload doors use (per x205/x270). This service adds the row-level check against the
 * resolved file's project + audience, so a caller who may hold the cap but not see this file is
 * refused. Internal and client roles both hold the files caps; the audience on the resolved file is
 * what scopes a client principal, exactly as it does for file tags — there is no internal-only cap
 * shortcut here.
 *
 * ## Delete own comment only
 *
 * A delete resolves the file (404 if cross-tenant), authorizes the write cap against it (403), then
 * finds the comment: an absent comment is an idempotent 204 no-op, and a comment authored by another
 * membership is refused (403, no delete) — authorship is `created_by` vs the acting membership.
 */

/** What a caller is allowed to see of one file comment. `organizationId` is deliberately absent. */
export interface FileCommentView {
  readonly id: string;
  readonly fileId: string;
  readonly body: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

const READ_CAPABILITY = 'file.download';
const WRITE_CAPABILITY = 'file.upload';

/** `file_comments.body` is `TEXT`; this keeps a comfortable ceiling below the 65_535-byte max. */
const MAX_BODY_LENGTH = 60_000;

export class FileCommentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly projects: ProjectsRepository,
    private readonly comments: FileCommentsRepository = new FileCommentsRepository(),
  ) {}

  /** The comment body length the service validates against before inserting. */
  static get maxBodyLength(): number {
    return MAX_BODY_LENGTH;
  }

  /** A file's comments, oldest-first, for a caller who may read the file. Behind `file.download`. */
  async list(
    context: TenantContext,
    principal: Principal,
    fileId: string,
  ): Promise<readonly FileCommentView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableFile(runner, context, principal, fileId);
      const rows = await this.comments.listForFile(runner, context, fileId);
      return rows.map(toView);
    });
  }

  /** Comment on a file. Behind `file.upload`. Empty body → 400; cross-tenant file → 404, no insert. */
  async add(
    context: TenantContext,
    principal: Principal,
    fileId: string,
    body: unknown,
  ): Promise<FileCommentView> {
    const clean = requiredBody(body);
    return this.database.transaction(context, async (tx) => {
      const file = await this.readableFile(tx, context, principal, fileId);
      await this.requireWrite(tx, context, principal, file);
      const row = await this.comments.append(tx, context, {
        fileAssetId: fileId,
        body: clean,
        createdBy: context.membershipId,
      });
      return toView(row);
    });
  }

  /**
   * Delete own comment. Behind `file.upload`. An absent comment is an idempotent no-op; a comment
   * authored by another membership is refused (403); the caller's own comment is removed.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    fileId: string,
    commentId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const file = await this.readableFile(tx, context, principal, fileId);
      await this.requireWrite(tx, context, principal, file);
      const comment = await this.comments.findOnFile(tx, context, fileId, commentId);
      if (!comment) return; // Idempotent: deleting an absent comment is a 204 no-op.
      if (comment.createdBy !== context.membershipId) {
        throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'not_comment_author');
      }
      await this.comments.deleteOnFile(tx, context, fileId, commentId);
    });
  }

  /**
   * Read the file asset, tenant-scoped, and refuse a caller who may not read it. The 404 for "no
   * relation" is produced here, before any write, and is the same 404 an absent id gives.
   */
  private async readableFile(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    fileId: string,
  ): Promise<FileAssetRow> {
    const row = await this.assets.findById(runner, context, fileId);
    if (!row || !(await this.mayRead(runner, context, principal, row))) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }
    return row;
  }

  private async requireWrite(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    file: FileAssetRow,
  ): Promise<void> {
    const verdict = authorize({
      principal,
      capability: WRITE_CAPABILITY,
      resource: await this.resourceOf(runner, context, file),
    });
    if (!verdict.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, verdict.code);
    }
  }

  private async mayRead(
    runner: TenantQueryRunner,
    context: TenantContext,
    principal: Principal,
    file: FileAssetRow,
  ): Promise<boolean> {
    return authorize({
      principal,
      capability: READ_CAPABILITY,
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

/** The explicit projection, not a serialised row — `organization_id` is never echoed to a body. */
function toView(row: FileCommentRow): FileCommentView {
  return {
    id: row.id,
    fileId: row.fileAssetId,
    body: row.body,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function requiredBody(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: 'must be a non-empty string' },
    ]);
  }
  const body = raw.trim();
  if (body.length > MAX_BODY_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'body', message: `must be ${MAX_BODY_LENGTH} characters or fewer` },
    ]);
  }
  return body;
}
