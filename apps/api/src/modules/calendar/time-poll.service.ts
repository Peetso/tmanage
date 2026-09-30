import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow, MeetingTimePollRow } from '../../common/database/schema.js';
import { MeetingsRepository } from './meetings.repository.js';
import { MeetingTimePollRepository } from './time-poll.repository.js';
import type { MeetingTimePollVoteChoice, NewPollOption } from './time-poll.repository.js';

/** DI token for the time-poll service — kept local so this slice touches no shared `tokens.ts`. */
export const MEETING_TIME_POLL_SERVICE = Symbol('MEETING_TIME_POLL_SERVICE');

/**
 * The application service for CAL meeting time-option poll (x298) — the object-level decisions the
 * route guard cannot make, and the transaction boundary the controller may not open. It follows the
 * `MeetingRsvpService` shape (x240) and reuses that slice's authorization reasoning verbatim.
 *
 * ## The two authorization layers, and why the object one uses `work.read` / `work.create`
 *
 * `CapabilityGuard` on the route asks the coarse `meeting.read` / `meeting.write` question: does
 * this role's ceiling include the capability at all. This service adds the **relation** check with
 * the meeting's project in hand — an internal member without organization-wide scope reads and
 * votes only for meetings on projects they belong to. That relation check is expressed with the
 * sibling `work.read` / `work.create` capabilities, exactly as `MeetingRsvpService` does and for the
 * reason it records: `meeting.read`/`meeting.write` were declared as ceiling-mirrors of
 * `work.read`/`work.create`, so the two are equal by construction and `work.*` is what `authorize()`
 * already relation-gates.
 *
 * ## Who may propose slots, and who may vote
 *
 * Proposing candidate slots is the **organiser's** act (the brief: `meeting.write`, organizer), so
 * `createPoll` requires the caller be the meeting's creator on top of the relation check — a member
 * with `meeting.write` who did not create the meeting gets a 403, not a silent write. Voting is any
 * invitee's act behind `meeting.read`; a vote is always keyed on the caller's own `membershipId`, so
 * a caller can only ever set their own — the isolation is structural, not a check a handler could
 * forget.
 */

/** How many members chose each answer on one candidate slot. */
export interface MeetingTimePollTally {
  readonly yes: number;
  readonly maybe: number;
  readonly no: number;
}

/**
 * One candidate slot as a caller reads it: its bounds (ISO-8601 instants on the wire), the caller's
 * own vote (`null` until they vote) and the tally. `organizationId` is deliberately absent
 * (`25-AUTH-AND-TENANT-ISOLATION` §7). Paired `Exact` with the web `MeetingTimePollOptionView` in
 * the contracts gate.
 */
export interface MeetingTimePollOptionView {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly ownVote: MeetingTimePollVoteChoice | null;
  readonly tally: MeetingTimePollTally;
}

/** A meeting's whole time-option poll — its candidate slots, in creation order. */
export interface MeetingTimePollView {
  readonly meetingId: string;
  readonly options: readonly MeetingTimePollOptionView[];
}

export interface CreatePollCommand {
  readonly meetingId: string;
  /** Already validated by the controller: forward intervals, at least one. */
  readonly options: readonly NewPollOption[];
}

export interface VoteCommand {
  readonly meetingId: string;
  readonly optionId: string;
  readonly choice: MeetingTimePollVoteChoice;
}

