import { authorize, defaultWorkingCalendar, localDateOf } from '@tmanage/domain';
import type { Capability, Principal, WorkingCalendar } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { WorkingCalendarRepository } from '../working-calendar/working-calendar.repository.js';
import { ProjectBaselineRepository } from './baseline.repository.js';
import type { BaselineKind, LiveBaselineItem, NewBaselineItem } from './baseline.repository.js';
import { ProjectsRepository } from './projects.repository.js';
import { bySlipDesc, durationWorkingDays, rowStatus } from './baseline-rules.js';
import type { BaselineRowStatus, FrozenDates } from './baseline-rules.js';
import type {
  ProjectBaselineMilestoneSnapshot,
  ProjectBaselineRow,
  ProjectRow,
} from '../../common/database/schema.js';

/**
 * The application service for PROJ / module 8 (x295) and 53-05 — project baselines: the frozen
 * milestone plan (0162) and, for a 'full' baseline, every live work item's dates (0298).
 *
 * ## The two authorization layers
 *
 * `CapabilityGuard` on the route asks the coarse question: `project.manage` for the writes
 * (create, set current, delete), `work.read` for the reads (list, variance, overlay). This service
 * adds the **relation** check with the project in hand — a member reads only projects they belong
 * to (the `ProjectHealthService.mayRead` pattern), and never writes.
 *
 * ## The Known-trap order
 *
 * Every id the request names is resolved **tenant-scoped before the relation check and any write**:
 * an unknown, another tenant's, or another project's id is a 404, never a foreign-key 500, and the
 * relation failure is a 404 too (a 403 would confirm the row exists to a non-member).
 *
 * ## Frozen once; variance recomputed at read time
 *
 * A snapshot freezes the milestone dates (JSON) and, for 'full', one `project_baseline_items` row
 * per live item — all with the `baseline.created` audit row in ONE transaction, so a failed item
 * insert leaves no baseline behind. Variance is recomputed on every read, in **working days** of
 * the org calendar (53-02). Item titles come from the live row only when the caller may read that
 * item (AUTH-03): otherwise `title: null`, ids only.
 *
 * No outbox event: the baseline path has never emitted one and nothing downstream consumes it. No
 * portal route: the client-safe publish flow is 53-07; `label` and `note` stay on internal routes.
 */

/** 53-05 limits. */
export const MAX_BASELINES_PER_PROJECT = 50;
export const MAX_BASELINE_ITEMS = 5_000;
export const VARIANCE_PAGE_SIZE = 200;
/** Live items read for a variance view (a project above this compares its first N by id). */
const MAX_LIVE_ITEMS_READ = 20_000;
/** `project_baseline_items.item_version` is INT UNSIGNED. */
const INT_UNSIGNED_MAX = 4_294_967_295;

