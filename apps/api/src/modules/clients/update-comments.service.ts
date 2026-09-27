import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { ProjectUpdateCommentRow, ProjectUpdateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectUpdatesRepository } from './project-updates.repository.js';
import { ProjectUpdateCommentsRepository } from './update-comments.repository.js';

/**
 * SEC / Portal update comments (x203, module 13) — the internal write/read surface and the client
 * projection for a comment thread hanging off a published project update.
 *
 * The design mirrors CLIENT-003 (project_updates, x125) and x139 (milestones), and for the same
 * reasons:
 *
 * - The **internal** routes (`POST`/`GET projects/:projectId/updates/:updateId/comments`) live on
 *   the internal `projects` path behind `project.manage`, which no client role holds. Keeping the
 *   write and the full read off `/portal` means a client principal never reaches them — a security
 *   property, not a routing preference; the guard refuses a client with 403 before the handler runs.
 * - The **client** route (`GET portal/projects/:projectId/updates/:updateId/comments`) is on a path
 *   of its own and serves {@link ClientUpdateCommentView}, which carries no staff identity, from an
 *   update that must be **published** and in a project this client may read.
 *
 * ## Resolve the parent update, tenant- and project-scoped, BEFORE authorizing or writing
 *
 * Every route names both `projectId` and `updateId`. The update is resolved first, scoped to the
 * acting tenant ({@link ProjectUpdatesRepository.findById}), and required to belong to the named
 * project — an update from another tenant does not resolve, and one from another project of the
 * same tenant is rejected the same way. The refusal is **404, not 403**: a caller must not learn
 * which project or update ids are real. That order is the Known trap (FAST-PROTOCOL 19:55): a
 * cross-tenant or other-project parent is a 404 with no write, never a comment against the wrong
 * thread, and the client read of one update's comments can never surface another project's.
 *
 * ## Client reply is Needs-Peter
 *
 * Every comment here is internal-authored: the write gate is `project.manage`, which no client role
 * holds. A client *reply* needs a client-write capability the permission matrix does not grant
 * (12-PERMISSION-MATRIX), so this slice is internal-post → client-read only, and there is no
 * author-audience column to get wrong.
 */

/** `project_update_comments.body` is `TEXT`; this bounds a single comment to a sane maximum. */
export const MAX_UPDATE_COMMENT_BODY_LENGTH = 5000;

/**
 * A comment as an **internal** principal is shown it — the full record behind `project.manage`.
 *
 * Carries `createdByUserId`: an internal manager may see who posted the comment. This view never
 * leaves the internal `projects` path. Paired against the web type in `e2e/contracts`.
 */
export interface UpdateCommentView {
  readonly id: string;
  readonly projectId: string;
  readonly updateId: string;
  readonly body: string;
  readonly createdByUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/**
 * A comment as a **client** is shown it — the client projection.
 *
 * **`createdByUserId` is not here.** 12-PERMISSION-MATRIX §4 excludes staff from the client
 * projection — which member of the agency posted the comment is an internal fact a client never
 * learns, the same omission `PortalUpdateView` makes for the update's author. Listing the fields
 * means a column added to `project_update_comments` tomorrow is invisible to a client until someone
 * decides otherwise.
 */
export interface ClientUpdateCommentView {
  readonly id: string;
  readonly projectId: string;
  readonly updateId: string;
  readonly body: string;
  readonly createdAt: string;
}

/** What an internal principal posts. The tenant and the author come from the context, never the body. */
export interface PostUpdateCommentInput {
  readonly body: string;
}

function toInternalView(row: ProjectUpdateCommentRow, projectId: string): UpdateCommentView {
  return {
    id: row.id,
    projectId,
    updateId: row.updateId,
    body: row.body,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toClientView(row: ProjectUpdateCommentRow, projectId: string): ClientUpdateCommentView {
  return {
    id: row.id,
    projectId,
    updateId: row.updateId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

export class UpdateCommentsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly updates: ProjectUpdatesRepository = new ProjectUpdatesRepository(),
    private readonly comments: ProjectUpdateCommentsRepository = new ProjectUpdateCommentsRepository(),
  ) {}

  /**
   * Post a comment on an update — the internal half. `project.manage`, internal only.
   *
   * The Known-trap order: the update is resolved tenant-scoped and required to belong to the named
   * project **before** authorize or write (404 on either miss, no write), then `project.manage` is
   * checked against the project (404, not 403, for a project the caller cannot manage — 403 would
   * confirm it exists). The author is `context.userId`, never a body field.
   */
  async post(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    updateId: string,
    input: PostUpdateCommentInput,
  ): Promise<UpdateCommentView> {
    await this.resolveManageableUpdate(context, principal, projectId, updateId);

    const row = await this.database.transaction(context, (tx) =>
      this.comments.create(tx, context, {
        updateId,
        body: input.body,
        createdByUserId: context.userId,
      }),
    );

    return toInternalView(row, projectId);
  }

  /** The full internal comment list for one update — `project.manage`, internal only. */
  async listInternal(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    updateId: string,
  ): Promise<readonly UpdateCommentView[]> {
    await this.resolveManageableUpdate(context, principal, projectId, updateId);

    const rows = await this.database.read(context, (runner) =>
      this.comments.listForUpdate(runner, context, updateId),
    );
    return rows.map((row) => toInternalView(row, projectId));
  }

  /**
   * The comments on one **published** update this client may read — the client half.
   *
   * {@link mayRead} runs `authorize()` rule 10 for a client — the project must be in
   * `principal.projectIds`, from `project_clients` and nothing else — so an unknown, cross-tenant or
   * sibling-client `projectId` is a 404 (not 403, not an empty list). The update is then resolved
   * tenant-scoped and required to be in that project **and** `published` — an unpublished update is
   * invisible to a client, so its comments are too. {@link toClientView} carries no staff identity.
   */
  async listForClient(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    updateId: string,
  ): Promise<readonly ClientUpdateCommentView[]> {
    if (!this.mayRead(principal, projectId)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const update = await this.database.read(context, (runner) =>
      this.updates.findById(runner, context, updateId),
    );
    if (!update || update.projectId !== projectId || !update.published) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound);
    }

    const rows = await this.database.read(context, (runner) =>
      this.comments.listForUpdate(runner, context, updateId),
    );
    return rows.map((row) => toClientView(row, projectId));
  }

  /**
   * Resolve the update tenant-scoped, require it belong to the named project, then check the caller
   * may manage that project. Throws the same 404 on every miss, so a caller can tell neither which
   * projects/updates exist nor which they are barred from.
   */
  private async resolveManageableUpdate(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    updateId: string,
  ): Promise<ProjectUpdateRow> {
    const update = await this.database.read(context, (runner) =>
      this.updates.findById(runner, context, updateId),
    );
    if (!update || update.projectId !== projectId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'update_not_visible');
    }

    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'update_not_visible');
    }

    return update;
  }

  /** May this principal read the client projection of this project? `authorize()` rules 7-10. */
  private mayRead(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'client_projection.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'client_visible',
        clientOrganizationId: principal.clientOrganizationId,
        lifecycle: 'active',
      },
    }).allowed;
  }
}
