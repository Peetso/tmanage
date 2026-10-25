import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { DecisionsRepository } from './decisions.repository.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import {
  DuplicateDecisionWorkLinkError,
  DecisionWorkLinksRepository,
} from './decision-work-links.repository.js';
import type { DecisionWorkLinkWithItem } from './decision-work-links.repository.js';

/**
 * The application service for DEC / module 12 (x149) — the decision→work-item linkage the route guard
 * cannot decide. It follows the `ObjectiveWorkLinksService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question — `meeting.write` (link/unlink) or
 * `work.read` (list): does this role's ceiling include the capability at all. This service adds the
 * **relation** check with the decision's project in hand, exactly as `DecisionsService` does: a member
 * without organization-wide scope links and lists only the projects they belong to. The relation
 * capability is `work.create` for writes and `work.read` for reads — the fine-grained, project-relational
 * capabilities `meeting.write` / `meeting.read` mirror (see `capabilities.ts`, x90) — so the decisions
 * module authorizes its edges the same way it authorizes the decisions themselves.
 *
 * ## The Known-trap order (FAST-PROTOCOL, 19:55)
 *
 * Every route names an id — `decisionId`, and on link the body's `workItemId`, and on unlink the
 * `linkId`. Each is resolved **tenant- and project-scoped BEFORE the relation check and the write**:
 * an unknown or another tenant's id is a 404, never a foreign-key 500, and the relation failure is a
 * 404 too (a 403 would confirm the row exists to a caller who is not a member). On link, the work item
 * must belong to the *same project* as the decision — a work item in another project of the tenant is
 * a 404, because the edge is scoped to the decision's project (the posture `DecisionsService` gives the
 * optional meeting link).
 *
 * No audit event is written yet — like `ObjectiveWorkLinksService`, that is a follow-up (it needs a
 * `decision_work_link.*` entry in the `AuditAction` catalog, out of this slice).
 */

