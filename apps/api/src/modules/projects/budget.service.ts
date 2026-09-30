import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectBudgetRepository } from './budget.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type { ProjectBudgetRow } from '../../common/database/schema.js';

/**
 * The application service for PROJ / project detail (x293) — a project's budget and its
 * budget-vs-tracked summary. It follows the `ProjectRiskRegisterService` shape.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question `project.manage` for both the read and the
 * write (setting and reading a budget is a manage-level view of a project's plan, not the everyday
 * `work.read` list). This service adds the **relation** check with the project in hand — a member
 * without organization-wide scope reads and writes only the budgets of projects they belong to.
 *
 * ## The Known-trap order
 *
 * Every route names `projectId` by id, and the composite foreign key would surface an unknown or
 * cross-tenant id as a foreign-key 500 the `HttpExceptionFilter` cannot map. So the project is
 * resolved **tenant-scoped before the relation check and before any read or write**: an unknown or
 * another tenant's id is a 404, never a 500, and the relation failure is a 404 too (a 403 would
 * confirm the project exists to a caller who is not a member).
 *
 * ## Hours at the edge, minutes in store
 *
 * The API speaks in hours (`budgetHours`); the column and the tracked total are in minutes (the unit
 * `work_item_time_logs.minutes` uses). Converting at this edge keeps `remaining`/`variance` exact
 * integer-minute subtraction with no floating decimal drift, then reports hours rounded to two
 * places for display.
 */

/** One hour is sixty minutes — the single conversion between the API's unit and the stored unit. */
const MINUTES_PER_HOUR = 60;
/**
 * A sane ceiling for a project's budgeted effort. `1_000_000` hours is 60,000,000 minutes, far below
 * `INT UNSIGNED`'s ~4.29e9 ceiling, and far above any real project budget.
 */
export const MAX_BUDGET_HOURS = 1_000_000;
/** A sane ceiling for a budgeted amount in minor units (`BIGINT UNSIGNED`), well inside safe-int range. */
export const MAX_BUDGET_AMOUNT_MINOR = 1_000_000_000_000;

/** The command the controller hands over once the body has passed shape validation. */
export interface SaveProjectBudgetCommand {
  /** Planned effort in hours (>= 0, whole minutes), or null when only an amount is budgeted. */
  readonly budgetHours: number | null;
  /** Planned amount in minor units (>= 0), or null when only effort is budgeted. */
  readonly budgetAmountMinor: number | null;
  /** ISO-4217 alphabetic code (uppercase), or null. */
  readonly currency: string | null;
}

/**
 * The budget-vs-tracked summary. `organizationId` is deliberately absent (spec §7). `budget*` are the
 * planned figures (null when that dimension is not budgeted); `trackedHours` is the effort already
 * logged on the project's work items; `remaining`/`variance` are computed from the effort budget and
 * are null when no effort is budgeted.
 */
export interface ProjectBudgetView {
  readonly projectId: string;
  readonly budgetHours: number | null;
  readonly budgetAmountMinor: number | null;
  readonly currency: string | null;
  /** Sum of logged effort on the project's work items, in hours (two decimals). */
  readonly trackedHours: number;
  /** `budgetHours - trackedHours`; positive is effort left, negative is overrun. Null with no effort budget. */
  readonly remainingHours: number | null;
  /** `trackedHours - budgetHours`; positive is over budget. Null with no effort budget. */
  readonly varianceHours: number | null;
  /** When the budget was last saved, ISO-8601; null when no budget has been set. */
  readonly updatedAt: string | null;
}

/** Two-decimal rounding for display; the arithmetic itself is done in whole minutes. */
function minutesToHours(minutes: number): number {
  return Math.round((minutes / MINUTES_PER_HOUR) * 100) / 100;
}

/**
 * Build the summary from the stored row (or its absence) and the tracked-minute total. Absence of a
 * row means no budget is set: the planned figures are null and remaining/variance are null, but the
 * tracked total is still reported.
 */
function toView(
  projectId: string,
  row: ProjectBudgetRow | null,
  trackedMinutes: number,
): ProjectBudgetView {
  const budgetMinutes = row?.budgetMinutes ?? null;
  const hasEffortBudget = budgetMinutes !== null;
  return {
    projectId,
    budgetHours: budgetMinutes === null ? null : minutesToHours(budgetMinutes),
    budgetAmountMinor: row?.budgetAmountMinor ?? null,
    currency: row?.currency ?? null,
    trackedHours: minutesToHours(trackedMinutes),
    remainingHours: hasEffortBudget ? minutesToHours(budgetMinutes - trackedMinutes) : null,
    varianceHours: hasEffortBudget ? minutesToHours(trackedMinutes - budgetMinutes) : null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export class ProjectBudgetService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly budgets: ProjectBudgetRepository = new ProjectBudgetRepository(),
    /**
     * Read-only, used to prove the project exists **inside this tenant** before any read or write. An
     * organization-wide caller skips the relation gate, so without this pre-resolution a missing or
     * cross-tenant `projectId` would fall through to the composite foreign key (a 500 on write, and
     * nothing at all to gate the read).
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
   * Read a project's budget-vs-tracked summary.
   *
   * The project is resolved manage-visible first (Known-trap): an unknown or cross-tenant `projectId`,
   * and a non-member's probe, both earn the same not-found. Then the stored budget (if any) and the
   * tracked-minute total are read and summarised. No budget set yet is a 200 with null figures, not a
   * 404 — the project exists, it simply has no budget.
   */
  async get(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectBudgetView> {
    await this.requireManageableProject(context, principal, projectId);

    const [row, trackedMinutes] = await this.database.read(context, async (runner) => {
      const found = await this.budgets.findForProject(runner, context, projectId);
      const tracked = await this.budgets.sumTrackedMinutes(runner, context, projectId);
      return [found, tracked] as const;
    });
    return toView(projectId, row, trackedMinutes);
  }

  /**
   * Set (create or replace) a project's budget, then return the fresh budget-vs-tracked summary.
   *
   * The project is resolved manage-visible first (Known-trap): an unknown or cross-tenant `projectId`
   * is a 404, and a caller who names a project they do not manage gets the same not-found rather than
   * a 403 that would confirm it exists. Then the upsert, then the tracked total. Hours are converted
   * to whole minutes here; the "at least one dimension" rule is enforced by the controller before
   * this runs.
   */
  async save(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    command: SaveProjectBudgetCommand,
  ): Promise<ProjectBudgetView> {
    await this.requireManageableProject(context, principal, projectId);

    const budgetMinutes =
      command.budgetHours === null ? null : Math.round(command.budgetHours * MINUTES_PER_HOUR);

    const row = await this.database.transaction(context, (tx) =>
      this.budgets.upsert(tx, context, {
        projectId,
        budgetMinutes,
        budgetAmountMinor: command.budgetAmountMinor,
        currency: command.currency,
        createdBy: context.userId,
      }),
    );
    const trackedMinutes = await this.database.read(context, (runner) =>
      this.budgets.sumTrackedMinutes(runner, context, projectId),
    );
    return toView(projectId, row, trackedMinutes);
  }
}
