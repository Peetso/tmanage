import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectRow } from '../../common/database/schema.js';
import { ProjectsRepository } from './projects.repository.js';
import { ProjectHealthRepository } from './health.repository.js';
import type { ProjectScheduleDriverRow, ProjectScheduleSignalRow } from './health.repository.js';

/**
 * The application service for PROJ / module 8 (x208) — the computed project-health roll-up.
 *
 * ## What it is
 *
 * A **read** that turns the signals already stored against a project — overdue milestones (x139),
 * open risks (x140) and objective progress (x124) — into a single deterministic score and a
 * traffic-light band. The portfolio (x137) deliberately stopped at arithmetic and deferred a score
 * to "NS-13"; this is that slice. Every input is a count anyone can re-derive, the weights are fixed
 * constants stated below, and the arithmetic is repeatable: the same project on the same day yields
 * the same band. No division is performed, so an empty project cannot raise a divide error — it has
 * no signals at all and is reported as the `neutral` band, not as a false green.
 *
 * ## The thresholds are constants, not input
 *
 * The Known-trap for this slice: the band thresholds and signal weights are **fixed module
 * constants** ({@link HEALTH_WEIGHTS}, {@link HEALTH_BANDS}), never per-request parameters. A caller
 * cannot pass a weight or a cut-off and move a project's band, so two callers see the same project in
 * the same colour. The only request input is which project(s) to read, and that is gated below.
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse `work.read` question. This service adds the
 * **relation** filter the guard cannot, exactly as `portfolio.service.ts` and `projects.service.ts`
 * do: it authorizes each project row against `authorize()` before it contributes a single signal.
 * The single-project read returns **not found** (never forbidden) for a project the caller may not
 * see or that belongs to another tenant, because 403 would confirm the project exists — the same
 * stance `ProjectsService.get` takes.
 */

/** Signal weights, in score points deducted per occurrence. Fixed; never per-request. */
export const HEALTH_WEIGHTS = {
  /** A planned milestone past its day. */
  overdueMilestone: 15,
  /** An open risk marked high severity. */
  highRisk: 20,
  /** An open risk of low or medium severity (an open risk that is not high). */
  otherOpenRisk: 8,
  /** An objective recorded as missed. */
  missedObjective: 12,
} as const;

/** Band cut-offs on the 0..100 score. `score >= green` → green; `>= amber` → amber; else red. */
export const HEALTH_BANDS = { green: 80, amber: 50 } as const;

/** The best possible score, and the ceiling a project with no penalties reports. */
export const HEALTH_MAX_SCORE = 100;

export type ProjectHealthBand = 'green' | 'amber' | 'red' | 'neutral';

/** The signal counts a band is derived from — each one independently checkable on the project. */
export interface ProjectHealthSignals {
  readonly overdueMilestones: number;
  readonly openRisks: number;
  readonly highRisks: number;
  readonly objectivesTotal: number;
  readonly objectivesMet: number;
  readonly objectivesMissed: number;
}

/** One project's computed health. `organizationId` is deliberately absent. */
export interface ProjectHealthView {
  readonly projectId: string;
  readonly name: string;
  readonly status: string;
  /** 0..100; `HEALTH_MAX_SCORE` for a project with no penalties (including an empty project). */
  readonly score: number;
  /** `neutral` when the project has no health signals at all; otherwise the banded score. */
  readonly band: ProjectHealthBand;
  readonly signals: ProjectHealthSignals;
  /**
   * 53-06. The stored critical-path summary, or `null` when the project has never been recomputed.
   * Informational: the score and the band do not use it. Optional so the existing web shape stays
   * an exact pair until the health card shows it.
   */
  readonly schedule?: ProjectScheduleHealth | null;
}

/** 53-06. A project's schedule block on the health view. */
export interface ProjectScheduleHealth {
  readonly criticalEndDate: string | null;
  readonly criticalCount: number;
  /** Baseline slip in working days — `null` until 53-05's baselines are wired in (R18). */
  readonly slipDays: null;
  /** Up to three critical items (latest early finish first) the caller may read. */
  readonly drivers: readonly { readonly id: string; readonly title: string }[];
  /** Of those top three, how many the caller may not read — counted, never named. */
  readonly hiddenDrivers: number;
}

