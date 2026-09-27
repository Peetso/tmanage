import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingSeriesRepository } from './meeting-series.repository.js';
import { expandOccurrences } from './meeting-series.expand.js';
import { MeetingOccurrenceOverrideRepository } from './occurrence-override.repository.js';
import type {
  MeetingOccurrenceOverrideStatus,
  UpsertOccurrenceOverrideInput,
} from './occurrence-override.repository.js';
import type { MeetingOccurrenceOverrideRow } from '../../common/database/schema.js';

/**
 * The application service for CAL per-occurrence override (x213) — the authorization decision the
 * route guard cannot make on its own, and the tenant-scope resolution the controller may not do.
 *
 * It follows `MeetingSeriesService`: an override, like its series, is org-scoped (names no project),
 * so the only object authorization is the capability ceiling itself — `authorize()` is called with
 * `meeting.read`/`meeting.write` against a resource whose `projectId` is `null`, which reduces to the
 * role ceiling (and active membership and tenant match). A role lacking the capability is denied,
 * surfacing as **403**; a cross-tenant series is a **404**, resolved *before* the capability so no
 * write and no probe reaches another tenant's rule.
 *
 * ## The Known-trap order
 *
 * Every handler resolves the series **tenant-scoped first** — an unknown or cross-tenant `seriesId`
 * is `null` → 404 — then checks the capability, then (for a write) validates that `:date` is a real
 * occurrence of the series rule before any write. The route's `CapabilityGuard` asks the same coarse
 * question first; the service repeats it so the decision holds even for a caller reaching the service
 * by a path that bypassed the guard (spec §3: route guards are UX, the evaluator is the control).
 */

/**
 * What a caller is allowed to see of an override. `organizationId` is deliberately absent (§7). Paired
 * `Exact` with the web `OccurrenceOverrideView` in the contracts gate.
 */