/** A baseline as listed — the snapshot itself is not echoed, only its counts. */
export interface ProjectBaselineView {
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly note: string | null;
  readonly kind: BaselineKind;
  readonly isCurrent: boolean;
  /** How many milestones were frozen into this baseline. */
  readonly milestoneCount: number;
  /** How many work items were frozen ('full'); 0 for a milestones-only baseline. */
  readonly itemCount: number;
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

/** 53-05: one work item's variance against the baseline. */
export interface ProjectBaselineItemVariance {
  readonly workItemId: string;
  /** The live title when the caller may read the item; null otherwise (AUTH-03) or when removed. */
  readonly title: string | null;
  readonly baselineStart: string | null;
  readonly baselineDue: string | null;
  readonly currentStart: string | null;
  readonly currentDue: string | null;
  readonly deltaWorkingDays: number | null;
  readonly status: BaselineRowStatus;
}

export interface ProjectBaselineVarianceSummary {
  readonly slipped: number;
  readonly early: number;
  readonly onTrack: number;
  readonly removed: number;
  readonly added: number;
  /** The largest slip in working days (0 when nothing slipped). */
  readonly maxSlipDays: number;
}

export interface ProjectBaselineVarianceView {
  readonly baselineId: string;
  readonly label: string;
  readonly createdAt: string;
  /** The other baseline compared against, or null when compared to the live plan. */
  readonly againstBaselineId: string | null;
  readonly rows: readonly ProjectBaselineVarianceRow[];
  readonly items: readonly ProjectBaselineItemVariance[];
  readonly summary: ProjectBaselineVarianceSummary;
  readonly nextCursor: string | null;
}

export interface ProjectBaselineOverlayView {
  readonly baselineId: string;
  readonly label: string;
  readonly createdAt: string;
  readonly items: readonly {
    readonly workItemId: string;
    readonly startAt: string | null;
    readonly dueAt: string | null;
  }[];
}

export interface ProjectBaselineServiceOptions {
  readonly audit?: AuditService;
  readonly calendars?: WorkingCalendarRepository;
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

/** An opaque cursor over the slip-ordered variance list. */
export function encodeVarianceCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

/** The offset a cursor names, or null when it is malformed. */
export function decodeVarianceCursor(cursor: string): number | null {
  const match = /^o:(\d{1,9})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match ? Number(match[1]) : null;
}

/** An explicit projection (`25-AUTH-AND-TENANT-ISOLATION` §7): `organization_id` is never echoed. */
function toView(row: ProjectBaselineRow, itemCount: number): ProjectBaselineView {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    note: row.note ?? null,
    kind: row.kind === 'full' ? 'full' : 'milestones',
    isCurrent: Boolean(row.isCurrent),
    milestoneCount: row.snapshot.length,
    itemCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function baselineNotVisible(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'baseline_not_visible');
}

function projectNotVisible(): ApiError {
  return new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
}

export class ProjectBaselineService {
  private readonly calendars: WorkingCalendarRepository;