/** 53-06. How many critical items the health card names per project. */
export const SCHEDULE_DRIVERS_PER_PROJECT = 3;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface ListHealthOptions {
  readonly limit?: number;
}

export class ProjectHealthService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly health: ProjectHealthRepository = new ProjectHealthRepository(),
    /** The clock, injectable so the overdue-milestone cut-off is deterministic in tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * The health band for every project this principal may read, in a deterministic, bounded page.
   *
   * The relation filter runs first (id ascending, `MAX_LIMIT`-bounded, the same keyset order the
   * portfolio pages by); the three signal aggregates are then handed only the surviving ids, so a
   * cross-tenant or unrelated project never contributes.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListHealthOptions = {},
  ): Promise<readonly ProjectHealthView[]> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const rows = await this.database.read(context, (runner) =>
      this.projects.list(runner, context, { limit }),
    );
    const visible = rows.filter((row) => this.mayRead(principal, row));

    return this.computeFor(context, visible, principal);
  }

  /**
   * The computed health of one project, or **not found** if the caller may not see it (a foreign or
   * unrelated project is indistinguishable from a missing one).
   */
  async get(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectHealthView> {
    const row = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );

    if (!row || !this.mayRead(principal, row)) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const [view] = await this.computeFor(context, [row], principal);
    // `computeFor` returns exactly one view per input row, so this is always defined.
    return view!;
  }

  /** Read the three signal aggregates for the given rows and fold each into a banded view. */
  private async computeFor(
    context: TenantContext,
    projects: readonly ProjectRow[],
    principal: Principal,
  ): Promise<readonly ProjectHealthView[]> {
    const projectIds = projects.map((row) => row.id);
    const today = toCalendarDay(this.now());

    const [milestones, risks, objectives, schedules, drivers] = await this.database.read(
      context,
      async (runner) => {
        const m = await this.health.milestoneSignals(runner, context, projectIds, today);
        const r = await this.health.riskSignals(runner, context, projectIds);
        const o = await this.health.objectiveSignals(runner, context, projectIds);
        // 53-06: one grouped read for the list, plus the critical items to name the drivers.
        const s = await this.health.scheduleSignals(runner, context, projectIds);
        const d = await this.health.scheduleDrivers(runner, context, projectIds);
        return [m, r, o, s, d] as const;
      },
    );
    const scheduleByProject = new Map(schedules.map((row) => [row.projectId, row]));
    const driversByProject = new Map<string, ProjectScheduleDriverRow[]>();
    for (const row of drivers) {
      const list = driversByProject.get(row.projectId) ?? [];
      if (list.length < SCHEDULE_DRIVERS_PER_PROJECT) list.push(row);
      driversByProject.set(row.projectId, list);
    }

    const milestonesByProject = new Map(milestones.map((row) => [row.projectId, row]));
    const risksByProject = new Map(risks.map((row) => [row.projectId, row]));
    const objectivesByProject = new Map<string, { open: number; met: number; missed: number }>();
    for (const row of objectives) {
      const tally = objectivesByProject.get(row.projectId) ?? { open: 0, met: 0, missed: 0 };
      tally[row.status] = row.count;
      objectivesByProject.set(row.projectId, tally);
    }

    return projects.map((project) => {
      const objective = objectivesByProject.get(project.id) ?? { open: 0, met: 0, missed: 0 };
      const signals: ProjectHealthSignals = {
        overdueMilestones: milestonesByProject.get(project.id)?.overdueMilestones ?? 0,
        openRisks: risksByProject.get(project.id)?.openRisks ?? 0,
        highRisks: risksByProject.get(project.id)?.highRisks ?? 0,
        objectivesTotal: objective.open + objective.met + objective.missed,
        objectivesMet: objective.met,
        objectivesMissed: objective.missed,
      };
      const score = scoreFor(signals);
      return {
        projectId: project.id,
        name: project.name,
        status: project.status,
        score,
        band: bandFor(signals, score),
        signals,
        schedule: this.scheduleOf(
          principal,
          scheduleByProject.get(project.id),
          driversByProject.get(project.id),
        ),
      };
    });
  }

  /** 53-06: the schedule block; drivers the caller cannot read are counted, never named. */
  private scheduleOf(
    principal: Principal,
    signal: ProjectScheduleSignalRow | undefined,
    top: readonly ProjectScheduleDriverRow[] = [],
  ): ProjectScheduleHealth | null {
    if (!signal || principal.kind === 'client') return null;
    const readable = top.filter(
      (row) =>
        authorize({
          principal,
          capability: 'work.read',
          resource: {
            organizationId: row.organizationId,
            projectId: row.projectId,
            audience: row.audience,
            lifecycle: row.state === 'archived' ? 'archived' : 'active',
          },
        }).allowed,
    );
    return {
      criticalEndDate: signal.criticalEndDate,
      criticalCount: signal.criticalCount,
      slipDays: null, // R18 wires 53-05's baselines in; this slice does not read them.
      drivers: readable.map((row) => ({ id: row.workItemId, title: row.title })),
      hiddenDrivers: top.length - readable.length,
    };
  }

  /** The relation gate: `work.read` against the project row, exactly as `ProjectsService`. */
  private mayRead(principal: Principal, row: ProjectRow): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: row.organizationId,
        projectId: row.id,
        audience: 'internal',
        lifecycle: row.archivedAt ? 'archived' : 'active',
      },
    }).allowed;
  }
}

