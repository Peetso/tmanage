import { and, eq, inArray, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetingTimePolls, meetingTimePollVotes } from '../../common/database/schema.js';
import type { MeetingTimePollRow, MeetingTimePollVoteRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The meeting time-option poll repository — CAL meeting time-option poll (x298), following the
 * `meeting_rsvps` (x240) pattern for the vote upsert and the `meeting_attendees` (x126) pattern for
 * the parent-owned option rows.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured structurally, exactly as the
 * meetings and RSVP repositories honour it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner`
 *    for the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** No input type carries `organizationId`,
 *    so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * The runner is a parameter, not a field: the repository holds no connection and no state.
 */

export const MEETING_TIME_POLL_REPOSITORY = Symbol('MEETING_TIME_POLL_REPOSITORY');

/** The three answers a member can give on a candidate slot. */
export type MeetingTimePollVoteChoice = 'yes' | 'maybe' | 'no';

/**
 * A candidate slot to create. Note what is absent: `organizationId` and `meetingId` — the tenant
 * comes from the context and the meeting is resolved tenant-scoped by the service before the write,
 * so neither is a field a request body could populate.
 */
export interface NewPollOption {
  readonly optionStart: Date;
  readonly optionEnd: Date;
}

/** A vote to record — always the caller's own membership, resolved by the service. */
export interface UpsertVoteInput {
  readonly optionId: string;
  readonly membershipId: string;
  readonly choice: MeetingTimePollVoteChoice;
}

/** One row of the per-option tally: how many members chose `choice` on `optionId`. */
export interface OptionChoiceCount {
  readonly optionId: string;
  readonly choice: MeetingTimePollVoteChoice;
  readonly count: number;
}

/** The caller's own vote on one option. */
export interface OwnVote {
  readonly optionId: string;
  readonly choice: MeetingTimePollVoteChoice;
}

export class MeetingTimePollRepository {
  /**
   * List a meeting's candidate slots within the acting tenant, in id (≈ creation) order.
   *
   * Both `organization_id` and `meeting_id` predicates are present. A meeting with no options
   * returns `[]`; the service reads that as an empty poll rather than a missing meeting (the meeting
   * itself is resolved separately, tenant-scoped, before this read).
   */
  async listOptions(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
  ): Promise<MeetingTimePollRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(meetingTimePolls)
      .where(
        and(
          eq(meetingTimePolls.organizationId, context.organizationId),
          eq(meetingTimePolls.meetingId, meetingId),
        ),
      )
      .orderBy(meetingTimePolls.id);
  }

  /**
   * Fetch one candidate slot by id within the acting tenant, or `null`.
   *
   * The service resolves the meeting tenant-scoped first, then this option, and checks the option's
   * `meetingId` matches the path meeting — so a cross-tenant or wrong-meeting option id is a 404
   * with no vote, never a foreign-key 500 a vote insert would otherwise drive.
   */
  async findOptionById(
    runner: TenantQueryRunner,
    context: TenantContext,
    optionId: string,
  ): Promise<MeetingTimePollRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingTimePolls)
      .where(
        and(
          eq(meetingTimePolls.organizationId, context.organizationId),
          eq(meetingTimePolls.id, optionId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert a meeting's candidate slots.
   *
   * Each id is generated here (UUIDv7, `07-DATA-MODEL`); `organization_id` comes from the context,
   * never from the input. The meeting is *not* re-checked to belong to the tenant here: the service
   * resolves it tenant-scoped before the write, and the composite foreign key refuses a meeting from
   * another tenant regardless. The `option_end <= option_start` ordering is refused in the service
   * before this is reached, so a stored option is always a forward interval.
   */
  async insertOptions(
    runner: TenantQueryRunner,
    context: TenantContext,
    meetingId: string,
    options: readonly NewPollOption[],
  ): Promise<void> {
    if (options.length === 0) return;
    const db = tenantDrizzle(runner);
    await db.insert(meetingTimePolls).values(
      options.map((option) => ({
        id: uuidv7(),
        // From the context. Not from the input — there is no such field.
        organizationId: context.organizationId,
        meetingId,
        optionStart: option.optionStart,
        optionEnd: option.optionEnd,
        createdAt: sql`current_timestamp(3)`,
      })),
    );
  }

  /**
   * Count a meeting's votes by option and choice, within the acting tenant.
   *
   * Scoped to the tenant's options for this meeting: the option ids are resolved (tenant- and
   * meeting-scoped) before this read, and the vote predicate carries `organization_id` and
   * `option_id IN (…)`, so no other tenant's votes are visible. An option nobody voted on is absent
   * from the grouped rows; the service fills the missing choices with `0`.
   */
  async tallyByOptions(
    runner: TenantQueryRunner,
    context: TenantContext,
    optionIds: readonly string[],
  ): Promise<OptionChoiceCount[]> {
    if (optionIds.length === 0) return [];
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        optionId: meetingTimePollVotes.optionId,
        choice: meetingTimePollVotes.choice,
        count: sql<number>`count(*)`,
      })
      .from(meetingTimePollVotes)
      .where(
        and(
          eq(meetingTimePollVotes.organizationId, context.organizationId),
          inArray(meetingTimePollVotes.optionId, [...optionIds]),
        ),
      )
      .groupBy(meetingTimePollVotes.optionId, meetingTimePollVotes.choice);
    return rows.map((row) => ({
      optionId: row.optionId,
      choice: row.choice,
      count: Number(row.count),
    }));
  }

  /**
   * The caller's own vote on each option they have voted on, within the acting tenant.
   *
   * Keyed on `membership_id`, so it is always the caller's own — never another member's. Options not
   * voted on are simply absent; the service reads a missing option as `ownVote: null`.
   */
  async ownVotes(
    runner: TenantQueryRunner,
    context: TenantContext,
    optionIds: readonly string[],
    membershipId: string,
  ): Promise<OwnVote[]> {
    if (optionIds.length === 0) return [];
    const db = tenantDrizzle(runner);
    const rows = await db
      .select({
        optionId: meetingTimePollVotes.optionId,
        choice: meetingTimePollVotes.choice,
      })
      .from(meetingTimePollVotes)
      .where(
        and(
          eq(meetingTimePollVotes.organizationId, context.organizationId),
          eq(meetingTimePollVotes.membershipId, membershipId),
          inArray(meetingTimePollVotes.optionId, [...optionIds]),
        ),
      );
    return rows.map((row) => ({ optionId: row.optionId, choice: row.choice }));
  }

  /**
   * Fetch the caller's vote row on one option, within the acting tenant.
   *
   * The `(organization_id, option_id, membership_id)` unique key backs this read: the service uses
   * it to decide between an INSERT (first vote) and an UPDATE (re-vote), so the PUT is idempotent
   * rather than a duplicate-key 500.
   */
  async findVote(
    runner: TenantQueryRunner,
    context: TenantContext,
    optionId: string,
    membershipId: string,
  ): Promise<MeetingTimePollVoteRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(meetingTimePollVotes)
      .where(
        and(
          eq(meetingTimePollVotes.organizationId, context.organizationId),
          eq(meetingTimePollVotes.optionId, optionId),
          eq(meetingTimePollVotes.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Record a member's first vote on an option.
   *
   * The id is generated here (UUIDv7); `organization_id` comes from the context. The option and
   * membership are *not* re-checked to belong to the tenant here: the service resolves the option
   * tenant-scoped before the write, the `membershipId` is the caller's own from the principal, and
   * the composite foreign keys refuse either from another tenant regardless.
   */
  async insertVote(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertVoteInput,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db.insert(meetingTimePollVotes).values({
      id: uuidv7(),
      organizationId: context.organizationId,
      optionId: input.optionId,
      membershipId: input.membershipId,
      choice: input.choice,
      createdAt: sql`current_timestamp(3)`,
      updatedAt: sql`current_timestamp(3)`,
    });
  }

  /**
   * Re-vote: update a member's existing vote on an option in place, within the acting tenant.
   *
   * The `WHERE` carries `organization_id`, `option_id` *and* `membership_id`: a row from another
   * tenant, option or member matches nothing and is left untouched. Only `choice` is written; the
   * identity columns are immutable at the engine (0166's trigger) besides, and `updated_at` advances
   * via its `ON UPDATE` clause.
   */
  async updateVote(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: UpsertVoteInput,
  ): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .update(meetingTimePollVotes)
      .set({ choice: input.choice })
      .where(
        and(
          eq(meetingTimePollVotes.organizationId, context.organizationId),
          eq(meetingTimePollVotes.optionId, input.optionId),
          eq(meetingTimePollVotes.membershipId, input.membershipId),
        ),
      );
  }
}
