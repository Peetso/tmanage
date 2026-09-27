import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectMilestoneRow } from '../../common/database/schema.js';
import { ProjectMilestonesRepository } from '../clients/project-milestones.repository.js';
import type { ProjectMilestoneStatus } from '../clients/project-milestones.repository.js';
import { MilestoneLinksRepository } from './milestone-links.repository.js';
import type { MilestoneEdge } from './milestone-links.repository.js';

/**
 * The application service for PROJ / module 8 (x236) — the milestone → milestone "depends-on"
 * linkage the route guard cannot decide. It follows the `ObjectiveWorkLinksService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question — `project.manage`: does this role's
 * ceiling include the capability at all. This service adds the **relation** check with the
 * milestone's project in hand: a member without organization-wide scope links, lists and unlinks
 * only the projects they belong to.
 *
 * ## The Known-trap order
 *
 * Every route names a milestone id — and on link, the body's `dependsOnMilestoneId`. **BOTH are
 * resolved tenant-scoped BEFORE the relation check and the write**: an unknown or another tenant's
 * id is a 404, never a foreign-key 500, and the relation failure is a 404 too (a 403 would confirm
 * the row exists to a caller who is not a member). Both milestones must belong to the **same
 * project** — a dependency across projects is not a link this route makes, so it earns the same
 * not-found. Only then the invariants: a self-link and any cycle are rejected (400), and a duplicate
 * pair resolves idempotently to the existing edge.
 */

/** What a caller is allowed to see of a dependency. `organizationId` is deliberately absent. */
export interface MilestoneLinkView {
  readonly linkId: string;
  readonly milestoneId: string;
  readonly dependsOnMilestoneId: string;
  readonly dependsOnTitle: string;
  readonly dependsOnStatus: ProjectMilestoneStatus;
  /** An ISO-8601 instant. */
  readonly createdAt: string;
}

