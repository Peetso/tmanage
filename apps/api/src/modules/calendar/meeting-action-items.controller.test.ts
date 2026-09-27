import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { CLIENT_ROLES, INTERNAL_ROLES, capabilitiesFor } from '@tmanage/domain';
import type { Capability } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { MeetingActionItemsController } from './meeting-action-items.controller.js';
import { MeetingActionItemsService } from './meeting-action-items.service.js';
import type { MeetingActionItemsRepository } from './meeting-action-items.repository.js';
import type { MeetingsRepository } from './meetings.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  MeetingActionItemRow,
  MeetingRow,
  MembershipRow,
} from '../../common/database/schema.js';

/**
 * CAL / MTG-03 meeting action items (x266) proofs — database-free over the module's fakes and with
 * the *real* `authorize()` in the loop. The SQL round-trip and the migration are the chain's DB
 * suites, not re-proven here. What only this file proves is the slice's own logic:
 *
 * - capture → list for a project member (the happy path);
 * - a cross-tenant meeting is 404 with no insert (the Known-trap order, the slice's refusal test);
 * - the routes declare `meeting.write`/`meeting.read`, held by internal roles and no client role.
 *
 * The fakes deliberately do **not** re-apply the tenant scope the real SQL applies, so the service's
 * own resolution must carry the isolation.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const MEETING = 'meeting-0000-0000-0000-00000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

function member(projectIds: readonly string[], hasOrgWideScope = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: hasOrgWideScope ? 'owner' : 'member',
    membershipId: 'membership-0000-0000-0000-0000-0000000009',
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

function serviceWith(options: { meetings?: readonly MeetingRow[] }): {
  service: MeetingActionItemsService;
  store: MeetingActionItemRow[];
} {
  const meetings = options.meetings ?? [meetingRow()];
  const store: MeetingActionItemRow[] = [];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repo = {
    list: async (_r: unknown, _c: unknown, o: { readonly meetingId: string }) =>
      store.filter((row) => row.meetingId === o.meetingId),
    findById: async (_r: unknown, _c: unknown, id: string) =>
      store.find((row) => row.id === id && row.organizationId === ORG) ?? null,
    create: async (
      _r: unknown,
      _c: unknown,
      input: {
        readonly meetingId: string;
        readonly title: string;
        readonly ownerMembershipId: string | null;
        readonly dueOn: string | null;
      },
    ) => {
      const row = {
        id: `action-0000-0000-0000-00000000000${++seq}`,
        organizationId: ORG,
        meetingId: input.meetingId,
        title: input.title,
        ownerMembershipId: input.ownerMembershipId,
        dueOn: input.dueOn,
        status: 'open',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as MeetingActionItemRow;
      store.push(row);
      return row;
    },
  } as unknown as MeetingActionItemsRepository;

  const meetingsRepo = {
    findById: async (_r: unknown, _c: unknown, id: string) =>
      meetings.find((m) => m.id === id && m.organizationId === ORG) ?? null,
  } as unknown as MeetingsRepository;

  const membershipsRepo = {
    findById: async (_r: unknown, _c: unknown, id: string) => ({ id }) as unknown as MembershipRow,
  } as unknown as MembershipsRepository;

  return {
    service: new MeetingActionItemsService(database, repo, meetingsRepo, membershipsRepo),
    store,
  };
}

describe('MeetingActionItemsService', () => {
  it('captures an action item on a readable meeting, then lists it', async () => {
    const { service } = serviceWith({});
    const created = await service.create(context, member([PROJECT]), {
      meetingId: MEETING,
      title: 'Send the deck',
      ownerMembershipId: null,
      dueOn: '2026-10-05',
    });
    expect(created.title).toBe('Send the deck');
    expect(created.status).toBe('open');
    expect(created.dueOn).toBe('2026-10-05');
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(created)).not.toContain(ORG);

    const listed = await service.list(context, member([PROJECT]), { meetingId: MEETING });
    expect(listed.map((a) => a.id)).toEqual([created.id]);
  });

  it('refuses to capture on a cross-tenant meeting as not-found, and writes nothing', async () => {
    // The meeting exists only in another tenant, so it does not resolve inside ORG → 404, before
    // any write. An org-wide caller (who would pass the relation gate) still gets not-found.
    const foreign = meetingRow({ id: MEETING, organizationId: OTHER_ORG });
    const { service, store } = serviceWith({ meetings: [foreign] });
    const error = await service
      .create(context, member([], true), {
        meetingId: MEETING,
        title: 'Leak attempt',
        ownerMembershipId: null,
        dueOn: null,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});

describe('MeetingActionItemsController', () => {
  it('rejects an empty title with 400 and never reaches the service', async () => {
    let called = false;
    const service = {
      create: async () => {
        called = true;
        return {} as never;
      },
    } as unknown as MeetingActionItemsService;
    const controller = new MeetingActionItemsController(service);

    const error = await controller
      .create(context, member([PROJECT]), MEETING, { title: '   ' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(called).toBe(false);
  });

  const create = Reflect.getMetadata(
    REQUIRED_CAPABILITY,
    MeetingActionItemsController.prototype.create,
  ) as Capability | undefined;
  const list = Reflect.getMetadata(
    REQUIRED_CAPABILITY,
    MeetingActionItemsController.prototype.list,
  ) as Capability | undefined;

  it('gates write on meeting.write and read on meeting.read', () => {
    expect(create).toBe('meeting.write');
    expect(list).toBe('meeting.read');
  });

  it('closes the write to every client role (the 403 boundary)', () => {
    for (const role of INTERNAL_ROLES) {
      if (capabilitiesFor(role).includes('meeting.write')) {
        expect(capabilitiesFor(role)).toContain(create);
      }
    }
    for (const role of CLIENT_ROLES) {
      expect(capabilitiesFor(role)).not.toContain(create);
    }
  });
});