  constructor(
    private readonly database: TenantDatabase,
    private readonly baselines: ProjectBaselineRepository = new ProjectBaselineRepository(),
    /**
     * Read-only, used to prove the project a baseline names exists **inside this tenant** before the
     * relation check; without it a missing or cross-tenant `projectId` would reach the foreign key.
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    private readonly options: ProjectBaselineServiceOptions = {},
  ) {
    this.calendars = options.calendars ?? new WorkingCalendarRepository();
  }

  /** Resolve the project tenant-scoped and ask `capability` of it, or throw the shared not-found. */
  private async requireProject(
    context: TenantContext,
    principal: Principal,
    projectId: string,
    capability: Capability,
  ): Promise<ProjectRow> {
    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, projectId),
    );
    if (!project) throw projectNotVisible();
    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: project.archivedAt ? 'archived' : 'active',
      },
    }).allowed;
    if (!permitted) throw projectNotVisible();
    return project;
  }

  private mayReadItem(principal: Principal, item: LiveBaselineItem): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: item.organizationId,
        projectId: item.projectId,
        audience: item.audience,
        lifecycle: item.state === 'archived' ? 'archived' : 'active',
      },
    }).allowed;
  }

  /** The org calendar with its holidays, else the default calendar in the org's zone. */
  private async calendarOf(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<WorkingCalendar> {
    const row = await this.calendars.findCalendar(runner, context, null);
    if (!row) {
      return defaultWorkingCalendar(await this.calendars.organizationTimeZone(runner, context));
    }
    const holidays = await this.calendars.listHolidays(runner, context, row.id);
    return {
      workingDaysMask: Number(row.workingDaysMask),
      dayStart: String(row.dayStart),
      dayEnd: String(row.dayEnd),
      timeZone: row.timeZone,
      holidays: new Set(holidays.map((h) => h.date)),
    };
  }

  private async requireBaselineOf(
    runner: TenantQueryRunner,
    context: TenantContext,
    projectId: string,
    baselineId: string,
  ): Promise<ProjectBaselineRow> {
    const found = await this.baselines.findById(runner, context, baselineId);
    if (!found || found.projectId !== projectId) throw baselineNotVisible();
    return found;
  }

  /**
   * Freeze the current plan as a named baseline: the milestone dates always, and for `kind: 'full'`
   * one row per live work item. Refused with 422 at 50 baselines per project or above 5,000 items.
   * Rows and the audit entry commit together or not at all.
   */
  async snapshot(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly projectId: string;
      readonly label: string;
      readonly note?: string | null;
      readonly kind?: BaselineKind;
    },
  ): Promise<ProjectBaselineView> {
    await this.requireProject(context, principal, input.projectId, 'project.manage');
    const kind = input.kind ?? 'full';

    const { row, itemCount } = await this.database.transaction(context, async (tx) => {
      const existing = await this.baselines.countForProject(tx, context, input.projectId);
      if (existing >= MAX_BASELINES_PER_PROJECT) {
        throw new ApiError(
          422,
          'validation_failed',
          `A project keeps at most ${MAX_BASELINES_PER_PROJECT} baselines; delete an old one first`,
          [{ field: 'baseline', message: 'baseline_limit' }],
          'baseline_limit',
        );
      }

      let items: readonly NewBaselineItem[] = [];
      if (kind === 'full') {
        const live = await this.baselines.listLiveItems(
          tx,
          context,
          input.projectId,
          MAX_BASELINE_ITEMS + 1,
        );
        if (live.length > MAX_BASELINE_ITEMS) {
          throw new ApiError(
            422,
            'validation_failed',
            `A baseline can freeze at most ${MAX_BASELINE_ITEMS} work items`,
            [{ field: 'baseline', message: 'baseline_too_large' }],
            'baseline_too_large',
          );
        }
        const calendar = await this.calendarOf(tx, context);
        items = live.map((item) => {
          const startAt = item.startAt ? localDateOf(item.startAt, calendar.timeZone) : null;
          const dueAt = item.dueAt ? localDateOf(item.dueAt, calendar.timeZone) : null;
          return {
            workItemId: item.id,
            startAt,
            dueAt,
            durationWorkingDays: durationWorkingDays(startAt, dueAt, calendar),
            itemVersion: Math.min(Number(item.version), INT_UNSIGNED_MAX),
          };
        });
      }

      const milestones = await this.baselines.listMilestones(tx, context, input.projectId);
      const snapshot: readonly ProjectBaselineMilestoneSnapshot[] = milestones.map((milestone) => ({
        milestoneId: milestone.id,
        targetDate: milestone.dueOn ?? null,
      }));
      const created = await this.baselines.create(tx, context, {
        projectId: input.projectId,
        label: input.label,
        snapshot,
        createdBy: context.userId,
        kind,
        note: input.note ?? null,
      });
      if (items.length > 0) await this.baselines.insertItems(tx, context, created.id, items);
      await this.options.audit?.record(tx, context, {
        action: 'baseline.created',
        result: 'allowed',
        objectId: created.id,
        actorUserId: context.userId,
        metadata: { kind, item_count: items.length, milestone_count: snapshot.length },
      });
      return { row: created, itemCount: items.length };
    });
    return toView(row, itemCount);
  }

  /** List a project's baselines, newest first — readable by any member of the project. */
  async list(
    context: TenantContext,
    principal: Principal,
    options: { readonly projectId: string; readonly limit?: number },
  ): Promise<readonly ProjectBaselineView[]> {
    await this.requireProject(context, principal, options.projectId, 'work.read');
    const { rows, counts } = await this.database.read(context, async (runner) => {
      const found = await this.baselines.list(runner, context, options);
      const itemCounts = await this.baselines.itemCounts(
        runner,
        context,
        found.map((row) => row.id),
      );
      return { rows: found, counts: itemCounts };
    });
    return rows.map((row) => toView(row, counts.get(row.id) ?? 0));
  }

  /** Make a baseline the project's one current baseline (the timeline overlay). */
  async activate(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly baselineId: string },
  ): Promise<ProjectBaselineView> {
    await this.requireProject(context, principal, input.projectId, 'project.manage');
    const row = await this.database.transaction(context, async (tx) => {
      await this.requireBaselineOf(tx, context, input.projectId, input.baselineId);
      await this.baselines.setCurrent(tx, context, input.projectId, input.baselineId);
      await this.options.audit?.record(tx, context, {
        action: 'baseline.activated',
        result: 'allowed',
        objectId: input.baselineId,
        actorUserId: context.userId,
        metadata: {},
      });
      return this.baselines.requireById(tx, context, input.baselineId);
    });
    const counts = await this.database.read(context, (runner) =>
      this.baselines.itemCounts(runner, context, [row.id]),
    );
    return toView(row, counts.get(row.id) ?? 0);
  }

  /**
   * The variance view: milestone rows (calendar days, as before) and, for item baselines, every
   * item's working-day slip — against the live plan, or against another baseline (`against`).
   */
  async variance(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly projectId: string;
      readonly baselineId: string;
      readonly against?: string;
      readonly cursor?: string;
    },
  ): Promise<ProjectBaselineVarianceView> {
    await this.requireProject(context, principal, input.projectId, 'work.read');
    const offset = input.cursor === undefined ? 0 : decodeVarianceCursor(input.cursor);
    if (offset === null) {
      throw new ApiError(400, 'validation_failed', 'The cursor is invalid', [
        { field: 'cursor', message: 'must be a cursor returned by this route' },
      ]);
    }

    const loaded = await this.database.read(context, async (runner) => {
      const baseline = await this.requireBaselineOf(
        runner,
        context,
        input.projectId,
        input.baselineId,
      );
      const other =
        input.against === undefined
          ? null
          : await this.requireBaselineOf(runner, context, input.projectId, input.against);
      return {
        baseline,
        other,
        milestones: await this.baselines.listMilestones(runner, context, input.projectId),
        frozen: await this.baselines.listItems(runner, context, baseline.id),
        otherItems: other ? await this.baselines.listItems(runner, context, other.id) : null,
        live: await this.baselines.listLiveItems(
          runner,
          context,
          input.projectId,
          MAX_LIVE_ITEMS_READ,
        ),
        calendar: await this.calendarOf(runner, context),
      };
    });
    const { baseline, other, milestones, frozen, otherItems, live, calendar } = loaded;

    // ---- milestones (unchanged semantics; `against` compares to the other frozen plan) ----
    const titleOf = new Map(milestones.map((m) => [m.id, m.title]));
    const currentMilestones = other
      ? other.snapshot.map((e) => ({ id: e.milestoneId, date: e.targetDate }))
      : milestones.map((m) => ({ id: m.id, date: m.dueOn ?? null }));
    const frozenById = new Map(baseline.snapshot.map((e) => [e.milestoneId, e.targetDate]));
    const rows: ProjectBaselineVarianceRow[] = [];
    const seen = new Set<string>();
    for (const current of currentMilestones) {
      seen.add(current.id);
      const baselineDate = frozenById.get(current.id) ?? null;
      rows.push({
        milestoneId: current.id,
        title: titleOf.get(current.id) ?? null,
        baselineDate,
        currentDate: current.date,
        deltaDays: computeDeltaDays(baselineDate, current.date),
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

    // ---- items (53-05) ----
    const liveById = new Map(live.map((item) => [item.id, item]));
    const frozenItems = new Map<string, FrozenDates>(
      frozen.map((f) => [f.workItemId, { startAt: f.startAt, dueAt: f.dueAt }]),
    );
    const currentItems = new Map<string, FrozenDates>(
      otherItems
        ? otherItems.map((f) => [f.workItemId, { startAt: f.startAt, dueAt: f.dueAt }])
        : live.map((item) => [
            item.id,
            {
              startAt: item.startAt ? localDateOf(item.startAt, calendar.timeZone) : null,
              dueAt: item.dueAt ? localDateOf(item.dueAt, calendar.timeZone) : null,
            },
          ]),
    );
    const ids = new Set<string>([...frozenItems.keys(), ...currentItems.keys()]);
    const all: ProjectBaselineItemVariance[] = [];
    for (const workItemId of ids) {
      const was = frozenItems.get(workItemId) ?? null;
      const now = currentItems.get(workItemId) ?? null;
      const variance = rowStatus(was, now, calendar);
      const liveRow = liveById.get(workItemId);
      all.push({
        workItemId,
        title: liveRow && this.mayReadItem(principal, liveRow) ? liveRow.title : null,
        baselineStart: was?.startAt ?? null,
        baselineDue: was?.dueAt ?? null,
        currentStart: now?.startAt ?? null,
        currentDue: now?.dueAt ?? null,
        deltaWorkingDays: variance.deltaWorkingDays,
        status: variance.status,
      });
    }
    all.sort(bySlipDesc);

    const summary = { slipped: 0, early: 0, onTrack: 0, removed: 0, added: 0, maxSlipDays: 0 };
    for (const item of all) {
      if (item.status === 'on_track') summary.onTrack += 1;
      else summary[item.status] += 1;
      if (item.deltaWorkingDays !== null && item.deltaWorkingDays > summary.maxSlipDays) {
        summary.maxSlipDays = item.deltaWorkingDays;
      }
    }
    const page = all.slice(offset, offset + VARIANCE_PAGE_SIZE);
    const next = offset + VARIANCE_PAGE_SIZE;

    return {
      baselineId: baseline.id,
      label: baseline.label,
      createdAt: baseline.createdAt.toISOString(),
      againstBaselineId: other?.id ?? null,
      rows,
      items: page,
      summary,
      nextCursor: next < all.length ? encodeVarianceCursor(next) : null,
    };
  }

  /** The current baseline's frozen item dates, for the Gantt ghost bars; 404 when none is current. */
  async overlay(
    context: TenantContext,
    principal: Principal,
    projectId: string,
  ): Promise<ProjectBaselineOverlayView> {
    await this.requireProject(context, principal, projectId, 'work.read');
    const found = await this.database.read(context, async (runner) => {
      const current = await this.baselines.findCurrent(runner, context, projectId);
      if (!current) return null;
      return { current, items: await this.baselines.listItems(runner, context, current.id) };
    });
    if (!found) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'baseline_not_current');
    }
    return {
      baselineId: found.current.id,
      label: found.current.label,
      createdAt: found.current.createdAt.toISOString(),
      items: found.items.map((item) => ({
        workItemId: item.workItemId,
        startAt: item.startAt,
        dueAt: item.dueAt,
      })),
    };
  }

  /**
   * Discard a baseline (its frozen items go with it by cascade). The current baseline is refused
   * with 409 — make another one current first.
   */
  async discard(
    context: TenantContext,
    principal: Principal,
    input: { readonly projectId: string; readonly baselineId: string },
  ): Promise<void> {
    await this.requireProject(context, principal, input.projectId, 'project.manage');

    await this.database.transaction(context, async (tx) => {
      const found = await this.requireBaselineOf(tx, context, input.projectId, input.baselineId);
      if (found.isCurrent) {
        throw new ApiError(
          409,
          'conflict',
          'The current baseline cannot be deleted; make another baseline current first',
          [{ field: 'baselineId', message: 'baseline_is_current' }],
          'baseline_is_current',
        );
      }
      await this.baselines.delete(tx, context, input.baselineId);
      await this.options.audit?.record(tx, context, {
        action: 'baseline.deleted',
        result: 'allowed',
        objectId: input.baselineId,
        actorUserId: context.userId,
        metadata: { kind: found.kind },
      });
    });
  }
}
