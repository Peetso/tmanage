import { authorize, isBudgetType, parseAlertThresholds } from '@tmanage/domain';
import type { BudgetType, BurnStatus, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectBudgetRepository } from './budget.repository.js';
import type { BudgetPhaseInput } from './budget.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import type { ProjectBudgetPhaseRow, ProjectBudgetRow } from '../../common/database/schema.js';
import type { AuditService } from '../audit/audit.service.js';
import { BudgetBurnRepository } from './budget-burn.repository.js';
import { burnFromFacts, holdsFinanceView, NO_EXTRA_BURN_SOURCES } from './budget-burn.service.js';
import type { BurnSources } from './budget-burn.service.js';

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
 *
 * ## 52-05 burn (R16-b)
 *
 * A save also stores the budget type, the alert thresholds, the client switch and the phase split,
 * refreshes the used caches in the same transaction (one indexed SUM) and writes `budget.updated`.
 * The read adds the burn (`burnOf` over the caches). Money keys (amounts, minor units) are dropped
 * unless the caller holds `finance.view` — the 52-23 stand-in rule, no new capability.
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
/** 52-05. At most this many phase lines in a split. */
export const MAX_BUDGET_PHASES = 20;

/** 52-05. One phase line as the API speaks it (hours at the edge). */
export interface BudgetPhaseCommand {
  readonly phaseId: string | null;
  readonly name: string;
  readonly budgetHours: number | null;
  readonly budgetAmountMinor: number | null;
  readonly position: number;
}

/** The command the controller hands over once the body has passed shape validation. */
export interface SaveProjectBudgetCommand {
  /** Planned effort in hours (>= 0, whole minutes), or null when only an amount is budgeted. */
  readonly budgetHours: number | null;
  /** Planned amount in minor units (>= 0), or null when only effort is budgeted. */
  readonly budgetAmountMinor: number | null;
  /** ISO-4217 alphabetic code (uppercase), or null. */
  readonly currency: string | null;
  /** 52-05. Absent keeps the stored value (or the default on first save). */
  readonly budgetType?: BudgetType;
  readonly includeExpenses?: boolean;
  readonly clientVisible?: boolean;
  /** One to four whole percents, ascending (validated by the controller). */
  readonly alertThresholds?: readonly number[];
  /** Replace-all phase split (<= 20); absent keeps the stored split. */
  readonly phases?: readonly BudgetPhaseCommand[];
}

export interface BudgetPhaseView {
  readonly phaseId: string | null;
  readonly name: string;
  readonly budgetHours: number | null;
  /** Dropped unless the caller holds `finance.view`. */
  readonly budgetAmountMinor?: number | null;
  readonly position: number;
}

export interface BudgetBurnSummary {
  readonly percentBp: number;
  readonly remainingMinutes: number | null;
  /** Dropped unless the caller holds `finance.view`. */
  readonly remainingMinor?: number | null;
  readonly status: BurnStatus;
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
  /** Money: dropped unless the caller holds `finance.view`. */
  readonly budgetAmountMinor?: number | null;
  readonly currency?: string | null;
  /** Sum of logged effort on the project's work items, in hours (two decimals). */
  readonly trackedHours: number;
  /** `budgetHours - trackedHours`; positive is effort left, negative is overrun. Null with no effort budget. */
  readonly remainingHours: number | null;
  /** `trackedHours - budgetHours`; positive is over budget. Null with no effort budget. */
  readonly varianceHours: number | null;
  /** When the budget was last saved, ISO-8601; null when no budget has been set. */
  readonly updatedAt: string | null;
  // ---- 52-05 ----
  readonly budgetType: BudgetType;
  readonly includeExpenses: boolean;
  readonly clientVisible: boolean;
  readonly alertThresholds: readonly number[];
  readonly phases: readonly BudgetPhaseView[];
  /** The cached used effort (refreshed on save and by the 15-minute sweep), in hours. */
  readonly usedHoursCache: number;
  readonly usedAmountCacheMinor?: number;
  readonly cacheRefreshedAt: string | null;
  /** Null when no budget has been set. */
  readonly burn: BudgetBurnSummary | null;
}

