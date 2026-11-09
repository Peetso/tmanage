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
  CreateMeetingNoteDraftInput,
  CreateMeetingNoteInput,
  ListMeetingNotesOptions,
} from './meeting-notes.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import type { MeetingNoteRow, MeetingRow } from '../../common/database/schema.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import type { MeetingClientAttendeesRepository } from './meeting-client-attendees.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { MeetingCalendarRepository } from './meeting-calendar.repository.js';
import type { InsertAttachmentInput, RosterEntry } from './meeting-calendar.repository.js';
import type { CalendarSyncPort } from './calendar-sync.port.js';
import { parseReminders } from './meeting-options.js';
import type { MeetingReminder } from './meeting-options.js';
import type { StoredAttendeeRsvp } from './meeting-attendees.repository.js';
import type { MeetingExternalEventRow, MeetingGuestRow } from '../../common/database/schema.js';

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
  /** 53-13. `mcp` when the note began as a draft from the member's own AI and was reviewed. */
  readonly source: 'human' | 'mcp';
  /** 53-13. The assistant that drafted it (`source='mcp'`), else null. */
  readonly assistantName: string | null;
}

function toNoteView(row: MeetingNoteRow): MeetingNoteView {
  return {
    id: row.id,
    meetingId: row.meetingId,
    kind: row.kind,
    body: row.body,
    authorUserId: row.authorUserId,
    createdAt: row.createdAt.toISOString(),
    source: row.source ?? 'human',
    assistantName: row.assistantName ?? null,
  };
}

/**
 * 53-13. A draft note from the member's own AI, waiting for a person to Save or Discard it. The
 * provenance (assistant, submitted time) is what the reviewer sees before deciding.
 */
export interface MeetingNoteDraftView {
  readonly id: string;
  readonly meetingId: string;
  readonly kind: 'note' | 'decision';
  readonly body: string;
  /** The member whose connector token the assistant used. */
  readonly authorUserId: string;
  readonly source: 'mcp';
  readonly assistantName: string;
  /** An ISO-8601 instant on the wire. */
  readonly submittedAt: string;
}

function toDraftView(row: MeetingNoteRow): MeetingNoteDraftView {
  return {
    id: row.id,
    meetingId: row.meetingId,
    kind: row.kind,
    body: row.body,
    authorUserId: row.authorUserId,
    source: 'mcp',
    assistantName: row.assistantName ?? '',
    submittedAt: (row.submittedAt ?? row.createdAt).toISOString(),
  };
}

/** 0237. A member invited with the meeting, with the optional flag. */
export interface MeetingAttendeeInput {
  readonly userId: string;
  readonly optional: boolean;
}

/** 0237. Someone invited by email (lower-cased by the controller). */
export interface MeetingGuestInput {
  readonly email: string;
  readonly displayName: string | null;
  readonly optional: boolean;
}

/** 0237. A Drive/OneDrive file picked for the meeting. */
export type MeetingAttachmentInput = Omit<InsertAttachmentInput, 'meetingId' | 'attachedByUserId'>;

/** 0237. One person on the meeting page: a member, a client person or an email guest. */
export interface MeetingOverviewPerson {
  readonly kind: 'member' | 'client' | 'guest';
  /** The attendee or guest row id (the guest id is what `DELETE …/guests/:guestId` takes). */
  readonly id: string;
  /** `null` for a guest. */
  readonly userId: string | null;
  readonly displayName: string | null;
  /** Shown for guests only — a member's address is not echoed to every reader. */
  readonly email: string | null;
  readonly optional: boolean;
  readonly organizer: boolean;
  readonly rsvp: StoredAttendeeRsvp;
}

/** 0237. The meeting's event in its organizer's Google or Microsoft calendar. */
export interface MeetingOverviewExternal {
  readonly provider: string;
  /** The Meet/Teams link; opened in a new tab (live calls cannot be embedded). */
  readonly joinUrl: string | null;
  /** "Open in Google Calendar / Outlook". */
  readonly htmlLink: string | null;
  readonly syncStatus: string;
  readonly lastErrorCode: string | null;
  readonly lastPushedAt: string | null;
  readonly lastPulledAt: string | null;
}

export interface MeetingOverviewAttachment {
  readonly id: string;
  readonly provider: string;
  readonly title: string;
  readonly mimeType: string;
  readonly webUrl: string | null;
}

