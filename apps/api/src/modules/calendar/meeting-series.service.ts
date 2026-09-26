import { authorize } from '@tmanage/domain';
import type { Capability, Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingSeriesRepository } from './meeting-series.repository.js';
import type {
  CreateMeetingSeriesInput,
  ListMeetingSeriesOptions,
  MeetingSeriesFreq,
} from './meeting-series.repository.js';
import { expandOccurrences } from './meeting-series.expand.js';
import type { MeetingSeriesRow } from '../../common/database/schema.js';

/**
 * The application service for CAL recurrence (x129) — the authorization decision the route guard
 * cannot make on its own, and the transaction boundary the controller may not open. It follows the
 * `MeetingsService` shape, with one deliberate difference.
 *
 * ## Why the object check uses `meeting.*` directly, not `work.*`
 *
 * `MeetingsService` relation-gates a meeting through the sibling `work.read`/`work.create`
 * capabilities, because a meeting names a project and membership of that project is the real gate. A
 * **series names no project** — it is org-scoped — so there is no project relation to check: the
 * only authorization is the capability ceiling itself. This service therefore calls `authorize()`
 * with `meeting.read`/`meeting.write` against a resource whose `projectId` is `null`; those
 * capabilities are not relation-gated in `authorize.ts`, so the decision reduces to the role ceiling
 * (and active membership and tenant match). A principal whose role lacks the capability is denied,
 * which surfaces as **403** — not the 404 a meeting returns, because there is no project existence to
 * hide behind a not-found.
 *
 * The route's `CapabilityGuard` asks the same coarse `meeting.read`/`meeting.write` question first;
 * this repeats it at the object layer so the decision holds even for a caller reaching the service by
 * some path that bypassed the guard (spec §3: route guards are UX, the evaluator is the control).
 *
 * No audit or outbox event is written yet, like `MeetingsService`'s still-missing ones — a
 * `meeting.*` entry in the `AuditAction` catalog is a domain change out of this slice's scope.
 */

/** What a caller is allowed to see of a series. `organizationId` is deliberately absent (§7). */
export interface MeetingSeriesView {
  readonly id: string;
  readonly title: string;
  /** `daily` | `weekly` | `monthly`. */
  readonly freq: MeetingSeriesFreq;
  /** Every-N interval (a positive integer). */
  readonly interval: number;
  /** The last calendar date the series may recur on, `'YYYY-MM-DD'`, or `null` when open-ended. */
  readonly until: string | null;
  readonly createdByUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7): a column added to
 * `meeting_series` in a future migration is invisible to every caller until someone decides
 * otherwise, and `organization_id` is never echoed into a response body.
 */
function toView(row: MeetingSeriesRow): MeetingSeriesView {
  return {
    id: row.id,
    title: row.title,
    freq: row.freq,
    interval: row.interval,
    until: row.until,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The occurrences a series falls on inside a window — ISO calendar dates, ascending. */
export interface MeetingSeriesOccurrences {
  readonly seriesId: string;
  readonly occurrences: readonly string[];
}

export class MeetingSeriesService {
  constructor(
    private readonly database: TenantDatabase,
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
        // A series is org-scoped: no project relation to check.
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    });
    if (!decision.allowed) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }
  }

  /** Create a series behind `meeting.write`. */
  async create(
    context: TenantContext,
    principal: Principal,
    input: Omit<CreateMeetingSeriesInput, 'createdByUserId'>,
  ): Promise<MeetingSeriesView> {
    this.requireCapability(context, principal, 'meeting.write');

    const row = await this.database.transaction(context, (tx) =>
      this.series.create(tx, context, { ...input, createdByUserId: context.userId }),
    );

    return toView(row);
  }

  /** List the tenant's series behind `meeting.read`, in the repository's deterministic order. */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListMeetingSeriesOptions,
  ): Promise<readonly MeetingSeriesView[]> {
    this.requireCapability(context, principal, 'meeting.read');

    const rows = await this.database.read(context, (runner) =>
      this.series.list(runner, context, options),
    );
    return rows.map(toView);
  }

  /**
   * Expand a series' occurrences inside `[from, to]` behind `meeting.read`.
   *
   * The Known-trap order (FAST-PROTOCOL 19:55): the route names the series by id, so it is resolved
   * **tenant-scoped first** — an unknown or cross-tenant `seriesId` is `null` → 404, before any
   * authorization or expansion, and with no write (this is a pure read). Only then is the capability
   * checked. The expansion itself is pure (`meeting-series.expand.ts`) and anchored at the series'
   * creation date; the window has already been bounded by the controller (max 90 days → 400).
   */
  async occurrences(
    context: TenantContext,
    principal: Principal,
    input: { readonly seriesId: string; readonly from: string; readonly to: string },
  ): Promise<MeetingSeriesOccurrences> {
    const row = await this.database.read(context, (runner) =>
      this.series.findById(runner, context, input.seriesId),
    );
    if (!row) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'series_not_visible');
    }

    this.requireCapability(context, principal, 'meeting.read');

    const occurrences = expandOccurrences(
      {
        freq: row.freq,
        interval: row.interval,
        // The anchor is the series' creation date (its UTC calendar date). An explicit anchor and a
        // time-of-day are part of the deferred per-occurrence override work (NS-13).
        anchor: row.createdAt.toISOString().slice(0, 10),
        until: row.until,
      },
      input.from,
      input.to,
    );

    return { seriesId: row.id, occurrences };
  }
}
