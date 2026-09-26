import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetingSeries } from '../../common/database/schema.js';
import type { MeetingSeriesRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The meeting-series repository — CAL recurrence (x129), following the `meetings` pattern (0029/x90).
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings repository honours it: every method takes the `TenantQueryRunner` and the `TenantContext`
 * (there is no unscoped overload), the tenant comes from the context and never from the DTO (the
 * input carries no `organizationId`), and every statement carries the tenant predicate and runs
 * through the guard. A series is org-scoped — it names no project — so, unlike a meeting, there is no
 * project predicate; the scope is the tenant alone.
 */

/** The recurrence frequencies, as a runtime list so a controller can validate against it. */
export const MEETING_SERIES_FREQS = ['daily', 'weekly', 'monthly'] as const;
export type MeetingSeriesFreq = (typeof MEETING_SERIES_FREQS)[number];

export class MeetingSeriesNotFoundError extends Error {
  constructor(readonly seriesId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe for
    // another tenant's series tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Meeting series ${seriesId} was not found`);
    this.name = 'MeetingSeriesNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface CreateMeetingSeriesInput {
  readonly title: string;
  readonly freq: MeetingSeriesFreq;
  /** Every-N interval; the service and the engine both require it to be a positive integer. */
  readonly interval: number;
  /** The optional last calendar date, `'YYYY-MM-DD'`, or `null` for an open-ended series. */
  readonly until: string | null;
  /** The person creating the series — the service passes `context.userId`. */
  readonly createdByUserId: string;
}

export interface ListMeetingSeriesOptions {
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class MeetingSeriesRepository {
  /**
   * List a tenant's meeting series, oldest-first by id.
   *
   * The `organization_id` predicate is present; keyset rather than offset pagination on `id`, the
   * way the meetings repository walks pages — `(organization_id, id)` is a key the schema carries and
   * UUIDv7 ids sort in creation order, so the walk is chronological without a second sort column.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListMeetingSeriesOptions,
  ): Promise<readonly MeetingSeriesRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [eq(meetingSeries.organizationId, context.organizationId)];
    if (options.after) predicates.push(gt(meetingSeries.id, options.after));

    return db
      .select()
      .from(meetingSeries)
      .where(and(...predicates))
      .orderBy(asc(meetingSeries.id))
      .limit(limit);
  }

  /**
   * Fetch one series by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row, which is
   * why ADR-0001 exists and this signature has no unscoped form. A cross-tenant id resolves to `null`.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    seriesId: string,
  ): Promise<MeetingSeriesRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingSeries)
      .where(
        and(eq(meetingSeries.organizationId, context.organizationId), eq(meetingSeries.id, seriesId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a meeting series.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateMeetingSeriesInput,
  ): Promise<MeetingSeriesRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(meetingSeries).values({
      id,
      organizationId: context.organizationId,
      title: input.title,
      freq: input.freq,
      interval: input.interval,
      until: input.until,
      createdByUserId: input.createdByUserId,
      createdAt: sql`current_timestamp(3)`,
    });

    return this.requireById(runner, context, id);
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    seriesId: string,
  ): Promise<MeetingSeriesRow> {
    const found = await this.findById(runner, context, seriesId);
    if (!found) throw new MeetingSeriesNotFoundError(seriesId);
    return found;
  }
}
