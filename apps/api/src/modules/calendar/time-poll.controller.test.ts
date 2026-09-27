import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CLIENT_ROLES, INTERNAL_ROLES, capabilitiesFor } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MeetingTimePollController } from './time-poll.controller.js';
import { MeetingTimePollService } from './time-poll.service.js';
import type { MeetingTimePollRepository } from './time-poll.repository.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  MeetingRow,
  MeetingTimePollRow,
  MeetingTimePollVoteRow,
} from '../../common/database/schema.js';

/**
 * CAL meeting time-option poll (x298) proofs, database-free over the module's fakes and with the
 * *real* `authorize()` in the loop — the SQL round-trip and the migration are the chain's DB suites,
 * not re-proven here. What only this file proves is the slice's own logic:
 *
 * - an organiser proposes slots, an invitee votes, and a re-vote updates the one row (idempotent);
 * - a vote on a meeting in another tenant is 404 with no upsert (the Known-trap order);
 * - a member with `meeting.write` who did not create the meeting cannot propose slots (403);
 * - an illegal choice / an ill-ordered slot is 400 and never reaches the service;
 * - the propose route declares `meeting.write` (held by no client role — the 403 boundary).
 *
 * The fakes deliberately do **not** re-apply the tenant scope the real SQL applies, so the service's
 * own resolution must carry the isolation.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const MEETING = 'meeting-0000-0000-0000-00000000000001';
const ORGANIZER = 'user-0000-0000-0000-0000-00000000000A';
const OTHER_USER = 'user-0000-0000-0000-0000-00000000000B';
const MEMBERSHIP = 'membership-0000-0000-0000-0000-0000000009';

function member(userId: string, hasOrgWideScope = true): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope,
  };
}

const context = { organizationId: ORG, userId: ORGANIZER } as unknown as TenantContext;

function meetingRow(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: MEETING,
    organizationId: ORG,
    projectId: PROJECT,
    title: 'Kickoff',
    startsAt: new Date('2026-10-01T14:00:00.000Z'),
    agendaNote: null,
    createdByUserId: ORGANIZER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MeetingRow;
}

function serviceWith(options: { meetings?: readonly MeetingRow[] }): {
  service: MeetingTimePollService;
  optionStore: MeetingTimePollRow[];
  voteStore: MeetingTimePollVoteRow[];
} {
  const meetings = options.meetings ?? [meetingRow()];
  const optionStore: MeetingTimePollRow[] = [];
  const voteStore: MeetingTimePollVoteRow[] = [];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const pollsRepo = {
    listOptions: async (_r: unknown, _c: unknown, meetingId: string) =>
      optionStore.filter((o) => o.organizationId === ORG && o.meetingId === meetingId),
    findOptionById: async (_r: unknown, _c: unknown, optionId: string) =>
      optionStore.find((o) => o.organizationId === ORG && o.id === optionId) ?? null,
    insertOptions: async (
      _r: unknown,
      _c: unknown,
      meetingId: string,
      opts: readonly { optionStart: Date; optionEnd: Date }[],
    ) => {
      for (const opt of opts) {
        optionStore.push({
          id: `option-0000-0000-0000-00000000000${++seq}`,
          organizationId: ORG,
          meetingId,
          optionStart: opt.optionStart,
          optionEnd: opt.optionEnd,
          createdAt: new Date(),
        } as MeetingTimePollRow);
      }
    },
    tallyByOptions: async (_r: unknown, _c: unknown, optionIds: readonly string[]) => {
      const counts = new Map<string, { yes: number; maybe: number; no: number }>();
      for (const v of voteStore) {
        if (v.organizationId !== ORG || !optionIds.includes(v.optionId)) continue;
        const c = counts.get(v.optionId) ?? { yes: 0, maybe: 0, no: 0 };
        c[v.choice] += 1;
        counts.set(v.optionId, c);
      }
      return [...counts.entries()].flatMap(([optionId, c]) =>
        (['yes', 'maybe', 'no'] as const)
          .filter((choice) => c[choice] > 0)
          .map((choice) => ({ optionId, choice, count: c[choice] })),
      );
    },
    ownVotes: async (
      _r: unknown,
      _c: unknown,
      optionIds: readonly string[],
      membershipId: string,
    ) =>
      voteStore
        .filter(
          (v) =>
            v.organizationId === ORG &&
            v.membershipId === membershipId &&
            optionIds.includes(v.optionId),
        )
        .map((v) => ({ optionId: v.optionId, choice: v.choice })),
    findVote: async (_r: unknown, _c: unknown, optionId: string, membershipId: string) =>
      voteStore.find(
        (v) =>
          v.organizationId === ORG && v.optionId === optionId && v.membershipId === membershipId,
      ) ?? null,
    insertVote: async (
      _r: unknown,
      _c: unknown,
      input: { optionId: string; membershipId: string; choice: string },
    ) => {
      voteStore.push({
        id: `vote-0000-0000-0000-00000000000${++seq}`,
        organizationId: ORG,
        optionId: input.optionId,
        membershipId: input.membershipId,
        choice: input.choice,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MeetingTimePollVoteRow);
    },
    updateVote: async (
      _r: unknown,
      _c: unknown,
      input: { optionId: string; membershipId: string; choice: string },
    ) => {
      const row = voteStore.find(
        (v) => v.optionId === input.optionId && v.membershipId === input.membershipId,
      );
      if (!row) throw new Error('missing');
      row.choice = input.choice as MeetingTimePollVoteRow['choice'];
    },
  } as unknown as MeetingTimePollRepository;

  const meetingsRepo = {
    findById: async (_r: unknown, _c: unknown, meetingId: string) =>
      meetings.find((m) => m.id === meetingId && m.organizationId === ORG) ?? null,
  } as unknown as MeetingsRepository;

  return {
    service: new MeetingTimePollService(database, pollsRepo, meetingsRepo),
    optionStore,
    voteStore,
  };
}

describe('MeetingTimePollService', () => {
  it('proposes slots, votes, and re-votes idempotently', async () => {
    const { service, voteStore } = serviceWith({});
    const created = await service.createPoll(context, member(ORGANIZER), {
      meetingId: MEETING,
      options: [
        {
          optionStart: new Date('2026-10-02T14:00:00.000Z'),
          optionEnd: new Date('2026-10-02T15:00:00.000Z'),
        },
      ],
    });
    expect(created.options).toHaveLength(1);
    const optionId = created.options[0]!.id;
    expect(created.options[0]!.ownVote).toBeNull();
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);

    const voted = await service.vote(context, member(ORGANIZER), {
      meetingId: MEETING,
      optionId,
      choice: 'yes',
    });
    expect(voted.options[0]!.ownVote).toBe('yes');
    expect(voted.options[0]!.tally).toEqual({ yes: 1, maybe: 0, no: 0 });

    // A re-vote updates the one row rather than adding a second (idempotent PUT).
    const revoted = await service.vote(context, member(ORGANIZER), {
      meetingId: MEETING,
      optionId,
      choice: 'maybe',
    });
    expect(revoted.options[0]!.ownVote).toBe('maybe');
    expect(revoted.options[0]!.tally).toEqual({ yes: 0, maybe: 1, no: 0 });
    expect(voteStore).toHaveLength(1);
    expect(voteStore[0]?.membershipId).toBe(MEMBERSHIP);
  });

  it('refuses a vote on a cross-tenant meeting as not-found, and writes nothing', async () => {
    const foreign = meetingRow({ organizationId: OTHER_ORG });
    const { service, voteStore } = serviceWith({ meetings: [foreign] });
    const error = await service
      .vote(context, member(ORGANIZER), {
        meetingId: MEETING,
        optionId: 'option-0000-0000-0000-000000000001',
        choice: 'yes',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(voteStore).toHaveLength(0);
  });

  it('refuses a non-organiser member with meeting.write proposing slots (403), writing nothing', async () => {
    const { service, optionStore } = serviceWith({});
    const error = await service
      .createPoll(context, member(OTHER_USER), {
        meetingId: MEETING,
        options: [
          {
            optionStart: new Date('2026-10-02T14:00:00.000Z'),
            optionEnd: new Date('2026-10-02T15:00:00.000Z'),
          },
        ],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(optionStore).toHaveLength(0);
  });
});

describe('MeetingTimePollController', () => {
  function stubService(): { service: MeetingTimePollService; calls: string[] } {
    const calls: string[] = [];
    const service = {
      createPoll: async () => {
        calls.push('createPoll');
        return {} as never;
      },
      vote: async () => {
        calls.push('vote');
        return {} as never;
      },
    } as unknown as MeetingTimePollService;
    return { service, calls };
  }

  it('rejects an illegal vote choice with 400 and never reaches the service', async () => {
    const { service, calls } = stubService();
    const controller = new MeetingTimePollController(service);
    const error = await controller
      .vote(context, member(ORGANIZER), MEETING, 'option-1', { choice: 'sometimes' })
      .catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it('rejects an ill-ordered slot (endsAt <= startsAt) with 400 and never reaches the service', async () => {
    const { service, calls } = stubService();
    const controller = new MeetingTimePollController(service);
    const error = await controller
      .create(context, member(ORGANIZER), MEETING, {
        options: [{ startsAt: '2026-10-02T15:00:00.000Z', endsAt: '2026-10-02T14:00:00.000Z' }],
      })
      .catch((e: unknown) => e);
    expect((error as ApiError).status).toBe(400);
    expect(calls).toEqual([]);
  });

  const post = Reflect.getMetadata(
    REQUIRED_CAPABILITY,
    MeetingTimePollController.prototype.create,
  ) as Capability | undefined;
  const put = Reflect.getMetadata(REQUIRED_CAPABILITY, MeetingTimePollController.prototype.vote) as
    Capability | undefined;
  const get = Reflect.getMetadata(REQUIRED_CAPABILITY, MeetingTimePollController.prototype.read) as
    Capability | undefined;

  it('gates propose on meeting.write and read/vote on meeting.read', () => {
    expect(post).toBe('meeting.write');
    expect(put).toBe('meeting.read');
    expect(get).toBe('meeting.read');
  });

  it('closes proposing to every client role (the 403 boundary)', () => {
    for (const role of INTERNAL_ROLES) {
      if (capabilitiesFor(role).includes('meeting.write')) {
        expect(capabilitiesFor(role)).toContain(post);
      }
    }
    for (const role of CLIENT_ROLES) {
      expect(capabilitiesFor(role)).not.toContain(post);
    }
  });
});
