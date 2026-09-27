import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow } from '../../common/database/schema.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingRsvpRepository } from './rsvp.repository.js';
import type { MeetingRsvpCounts, MeetingRsvpResponse } from './rsvp.repository.js';

/** DI token for the RSVP service — kept local so this slice touches no shared `tokens.ts`. */
export const MEETING_RSVP_SERVICE = Symbol('MEETING_RSVP_SERVICE');

/**
 * The application service for CAL meeting RSVP (x240) — the object-level decision the route guard
 * cannot make, and the transaction boundary the controller may not open. It follows the
 * `MeetingAttendeesService` shape (x126) and reuses that slice's authorization reasoning verbatim.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse `meeting.read` / `meeting.write` question: does
 * this role's ceiling include the capability at all. This service adds the **relation** check with
 * the meeting's project in hand — an internal member without organization-wide scope reads and
 * responds only for meetings on projects they belong to. That relation check is expressed with the
 * sibling `work.read` / `work.create` capabilities, exactly as `MeetingAttendeesService` does and
 * for the reason it records: `meeting.read`/`meeting.write` were declared as ceiling-mirrors of
 * `work.read`/`work.create`, so the two are equal by construction and `work.*` is what `authorize()`
 * already relation-gates.
 *
 * ## A caller answers only for themselves
 *
 * Unlike the attendee roster (an organiser inviting anyone), a response is always the caller's own:
 * the row is keyed on `principal.membershipId`, never on an id from the path or body. There is no
 * field for another member, so a caller cannot set another member's response — the isolation is
 * structural, not a check a handler could forget.
 */

/**
 * What a caller is allowed to see of a meeting's RSVP state: the summary counts and their **own**
 * response (`null` until they answer). `organizationId` is deliberately absent
 * (`25-AUTH-AND-TENANT-ISOLATION` §7); no other member's response is surfaced — the counts are the
 * only aggregate view, and a member's individual answer belongs to that member. Paired `Exact` with
 * the web `MeetingRsvpView` in the contracts gate (`e2e/contracts/api-web-shapes.ts`).
 */
export interface MeetingRsvpView {
  readonly meetingId: string;
  /** The caller's own response, or `null` if they have not answered. */
  readonly response: MeetingRsvpResponse | null;
  readonly counts: {
    readonly accepted: number;
    readonly declined: number;
    readonly tentative: number;
  };
}

export interface SetRsvpCommand {
  readonly meetingId: string;
  readonly response: MeetingRsvpResponse;
}

function toView(
  meetingId: string,
  ownResponse: MeetingRsvpResponse | null,
  counts: MeetingRsvpCounts,
): MeetingRsvpView {
  return {
    meetingId,
    response: ownResponse,
    counts: {
      accepted: counts.accepted,
      declined: counts.declined,
      tentative: counts.tentative,
    },
  };
}

export class MeetingRsvpService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly rsvps: MeetingRsvpRepository = new MeetingRsvpRepository(),
    /**
     * Read-only, used to resolve the meeting named in the path tenant-scoped before any authorize
     * or write — the Known-trap order. Stateless, so a fresh handle is cheap.
     */
    private readonly meetings: MeetingsRepository = new MeetingsRepository(),
  ) {}

  /**
   * Resolve a meeting the principal may act on with `capability`, or throw the same **not found** a
   * missing meeting throws.
   *
   * The Known-trap order: the route names the meeting by id, so it is resolved **tenant-scoped
   * first**. An unknown or cross-tenant `meetingId` is `null` → 404, never a 500 from a foreign key
   * a response insert would otherwise drive it into. Only then is the relation checked, with the
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
   * Read a meeting's RSVP summary — the counts and the caller's own response — for a caller who may
   * read the meeting.
   *
   * The meeting is resolved and relation-checked first; a caller who cannot read it gets 404, not an
   * empty summary, so the read never doubles as a probe for a meeting's existence.
   */
  async getSummary(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingRsvpView> {
    await this.resolveMeetingFor(context, principal, meetingId, 'work.read');

    const [own, counts] = await this.database.read(context, async (runner) => {
      const ownRow = await this.rsvps.findByMember(
        runner,
        context,
        meetingId,
        principal.membershipId,
      );
      const summary = await this.rsvps.countsByResponse(runner, context, meetingId);
      return [ownRow, summary] as const;
    });

    return toView(meetingId, own?.response ?? null, counts);
  }

  /**
   * Set the caller's own response to a meeting they may write to (idempotent upsert).
   *
   * The meeting is resolved tenant-scoped and relation-checked before the write (Known-trap order).
   * The response row is keyed on `principal.membershipId`, so a caller can only ever set their own.
   * A first answer INSERTs; a re-answer UPDATEs the one row (the `(organization_id, meeting_id,
   * member_id)` unique key), so a repeated PUT is idempotent rather than a duplicate-key 500. The
   * response value's legality is the controller's (a value outside the vocabulary never reaches
   * here).
   */
  async setResponse(
    context: TenantContext,
    principal: Principal,
    command: SetRsvpCommand,
  ): Promise<MeetingRsvpView> {
    await this.resolveMeetingFor(context, principal, command.meetingId, 'work.create');

    const existing = await this.database.read(context, (runner) =>
      this.rsvps.findByMember(runner, context, command.meetingId, principal.membershipId),
    );

    const counts = await this.database.transaction(context, async (tx) => {
      const input = {
        meetingId: command.meetingId,
        memberId: principal.membershipId,
        response: command.response,
      };
      if (existing) {
        await this.rsvps.updateResponse(tx, context, input);
      } else {
        await this.rsvps.insert(tx, context, input);
      }
      return this.rsvps.countsByResponse(tx, context, command.meetingId);
    });

    return toView(command.meetingId, command.response, counts);
  }
}
