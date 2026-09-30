import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectBaselineRepository } from './baseline.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type {
  ProjectBaselineMilestoneSnapshot,
  ProjectBaselineRow,
} from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x295) — the milestone-plan baseline's object-level
 * decisions. It follows the `ProjectRiskRegisterService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage`. This service adds the
 * **relation** check with the row's project in hand — a member without organization-wide scope acts
 * only on the projects they belong to.
 *
 * ## The Known-trap order
 *
 * Every route names `projectId` (and, on variance/discard, `baselineId`) by id, and the composite
 * foreign key would surface an unknown or cross-tenant id as a foreign-key 500 the
 * `HttpExceptionFilter` cannot map. So every id the request names is resolved **tenant-scoped before
 * the relation check and any write**: an unknown or another tenant's id is a 404, never a 500, and
 * the relation failure is a 404 too (a 403 would confirm the row exists to a caller who is not a
 * member).
 *
 * ## The snapshot is frozen once; variance is recomputed at read time
 *
 * `snapshot()` reads the current milestones read-only and freezes their target dates into the JSON.
 * The baseline is then immutable — `variance()` recomputes today's dates against the frozen plan, so
 * slippage always reflects the live milestones without the snapshot ever being mutated.
 */

/** A baseline as listed — the snapshot itself is not echoed, only its milestone count. */
export interface ProjectBaselineView {
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  /** How many milestones were frozen into this baseline. */
  readonly milestoneCount: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** One row of the variance view: a milestone, its frozen date, its current date, and the slippage. */
export interface ProjectBaselineVarianceRow {
  readonly milestoneId: string;
  /** The milestone's current title, or null when it was frozen in the baseline but since removed. */
  readonly title: string | null;
  /** The date frozen in the baseline (`YYYY-MM-DD`), or null (added after the baseline / no date). */
  readonly baselineDate: string | null;
  /** The milestone's current target date (`YYYY-MM-DD`), or null (removed / no committed date). */
  readonly currentDate: string | null;
  /** `currentDate - baselineDate` in whole days (positive = slipped later); null when either is absent. */
  readonly deltaDays: number | null;
}

export interface ProjectBaselineVarianceView {
  readonly baselineId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly rows: readonly ProjectBaselineVarianceRow[];
}

const MILLIS_PER_DAY = 86_400_000;

/** `currentDate - baselineDate` in whole days, or null when either date is missing/unparseable. */
export function computeDeltaDays(
  baselineDate: string | null,
  currentDate: string | null,
): number | null {
  if (baselineDate === null || currentDate === null) return null;
  const base = Date.parse(`${baselineDate}T00:00:00Z`);
  const current = Date.parse(`${currentDate}T00:00:00Z`);
  if (Number.isNaN(base) || Number.isNaN(current)) return null;
  return Math.round((current - base) / MILLIS_PER_DAY);
}

/** An explicit projection (`25-AUTH-AND-TENANT-ISOLATION` §7): `organization_id` is never echoed. */
function toView(row: ProjectBaselineRow): ProjectBaselineView {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    milestoneCount: row.snapshot.length,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

export class ProjectBaselineService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly baselines: ProjectBaselineRepository = new ProjectBaselineRepository(),
    /**
     * Read-only, used to prove the project a baseline names exists **inside this tenant** before the
     * write. The composite foreign key already refuses another tenant's project, but it surfaces as a
     * 500; an organization-wide caller skips the relation gate, so without this pre-resolution a
     * missing or cross-tenant `projectId` would fall through to that foreign key.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
  ) {}

  /**
   * Resolve a project the principal may manage, tenant- and relation-scoped, or throw the not-found
   * that both an unknown id and a non-member's probe must earn.
   */
  private async requireManageableProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<void> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
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
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }
  }

  /**
   * Freeze the current milestone plan as a named baseline.
   *
   * The project is resolved manage-visible first (Known-trap). Then the current milestones are read
   * read-only and their target dates frozen into the snapshot JSON, and the row is inserted. Both the
   * read and the write run in one transaction so the snapshot reflects a single consistent moment.
   */
  async snapshot(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly label: string },
  ): Promise<ProjectBaselineView> {
    await this.requireManageableProject(context, principal, input.projectId);

    const row = await this.database.transaction(context, async (tx) => {
      const milestones = await this.baselines.listMilestones(tx, context, input.projectId);
      const snapshot: readonly ProjectBaselineMilestoneSnapshot[] = milestones.map((milestone) => ({
        milestoneId: milestone.id,
        targetDate: milestone.dueOn ?? null,
      }));
      return this.baselines.create(tx, context, {
        projectId: input.projectId,
        label: input.label,
        snapshot,
        createdBy: context.userId,
      });
    });
    return toView(row);
  }

  /**
   * List a project's baselines, newest first. The project is resolved manage-visible first
   * (Known-trap): an unknown or cross-tenant `projectId`, and a non-member's probe, both earn the
   * same not-found.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<readonly ProjectBaselineView[]> {
    await this.requireManageableProject(context, principal, options.projectId);
    const rows = await this.database.read(context, (runner) =>
      this.baselines.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Read a baseline's variance view: today's milestone dates against the frozen plan.
   *
   * The project is resolved manage-visible first, then the baseline is resolved tenant-scoped and
   * checked to belong to that project (Known-trap: an unknown/cross-tenant/other-project baseline is a
   * 404). The live milestones are then read and each is joined to its frozen date; `deltaDays` is the
   * slippage. Milestones added after the baseline carry a null `baselineDate`; those removed since are
   * surfaced with a null current title/date so the frozen commitment is still visible.
   */
  async variance(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly baselineId: string },
  ): Promise<ProjectBaselineVarianceView> {
    await this.requireManageableProject(context, principal, input.projectId);

    const { baseline, milestones } = await this.database.read(context, async (runner) => {
      const found = await this.baselines.findById(runner, context, input.baselineId);
      if (!found || found.projectId !== input.projectId) {
        return { baseline: null, milestones: [] as const };
      }
      const rows = await this.baselines.listMilestones(runner, context, input.projectId);
      return { baseline: found, milestones: rows };
    });

    if (!baseline) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'baseline_not_visible');
    }

    const frozenById = new Map(
      baseline.snapshot.map((entry) => [entry.milestoneId, entry.targetDate]),
    );

    const rows: ProjectBaselineVarianceRow[] = [];
    // Every live milestone, plus any frozen milestone since removed — the full commitment picture.
    const seen = new Set<string>();
    for (const milestone of milestones) {
      seen.add(milestone.id);
      const baselineDate = frozenById.get(milestone.id) ?? null;
      const currentDate = milestone.dueOn ?? null;
      rows.push({
        milestoneId: milestone.id,
        title: milestone.title,
        baselineDate,
        currentDate,
        deltaDays: computeDeltaDays(baselineDate, currentDate),
      });
    }
    for (const entry of baseline.snapshot) {
      if (seen.has(entry.milestoneId)) continue;
      rows.push({
        milestoneId: entry.milestoneId,
        title: null,
        baselineDate: entry.targetDate,
        currentDate: null,
        deltaDays: null,
      });
    }

    return {
      baselineId: baseline.id,
      label: baseline.label,
      createdAt: baseline.createdAt.toISOString(),
      rows,
    };
  }

  /**
   * Discard a baseline. The project is resolved manage-visible first, then the baseline is resolved
   * tenant-scoped and checked to belong to that project (an unknown/cross-tenant/other-project
   * baseline is a 404), then deleted. A baseline is immutable, but a superseded one may be removed.
   */
  async discard(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly baselineId: string },
  ): Promise<void> {
    await this.requireManageableProject(context, principal, input.projectId);

    await this.database.transaction(context, async (tx) => {
      const found = await this.baselines.findById(tx, context, input.baselineId);
      if (!found || found.projectId !== input.projectId) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'baseline_not_visible');
      }
      await this.baselines.delete(tx, context, input.baselineId);
    });
  }
}