/** The deterministic 0..100 score: full marks less the fixed penalty for each signal. */
export function scoreFor(signals: ProjectHealthSignals): number {
  const otherOpenRisks = Math.max(signals.openRisks - signals.highRisks, 0);
  const penalty =
    signals.overdueMilestones * HEALTH_WEIGHTS.overdueMilestone +
    signals.highRisks * HEALTH_WEIGHTS.highRisk +
    otherOpenRisks * HEALTH_WEIGHTS.otherOpenRisk +
    signals.objectivesMissed * HEALTH_WEIGHTS.missedObjective;
  return Math.min(Math.max(HEALTH_MAX_SCORE - penalty, 0), HEALTH_MAX_SCORE);
}

/** D7: the signal that cost a project the most score — why its band is what it is, in facts. */
export interface ProjectHealthReason {
  readonly kind: 'overdueMilestones' | 'highRisks' | 'openRisks' | 'missedObjectives';
  readonly count: number;
}

/**
 * The heaviest penalty of {@link scoreFor}, or `null` for a project that lost nothing. Ties go to
 * the order below (milestones, high risks, other risks, objectives). `openRisks` counts the
 * open risks that are not high, as the score does.
 */
export function healthReasonOf(signals: ProjectHealthSignals): ProjectHealthReason | null {
  const candidates: readonly (ProjectHealthReason & { readonly penalty: number })[] = [
    {
      kind: 'overdueMilestones',
      count: signals.overdueMilestones,
      penalty: signals.overdueMilestones * HEALTH_WEIGHTS.overdueMilestone,
    },
    {
      kind: 'highRisks',
      count: signals.highRisks,
      penalty: signals.highRisks * HEALTH_WEIGHTS.highRisk,
    },
    {
      kind: 'openRisks',
      count: Math.max(signals.openRisks - signals.highRisks, 0),
      penalty: Math.max(signals.openRisks - signals.highRisks, 0) * HEALTH_WEIGHTS.otherOpenRisk,
    },
    {
      kind: 'missedObjectives',
      count: signals.objectivesMissed,
      penalty: signals.objectivesMissed * HEALTH_WEIGHTS.missedObjective,
    },
  ];
  let heaviest: (typeof candidates)[number] | null = null;
  for (const candidate of candidates) {
    if (candidate.penalty > (heaviest?.penalty ?? 0)) heaviest = candidate;
  }
  return heaviest === null ? null : { kind: heaviest.kind, count: heaviest.count };
}

/**
 * The band for a score. A project with no signals at all is `neutral` — there is nothing to assess,
 * and a full-marks green would imply a clean bill of health the data does not support.
 */
export function bandFor(signals: ProjectHealthSignals, score: number): ProjectHealthBand {
  const hasSignal =
    signals.overdueMilestones > 0 || signals.openRisks > 0 || signals.objectivesTotal > 0;
  if (!hasSignal) return 'neutral';
  if (score >= HEALTH_BANDS.green) return 'green';
  if (score >= HEALTH_BANDS.amber) return 'amber';
  return 'red';
}

/** A `Date` as the `YYYY-MM-DD` UTC calendar day, to compare against the `DATE`-typed `due_on`. */
function toCalendarDay(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}