/** 0237. Everything the meeting page shows, in one read (`GET …/meetings/:meetingId/overview`). */
export interface MeetingOverviewView {
  readonly meeting: MeetingView;
  readonly allDay: boolean;
  readonly timeZone: string | null;
  readonly location: string | null;
  readonly rrule: string | null;
  readonly visibility: string;
  readonly showAs: string;
  readonly colorId: string | null;
  readonly conference: string;
  /** `null` = the calendar's default reminders. */
  readonly reminders: readonly MeetingReminder[] | null;
  readonly guestsCanModify: boolean;
  readonly guestsCanInviteOthers: boolean;
  readonly guestsCanSeeOthers: boolean;
  readonly cancelledAt: string | null;
  readonly people: readonly MeetingOverviewPerson[];
  /** `null` while the organizer has no calendar connected (the meeting is TManage-only). */
  readonly external: MeetingOverviewExternal | null;
  readonly attachments: readonly MeetingOverviewAttachment[];
}

/** 0237. A guest as the guest routes answer it. */
export interface MeetingGuestEntry {
  readonly id: string;
  readonly meetingId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly optional: boolean;
  readonly rsvp: string;
  readonly createdAt: string;
}

function toGuestEntry(row: MeetingGuestRow): MeetingGuestEntry {
  return {
    id: row.id,
    meetingId: row.meetingId,
    email: row.email,
    displayName: row.displayName,
    optional: row.optional,
    rsvp: row.rsvp,
    createdAt: row.createdAt.toISOString(),
  };
}

function toExternal(link: MeetingExternalEventRow | null): MeetingOverviewExternal | null {
  if (!link) return null;
  return {
    provider: link.provider,
    joinUrl: link.joinUrl,
    htmlLink: link.htmlLink,
    syncStatus: link.syncStatus,
    lastErrorCode: link.lastErrorCode,
    lastPushedAt: link.lastPushedAt ? link.lastPushedAt.toISOString() : null,
    lastPulledAt: link.lastPulledAt ? link.lastPulledAt.toISOString() : null,
  };
}

function toPerson(entry: RosterEntry, organizerUserId: string): MeetingOverviewPerson {
  return {
    kind: entry.kind,
    id: entry.id,
    userId: entry.userId,
    displayName: entry.displayName,
    email: entry.kind === 'guest' ? entry.email : null,
    optional: entry.optional,
    organizer: entry.userId !== null && entry.userId === organizerUserId,
    rsvp: entry.rsvp,
  };
}

/** 0237. The All meetings window: default today − 7 days … + 60 days, at most 500 meetings. */
export const WINDOW_BACK_MS = 7 * 86_400_000;
export const WINDOW_AHEAD_MS = 60 * 86_400_000;
export const WINDOW_MAX_MEETINGS = 500;
/** "Pull on open": re-read the provider event when the last pull is older than this. */
export const PULL_ON_OPEN_MS = 60_000;

/**
 * BK5: which of the fields attendees are told about an edit actually changes — title, start, end.
 * An agenda-note edit, or a PATCH that re-sends the current values, is not news.
 */
