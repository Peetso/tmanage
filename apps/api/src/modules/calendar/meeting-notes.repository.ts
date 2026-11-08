import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetingNotes } from '../../common/database/schema.js';
import type { MeetingNoteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The meeting-notes repository — CAL-01 / MTG-01 second slice (x105), following the `meetings`
 * pattern.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the
 *    `TenantQueryRunner` for the current unit of work and the `TenantContext`. There is no
 *    overload without a context, so a caller that never established a tenant is a type error.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateMeetingNoteInput} has no
 *    `organizationId` field, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through
 *    the guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

/** The two kinds a captured record can be. A decision is a note with `kind='decision'`. */
export type MeetingNoteKind = 'note' | 'decision';

/**
 * Note what is absent: `organizationId`. It is taken from the context, so there is no field for
 * a request body to populate and no code path that could prefer one over the other. `meetingId`
 * is resolved tenant-scoped by the service before the write, and the composite foreign key
 * `fk_meeting_notes_meeting_tenant` refuses a meeting from another tenant besides.
 */
export interface CreateMeetingNoteInput {
  readonly meetingId: string;
  readonly kind: MeetingNoteKind;
  readonly body: string;
  /** The person capturing the note — the service passes `context.userId`. */
  readonly authorUserId: string;
}

export interface ListMeetingNotesOptions {
  /** Required: this slice lists one meeting's notes, never a whole tenant's. */
  readonly meetingId: string;
  /** Keyset pagination. Cursors are ids, and the sort is `id` (UUIDv7 ≈ creation order). */
  readonly after?: string;
  readonly limit?: number;
  /**
   * 53-13. `saved` (the default) is the meeting's record; `pending` is the review queue of drafts
   * the customer's own AI submitted over MCP. A pending draft is never part of the record.
   */
  readonly status?: MeetingNoteStatus;
}

/** 53-13 (0326). A note is `saved`; an assistant's draft stays `pending` until a person saves it. */
export type MeetingNoteStatus = 'saved' | 'pending';

/** 53-13. A draft submitted by the member's own assistant over the MCP connector. */
export interface CreateMeetingNoteDraftInput {
  readonly meetingId: string;
  readonly kind: MeetingNoteKind;
  readonly body: string;
  /** The member whose token the assistant used — the service passes `context.userId`. */
  readonly authorUserId: string;
  /** The assistant's own name (e.g. `Claude`), shown to the reviewer as provenance. */
  readonly assistantName: string;
}

/** 53-13. What the reviewer settled on when saving a draft. */
export interface SaveMeetingNoteDraftInput {
  readonly kind: MeetingNoteKind;
  readonly body: string;
  readonly reviewedByUserId: string;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export function effectivePageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

export class MeetingNotesRepository {
  /**
   * List one meeting's notes and decisions, within the acting tenant.
   *
   * Both `organization_id` and `meeting_id` predicates are present. Keyset rather than offset
   * pagination on `id`, the way the meetings repository walks pages: `(organization_id, id)` is a
   * key the schema carries, and UUIDv7 ids sort in creation order so the ordering is
   * deterministic and chronological without a second sort column.
   */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    options: ListMeetingNotesOptions,
  ): Promise<readonly MeetingNoteRow[]> {
    const limit = effectivePageSize(options.limit);
    const db = tenantDrizzle(runner);

    const predicates = [
      eq(meetingNotes.organizationId, context.organizationId),
      eq(meetingNotes.meetingId, options.meetingId),
      eq(meetingNotes.status, options.status ?? 'saved'),
    ];
    if (options.after) predicates.push(gt(meetingNotes.id, options.after));

    return db
      .select()
      .from(meetingNotes)
      .where(and(...predicates))
      .orderBy(asc(meetingNotes.id))
      .limit(limit);
  }

  /**
   * Fetch one note by id, within the acting tenant.
   *
   * No `findById(id)` without a context: on MySQL that would return another customer's row.
   */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    noteId: string,
  ): Promise<MeetingNoteRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingNotes)
      .where(
        and(eq(meetingNotes.organizationId, context.organizationId), eq(meetingNotes.id, noteId)),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Create a note or a decision against a meeting.
   *
   * The id is generated here (UUIDv7, `07-DATA-MODEL`). `organization_id` comes from the context,
   * never from `input`. The meeting is *not* re-checked to belong to the tenant here: the service
   * resolves it tenant-scoped before the write, and `fk_meeting_notes_meeting_tenant` is a
   * composite foreign key including `organization_id`, so the database refuses a meeting from
   * another tenant regardless.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateMeetingNoteInput,
  ): Promise<MeetingNoteRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(meetingNotes).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      meetingId: input.meetingId,
      kind: input.kind,
      body: input.body,
      authorUserId: input.authorUserId,
      createdAt: sql`current_timestamp(3)`,
    });

    // Read back rather than reconstruct: the row now carries the server-generated timestamp.
    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the row was just inserted in this transaction. The scoped read-back is how
      // the created row is returned, and a null here would be a torn write.
      throw new Error(`meeting_note ${id} was not found immediately after insert`);
    }
    return created;
  }
  /**
   * 53-13. Land a draft from the customer's own AI as `pending`, with its provenance. It is not
   * part of the meeting's record (the default `list` reads `saved` only) until a person saves it.
   */
  async createDraft(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateMeetingNoteDraftInput,
  ): Promise<MeetingNoteRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(meetingNotes).values({
      id,
      organizationId: context.organizationId,
      meetingId: input.meetingId,
      kind: input.kind,
      body: input.body,
      authorUserId: input.authorUserId,
      createdAt: sql`current_timestamp(3)`,
      status: 'pending',
      source: 'mcp',
      assistantName: input.assistantName,
      submittedAt: sql`current_timestamp(3)`,
    });
    const created = await this.findById(runner, context, id);
    if (!created) throw new Error(`meeting_note ${id} was not found immediately after insert`);
    return created;
  }

  /**
   * 53-13. Save a pending draft as a normal note with the reviewer's text. Guarded on
   * `status='pending'`, so a draft already saved or discarded changes nothing (returns false);
   * 0326's trigger refuses any change to a saved note besides.
   */
  async saveDraft(
    runner: TenantQueryRunner,
    context: TenantContext,
    noteId: string,
    input: SaveMeetingNoteDraftInput,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const [result] = await db
      .update(meetingNotes)
      .set({
        kind: input.kind,
        body: input.body,
        status: 'saved',
        reviewedByUserId: input.reviewedByUserId,
        reviewedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(meetingNotes.organizationId, context.organizationId),
          eq(meetingNotes.id, noteId),
          eq(meetingNotes.status, 'pending'),
        ),
      );
    return affectedRows(result) > 0;
  }

  /** 53-13. Discard a pending draft: the row is removed; a saved note is never deleted here. */
  async discardDraft(
    runner: TenantQueryRunner,
    context: TenantContext,
    noteId: string,
  ): Promise<boolean> {
    const db = tenantDrizzle(runner);
    const [result] = await db
      .delete(meetingNotes)
      .where(
        and(
          eq(meetingNotes.organizationId, context.organizationId),
          eq(meetingNotes.id, noteId),
          eq(meetingNotes.status, 'pending'),
        ),
      );
    return affectedRows(result) > 0;
  }
}

function affectedRows(result: unknown): number {
  const value = (result as { affectedRows?: unknown } | undefined)?.affectedRows;
  return typeof value === 'number' ? value : 0;
}
