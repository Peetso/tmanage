import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomeService } from './home.service.js';
import { HomePulseService, dayWindow } from './home-pulse.service.js';
import type { HomePulseRepository } from './home-pulse.repository.js';
import type { MyDayRepository } from './my-day.repository.js';
import type { WaitingRepository } from './waiting.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  ApprovalRow,
  ClientRequestRow,
  MeetingRow,
  WorkItemRow,
} from '../../common/database/schema.js';

// HOME-01's Focus/Pulse summary is a pure count over the acting user's own open work, the tenant's
// meetings-today, and the Waiting reads — proven over fakes with the *real* `authorize`, so no read
// of its own and no `.db.test.ts` owed (pass-20 rules). The counts name the acting user + tenant
// only: a row the caller may not read never lifts a number, and a client principal counts nothing.
const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const OTHER_PROJECT = 'project-0000-0000-0000-0000-000000000002';
const ME = 'user-0000-0000-0000-0000-000000000001';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const TODAY = new Date('2026-09-20T09:00:00.000Z');
const TOMORROW = new Date('2026-09-21T09:00:00.000Z');

function work(overrides: Partial<WorkItemRow>): WorkItemRow {
  return {
    id: 'work-0000-0000-0000-0000-000000000000',
    organizationId: ORG,
    projectId: PROJECT,
    type: 'task',
    title: 'a task',
    state: 'in_progress',
    ownerUserId: ME,
    audience: 'internal',
    startAt: null,
    dueAt: null,
    completedAt: null,
    version: 1n,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  } as unknown as WorkItemRow;
}

function meeting(overrides: Partial<MeetingRow>): MeetingRow {
  return {
    id: 'meeting-0000-0000-0000-000000000000',
    organizationId: ORG,
    projectId: PROJECT,
    title: 'a meeting',
    startsAt: TODAY,
    agendaNote: null,
    createdByUserId: ME,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as MeetingRow;
}

function approval(overrides: Partial<ApprovalRow>): ApprovalRow {
  return {
    id: 'approval-0000-0000-0000-000000000000',
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: 'deliverable-0000-0000-0000-00000001',
    deliverableVersionId: 'version-0000-0000-0000-000000001',
    contentHash: 'a'.repeat(64),
    state: 'requested',
    policy: 'all_required',
    reviewerIds: [ME],
    decidedByUserId: null,
    decidedAt: null,
    feedback: null,
    invalidationReason: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as ApprovalRow;
}

// A `manager` scoped to PROJECT: holds work.read there (own work + meetings) and approval.read +
// the reviewer relation (waiting), but is NOT org-wide, so rows in OTHER_PROJECT/OTHER_ORG fail the
// relation check even if a read leaked them.
function manager(): Principal {
  return {
    userId: ME,
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

function client(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000099',
    organizationId: ORG,
    kind: 'client',
    role: 'client_reviewer',
    membershipId: 'membership-0000-0000-000000000099',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

function serviceWith(args: {
  workRows: readonly WorkItemRow[];
  meetingRows: readonly MeetingRow[];
  approvalRows?: readonly ApprovalRow[];
  clientRows?: readonly ClientRequestRow[];
}): HomePulseService {
  const database = {
    read: async (_context: unknown, workFn: (db: unknown) => Promise<unknown>) => workFn({}),
  } as unknown as TenantDatabase;
  const pulse = {
    listOwnedOpen: async () => args.workRows,
    listMeetingsInWindow: async () => args.meetingRows,
  } as unknown as HomePulseRepository;
  // A real HomeService (real `authorize`) over fake reads, so the reused waiting count is genuinely
  // gated per bucket rather than stubbed.
  const myDay = { listOwnedOpen: async () => [] } as unknown as MyDayRepository;
  const waiting = {
    listPending: async () => args.approvalRows ?? [],
    listOpenClientRequests: async () => args.clientRows ?? [],
  } as unknown as WaitingRepository;
  const home = new HomeService(database, myDay, waiting);
  return new HomePulseService(database, pulse, home);
}

describe('dayWindow', () => {
  it('is the half-open UTC day containing now', () => {
    const { from, to } = dayWindow(NOW);
    expect(from.toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
});

describe('HomePulseService.pulseOf (HOME-01 Focus)', () => {
  it('counts the acting user + tenant only, due-today windowed, meetings-today gated', async () => {
    const service = serviceWith({
      workRows: [
        work({ id: 'w-today-000000000000000000001', dueAt: TODAY }),
        work({ id: 'w-tomorrow-0000000000000000002', dueAt: TOMORROW }),
        work({ id: 'w-nodue-000000000000000000003', dueAt: null }),
        // A row a leaky read might return but the caller has no relation to — excluded by authorize.
        work({ id: 'w-foreign-00000000000000000004', projectId: OTHER_PROJECT, dueAt: TODAY }),
      ],
      meetingRows: [
        meeting({ id: 'm-mine-0000000000000000000001' }),
        // Foreign-project meeting the read window returned — the caller cannot read it.
        meeting({ id: 'm-foreign-00000000000000000002', projectId: OTHER_PROJECT }),
      ],
      approvalRows: [approval({ id: 'a-requested-0000000000000000001' })],
    });

    const pulse = await service.pulseOf(context, manager(), NOW);

    expect(pulse).toEqual({
      openWork: 3, // three readable own rows; the foreign-project row is excluded
      dueToday: 1, // only the row due inside today's UTC window
      waitingOnYou: 1, // the one pending approval the caller reviews
      meetingsToday: 1, // only the meeting in a project the caller may read
    });
  });

  it('counts nothing for a client principal (no work.read)', async () => {
    const service = serviceWith({
      workRows: [
        work({ id: 'w-today-000000000000000000001', dueAt: TODAY, ownerUserId: client().userId }),
      ],
      meetingRows: [meeting({ id: 'm-mine-0000000000000000000001' })],
      approvalRows: [approval({ id: 'a-requested-0000000000000000001' })],
    });

    const pulse = await service.pulseOf(context, client(), NOW);

    expect(pulse).toEqual({ openWork: 0, dueToday: 0, waitingOnYou: 0, meetingsToday: 0 });
  });
});