export function meetingChangedFields(
  meeting: MeetingRow,
  input: UpdateMeetingInput,
): ('title' | 'startsAt' | 'endsAt')[] {
  const changed: ('title' | 'startsAt' | 'endsAt')[] = [];
  if (input.title !== undefined && input.title !== meeting.title) changed.push('title');
  if (input.startsAt !== undefined && input.startsAt.getTime() !== meeting.startsAt.getTime()) {
    changed.push('startsAt');
  }
  if (input.endsAt !== undefined) {
    const before = meeting.endsAt ? meeting.endsAt.getTime() : null;
    const after = input.endsAt ? input.endsAt.getTime() : null;
    if (before !== after) changed.push('endsAt');
  }
  return changed;
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
    /**
     * BK5: the roster reads the "meeting changed" notice snapshots — who attends (members and client
     * people) at the moment of the edit. Optional; without it an edit notifies nobody.
     */
    private readonly clientAttendees?: MeetingClientAttendeesRepository,
    /** 0237. Guests, attachments, the provider event link and the roster with emails. */
    private readonly calendar: MeetingCalendarRepository = new MeetingCalendarRepository(),
    /** 0237. `meeting.cancelled` / `meeting.synced`. Optional for the database-free suites. */
    private readonly audit?: AuditService,
    /** 0237. Google/Microsoft calendar sync; absent = meetings stay TManage-only. */
    private readonly sync?: CalendarSyncPort,
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
      /** 0237. Members with the optional flag (merged with `attendeeUserIds`). */
      readonly attendees?: readonly MeetingAttendeeInput[];
      /** 0237. People invited by email who are not TManage users. */
      readonly guests?: readonly MeetingGuestInput[];
      /** 0237. Drive/OneDrive files picked for the meeting. */
      readonly attachments?: readonly MeetingAttachmentInput[];
    },
  ): Promise<MeetingView> {
    const {
      attendeeUserIds: plainIds = [],
      attendees: flagged = [],
      guests = [],
      attachments = [],
      ...meetingInput
    } = input;
    const attendeeUserIds = [...plainIds, ...flagged.map((a) => a.userId)];
    const optionalUserIds = new Set(flagged.filter((a) => a.optional).map((a) => a.userId));
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
        if (!organizer && optionalUserIds.has(invitee.userId)) {
          await this.calendar.setMemberOptional(
            tx,
            context,
            created.id,
            invitee.membershipId,
            true,
          );
        }
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
      for (const guest of guests) {
        await this.calendar.upsertGuest(tx, context, { meetingId: created.id, ...guest });
      }
      for (const attachment of attachments) {
        await this.calendar.insertAttachment(tx, context, {
          meetingId: created.id,
          ...attachment,
          attachedByUserId: context.userId,
        });
      }
      return created;
    });

    // 0237. After the commit: the organizer's calendar creates the event and sends invitations.
    await this.sync?.pushMeeting(context, row.id);
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
    if (meeting.cancelledAt) {
      throw new ApiError(409, 'conflict', 'This meeting was cancelled', [
        { field: 'meetingId', message: 'cancelled' },
      ]);
    }
    assertEndAfterStart(
      input.startsAt ?? meeting.startsAt,
      input.endsAt === undefined ? (meeting.endsAt ?? null) : input.endsAt,
    );

    const changedFields = meetingChangedFields(meeting, input);
    const row = await this.database.transaction(context, async (tx) => {
      const updated = await this.meetings.update(tx, context, meetingId, input);
      // BK5: a new title, date or time is news to everyone already attending. The recipients are
      // the roster at this moment, so a person added afterwards gets the invitation, not this.
      const roster = this.clientAttendees;
      if (changedFields.length > 0 && this.outbox && roster) {
        const memberUserIds = await roster.listMemberUserIds(tx, context, meetingId);
        const clients = await roster.listForMeeting(tx, context, meetingId);
        if (memberUserIds.length > 0 || clients.length > 0) {
          await this.outbox.append(tx, context, {
            type: 'meeting.changed.v1',
            aggregateId: meetingId,
            payload: {
              meetingId,
              projectId: meeting.projectId,
              changedByUserId: context.userId,
              changedFields,
              memberUserIds,
              clientAttendees: clients.map((client) => ({
                userId: client.userId,
                clientOrganizationId: client.clientOrganizationId,
              })),
            },
          });
        }
      }
      return updated;
    });
    await this.sync?.pushMeeting(context, meetingId);
    return toView(row);
  }

  /**
   * 0237 (owner bug 1). Every meeting the principal may read in a window, soonest first — the All
   * meetings calendar, with no project chosen. Relation-filtered after the read exactly as
   * {@link list} is; the window is capped at {@link WINDOW_MAX_MEETINGS}.
   */
  async listWindow(
    context: TenantContext,
    principal: Principal,
    options: { readonly from?: Date; readonly to?: Date; readonly includeCancelled?: boolean },
  ): Promise<readonly MeetingView[]> {
    const now = Date.now();
    const from = options.from ?? new Date(now - WINDOW_BACK_MS);
    const to = options.to ?? new Date(now + WINDOW_AHEAD_MS);
    if (to.getTime() <= from.getTime()) {
      throw new ApiError(400, 'validation_failed', 'The request is invalid', [
        { field: 'to', message: 'must be after from' },
      ]);
    }
    const rows = await this.database.read(context, (runner) =>
      this.meetings.listWindow(runner, context, {
        from,
        to,
        includeCancelled: options.includeCancelled ?? false,
        limit: WINDOW_MAX_MEETINGS,
      }),
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
   * 0237 (owner bug 2). The meeting page in one read: the meeting, its event options, everyone
   * invited with their answer, the provider event (Join link, sync state) and the attachments.
   * Resolved tenant-scoped and relation-checked first; "pull on open" re-reads the provider event
   * when the last pull is older than a minute (best effort — a provider failure never fails the page).
   */
  async overview(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingOverviewView> {
    await this.resolveMeetingFor(context, principal, meetingId, 'work.read');
    await this.sync?.pullMeeting(context, meetingId, PULL_ON_OPEN_MS);
    const { meeting, roster, link, attachments } = await this.database.read(
      context,
      async (runner) => ({
        meeting: await this.meetings.requireById(runner, context, meetingId),
        roster: await this.calendar.roster(runner, context, meetingId),
        link: await this.calendar.findLink(runner, context, meetingId),
        attachments: await this.calendar.listAttachments(runner, context, meetingId),
      }),
    );
    return {
      meeting: toView(meeting),
      allDay: meeting.allDay,
      timeZone: meeting.timeZone,
      location: meeting.location,
      rrule: meeting.recurrenceRrule,
      visibility: meeting.visibility,
      showAs: meeting.showAs,
      colorId: meeting.colorId,
      conference: meeting.conference,
      reminders: parseReminders(meeting.reminders),
      guestsCanModify: meeting.guestsCanModify,
      guestsCanInviteOthers: meeting.guestsCanInviteOthers,
      guestsCanSeeOthers: meeting.guestsCanSeeOthers,
      cancelledAt: meeting.cancelledAt ? meeting.cancelledAt.toISOString() : null,
      people: roster.map((entry) => toPerson(entry, meeting.createdByUserId)),
      external: toExternal(link),
      attachments: attachments.map((a) => ({
        id: a.id,
        provider: a.provider,
        title: a.title,
        mimeType: a.mimeType,
        webUrl: a.webUrl,
      })),
    };
  }

  /**
   * 0237. Cancel a meeting: `cancelled_at` is set (the row stays, with its notes and decisions) and,
   * after the commit, the organizer's provider event is deleted — Google/Outlook tell every guest.
   * Cancelling twice is a no-op.
   */
  async cancel(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingView> {
    const meeting = await this.resolveMeetingFor(context, principal, meetingId, 'work.create');
    if (meeting.cancelledAt) return toView(meeting);
    const row = await this.database.transaction(context, async (tx) => {
      const updated = await this.meetings.update(tx, context, meetingId, {
        cancelledAt: new Date(),
      });
      await this.audit?.record(tx, context, {
        action: 'meeting.cancelled',
        result: 'allowed',
        objectId: meetingId,
        metadata: { project_id: meeting.projectId },
      });
      return updated;
    });
    await this.sync?.pushMeeting(context, meetingId);
    return toView(row);
  }

  /**
   * Live check a6f66e47: a cancelled meeting can be removed from the calendar. Only a cancelled one
   * (409 otherwise — cancel first, so the guests are told); the row is soft-deleted, so its notes
   * stay recoverable and the audit names who removed it. Removing twice is a 404.
   */
  async remove(context: TenantContext, principal: Principal, meetingId: string): Promise<void> {
    const meeting = await this.resolveMeetingFor(context, principal, meetingId, 'work.create');
    if (!meeting.cancelledAt) {
      throw new ApiError(
        409,
        'conflict',
        'Cancel the meeting before removing it',
        [{ field: 'meetingId', message: 'only a cancelled meeting can be removed' }],
        'meeting_not_cancelled',
      );
    }
    await this.database.transaction(context, async (tx) => {
      await this.meetings.update(tx, context, meetingId, {
        deleted: { at: new Date(), byUserId: principal.userId },
      });
      await this.audit?.record(tx, context, {
        action: 'meeting.deleted',
        result: 'allowed',
        objectId: meetingId,
        metadata: { project_id: meeting.projectId },
      });
    });
  }

  /**
   * 0237. "Retry" on the meeting page: push the meeting to the organizer's calendar again, then pull
   * the answers back, and return the fresh overview. Audited (`meeting.synced`).
   */
  async syncNow(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingOverviewView> {
    await this.resolveMeetingFor(context, principal, meetingId, 'work.create');
    await this.sync?.pushMeeting(context, meetingId);
    await this.sync?.pullMeeting(context, meetingId, 0);
    await this.audit?.recordStandalone(context, {
      action: 'meeting.synced',
      result: 'allowed',
      objectId: meetingId,
      metadata: { connected: this.sync !== undefined },
    });
    return this.overview(context, principal, meetingId);
  }

  async listGuests(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<readonly MeetingGuestEntry[]> {
    await this.resolveMeetingFor(context, principal, meetingId, 'work.read');
    const rows = await this.database.read(context, (runner) =>
      this.calendar.listGuests(runner, context, meetingId),
    );
    return rows.map(toGuestEntry);
  }

  /** 0237. Invite someone by email (again: updates the name and the optional flag), then push. */
  async addGuest(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    guest: MeetingGuestInput,
  ): Promise<MeetingGuestEntry> {
    await this.resolveMeetingFor(context, principal, meetingId, 'work.create');
    const row = await this.database.transaction(context, (tx) =>
      this.calendar.upsertGuest(tx, context, { meetingId, ...guest }),
    );
    await this.sync?.pushMeeting(context, meetingId);
    return toGuestEntry(row);
  }

  /** 0237. Remove an email guest; an unknown or other meeting's guest is a 404 with no write. */
  async removeGuest(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
    guestId: string,
  ): Promise<void> {
    await this.resolveMeetingFor(context, principal, meetingId, 'work.create');
    const removed = await this.database.transaction(context, (tx) =>
      this.calendar.deleteGuest(tx, context, meetingId, guestId),
    );
    if (!removed) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'guest_not_visible');
    }
    await this.sync?.pushMeeting(context, meetingId);
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

    // A removed (soft-deleted) meeting is gone for every reader.
    if (!meeting || meeting.deletedAt) {
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

  /**
   * 53-13. The member's own assistant submits a draft note over MCP. Same gate as a capture (the
   * meeting resolved tenant-scoped, then the write relation), but the row lands `pending` with
   * its provenance and is not part of the meeting's record until a person saves it.
   */
  async submitNoteDraft(
    context: TenantContext,
    principal: Principal,
    input: Omit<CreateMeetingNoteDraftInput, 'authorUserId'>,
  ): Promise<MeetingNoteDraftView> {
    await this.resolveMeetingFor(context, principal, input.meetingId, 'work.create');
    const row = await this.database.transaction(context, (tx) =>
      this.notes.createDraft(tx, context, { ...input, authorUserId: context.userId }),
    );
    return toDraftView(row);
  }

  /** 53-13. The drafts waiting for review on one meeting (readers of the meeting see them). */
  async listNoteDrafts(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<readonly MeetingNoteDraftView[]> {
    await this.resolveMeetingFor(context, principal, meetingId, 'work.read');
    const rows = await this.database.read(context, (runner) =>
      this.notes.list(runner, context, { meetingId, status: 'pending' }),
    );
    return rows.map(toDraftView);
  }

  /**
   * 53-13. A person reviews a draft: `save` turns it into a normal note with the text and kind
   * they settled on (they become its reviewer); `discard` removes it. Either way the draft must
   * still be pending and belong to this meeting, else 404 — a second Save is not a second note.
   * The route is NEVER-classified, so no AI token can approve its own draft.
   */
  async reviewNoteDraft(
    context: TenantContext,
    principal: Principal,
    input: ReviewMeetingNoteDraftInput,
  ): Promise<MeetingNoteView | null> {
    await this.resolveMeetingFor(context, principal, input.meetingId, 'work.create');
    return this.database.transaction(context, async (tx) => {
      const draft = await this.notes.findById(tx, context, input.noteId);
      if (!draft || draft.meetingId !== input.meetingId || draft.status !== 'pending') {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'note_draft_not_pending',
        );
      }
      if (input.decision === 'discard') {
        await this.notes.discardDraft(tx, context, input.noteId);
        return null;
      }
      const saved = await this.notes.saveDraft(tx, context, input.noteId, {
        kind: input.kind ?? draft.kind,
        body: input.body ?? draft.body,
        reviewedByUserId: context.userId,
      });
      if (!saved) {
        throw new ApiError(
          404,
          'not_found',
          MESSAGES.notFound,
          undefined,
          'note_draft_not_pending',
        );
      }
      const row = await this.notes.findById(tx, context, input.noteId);
      if (!row) throw new Error(`meeting_note ${input.noteId} vanished after save`);
      return toNoteView(row);
    });
  }
}

/** 53-13. A reviewer's decision on a pending draft; `kind`/`body` are the edited values on save. */
export interface ReviewMeetingNoteDraftInput {
  readonly meetingId: string;
  readonly noteId: string;
  readonly decision: 'save' | 'discard';
  readonly kind?: 'note' | 'decision';
  readonly body?: string;
}

/** Audit gap 8: a recorded end must be strictly after the start (no CHECK constraint on MariaDB). */
function assertEndAfterStart(startsAt: Date, endsAt: Date | null): void {
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'endsAt', message: 'must be after startsAt' },
    ]);
  }
}
