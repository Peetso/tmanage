import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import {
  MEETING_OCCURRENCE_OVERRIDE_STATUS,
  meetingOccurrenceOverrides,
} from '../../common/database/schema.js';
import type { MeetingOccurrenceOverrideRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The meeting-occurrence-override repository — CAL per-occurrence override (x213), following the
 * `meeting_series` pattern (0043/x129).
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * series repository honours it: every method takes the `TenantQueryRunner` and the `TenantContext`
 * (no unscoped overload), the tenant comes from the context and never from the DTO (the input carries
 * no `organizationId`), and every statement carries the tenant predicate and runs through the guard.
 * An override is org-scoped like its series — it names no project — so the scope is the tenant alone.
 */

/** The override kinds, as a runtime list so a controller can validate against it. */
export const MEETING_OCCURRENCE_OVERRIDE_STATUSES = MEETING_OCCURRENCE_OVERRIDE_STATUS;
export type MeetingOccurrenceOverrideStatus = (typeof MEETING_OCCURRENCE_OVERRIDE_STATUSES)[number];

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for a
 * request body to populate and no code path that could prefer one over the other.
 */
export interface UpsertOccurrenceOverrideInput {
  readonly seriesId: string;
  /** The ORIGINAL occurrence date being overridden, `'YYYY-MM-DD'`. */
  readonly occurrenceDate: string;
  readonly status: MeetingOccurrenceOverrideStatus;
  /** For a `moved` override: the new calendar date, `'YYYY-MM-DD'`, or `null`. */
  readonly newDate: string | null;
  /** For a `moved` override: an optional new time-of-day, `'HH:MM:SS'`, or `null`. */
  readonly newStartTime: string | null;
  /** For a `moved` override: an optional new title, or `null`. */
  readonly newTitle: string | null;
  /** The person writing the override — the service passes `context.userId`. */
  readonly createdByUserId: string;
}

export class MeetingOccurrenceOverrideRepository {
  /**
   * Upsert the override for one (series, original occurrence date). The unique key
   * `(organization_id, series_id, occurrence_date)` is the conflict target: a second write for the
   * same date replaces the first rather than duplicating it, which is what `POST` on a fixed date
   * means. `organization_id` comes from the context, never from `input`.
   */
  async upsert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertOccurrenceOverrideInput,
  ): Promise<MeetingOccurrenceOverrideRow> {
    await tenantDrizzle(runner)
      .insert(meetingOccurrenceOverrides)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        seriesId: input.seriesId,
        occurrenceDate: input.occurrenceDate,
        status: input.status,
        newDate: input.newDate,
        newStartTime: input.newStartTime,
        newTitle: input.newTitle,
        createdByUserId: input.createdByUserId,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          status: input.status,
          newDate: input.newDate,
          newStartTime: input.newStartTime,
          newTitle: input.newTitle,
          updatedAt: sql`current_timestamp(3)`,
        },
      });

    const row = await this.findByDate(runner, context, input.seriesId, input.occurrenceDate);
    if (!row) throw new Error('meeting_occurrence_overrides row vanished immediately after upsert');
    return row;
  }

  /** The override for one (series, original occurrence date) within the acting tenant, or `null`. */
  async findByDate(
    runner: TenantQueryRunner,
    context: TenantContext,
    seriesId: string,
    occurrenceDate: string,
  ): Promise<MeetingOccurrenceOverrideRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(meetingOccurrenceOverrides)
      .where(
        and(
          eq(meetingOccurrenceOverrides.organizationId, context.organizationId),
          eq(meetingOccurrenceOverrides.seriesId, seriesId),
          eq(meetingOccurrenceOverrides.occurrenceDate, occurrenceDate),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Every override a series carries in this tenant, oldest occurrence-date first for a stable merge. */
  async listBySeries(
    runner: TenantQueryRunner,
    context: TenantContext,
    seriesId: string,
  ): Promise<readonly MeetingOccurrenceOverrideRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(meetingOccurrenceOverrides)
      .where(
        and(
          eq(meetingOccurrenceOverrides.organizationId, context.organizationId),
          eq(meetingOccurrenceOverrides.seriesId, seriesId),
        ),
      )
      .orderBy(asc(meetingOccurrenceOverrides.occurrenceDate));
  }

  /**
   * Delete the override for one (series, original occurrence date), restoring the base rule there.
   * Scoped by `(organization_id, series_id, occurrence_date)`, so a date with no override removes
   * nothing and the service answers 404.
   */
  async deleteByDate(
    runner: TenantQueryRunner,
    context: TenantContext,
    seriesId: string,
    occurrenceDate: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(meetingOccurrenceOverrides)
      .where(
        and(
          eq(meetingOccurrenceOverrides.organizationId, context.organizationId),
          eq(meetingOccurrenceOverrides.seriesId, seriesId),
          eq(meetingOccurrenceOverrides.occurrenceDate, occurrenceDate),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
