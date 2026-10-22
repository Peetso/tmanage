import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import type {
  CreateMeetingInput,
  ListMeetingsOptions,
  UpdateMeetingInput,
} from './meetings.repository.js';
import type { MeetingAttendeesRepository } from './meeting-attendees.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import { MeetingNotesRepository } from './meeting-notes.repository.js';
import type {
  CreateMeetingNoteInput,
  ListMeetingNotesOptions,
} from './meeting-notes.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { MeetingNoteRow, MeetingRow } from '../../common/database/schema.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';

/**
 * The application service for CAL-01 / MTG-01 (x90) — the object-level decision the route guard
 * cannot make, and the transaction boundary the controller may not open. It follows the
 * `ProjectsService` shape.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse question `meeting.read` / `meeting.write`: does
 * this role's ceiling include the capability at all. That is all a guard can honestly answer,
 * because no object has been loaded. This service adds the **relation** check with the row's
 * project in hand — an internal member without organization-wide scope reads and writes only
 * the projects they belong to.
 *
 * That relation check is expressed with the sibling `work.read` / `work.create` capabilities
 * rather than with `meeting.*`. It is exact, not a shortcut: `meeting.read` was declared as a
 * ceiling-mirror of `work.read` and `meeting.write` of `work.create` (see
 * `packages/domain/src/policies/capabilities.ts`), so the two are equal by construction for
 * every role, and `work.*` is what `authorize()` already relation-gates. Relation-gating
 * `meeting.*` directly in `authorize.ts` would be an edit to the security core this slice does
 * not need; a later slice may make it so. Recorded as a decision in the x90 report.
 *
 * No audit event is written yet — like `ProjectsService`'s still-missing outbox event, the
 * audit action for a meeting is a follow-up (it needs a `meeting.*` entry in the `AuditAction`
 * catalog, a domain change out of this slice's scope).
 */

/** What a caller is allowed to see of a meeting. `organizationId` is deliberately absent. */
export interface MeetingView {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** An ISO-8601 instant on the wire. */
  readonly startsAt: string;
  /** Audit gap 8 (0213): an ISO-8601 instant, or null when no end was recorded. */
  readonly endsAt: string | null;
  readonly agendaNote: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * An explicit projection, not a serialised row (`25-AUTH-AND-TENANT-ISOLATION` §7). Listing the
 * fields means a column added to `meetings` in a future migration is invisible to every caller
 * until someone decides otherwise. `organization_id` is never echoed into a response body.
 */
function toView(row: MeetingRow): MeetingView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    agendaNote: row.agendaNote,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What a caller is allowed to see of a captured note or decision. `organizationId` is
 * deliberately absent (`25-AUTH-AND-TENANT-ISOLATION` §7); `meetingId` is the parent already in
 * the caller's hand from the route.
 */
export interface MeetingNoteView {
  readonly id: string;
  readonly meetingId: string;
  /** `note` or `decision`. */
  readonly kind: 'note' | 'decision';
  readonly body: string;
  readonly authorUserId: string;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

function toNoteView(row: MeetingNoteRow): MeetingNoteView {
  return {
    id: row.id,
    meetingId: row.meetingId,
    kind: row.kind,
    body: row.body,
    authorUserId: row.authorUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

export class MeetingsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
    /**
     * Read-only, and used for one thing: proving the project a new meeting names exists **inside
     * this tenant** before the insert is attempted, exactly as `ConversationsService` does. The
     * composite foreign key already refuses another tenant's project, but it surfaces as a 500;
     * an organization-wide caller skips the relation gate, so without this pre-resolution a
     * missing or cross-tenant `projectId` would fall through to that foreign key. A stateless
     * repository is cheap to own a second handle on (the reasoning `ConversationsModule` records).
     */
    private readonly projects: ProjectsRepository = new ProjectsRepository(),
    /**
     * The meeting-notes store (x105). Stateless like the others; owned by this service because a
     * note is read and written *through a meeting* — the meeting is resolved tenant-scoped and
     * relation-checked here first, and the note store then reads or appends against it.
     */
    private readonly notes: MeetingNotesRepository = new MeetingNotesRepository(),
    /** CQ-12 (AUT-01): the `meeting_scheduled` automation trigger. Optional for suites. */
    private readonly outbox?: OutboxEventsRepository,
    /**
     * Audit gap 8 (COL-09): the attendee store and the member lookup the schedule form needs to
     * add the organizer and the chosen attendees in the create transaction. Optional so the
     * database-free suites and the inbox's read-only handle keep their shape; without them a create
     * simply adds no attendees.
     */
    private readonly attendees?: MeetingAttendeesRepository,
    private readonly memberships?: MembershipsRepository,
  ) {}

  /**
   * List a project's meetings the principal may read.
   *
   * The tenant filter is the repository's. What this adds is the relation filter: a member
   * without organization-wide scope sees a project's meetings only if they belong to that
   * project. Filtered after the read rather than pushed into the query, for the reason
   * `ProjectsService.list` gives — `authorize()` is the single place the relation rule lives,
   * and a `WHERE ... IN (...)` copy would be free to disagree with it.
   */
  async list(
    context: TenantContext,
    principal: Principal,
    options: ListMeetingsOptions,
  ): Promise<readonly MeetingView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.meetings.list(runner, context, options),
    );