/** What a caller is allowed to see of a link. `organizationId` is deliberately absent. */
export interface DecisionWorkLinkView {
  readonly linkId: string;
  readonly decisionId: string;
  readonly workItemId: string;
  readonly workItemTitle: string;
  readonly workItemState: string;
  /** A15. The owner's display name ("Lina Samir · due 24 Oct"); `null` when unowned. */
  readonly workItemOwnerName: string | null;
  /** A15. The work item's due instant, ISO-8601; `null` when it has none. */
  readonly workItemDueAt: string | null;
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added later is invisible to every caller until someone decides otherwise, and
 * `organization_id` is never echoed into a response body.
 */
function toView(joined: DecisionWorkLinkWithItem): DecisionWorkLinkView {
  return {
    linkId: joined.link.id,
    decisionId: joined.link.decisionId,
    workItemId: joined.link.workItemId,
    workItemTitle: joined.workItemTitle,
    workItemState: joined.workItemState,
    workItemOwnerName: joined.workItemOwnerName ?? null,
    workItemDueAt: joined.workItemDueAt ? joined.workItemDueAt.toISOString() : null,
    createdAt: joined.link.createdAt.toISOString(),
  };
}

export class DecisionWorkLinksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly links: DecisionWorkLinksRepository = new DecisionWorkLinksRepository(),
    private readonly decisions: DecisionsRepository = new DecisionsRepository(),
    private readonly workItems: WorkItemsRepository = new WorkItemsRepository(),
  ) {}

  /**
   * Resolve a decision the principal may act on under `capability`, tenant-scoped and relation-gated
   * on its project, or throw the not-found that both an unknown id and a non-member's probe must earn.
   * Returns the decision's `projectId` so the caller has it for the next resolution.
   */
  private async requireVisibleDecision(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
    capability: 'work.create' | 'work.read',
  ): Promise<{ readonly projectId: string }> {
    const decision = await this.database.read(context, (runner) =>
      this.decisions.findById(runner, context, decisionId),
    );
    if (!decision) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'decision_not_visible');
    }
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: decision.organizationId,
        projectId: decision.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'decision_not_visible');
    }
    return { projectId: decision.projectId };
  }

  /**
   * List the work linked to a decision the principal may read, in creation order.
   *
   * The decision is resolved read-visible first (Known-trap): an unknown or cross-tenant `decisionId`
   * and a non-member's probe both earn the same not-found. The tenant filter, the join and the
   * deterministic order are the repository's.
   *
   * F31. Only work items still in the decision's project and not soft-deleted are listed: an item
   * moved to a project the reader may not see must not keep showing its title, state, owner or due
   * date here. The repository filters in SQL; the service re-checks the joined row as a second layer.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly decisionId: string; readonly limit?: number },
  ): Promise<readonly DecisionWorkLinkView[]> {
    const { projectId } = await this.requireVisibleDecision(
      context,
      principal,
      options.decisionId,
      'work.read',
    );

    const rows = await this.database.read(context, (runner) =>
      this.links.listByDecision(runner, context, options.decisionId, projectId, options.limit),
    );
    return rows
      .filter((row) => row.workItemProjectId === projectId && row.workItemDeletedAt === null)
      .map(toView);
  }

  /**
   * Link a work item to a decision, both in a project the principal may write.
   *
   * BOTH ids are resolved tenant- and project-scoped BEFORE the write (Known-trap): the decision is
   * resolved write-visible; the work item is resolved inside the tenant and must belong to the *same*
   * project (and not be soft-deleted), else the same not-found. Only then the write, which is a 409 if
   * the pair is already linked.
   */
  async link(
    context: TenantContext,
    principal: Principal,
    input: { readonly decisionId: string; readonly workItemId: string },
  ): Promise<DecisionWorkLinkView> {
    const { projectId } = await this.requireVisibleDecision(
      context,
      principal,
      input.decisionId,
      'work.create',
    );

    const workItem = await this.database.read(context, (runner) =>
      this.workItems.findById(runner, context, input.workItemId),
    );
    // A work item in another tenant is already null (the predicate never selects it). A work item in
    // another project of this tenant, or a soft-deleted one, is invisible to this edge: the linkage is
    // scoped to the decision's project, so it earns the same not-found rather than a 403 or a
    // cross-project link.
    if (!workItem || workItem.projectId !== projectId || workItem.deletedAt !== null) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'work_item_not_visible');
    }

    try {
      const row = await this.database.transaction(context, (tx) =>
        this.links.create(tx, context, {
          decisionId: input.decisionId,
          workItemId: input.workItemId,
          createdBy: context.userId,
        }),
      );
      const ownerName = workItem.ownerUserId
        ? await this.database.read(context, (runner) =>
            this.links.findMemberName(runner, context, workItem.ownerUserId as string),
          )
        : null;
      return toView({
        link: row,
        workItemTitle: workItem.title,
        workItemState: workItem.state,
        workItemOwnerName: ownerName,
        workItemDueAt: workItem.dueAt ?? null,
        workItemProjectId: workItem.projectId,
        workItemDeletedAt: workItem.deletedAt,
      });
    } catch (error) {
      if (error instanceof DuplicateDecisionWorkLinkError) {
        throw new ApiError(
          409,
          'conflict',
          'This work item is already linked to the decision',
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
   * 404 with no write. Its decision is then resolved write-visible (a non-member's probe ⇒ 404), so
   * unlink requires the same relation the link did. Only then the delete, which removes the edge and
   * nothing else.
   */
  async unlink(
    context: TenantContext,
    principal: Principal,
    decisionId: string,
    linkId: string,
  ): Promise<void> {
    const link = await this.database.read(context, (runner) =>
      this.links.findById(runner, context, linkId),
    );
    // The link must exist in the tenant AND belong to the decision named in the path: a link id that
    // names another decision's edge is not this route's to remove, so it earns the same not-found.
    if (!link || link.decisionId !== decisionId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'link_not_visible');
    }

    await this.requireVisibleDecision(context, principal, decisionId, 'work.create');

    await this.database.transaction(context, (tx) => this.links.deleteById(tx, context, linkId));
  }
}
