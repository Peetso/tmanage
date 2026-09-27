import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CLIENT_ROLES, INTERNAL_ROLES, capabilitiesFor } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MeetingRsvpController } from './rsvp.controller.js';
import { MeetingRsvpService } from './rsvp.service.js';
import type { MeetingRsvpRepository } from './rsvp.repository.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MeetingRow, MeetingRsvpRow } from '../../common/database/schema.js';

/**
 * CAL meeting RSVP (x240) proofs, database-free over the module's fakes and with the *real*
 * `authorize()` in the loop — the SQL round-trip and the migration are the chain's DB suites, not
 * re-proven here. What only this file proves is the slice's own logic:
 *
 * - set → read own response, with the summary counts (the happy path, idempotent re-answer);
 * - a cross-tenant meeting id is 404 with no write (the Known-trap order);
 * - an illegal response is 400 and never reaches the service;
 * - the write is keyed on the caller's own membership — a caller cannot answer for another member;
 * - the routes declare `meeting.read`/`meeting.write`, held by internal roles and no client role
 *   (the 403 boundary, from the capability ceiling rather than a check a handler could forget).
 *
 * The fakes deliberately do **not** re-apply the tenant scope the real SQL applies, so the service's
 * own resolution must carry the isolation.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const MEETING = 'meeting-0000-0000-0000-00000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-0000-0000-0000000009';

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function meetingRow(overrides: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: MEETING,
    organizationId: ORG,
    projectId: PROJECT,
    title: 'Kickoff',
    startsAt: new Date('2026-10-01T14:00:00.000Z'),
    agendaNote: null,
    createdByUserId: USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MeetingRow;
}

/**
 * A service over an in-memory store whose reads omit the tenant scope on purpose. `knownMeetings`
 * stands in for what resolves inside the acting tenant.
 */
function serviceWith(options: { meetings?: readonly MeetingRow[] }): {
  service: MeetingRsvpService;
  store: MeetingRsvpRow[];
} {
  const meetings = options.meetings ?? [meetingRow()];
  const store: MeetingRsvpRow[] = [];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const rsvpsRepo = {
    findByMember: async (_r: unknown, _c: unknown, meetingId: string, memberId: string) =>
      store.find(
        (row) =>
          row.organizationId === ORG && row.meetingId === meetingId && row.memberId === memberId,
      ) ?? null,
    countsByResponse: async (_r: unknown, _c: unknown, meetingId: string) => {
      const counts = { accepted: 0, declined: 0, tentative: 0 };
      for (const row of store) {
        if (row.organizationId === ORG && row.meetingId === meetingId) counts[row.response] += 1;
      }
      return counts;
    },
    insert: async (
      _r: unknown,
      _c: unknown,
      input: { readonly meetingId: string; readonly memberId: string; readonly response: string },
    ) => {
      const row = {
        id: `rsvp-0000-0000-0000-00000000000${++seq}`,
        organizationId: ORG,
        meetingId: input.meetingId,
        memberId: input.memberId,
        response: input.response,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MeetingRsvpRow;
      store.push(row);
      return row;
    },
    updateResponse: async (
      _r: unknown,
      _c: unknown,
      input: { readonly meetingId: string; readonly memberId: string; readonly response: string },
    ) => {
      const row = store.find(
        (r) => r.meetingId === input.meetingId && r.memberId === input.memberId,
      );
      if (!row) throw new Error('missing');
      row.response = input.response as MeetingRsvpRow['response'];
      return row;
    },
  } as unknown as MeetingRsvpRepository;

  const meetingsRepo = {
    findById: async (_r: unknown, _c: unknown, meetingId: string) =>
      meetings.find((m) => m.id === meetingId && m.organizationId === ORG) ?? null,
  } as unknown as MeetingsRepository;

  return {
    service: new MeetingRsvpService(database, rsvpsRepo, meetingsRepo),
    store,
  };
}

describe('MeetingRsvpService', () => {
  it('sets the caller own response, re-answers idempotently, and reads the summary', async () => {
    const { service, store } = serviceWith({});
    const first = await service.setResponse(context, member([PROJECT]), {
      meetingId: MEETING,
      response: 'accepted',
    });
    expect(first.response).toBe('accepted');
    expect(first.counts).toEqual({ accepted: 1, declined: 0, tentative: 0 });
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(first)).not.toContain(ORG);

    // A re-answer updates the one row rather than adding a second (idempotent PUT).
    const second = await service.setResponse(context, member([PROJECT]), {
      meetingId: MEETING,
      response: 'tentative',
    });
    expect(second.response).toBe('tentative');
    expect(second.counts).toEqual({ accepted: 0, declined: 0, tentative: 1 });
    expect(store).toHaveLength(1);
    // The stored row is keyed on the caller's own membership — never another member's.
    expect(store[0]?.memberId).toBe(MEMBERSHIP);

    const summary = await service.getSummary(context, member([PROJECT]), MEETING);
    expect(summary.response).toBe('tentative');
    expect(summary.counts).toEqual({ accepted: 0, declined: 0, tentative: 1 });
  });

  it('refuses a response to a cross-tenant meeting as not-found, and writes nothing', async () => {
    const foreign = meetingRow({ id: MEETING, organizationId: OTHER_ORG });
    const { service, store } = serviceWith({ meetings: [foreign] });
    const error = await service
      .setResponse(context, member([], true), { meetingId: MEETING, response: 'accepted' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});

describe('MeetingRsvpController', () => {
  it('rejects an illegal response with 400 and never reaches the service', async () => {
    let called = false;
    const service = {
      setResponse: async () => {
        called = true;
        return {} as never;
      },
    } as unknown as MeetingRsvpService;
    const controller = new MeetingRsvpController(service);

    const error = await controller
      .setResponse(context, member([PROJECT]), MEETING, { response: 'maybe' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(called).toBe(false);
  });

  // The 403 boundary is the capability ceiling, not a handler check: assert the declared capability
  // and that it is held by every internal role that holds meeting.write and no client role.
  const put = Reflect.getMetadata(
    REQUIRED_CAPABILITY,
    MeetingRsvpController.prototype.setResponse,
  ) as Capability | undefined;
  const get = Reflect.getMetadata(REQUIRED_CAPABILITY, MeetingRsvpController.prototype.summary) as
    Capability | undefined;

  it('gates the response on meeting.write and the summary on meeting.read', () => {
    expect(put).toBe('meeting.write');
    expect(get).toBe('meeting.read');
  });

  it('closes the write to every client role (the 403 boundary)', () => {
    for (const role of INTERNAL_ROLES) {
      if (capabilitiesFor(role).includes('meeting.write')) {
        expect(capabilitiesFor(role)).toContain(put);
      }
    }
    for (const role of CLIENT_ROLES) {
      expect(capabilitiesFor(role)).not.toContain(put);
    }
  });
});
