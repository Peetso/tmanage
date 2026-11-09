import { and, asc, eq, gt, gte, isNull, lt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetings } from '../../common/database/schema.js';
import type { MeetingRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { formatReminders } from './meeting-options.js';
import type { MeetingOptionsInput } from './meeting-options.js';

/**
 * The meetings repository — CAL-01 / MTG-01 (x90), following the `projects` pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * projects repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` for the current unit of work and the `TenantContext`. There is no
 *    overload without a context, so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateMeetingInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through
 *    the guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state, so a
 * command composes several writes on one connection inside one transaction that
 * `TenantDatabase.transaction()` owns.
 */

export class MeetingNotFoundError extends Error {
  constructor(readonly meetingId: string) {
    // No organization id in the message: a not-found returned to a caller must not let a probe
    // for another tenant's meeting tell "does not exist" from "exists elsewhere" (spec §4).
    super(`Meeting ${meetingId} was not found`);
    this.name = 'MeetingNotFoundError';
  }
}

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for
 * a request body to populate and no code path that could prefer one over the other.
 */
export interface CreateMeetingInput {
  readonly projectId: string;
  readonly title: string;
  /** A point in time, stored as a UTC instant (the column is `DATETIME(3)`). */
  readonly startsAt: Date;
  /** Audit gap 8 (0213): optional end instant; the service has already checked it is after the start. */
  readonly endsAt?: Date | null;
  readonly agendaNote?: string | null;
  /** The person creating the meeting — the service passes `context.userId`. */
  readonly createdByUserId: string;
  /** 0237. The event options; absent ones take the column defaults. */
  readonly options?: MeetingOptionsInput;
}

/**
 * Audit gap 8 (COL-06/09): the editable fields of a meeting. An absent field is left alone; `null`
 * clears an optional one. Identity (`organizationId`/`projectId`/`createdByUserId`) has no field here
 * and is pinned by 0029's trigger besides.
 */
export interface UpdateMeetingInput {
  readonly title?: string;
  readonly startsAt?: Date;
  readonly endsAt?: Date | null;
  readonly agendaNote?: string | null;
  /** 0237. The event options; an absent one is left alone. */
  readonly options?: MeetingOptionsInput;
  /** 0237. Set by cancel; a pull from the provider may set it too. */
  readonly cancelledAt?: Date | null;
  /** Remove a cancelled meeting (live check a6f66e47): soft delete, who removed it is kept. */
  readonly deleted?: { readonly at: Date; readonly byUserId: string };
}

/** 0237. Every meeting of the organization in a time window (the All meetings calendar). */
export interface ListMeetingWindowOptions {
  readonly from: Date;
  readonly to: Date;
  readonly includeCancelled: boolean;
  readonly limit: number;
}

/** The column values of the options that are set; `undefined` ones are left out. */
function optionColumns(options: MeetingOptionsInput | undefined): Record<string, unknown> {
  if (!options) return {};
  const out: Record<string, unknown> = {};
  const copy = [
    'allDay',
    'timeZone',
    'location',
    'recurrenceRrule',
    'visibility',
    'showAs',
    'colorId',
    'conference',
    'guestsCanModify',
    'guestsCanInviteOthers',
    'guestsCanSeeOthers',
  ] as const;
  for (const key of copy) if (options[key] !== undefined) out[key] = options[key];
  if (options.reminders !== undefined) out['reminders'] = formatReminders(options.reminders);
  return out;
}

export interface ListMeetingsOptions {
  /** Required: this slice lists one project's meetings, never a whole tenant's. */
  readonly projectId: string;
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class MeetingsRepository {
  /**
   * List one project's meetings, within the acting tenant.
   *
   * Both `organization_id` and `project_id` predicates are present. Keyset rather than offset
   * pagination on `id`, the way the projects repository walks pages: `(organization_id, id)` is
   * a key the schema carries, and UUIDv7 ids sort in creation order so the walk is chronological
   * without a second sort column.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListMeetingsOptions,
  ): Promise<readonly MeetingRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(meetings.organizationId, context.organizationId),
      eq(meetings.projectId, options.projectId),
      // PA-03 (0245): a soft-deleted meeting leaves the list.
      isNull(meetings.deletedAt),
    ];
    if (options.after) predicates.push(gt(meetings.id, options.after));

    return db
      .select()
      .from(meetings)
      .where(and(...predicates))
      .orderBy(asc(meetings.id))
      .limit(limit);
  }

  /**
   * 0237. Every meeting of the tenant starting inside `[from, to)`, soonest first — the All meetings
   * calendar. The relation filter (which projects the caller may read) is the service's, after the
   * read, for the reason `MeetingsService.list` gives. `ix_meetings_org_project` does not lead with
   * `starts_at`, so the window is bounded by `limit` (the service caps it at 500).
   */
  async listWindow(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListMeetingWindowOptions,
  ): Promise<readonly MeetingRow[]> {
    const predicates = [
      eq(meetings.organizationId, context.organizationId),
      gte(meetings.startsAt, options.from),
      lt(meetings.startsAt, options.to),
      // PA-03 (0245): a soft-deleted meeting leaves the list.
      isNull(meetings.deletedAt),
    ];
    if (!options.includeCancelled) predicates.push(isNull(meetings.cancelledAt));
    return tenantDrizzle(runner)
      .select()
      .from(meetings)
      .where(and(...predicates))
      .orderBy(asc(meetings.startsAt), asc(meetings.id))
      .limit(options.limit);
  }

  /**
   * Fetch one meeting by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row,
   * which is why ADR-0001 exists and this signature has no unscoped form.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<MeetingRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.organizationId, context.organizationId), eq(meetings.id, meetingId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<MeetingRow> {
    const found = await this.findById(runner, context, meetingId);
    if (!found) throw new MeetingNotFoundError(meetingId);
    return found;
  }

  /**
   * Create a meeting.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`) so a command knows it before the insert
   * commits. `organization_id` comes from the context, never from `input`. The project is *not*
   * checked to belong to the tenant here: `fk_meetings_project_tenant` is a composite foreign
   * key including `organization_id`, so the database refuses a project from another tenant — a
   * service-layer check would duplicate a guarantee that already cannot be bypassed.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateMeetingInput,
  ): Promise<MeetingRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(meetings).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      projectId: input.projectId,
      title: input.title,
      startsAt: input.startsAt,
      endsAt: input.endsAt ?? null,
      agendaNote: input.agendaNote ?? null,
      createdByUserId: input.createdByUserId,
      ...optionColumns(input.options),
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries server-generated timestamps, and
    // returning a hand-assembled object would let the two disagree.
    return this.requireById(runner, context, id);
  }

  /**
   * Edit a meeting in place (audit gap 8). The `WHERE` carries `organization_id` and `id`, so a row
   * of another tenant matches nothing; the service resolved the meeting scoped before calling this.
   */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    input: UpdateMeetingInput,
  ): Promise<MeetingRow> {
    const db = tenantDrizzle(runner);
    await db
      .update(meetings)
      .set({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
        ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
        ...(input.agendaNote !== undefined ? { agendaNote: input.agendaNote } : {}),
        ...(input.cancelledAt !== undefined ? { cancelledAt: input.cancelledAt } : {}),
        ...(input.deleted !== undefined
          ? { deletedAt: input.deleted.at, deletedByUserId: input.deleted.byUserId }
          : {}),
        ...optionColumns(input.options),
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(and(eq(meetings.organizationId, context.organizationId), eq(meetings.id, meetingId)));
    return this.requireById(runner, context, meetingId);
  }
}
