import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { FileAssetRow, FileTagRow } from '../../common/database/schema.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { FileTagsRepository } from './file-tags.repository.js';
import { FileClientRelation } from './file-client-relation.js';

/**
 * x270's application service — file tags (Files module).
 *
 * Two objects, one table (see `0140_file_tags.sql`): a **tag definition** the org owns, and a **tag
 * assignment** tying a definition to a file asset. The two rules that matter live here, the way
 * `WorkLabelsService` (x233) places them:
 *
 * ## Resolve the file AND the tag, tenant-scoped, BEFORE authorizing or writing
 *
 * Assign and remove name a `fileId` in the path; the file asset is read first, scoped to the acting
 * tenant — a cross-tenant `file_id` simply does not resolve, and the answer is the same 404 an
 * absent id gives, before `authorize()` is ever asked and before any write. The tag id is resolved
 * the same way: a tag of another org does not resolve and is a 404.
 *
 * ## Definitions are org-scoped; assignments inherit the file's audience
 *
 * Defining and listing tags is org-wide (behind `file.upload` to define, `file.download` to list). A
 * name is unique per tenant — a collision is a 409. Tagging is idempotent: assigning a tag already
 * on the file returns the existing assignment rather than a duplicate. The row-level write is
 * authorized against the resolved file's project + audience, so a caller who may see the file but
 * not manage it is refused (403), and one in another tenant never gets that far (404).
 */

/** The client-facing projection of one tag definition. Paired in `e2e/contracts`. */
export interface FileTagView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** The client-facing projection of one tag assigned to a file. Paired in `e2e/contracts`. */
export interface FileTagAssignmentView {
  readonly id: string;
  readonly fileId: string;
  readonly tagId: string;
  readonly name: string;
  readonly createdAt: string;
}

const READ_CAPABILITY = 'file.download';
const WRITE_CAPABILITY = 'file.upload';

export class FileTagsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly projects: ProjectsRepository,
    private readonly tags: FileTagsRepository = new FileTagsRepository(),
    /** F35. A client principal is held to the request row's relation, as the download gate is. */
    private readonly relation: FileClientRelation = new FileClientRelation(),
  ) {}

  /** The tenant's tag definitions, name-ascending. Behind `file.download`. */
  async listDefinitions(context: TenantContext): Promise<readonly FileTagView[]> {
    return this.database.read(context, async (runner) => {
      const rows = await this.tags.listDefinitions(runner, context);
      return rows.map(toTagView);
    });
  }

  /** Define a tag. Behind `file.upload`. Duplicate name → 409. */
  async define(context: TenantContext, name: unknown): Promise<FileTagView> {
    const clean = requiredName(name);
    return this.database.transaction(context, async (tx) => {
      const clash = await this.tags.findDefinitionByName(tx, context, clean);
      if (clash) {
        throw new ApiError(409, 'conflict', 'A tag with this name already exists');
      }
      const row = await this.tags.createDefinition(tx, context, clean);
      return toTagView(row);
    });
  }

  /** The tags assigned to a file. Behind `file.download` on the resolved file. */
  async listForFile(
    context: TenantContext,
    principal: Principal,
    fileId: string,
  ): Promise<readonly FileTagAssignmentView[]> {
    return this.database.read(context, async (runner) => {
      await this.readableFile(runner, context, principal, fileId);
      const [assignments, definitions] = await Promise.all([
        this.tags.listAssignments(runner, context, fileId),
        this.tags.listDefinitions(runner, context),
      ]);
      const byId = new Map(definitions.map((row) => [row.id, row]));
      return assignments
        .map((assignment) => toAssignmentView(assignment, byId.get(assignment.tagId ?? '')))
        .filter((view): view is FileTagAssignmentView => view !== null);
    });
  }

  /** Tag a file. Behind `file.upload`. Idempotent; unknown tag or cross-tenant file → 404. */
  async assign(
    context: TenantContext,
    principal: Principal,
    fileId: string,
    tagId: string,
  ): Promise<FileTagAssignmentView> {
    return this.database.transaction(context, async (tx) => {
      // Resolve the file, tenant-scoped, and authorize the write against it — before any insert.
      const file = await this.readableFile(tx, context, principal, fileId);
      await this.requireWrite(tx, context, principal, file);

      // The tag is resolved scoped to the tenant; a cross-tenant or unknown tag id does not resolve
      // and is a 404, before any write.
      const definition = await this.tags.findDefinition(tx, context, tagId);
      if (!definition) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // Idempotent: an already-present tag returns its existing row rather than a duplicate.
      const existing = await this.tags.findAssignment(tx, context, fileId, tagId);
      const row = existing ?? (await this.tags.createAssignment(tx, context, fileId, tagId));
      const view = toAssignmentView(row, definition);
      if (!view) throw new ApiError(404, 'not_found', MESSAGES.notFound);
      return view;
    });
  }

  /** Untag a file. Behind `file.upload`. A tag that is not present is a no-op 204. */
  async remove(
    context: TenantContext,
    principal: Principal,
    fileId: string,
    tagId: string,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      const file = await this.readableFile(tx, context, principal, fileId);
      await this.requireWrite(tx, context, principal, file);
      await this.tags.deleteAssignment(tx, context, fileId, tagId);
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
    if (
      !row ||
      !(await this.relation.mayClientReach(runner, context, principal, row)) ||
      !(await this.mayRead(runner, context, principal, row))
    ) {
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

function toTagView(row: FileTagRow): FileTagView {
  return {
    id: row.id,
    name: row.name ?? '',
    createdAt: row.createdAt.toISOString(),
  };
}

/** An assignment row plus its definition; `null` if the definition is missing (never, in practice). */
function toAssignmentView(
  assignment: FileTagRow,
  definition: FileTagRow | undefined,
): FileTagAssignmentView | null {
  if (!definition || assignment.fileId === null || assignment.tagId === null) return null;
  return {
    id: assignment.id,
    fileId: assignment.fileId,
    tagId: assignment.tagId,
    name: definition.name ?? '',
    createdAt: assignment.createdAt.toISOString(),
  };
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