export class MeetingTimePollService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly polls: MeetingTimePollRepository = new MeetingTimePollRepository(),
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
   * a poll or vote insert would otherwise drive it into. Only then is the relation checked, with the
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

  private buildView(
    meetingId: string,
    options: readonly MeetingTimePollRow[],
    tallies: ReadonlyArray<{ optionId: string; choice: MeetingTimePollVoteChoice; count: number }>,
    ownVotes: ReadonlyArray<{ optionId: string; choice: MeetingTimePollVoteChoice }>,
  ): MeetingTimePollView {
    const tallyByOption = new Map<string, { yes: number; maybe: number; no: number }>();
    for (const option of options) {
      tallyByOption.set(option.id, { yes: 0, maybe: 0, no: 0 });
    }
    for (const row of tallies) {
      const tally = tallyByOption.get(row.optionId);
      if (tally) tally[row.choice] = row.count;
    }
    const ownByOption = new Map<string, MeetingTimePollVoteChoice>();
    for (const vote of ownVotes) ownByOption.set(vote.optionId, vote.choice);

    return {
      meetingId,
      options: options.map((option) => ({
        id: option.id,
        startsAt: option.optionStart.toISOString(),
        endsAt: option.optionEnd.toISOString(),
        ownVote: ownByOption.get(option.id) ?? null,
        tally: tallyByOption.get(option.id) ?? { yes: 0, maybe: 0, no: 0 },
      })),
    };
  }

  private async readView(
    context: TenantContext,
    meetingId: string,
    membershipId: string,
  ): Promise<MeetingTimePollView> {
    const { options, tallies, ownVotes } = await this.database.read(context, async (runner) => {
      const optionRows = await this.polls.listOptions(runner, context, meetingId);
      const optionIds = optionRows.map((row) => row.id);
      const tallyRows = await this.polls.tallyByOptions(runner, context, optionIds);
      const ownRows = await this.polls.ownVotes(runner, context, optionIds, membershipId);
      return { options: optionRows, tallies: tallyRows, ownVotes: ownRows };
    });
    return this.buildView(meetingId, options, tallies, ownVotes);
  }

  /**
   * Read a meeting's time-option poll — its candidate slots, tallies and the caller's own votes —
   * for a caller who may read the meeting.
   *
   * The meeting is resolved and relation-checked first; a caller who cannot read it gets 404, not an
   * empty poll, so the read never doubles as a probe for a meeting's existence.
   */
  async getPoll(
    context: TenantContext,
    principal: Principal,
    meetingId: string,
  ): Promise<MeetingTimePollView> {
    await this.resolveMeetingFor(context, principal, meetingId, 'work.read');
    return this.readView(context, meetingId, principal.membershipId);
  }

  /**
   * Propose candidate slots for a meeting — the **organiser's** act.
   *
   * The meeting is resolved tenant-scoped and relation-checked before the write (Known-trap order).
   * On top of that, the caller must be the meeting's creator: a member with `meeting.write` who did
   * not create the meeting is a 403 with no write. The option bounds are validated by the controller
   * (forward intervals, at least one), so an ill-ordered slot never reaches here.
   */
  async createPoll(
    context: TenantContext,
    principal: Principal,
    command: CreatePollCommand,
  ): Promise<MeetingTimePollView> {
    const meeting = await this.resolveMeetingFor(
      context,
      principal,
      command.meetingId,
      'work.create',
    );

    // Proposing slots is the organiser's act. The relation check above lets any project member with
    // `meeting.write` through; this narrows it to the meeting's creator, so a non-organiser member
    // gets a 403 rather than a silent write.
    if (meeting.createdByUserId !== principal.userId) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
    }

    await this.database.transaction(context, (tx) =>
      this.polls.insertOptions(tx, context, command.meetingId, command.options),
    );

    return this.readView(context, command.meetingId, principal.membershipId);
  }

  /**
   * Cast or change the caller's own vote on one candidate slot (idempotent upsert).
   *
   * The meeting is resolved tenant-scoped and relation-checked before the write; then the option is
   * resolved tenant-scoped and checked to belong to that meeting — a cross-tenant or wrong-meeting
   * option id is a 404 with no upsert (the Known-trap order). The vote row is keyed on
   * `principal.membershipId`, so a caller can only ever set their own. A first vote INSERTs; a
   * re-vote UPDATEs the one row (the `(organization_id, option_id, membership_id)` unique key), so a
   * repeated PUT is idempotent rather than a duplicate-key 500. The choice's legality is the
   * controller's (a value outside the vocabulary never reaches here).
   */
  async vote(
    context: TenantContext,
    principal: Principal,
    command: VoteCommand,
  ): Promise<MeetingTimePollView> {
    await this.resolveMeetingFor(context, principal, command.meetingId, 'work.read');

    const option = await this.database.read(context, (runner) =>
      this.polls.findOptionById(runner, context, command.optionId),
    );
    if (!option || option.meetingId !== command.meetingId) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'poll_option_not_visible');
    }

    const existing = await this.database.read(context, (runner) =>
      this.polls.findVote(runner, context, command.optionId, principal.membershipId),
    );

    await this.database.transaction(context, async (tx) => {
      const input = {
        optionId: command.optionId,
        membershipId: principal.membershipId,
        choice: command.choice,
      };
      if (existing) {
        await this.polls.updateVote(tx, context, input);
      } else {
        await this.polls.insertVote(tx, context, input);
      }
    });

    return this.readView(context, command.meetingId, principal.membershipId);
  }
}