    return rows
      .filter(
        (row) =>
          authorize({
            principal,
            capability: 'work.read',
            resource: {
              organizationId: row.organizationId,
              projectId: row.projectId,
              audience: 'internal',
              lifecycle: 'active',
            },
          }).allowed,
      )
      .map(toView);
  }

  /**
   * Create a meeting in a project the principal may write to.
   *
   * Two checks precede the write, both surfacing the same **not found** so a caller can tell
   * neither which projects exist nor which ones they are barred from:
   *
   * 1. The named project is resolved inside this tenant first (`findById` is tenant-scoped). A
   *    projectId that is unknown or belongs to another organization returns `null` → 404, exactly
   *    as `ConversationsService.create` does. Without it an organization-wide caller — who passes
   *    the relation check below — would drive an unknown or cross-tenant id into the composite
   *    foreign key, which refuses the row but surfaces as a 500 rather than a not-found.
   * 2. The relation check: a caller who names a project they are not a member of gets not found,
   *    never forbidden — 403 would confirm the project exists, and which projects a studio runs is
   *    exactly what a non-member must not be able to enumerate (the reasoning `ProjectsService.get`
   *    gives). An organization-wide role passes it and reaches the tenant-resolved project above.
   */
  async create(
    context: TenantContext,
    principal: Principal,
    input: Omit<CreateMeetingInput, 'createdByUserId'> & {
      /** Audit gap 8 (COL-09): members to invite with the meeting; each is notified. */
      readonly attendeeUserIds?: readonly string[];
    },
  ): Promise<MeetingView> {
    const { attendeeUserIds = [], ...meetingInput } = input;
    assertEndAfterStart(meetingInput.startsAt, meetingInput.endsAt ?? null);

    const project = await this.database.read(context, (runner) =>
      this.projects.findById(runner, context, meetingInput.projectId),
    );

    if (!project) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const permitted = authorize({
      principal,
      capability: 'work.create',
      resource: {
        organizationId: context.organizationId,
        projectId: meetingInput.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'project_not_visible');
    }

    const invitees = await this.resolveInvitees(context, attendeeUserIds);

    const row = await this.database.transaction(context, async (tx) => {
      const created = await this.meetings.create(tx, context, {
        ...meetingInput,
        createdByUserId: context.userId,
      });
      await this.outbox?.append(tx, context, {
        type: 'meeting.scheduled.v1',
        aggregateId: created.id,
        payload: { meetingId: created.id, projectId: created.projectId },
      });
      // COL-09 "organizer not included": the organizer attends, already accepted; every chosen
      // member is invited and told through the existing invite notice.
      for (const invitee of invitees) {
        const organizer = invitee.userId === context.userId;
        await this.attendees?.invite(tx, context, {
          meetingId: created.id,
          membershipId: invitee.membershipId,
          rsvp: organizer ? 'accepted' : 'invited',
        });
        if (!organizer) {
          await this.outbox?.append(tx, context, {
            type: 'meeting.attendee_invited.v1',
            aggregateId: created.id,
            payload: {
              meetingId: created.id,
              projectId: created.projectId,
              attendeeUserId: invitee.userId,
              invitedByUserId: context.userId,
            },
          });
        }
      }
      return created;
    });

    return toView(row);
  }

  /**
   * Edit a meeting's title, start, end or agenda note (audit gap 8, COL-06).
   *
   * Known-trap order: the meeting is resolved tenant-scoped and relation-checked (`work.create`)
   * before the write, so an unknown or unwritable meeting is a 404 with no write. The end must stay
   * after the start, judged on the values the row will hold after the edit — moving only the start
   * past a recorded end is refused, not silently left inverted.
   */
  async update(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    input: UpdateMeetingInput,
  ): Promise<MeetingView> {
    const meeting = await this.resolveMeetingFor(context, principal, meetingId, 'work.create');
    assertEndAfterStart(
      input.startsAt ?? meeting.startsAt,
      input.endsAt === undefined ? (meeting.endsAt ?? null) : input.endsAt,
    );

    const row = await this.database.transaction(context, (tx) =>
      this.meetings.update(tx, context, meetingId, input),
    );
    return toView(row);
  }

  /**
   * The organizer plus the requested attendees as active memberships of this tenant, de-duplicated.
   * An unknown, cross-tenant or inactive user id is a 400 naming the field, before any write.
   */
  private async resolveInvitees(
    context: TenantContext,
    attendeeUserIds: readonly string[],
  ): Promise<readonly { readonly userId: string; readonly membershipId: string }[]> {
    const memberships = this.memberships;
    if (!memberships || !this.attendees) return [];

    const userIds = [...new Set([context.userId, ...attendeeUserIds])];
    const resolved: { userId: string; membershipId: string }[] = [];
    for (const userId of userIds) {
      const membership = await this.database.read(context, (runner) =>
        memberships.findByUserId(runner, context, userId),
      );
      if (!membership || membership.status !== 'active') {
        throw new ApiError(
          400,
          'validation_failed',
          'The request body is invalid',
          [{ field: 'attendeeUserIds', message: 'must name active members of this organization' }],
          'membership_not_visible',
        );
      }
      resolved.push({ userId, membershipId: membership.id });
    }
    return resolved;
  }

  /**
   * Resolve a meeting the principal may act on with `capability`, or throw the same **not found**
   * a missing meeting throws.
   *
   * This is the Known-trap order the calendar module has re-learned (FAST-PROTOCOL 19:55): the
   * route names the meeting by id, so the meeting is resolved **tenant-scoped first**. An unknown
   * or cross-tenant `meetingId` is `null` → 404, never a 500 from a foreign key the note insert
   * would otherwise drive it into. Only then is the relation checked, with the meeting's project
   * in hand — and a caller off that project relation gets the same 404, never a 403, so a
   * non-member can tell neither which meetings exist nor which they are barred from (the reasoning
   * `MeetingsService.create` gives for its project resolution).
   */
  private async resolveMeetingFor(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    capability: 'work.read' | 'work.create',
  ): Promise<MeetingRow> {
    const meeting = await this.database.read(context, (runner) =>
      this.meetings.findById(runner, context, meetingId),
    );

    if (!meeting) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');
    }

    const permitted = authorize({
      principal,
      capability,
      resource: {
        organizationId: meeting.organizationId,
        projectId: meeting.projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;

    if (!permitted) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'meeting_not_visible');
    }

    return meeting;
  }

  /**
   * Fetch one meeting a caller may read (x128 — the ICS export's read).
   *
   * The meeting is resolved tenant-scoped and relation-checked first (see {@link resolveMeetingFor})
   * — the Known-trap order — so an unknown or cross-tenant `meetingId` is a 404, never a 500, and a
   * non-member gets the same 404 rather than a 403 that would confirm the meeting exists. The
   * projection is the same wire shape the list returns; `organizationId` is never echoed.
   */
  async get(context: TenantContext, principal: Principal, meetingId: string): Promise<MeetingView> {
    const meeting = await this.resolveMeetingFor(context, principal, meetingId, 'work.read');
    return toView(meeting);
  }

  /**
   * List a meeting's notes and decisions, deterministically ordered, for a caller who may read
   * the meeting.
   *
   * The meeting is resolved and relation-checked first (see {@link resolveMeetingFor}); a caller
   * who cannot read it gets 404, not an empty list, so the list never doubles as a probe for a
   * meeting's existence. The repository's `(organization_id, meeting_id, id)` walk is the
   * deterministic order — no post-read relation filter is needed because the whole meeting was
   * authorised once, its notes inherit its relation, and every row is already tenant- and
   * meeting-scoped by the query.
   */
  async listNotes(
    context: TenantContext,
    principal: Principal,
    options: ListMeetingNotesOptions,
  ): Promise<readonly MeetingNoteView[]> {
    await this.resolveMeetingFor(context, principal, options.meetingId, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.notes.list(runner, context, options),
    );

    return rows.map(toNoteView);
  }

  /**
   * Capture a note or a decision against a meeting the principal may write to.
   *
   * The meeting is resolved tenant-scoped and relation-checked before the insert (see
   * {@link resolveMeetingFor}) — the Known-trap order. The note's author is `context.userId`, not
   * a body field, so a caller cannot attribute a note to someone else.
   */
  async createNote(
    context: TenantContext,
    principal: Principal,
    input: Omit<CreateMeetingNoteInput, 'authorUserId'>,
  ): Promise<MeetingNoteView> {
    await this.resolveMeetingFor(context, principal, input.meetingId, 'work.create');

    const row = await this.database.transaction(context, (tx) =>
      this.notes.create(tx, context, { ...input, authorUserId: context.userId }),
    );

    return toNoteView(row);
  }
}

/** Audit gap 8: a recorded end must be strictly after the start (no CHECK constraint on MariaDB). */
function assertEndAfterStart(startsAt: Date, endsAt: Date | null): void {
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'endsAt', message: 'must be after startsAt' },
    ]);
  }
}
