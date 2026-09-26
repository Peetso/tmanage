import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingAttendeesRepository } from './meeting-attendees.repository.js';
import type {
  AttendeeRsvp,
  AttendeeWithUser,
  ListAttendeesOptions,
} from './meeting-attendees.repository.js';
import { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { MeetingRow } from '../../common/database/schema.js';

/**
 * The application service for CAL-01 / MTG-01 attendees + RSVP (x126) — the object-level decision
 * the route guard cannot make, and the transaction boundary the controller may not open. It follows
 * the `MeetingsService` shape (x90/x105), and reuses that slice's authorization reasoning verbatim.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse `meeting.read` / `meeting.write` question: does
 * this role's ceiling include the capability at all. This service adds the **relation** check with
 * the meeting's project in hand — an internal member without organization-wide scope reads and
 * writes attendees only for meetings on projects they belong to. That relation check is expressed
 * with the sibling `work.read` / `work.create` capabilities, exactly as `MeetingsService` does and
 * for the reason it records: `meeting.read`/`meeting.write` were declared as ceiling-mirrors of
 * `work.read`/`work.create`, so the two are equal by construction and `work.*` is what `authorize()`
 * already relation-gates.
 *
 * ## Attendees are identified by `user_id` on the wire, `membership_id` at rest
 *
 * The rest of the app names a person by `user_id` (the member directory, work ownership), so an
 * invite names a `userId`. The table stores the `membership_id` — the tenant-composite identity the
 * roster and project membership use — so the service resolves the `userId` to the member's
 * membership before the write, and reads project the `user_id` back. An unknown or cross-tenant
 * `userId` is a clean 400, not a composite foreign-key 500 (the pre-resolution `MeetingsService`
 * does for a project id).
 */

/**
 * What a caller is allowed to see of a meeting attendee. `organizationId` is deliberately absent
 * (`25-AUTH-AND-TENANT-ISOLATION` §7); `meetingId` is the parent already in the caller's hand from
 * the route; `membershipId` is not surfaced (the roster hides it as its cursor), the member is named
 * by `userId` as everywhere else.
 */
export interface MeetingAttendeeView {
  readonly id: string;
  readonly meetingId: string;
  readonly userId: string;
  /** `invited`, `accepted` or `declined`. */
  readonly rsvp: AttendeeRsvp;
  /** An ISO-8601 instant on the wire. */
  readonly createdAt: string;
}

function toView(row: AttendeeWithUser): MeetingAttendeeView {
  return {
    id: row.id,
    meetingId: row.meetingId,
    userId: row.userId,
    rsvp: row.rsvp,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface InviteAttendeeCommand {
  readonly meetingId: string;
  /** The member to invite, named by user id (the roster's identity). */
  readonly userId: string;
}

export interface SetRsvpCommand {
  readonly meetingId: string;
  readonly attendeeId: string;
  readonly rsvp: AttendeeRsvp;
}

export class MeetingAttendeesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly attendees: MeetingAttendeesRepository = new MeetingAttendeesRepository(),
    /**
     * Read-only, used to resolve the meeting named in the path tenant-scoped before any authorize
     * or write — the Known-trap order (FAST-PROTOCOL 19:55). Stateless, so a fresh handle is cheap
     * (the reasoning `CalendarModule` records for its second `ProjectsRepository`).
     */
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
    /**
     * Read-only, used to resolve the invited member's membership inside this tenant before the
     * insert — so an unknown or cross-tenant `userId` is a clean 400, not a composite foreign-key
     * 500 (the same pre-resolution `MeetingsService` does for a project id).
     */
    private readonly memberships: MembershipsRepository = new MembershipsRepository(),
  ) {}

  /**
   * Resolve a meeting the principal may act on with `capability`, or throw the same **not found**
   * a missing meeting throws.
   *
   * The Known-trap order: the route names the meeting by id, so it is resolved **tenant-scoped
   * first**. An unknown or cross-tenant `meetingId` is `null` → 404, never a 500 from a foreign key
   * an attendee insert would otherwise drive it into. Only then is the relation checked, with the
   * meeting's project in hand — and a caller off that project relation gets the same 404, never a
   * 403, so a non-member can tell neither which meetings exist nor which they are barred from.
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
   * List a meeting's attendees, deterministically ordered, for a caller who may read the meeting.
   *
   * The meeting is resolved and relation-checked first; a caller who cannot read it gets 404, not an
   * empty list, so the list never doubles as a probe for a meeting's existence. The repository's
   * `(organization_id, meeting_id, id)` walk is the deterministic order — no post-read relation
   * filter is needed because the whole meeting was authorised once and every row is already tenant-
   * and meeting-scoped by the query.
   */
  async listAttendees(
    context: TenantContext,
    principal: Principal,
    options: ListAttendeesOptions,
  ): Promise<readonly MeetingAttendeeView[]> {
    await this.resolveMeetingFor(context, principal, options.meetingId, 'work.read');

    const rows = await this.database.read(context, (runner) =>
      this.attendees.list(runner, context, options),
    );

    return rows.map(toView);
  }

  /**
   * Invite a member to a meeting the principal may write to.
   *
   * The meeting is resolved tenant-scoped and relation-checked before the write (Known-trap order).
   * The member's membership is then resolved tenant-scoped by `userId`, so an unknown or
   * cross-tenant user is a 400 rather than a composite foreign-key 500. A member already invited to
   * this meeting is a 409 (the `(organization_id, meeting_id, membership_id)` unique key), surfaced
   * from a scoped read rather than a driver duplicate-key error. A new attendee starts `invited`.
   */
  async invite(
    context: TenantContext,
    principal: Principal,
    command: InviteAttendeeCommand,
  ): Promise<MeetingAttendeeView> {
    await this.resolveMeetingFor(context, principal, command.meetingId, 'work.create');

    const membership = await this.database.read(context, (runner) =>
      this.memberships.findByUserId(runner, context, command.userId),
    );
    if (!membership) {
      throw new ApiError(
        400,
        'validation_failed',
        'The request body is invalid',
        [{ field: 'userId', message: 'must name a member of this organization' }],
        'membership_not_visible',
      );
    }

    const existing = await this.database.read(context, (runner) =>
      this.attendees.findByMembership(runner, context, command.meetingId, membership.id),
    );
    if (existing) {
      throw new ApiError(
        409,
        'conflict',
        'That member is already an attendee of this meeting',
        undefined,
        'attendee_already_invited',
      );
    }

    const row = await this.database.transaction(context, (tx) =>
      this.attendees.invite(tx, context, {
        meetingId: command.meetingId,
        membershipId: membership.id,
        rsvp: 'invited',
      }),
    );

    return toView(row);
  }

  /**
   * Set an attendee's RSVP, for a caller who may write to the meeting.
   *
   * The meeting is resolved tenant-scoped and relation-checked first (Known-trap order). The
   * attendee is then resolved tenant-scoped and checked to belong to *this* meeting: an unknown,
   * cross-tenant or cross-meeting `attendeeId` is a 404 with no write, never a 403 and never a row
   * from another meeting silently updated. The RSVP value's legality is the controller's (a value
   * outside the vocabulary never reaches here).
   */
  async setRsvp(
    context: TenantContext,
    principal: Principal,
    command: SetRsvpCommand,
  ): Promise<MeetingAttendeeView> {
    await this.resolveMeetingFor(context, principal, command.meetingId, 'work.create');

    const attendee = await this.database.read(context, (runner) =>
      this.attendees.findById(runner, context, command.attendeeId),
    );
    if (!attendee || attendee.meetingId !== command.meetingId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'attendee_not_visible');
    }

    const row = await this.database.transaction(context, (tx) =>
      this.attendees.setRsvp(tx, context, command.meetingId, command.attendeeId, command.rsvp),
    );

    return toView(row);
  }
}