export class MilestoneLinksService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly links: MilestoneLinksRepository = new MilestoneLinksRepository(),
    private readonly milestones: ProjectMilestonesRepository = new ProjectMilestonesRepository(),
  ) {}

  /**
   * List the dependencies of a milestone the principal may manage, in creation order.
   *
   * The milestone is resolved manage-visible first (Known-trap): an unknown or cross-tenant
   * `milestoneId` and a non-member's probe both earn the same not-found.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly milestoneId: string; readonly limit?: number },
  ): Promise<readonly MilestoneLinkView[]> {
    await this.requireManageableMilestone(context, principal, options.milestoneId);

    const rows = await this.database.read(context, (runner) =>
      this.links.listByMilestone(runner, context, options.milestoneId, options.limit),
    );
    return rows.map((row) => ({
      linkId: row.link.id,
      milestoneId: row.link.milestoneId,
      dependsOnMilestoneId: row.link.dependsOnMilestoneId,
      dependsOnTitle: row.dependsOnTitle,
      dependsOnStatus: row.dependsOnStatus as ProjectMilestoneStatus,
      createdAt: row.link.createdAt.toISOString(),
    }));
  }

  /**
   * Link a milestone to a prerequisite, both in a project the principal may manage.
   *
   * BOTH ids are resolved tenant-scoped BEFORE the write (Known-trap): the dependent milestone is
   * resolved manage-visible; the prerequisite is resolved inside the tenant and must belong to the
   * *same* project, else the same not-found. Then the invariants — a self-link (400), a cycle
   * (400) — and finally the write, which is idempotent on the pair.
   */
  async link(
    context: TenantContext,
    principal: Principal,
    input: { readonly milestoneId: string; readonly dependsOnMilestoneId: string },
  ): Promise<MilestoneLinkView> {
    const milestone = await this.requireManageableMilestone(context, principal, input.milestoneId);

    const dependsOn = await this.database.read(context, (runner) =>
      this.milestones.findById(runner, context, input.dependsOnMilestoneId),
    );
    // A prerequisite in another tenant is already null. A prerequisite in another project of this
    // tenant is invisible to this edge: a dependency is project-scoped, so it earns the same
    // not-found rather than a cross-project link.
    if (!dependsOn || dependsOn.projectId !== milestone.projectId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'milestone_not_visible');
    }

    // A milestone cannot depend on itself.
    if (input.milestoneId === input.dependsOnMilestoneId) {
      throw new ApiError(
        400,
        'validation_failed',
        'A milestone cannot depend on itself',
        [{ field: 'dependsOnMilestoneId', message: 'must differ from the milestone' }],
        'self_link',
      );
    }

    // A dependency must not close a cycle. Adding `milestoneId → dependsOnMilestoneId` closes one
    // iff `dependsOnMilestoneId` can already reach `milestoneId` through existing depends-on edges.
    const edges = await this.database.read(context, (runner) =>
      this.links.listEdgesForProject(runner, context, milestone.projectId),
    );
    if (reaches(edges, input.dependsOnMilestoneId, input.milestoneId)) {
      throw new ApiError(
        400,
        'validation_failed',
        'This dependency would create a cycle',
        [{ field: 'dependsOnMilestoneId', message: 'would create a dependency cycle' }],
        'dependency_cycle',
      );
    }

    // Idempotent: a pair that is already linked returns the existing edge rather than a second row.
    const existing = await this.database.read(context, (runner) =>
      this.links.findByPair(runner, context, input.milestoneId, input.dependsOnMilestoneId),
    );
    const row =
      existing ??
      (await this.database.transaction(context, (tx) =>
        this.links.create(tx, context, {
          milestoneId: input.milestoneId,
          dependsOnMilestoneId: input.dependsOnMilestoneId,
          createdBy: context.userId,
        }),
      ));

    return this.toView(row, dependsOn);
  }

  /**
   * Remove a dependency by its (milestone, prerequisite) pair.
   *
   * The dependent milestone is resolved manage-visible first (Known-trap): an unknown or
   * cross-tenant `milestoneId`, and a non-member's probe, are each a 404 with no write. The unlink
   * is idempotent — a pair that is not linked is a no-op — so the route is a clean 204 either way.
   */
  async unlink(
    context: TenantContext,
    principal: Principal,
    milestoneId: string,
    dependsOnMilestoneId: string,
  ): Promise<void> {
    await this.requireManageableMilestone(context, principal, milestoneId);

    const existing = await this.database.read(context, (runner) =>
      this.links.findByPair(runner, context, milestoneId, dependsOnMilestoneId),
    );
    if (!existing) return;

    await this.database.transaction(context, (tx) =>
      this.links.deleteById(tx, context, existing.id),
    );
  }

  /**
   * Resolve a milestone the principal may manage, tenant-scoped and relation-gated on its project,
   * or throw the not-found that both an unknown id and a non-member's probe must earn. Returns the
   * milestone row so the caller has its `projectId` for the next resolution.
   */
  private async requireManageableMilestone(
    context: TenantContext,
    principal: Principal,
    milestoneId: string,
  ): Promise<ProjectMilestoneRow> {
    const milestone = await this.database.read(context, (runner) =>
      this.milestones.findById(runner, context, milestoneId),
    );
    if (!milestone) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'milestone_not_visible');
    }
    const permitted = authorize({
      principal,
      capability: 'project.manage',
      resource: {
        organizationId: milestone.organizationId,
        projectId: milestone.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'milestone_not_visible');
    }
    return milestone;
  }

  private toView(
    row: { id: string; milestoneId: string; dependsOnMilestoneId: string; createdAt: Date },
    dependsOn: ProjectMilestoneRow,
  ): MilestoneLinkView {
    return {
      linkId: row.id,
      milestoneId: row.milestoneId,
      dependsOnMilestoneId: row.dependsOnMilestoneId,
      dependsOnTitle: dependsOn.title,
      dependsOnStatus: dependsOn.status,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Is `target` reachable from `start` by following depends-on edges? A breadth-first walk over the
 * project's dependency adjacency, guarded against revisiting a node so a pre-existing (impossible,
 * but defensively handled) cycle cannot loop forever.
 */
function reaches(edges: readonly MilestoneEdge[], start: string, target: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.milestoneId);
    if (list) list.push(edge.dependsOnMilestoneId);
    else adjacency.set(edge.milestoneId, [edge.dependsOnMilestoneId]);
  }

  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    if (node === target) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of adjacency.get(node) ?? []) queue.push(next);
  }
  return false;
}