/** Two-decimal rounding for display; the arithmetic itself is done in whole minutes. */
function minutesToHours(minutes: number): number {
  return Math.round((minutes / MINUTES_PER_HOUR) * 100) / 100;
}

/** The type a pre-0291 caller meant by the dimensions it sent. */
function impliedType(minutes: number | null, amount: number | null): BudgetType {
  if (minutes !== null && amount !== null) return 'both';
  return amount !== null ? 'money' : 'hours';
}

interface ViewInput {
  readonly row: ProjectBudgetRow | null;
  readonly phases: readonly ProjectBudgetPhaseRow[];
  readonly trackedMinutes: number;
  readonly expensesMinor: number;
  /** The caller holds `finance.view`. */
  readonly money: boolean;
}

/**
 * Build the summary from the stored row (or its absence) and the tracked-minute total. Absence of a
 * row means no budget is set: the planned figures are null and remaining/variance are null, but the
 * tracked total is still reported. Money keys are omitted unless `money`.
 */
function toView(projectId: string, input: ViewInput): ProjectBudgetView {
  const { row, trackedMinutes, money } = input;
  const budgetMinutes = row?.budgetMinutes ?? null;
  const hasEffortBudget = budgetMinutes !== null;
  const budgetType: BudgetType = row && isBudgetType(row.budgetType) ? row.budgetType : 'hours';
  const burn = row ? burnFromFacts({ ...row, budgetType }, input.expensesMinor) : null;
  return {
    projectId,
    budgetHours: budgetMinutes === null ? null : minutesToHours(budgetMinutes),
    ...(money ? { budgetAmountMinor: row?.budgetAmountMinor ?? null } : {}),
    ...(money ? { currency: row?.currency ?? null } : {}),
    trackedHours: minutesToHours(trackedMinutes),
    remainingHours: hasEffortBudget ? minutesToHours(budgetMinutes - trackedMinutes) : null,
    varianceHours: hasEffortBudget ? minutesToHours(trackedMinutes - budgetMinutes) : null,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    budgetType,
    includeExpenses: row?.includeExpenses ?? true,
    clientVisible: row?.clientVisible ?? false,
    alertThresholds: parseAlertThresholds(row?.alertThresholds),
    phases: input.phases.map((phase) => ({
      phaseId: phase.phaseId,
      name: phase.name,
      budgetHours: phase.budgetMinutes === null ? null : minutesToHours(phase.budgetMinutes),
      ...(money ? { budgetAmountMinor: phase.budgetAmountMinor } : {}),
      position: phase.position,
    })),
    usedHoursCache: minutesToHours(row?.usedMinutesCache ?? 0),
    ...(money ? { usedAmountCacheMinor: row?.usedAmountCacheMinor ?? 0 } : {}),
    cacheRefreshedAt: row?.cacheRefreshedAt ? row.cacheRefreshedAt.toISOString() : null,
    burn: burn
      ? {
          percentBp: burn.percentBp,
          remainingMinutes: burn.remainingMinutes,
          ...(money ? { remainingMinor: burn.remainingMinor } : {}),
          status: burn.status,
        }
      : null,
  };
}

