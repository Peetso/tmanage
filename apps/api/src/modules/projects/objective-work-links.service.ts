import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectObjectivesRepository } from './project-objectives.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import {
  DuplicateObjectiveWorkLinkError,
  ObjectiveWorkLinksRepository,
} from './objective-work-links.repository.js';
import type { ObjectiveWorkLinkWithItem } from './objective-work-links.repository.js';

/**
 * The application service for PROJ / module 8 (x138) — the objective→work-item linkage the route guard
 * cannot decide. It follows the `ProjectObjectivesService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question — `project.manage` (link/unlink) or
 * `work.read` (list): does this role's ceiling include the capability at all. This service adds the
 * **relation** check with the objective's project in hand: a member without organization-wide scope
 * links and lists only the projects they belong to.
 *
 * ## The Known-trap order (FAST-PROTOCOL, 19:55)
 *
 * Every route names an id — `objectiveId`, and on link the body's `workItemId`, and on unlink the
 * `linkId`. Each is resolved **tenant- and project-scoped BEFORE the relation check and the write**:
 * an unknown or another tenant's id is a 404, never a foreign-key 500, and the relation failure is a
 * 404 too (a 403 would confirm the row exists to a caller who is not a member). On link, the work item
 * must belong to the *same project* as the objective — a work item in another project of the tenant is
 * a 404, because the edge is scoped to one project.
 *
 * No audit event is written yet — like `ProjectObjectivesService`, that is a follow-up (it needs an
 * `objective_work_link.*` entry in the `AuditAction` catalog, out of this slice).
 */

/** What a caller is allowed to see of a link. `organizationId` is deliberately absent. */
export interface ObjectiveWorkLinkView {
  readonly linkId: string;
  readonly objectiveId: string;
  readonly workItemId: string;
  readonly workItemTitle: string;
  readonly workItemState: string;
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added later is invisible to every caller until someone decides otherwise, and
 * `organization_id` is never echoed into a response body.
 */
function toView(joined: ObjectiveWorkLinkWithItem): ObjectiveWorkLinkView {
  return {
    linkId: joined.link.id,
    objectiveId: joined.link.objectiveId,
    workItemId: joined.link.workItemId,
    workItemTitle: joined.workItemTitle,
    workItemState: joined.workItemState,
    createdAt: joined.link.createdAt.toISOString(),
  };
}

export class ObjectiveWorkLinksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly links: ObjectiveWorkLinksRepository = new ObjectiveWorkLinksRepository(),
    private readonly objectives: ProjectObjectivesRepository = new ProjectObjectivesRepository(),
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
  ) {}

  /**
   * Resolve an objective the principal may act on under `capability`, tenant-scoped and relation-gated
   * on its project, or throw the not-found that both an unknown id and a non-member's probe must earn.
   * Returns the objective row so the caller has its `projectId` for the next resolution.
   */
  private async requireVisibleObjective(
    context: TenantContext,
    principal: Principal,
    objectiveId: string,
    capability: 'project.manage' | 'work.read',
  ): Promise<{ readonly projectId: string }> {
    const objective = await this.database.read(context, (runner) =>
      this.objectives.findById(runner, context, objectiveId),
    );
    if (!objective) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'objective_not_visible');
    }
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: objective.organizationId,
        projectId: objective.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'objective_not_visible');
    }
    return { projectId: objective.projectId };
  }

  /**
   * List the work linked to an objective the principal may read, in creation order.
   *
   * The objective is resolved read-visible first (Known-trap): an unknown or cross-tenant `objectiveId`
   * and a non-member's probe both earn the same not-found. The tenant filter, the join and the
   * deterministic order are the repository's.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly objectiveId: string; readonly limit?: number },
  ): Promise<readonly ObjectiveWorkLinkView[]> {
    await this.requireVisibleObjective(context, principal, options.objectiveId, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.links.listByObjective(runner, context, options.objectiveId, options.limit),
    );
    return rows.map(toView);
  }

  /**
   * Link a work item to an objective, both in a project the principal may manage.
   *
   * BOTH ids are resolved tenant- and project-scoped BEFORE the write (Known-trap): the objective is
   * resolved manage-visible; the work item is resolved inside the tenant and must belong to the *same*
   * project (and not be soft-deleted), else the same not-found. Only then the write, which is a 409 if
   * the pair is already linked.
   */
  async link(
    context: TenantContext,
    principal: Principal,
    input: { readonly objectiveId: string; readonly workItemId: string },
  ): Promise<ObjectiveWorkLinkView> {
    const { projectId } = await this.requireVisibleObjective(
      context,
      principal,
      input.objectiveId,
      'project.manage',
    );

    const workItem = await this.database.read(context, (runner) =>
      this.workItems.findById(runner, context, input.workItemId),
    );
    // A work item in another tenant is already null (the predicate never selects it). A work item in
    // another project of this tenant, or a soft-deleted one, is invisible to this edge: the linkage is
    // project-scoped, so it earns the same not-found rather than a 403 or a cross-project link.
    if (!workItem || workItem.projectId !== projectId || workItem.deletedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'work_item_not_visible');
    }

    try {
      const row = await this.database.transaction(context, (tx) =>
        this.links.create(tx, context, {
          objectiveId: input.objectiveId,
          workItemId: input.workItemId,
          createdBy: context.userId,
        }),
      );
      return toView({ link: row, workItemTitle: workItem.title, workItemState: workItem.state });
    } catch (error) {
      if (error instanceof DuplicateObjectiveWorkLinkError) {
        throw new ApiError(
          409,
          'conflict',
          'This work item is already linked to the objective',
          [{ field: 'workItemId', message: 'already linked' }],
          'duplicate_link',
        );
      }
      throw error;
    }
  }

  /**
   * Remove a link by id.
   *
   * The link is resolved tenant-scoped first (Known-trap): an unknown or cross-tenant `linkId` is a
   * 404 with no write. Its objective is then resolved manage-visible (a non-manager's probe ⇒ 404),
   * so unlink requires the same `project.manage` relation the link did. Only then the delete, which
   * removes the edge and nothing else.
   */
  async unlink(
    context: TenantContext,
    principal: Principal,
    objectiveId: string,
    linkId: string,
  ): Promise<void> {
    const link = await this.database.read(context, (runner) =>
      this.links.findById(runner, context, linkId),
    );
    // The link must exist in the tenant AND belong to the objective named in the path: a link id that
    // names another objective's edge is not this route's to remove, so it earns the same not-found.
    if (!link || link.objectiveId !== objectiveId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'link_not_visible');
    }

    await this.requireVisibleObjective(context, principal, objectiveId, 'project.manage');

    await this.database.transaction(context, (tx) => this.links.deleteById(tx, context, linkId));
  }
}