export interface OccurrenceOverrideView {
  readonly id: string;
  readonly seriesId: string;
  /** The ORIGINAL occurrence date being overridden, `'YYYY-MM-DD'`. */
  readonly occurrenceDate: string;
  readonly status: MeetingOccurrenceOverrideStatus;
  /** For a `moved` override: the new calendar date, `'YYYY-MM-DD'`, else `null`. */
  readonly newDate: string | null;
  /** For a `moved` override: an optional new time-of-day, `'HH:MM:SS'`, else `null`. */
  readonly newStartTime: string | null;
  /** For a `moved` override: an optional new title, else `null`. */
  readonly newTitle: string | null;
  readonly createdByUserId: string;
  /** ISO-8601 instants on the wire. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An explicit projection (§7): `organization_id` is never echoed into a response body. */
function toView(row: MeetingOccurrenceOverrideRow): OccurrenceOverrideView {
  return {
    id: row.id,
    seriesId: row.seriesId,
    occurrenceDate: row.occurrenceDate,
    status: row.status,
    newDate: row.newDate,
    newStartTime: row.newStartTime,
    newTitle: row.newTitle,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** One occurrence after overrides are applied over a base expansion. */
export interface MergedOccurrence {
  /** The effective calendar date, `'YYYY-MM-DD'` — the base date, or a moved override's `newDate`. */
  readonly date: string;
  /** An overridden time-of-day, or `null` when the occurrence keeps the series default. */
  readonly startTime: string | null;
  /** An overridden title, or `null` when the occurrence keeps the series title. */
  readonly title: string | null;
  /** The original date this occurrence was moved from, or `null` when it was not moved. */
  readonly movedFrom: string | null;
}

/** The subset of an override the merge needs — a row, a view, or any shape carrying these fields. */
export interface OverrideForMerge {
  readonly occurrenceDate: string;
  readonly status: MeetingOccurrenceOverrideStatus;
  readonly newDate: string | null;
  readonly newStartTime: string | null;
  readonly newTitle: string | null;
}

/**
 * Apply per-occurrence overrides over a base expansion, deterministically (x213 — the merge x127/x212
 * grids consume).
 *
 * A pure function of its arguments: for each base occurrence date, a `cancelled` override drops it and
 * a `moved` override replaces its date (and may carry a new time/title); a date with no override is
 * kept unchanged. The result is sorted ascending by effective date, tie-broken by the original date,
 * so two overrides that land on the same day order stably regardless of input order. An override whose
 * `occurrenceDate` is not in the base window is ignored — it decorates a date the caller did not ask
 * for.
 */
export function applyOverrides(
  base: readonly string[],
  overrides: readonly OverrideForMerge[],
): readonly MergedOccurrence[] {
  const byDate = new Map(overrides.map((o) => [o.occurrenceDate, o]));
  const merged: MergedOccurrence[] = [];
  for (const date of base) {
    const override = byDate.get(date);
    if (!override) {
      merged.push({ date, startTime: null, title: null, movedFrom: null });
      continue;
    }
    if (override.status === 'cancelled') continue;
    merged.push({
      date: override.newDate ?? date,
      startTime: override.newStartTime,
      title: override.newTitle,
      movedFrom: date,
    });
  }
  return merged.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    const am = a.movedFrom ?? '';
    const bm = b.movedFrom ?? '';
    return am < bm ? -1 : am > bm ? 1 : 0;
  });
}

export class OccurrenceOverrideService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly overrides: MeetingOccurrenceOverrideRepository = new MeetingOccurrenceOverrideRepository(),
    private readonly series: MeetingSeriesRepository = new MeetingSeriesRepository(),
  ) {}

  /** Throw 403 unless the principal's ceiling includes `capability` in the acting tenant. */
  private requireCapability(
    context: TenantContext,
    principal: Principal,
    capability: Capability,
  ): void {
    const decision = authorize({
      principal,
      capability,
      resource: {
        organizationId: context.organizationId,
        // An override, like its series, is org-scoped: no project relation to check.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!decision.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
  }

  /**
   * Resolve the series tenant-scoped, or 404. The Known-trap order: called first in every handler so
   * a cross-tenant or unknown `seriesId` is a 404 with no read of another tenant's rule and no write,
   * before the capability check. Returns the row so a write can validate `:date` against its rule.
   */
  private async resolveSeriesOrThrow(context: TenantContext, seriesId: string) {
    const row = await this.database.read(context, (runner) =>
      this.series.findById(runner, context, seriesId),
    );
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'series_not_visible');
    }
    return row;
  }

  /**
   * Whether `date` is a real occurrence of the series rule. Reuses the pure expansion engine over a
   * one-day window `[date, date]`: the date is an occurrence iff the rule falls on it. The anchor is
   * the series' creation date, matching `MeetingSeriesService.occurrences`.
   */
  private isOccurrenceDate(
    series: Awaited<ReturnType<OccurrenceOverrideService['resolveSeriesOrThrow']>>,
    date: string,
  ): boolean {
    const expanded = expandOccurrences(
      {
        freq: series.freq,
        interval: series.interval,
        anchor: series.createdAt.toISOString().slice(0, 10),
        until: series.until,
      },
      date,
      date,
    );
    return expanded.length === 1;
  }

  /** Read the override for one occurrence date behind `meeting.read`, or 404. */
  async get(
    context: TenantContext,
    principal: Principal,
    input: { readonly seriesId: string; readonly occurrenceDate: string },
  ): Promise<OccurrenceOverrideView> {
    await this.resolveSeriesOrThrow(context, input.seriesId);
    this.requireCapability(context, principal, 'meeting.read');

    const row = await this.database.read(context, (runner) =>
      this.overrides.findByDate(runner, context, input.seriesId, input.occurrenceDate),
    );
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'override_not_found');
    }
    return toView(row);
  }

  /**
   * Upsert the override for one occurrence date behind `meeting.write`.
   *
   * Series resolved tenant-scoped first (404), then the capability (403), then `:date` is validated
   * against the series rule (a non-occurrence date is a 400 — there is nothing to override there)
   * before any write. Coherence of the move fields against `status` is the controller's job.
   */
  async upsert(
    context: TenantContext,
    principal: Principal,
    input: {
      readonly seriesId: string;
      readonly occurrenceDate: string;
      readonly status: MeetingOccurrenceOverrideStatus;
      readonly newDate: string | null;
      readonly newStartTime: string | null;
      readonly newTitle: string | null;
    },
  ): Promise<OccurrenceOverrideView> {
    const series = await this.resolveSeriesOrThrow(context, input.seriesId);
    this.requireCapability(context, principal, 'meeting.write');

    if (!this.isOccurrenceDate(series, input.occurrenceDate)) {
      throw new ApiError(400, 'validation_failed', 'The date is not an occurrence of this series', [
        { field: 'date', message: 'must fall on a date the series recurs on' },
      ]);
    }

    const write: UpsertOccurrenceOverrideInput = {
      seriesId: input.seriesId,
      occurrenceDate: input.occurrenceDate,
      status: input.status,
      newDate: input.newDate,
      newStartTime: input.newStartTime,
      newTitle: input.newTitle,
      createdByUserId: context.userId,
    };
    const row = await this.database.transaction(context, (tx) =>
      this.overrides.upsert(tx, context, write),
    );
    return toView(row);
  }

  /**
   * Remove the override for one occurrence date behind `meeting.write`, restoring the base rule there.
   *
   * Series resolved tenant-scoped first (404), then the capability (403). A date with no override
   * removes nothing and is a 404 — there was no exception to restore.
   */
  async remove(
    context: TenantContext,
    principal: Principal,
    input: { readonly seriesId: string; readonly occurrenceDate: string },
  ): Promise<void> {
    await this.resolveSeriesOrThrow(context, input.seriesId);
    this.requireCapability(context, principal, 'meeting.write');

    const removed = await this.database.transaction(context, (tx) =>
      this.overrides.deleteByDate(tx, context, input.seriesId, input.occurrenceDate),
    );
    if (!removed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'override_not_found');
    }
  }
}