/** 52-05. The collaborators beyond the budget and project repositories. */
export interface ProjectBudgetServiceOptions {
  readonly audit?: Pick<AuditService, 'record'> | null;
  readonly burn?: Pick<BudgetBurnRepository, 'refreshCache'>;
  readonly sources?: BurnSources;
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
    private readonly options: ProjectBudgetServiceOptions = {},
  ) {}

  private get burnRepository(): Pick<BudgetBurnRepository, 'refreshCache'> {
    return this.options.burn ?? new BudgetBurnRepository();
  }

  private get sources(): BurnSources {
    return this.options.sources ?? NO_EXTRA_BURN_SOURCES;
  }

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

  /** Read everything the view needs, then shape it for this caller. */
  private async view(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectBudgetView> {
    const [row, phases, trackedMinutes] = await this.database.read(context, async (runner) => {
      const found = await this.budgets.findForProject(runner, context, projectId);
      const split = found ? await this.budgets.listPhases(runner, context, projectId) : [];
      const tracked = await this.budgets.sumTrackedMinutes(runner, context, projectId);
      return [found, split, tracked] as const;
    });
    const expensesMinor =
      row?.includeExpenses === true ? await this.sources.expensesMinor(context, projectId) : 0;
    return toView(projectId, {
      row,
      phases,
      trackedMinutes,
      expensesMinor,
      money: holdsFinanceView(principal, context.organizationId),
    });
  }

  /**
   * Read a project's budget-vs-tracked summary.
   *
   * The project is resolved manage-visible first (Known-trap): an unknown or cross-tenant `projectId`,
   * and a non-member's probe, both earn the same not-found. No budget set yet is a 200 with null
   * figures, not a 404 — the project exists, it simply has no budget.
   */
  async get(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectBudgetView> {
    await this.requireManageableProject(context, principal, projectId);
    return this.view(context, principal, projectId);
  }

  /**
   * Set (create or replace) a project's budget, then return the fresh summary.
   *
   * The project is resolved manage-visible first (Known-trap). Then, in one transaction: the upsert,
   * the phase split (replace-all, when sent; every `phaseId` must be a phase of this project), the
   * cache refresh and the `budget.updated` audit row. Fields the body leaves out keep their stored
   * values; a first save without a type takes the one its dimensions imply.
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
    const phases: BudgetPhaseInput[] | undefined = command.phases?.map((phase) => ({
      phaseId: phase.phaseId,
      name: phase.name,
      budgetMinutes:
        phase.budgetHours === null ? null : Math.round(phase.budgetHours * MINUTES_PER_HOUR),
      budgetAmountMinor: phase.budgetAmountMinor,
      position: phase.position,
    }));

    await this.database.transaction(context, async (tx) => {
      const existing = await this.budgets.findForProject(tx, context, projectId);
      const phaseIds = [
        ...new Set((phases ?? []).flatMap((phase) => (phase.phaseId ? [phase.phaseId] : []))),
      ];
      if (
        phaseIds.length > 0 &&
        (await this.budgets.countProjectPhases(tx, context, projectId, phaseIds)) !==
          phaseIds.length
      ) {
        throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
          { field: 'phases', message: 'phaseId must name a phase of this project' },
        ]);
      }
      const budgetType =
        command.budgetType ??
        (existing && isBudgetType(existing.budgetType)
          ? existing.budgetType
          : impliedType(budgetMinutes, command.budgetAmountMinor));
      const alertThresholds =
        command.alertThresholds !== undefined
          ? command.alertThresholds.join(',')
          : (existing?.alertThresholds ?? '70,85,95,100');
      const clientVisible = command.clientVisible ?? existing?.clientVisible ?? false;
      await this.budgets.upsert(tx, context, {
        projectId,
        budgetMinutes,
        budgetAmountMinor: command.budgetAmountMinor,
        currency: command.currency,
        createdBy: context.userId,
        budgetType,
        includeExpenses: command.includeExpenses ?? existing?.includeExpenses ?? true,
        clientVisible,
        alertThresholds,
      });
      if (phases !== undefined) await this.budgets.replacePhases(tx, context, projectId, phases);
      await this.burnRepository.refreshCache(tx, context, projectId);
      await this.options.audit?.record(tx, context, {
        action: 'budget.updated',
        result: 'allowed',
        objectId: projectId,
        actorUserId: context.userId,
        metadata: {
          budget_type: budgetType,
          alert_thresholds: alertThresholds.split(',').map(Number),
          client_visible: clientVisible,
          phase_count: phases?.length ?? null,
        },
      });
    });
    return this.view(context, principal, projectId);
  }
}
