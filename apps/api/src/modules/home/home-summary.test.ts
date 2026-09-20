import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomeService, STALE_FOLLOW_UP_WINDOW_MS } from './home.service.js';
import type { MyDayRepository } from './my-day.repository.js';
import type { WaitingRepository } from './waiting.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, ClientRequestRow, WorkItemRow } from '../../common/database/schema.js';

// HOME-01's hero summary is a pure aggregation over the My Day and Waiting reads — every count is
// derived from the same ranked lists the sections render, so it is proven over fakes here: no read
// of its own, no `.db.test.ts` owed. AC4: the hero shows no number the lists do not.
const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const ME = 'user-0000-0000-0000-0000-000000000001';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function item(overrides: Partial<WorkItemRow>): WorkItemRow {
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

function clientRequest(overrides: Partial<ClientRequestRow>): ClientRequestRow {
  return {
    id: 'client-request-0000-000000000000',
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    submittedByUserId: 'user-0000-0000-0000-0000-000000000009',
    title: 'A client request',
    category: 'general',
    description: 'Please do the thing.',
    urgencyReason: null,
    desiredAt: null,
    state: 'submitted',
    clarificationQuestion: null,
    clientVisibleReason: null,
    clientSafeScopeSummary: null,
    commitment: null,
    committedAt: null,
    linkedWorkItemId: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as ClientRequestRow;
}

// A `manager` holds work.read (personal work), approval.read + the reviewer relation (approvals),
// and client_request.triage (client requests), so the summary spans every bucket.
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

function serviceWith(
  workRows: readonly WorkItemRow[],
  approvalRows: readonly ApprovalRow[],
  clientRows: readonly ClientRequestRow[],
): HomeService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const myDay = {
    listOwnedOpen: async () => workRows,
  } as unknown as MyDayRepository;
  const waiting = {
    listPending: async () => approvalRows,
    listOpenClientRequests: async () => clientRows,
  } as unknown as WaitingRepository;
  return new HomeService(database, myDay, waiting);
}

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

describe('HomeService.summaryOf (HOME-01 hero)', () => {
  it('derives every count from the ranked My Day and Waiting lists (AC4)', async () => {
    const workRows = [
      item({ id: 'w-overdue-00000000000000000001', dueAt: new Date(NOW.getTime() - 1 * DAY) }),
      item({ id: 'w-duesoon-00000000000000000002', dueAt: new Date(NOW.getTime() + 1 * HOUR) }),
      item({ id: 'w-assigned-0000000000000000003', dueAt: null }),
    ];
    const approvalRows = [approval({ id: 'a-requested-0000000000000000001', state: 'requested' })];
    const clientRows = [
      clientRequest({ id: 'cr-submitted-000000000000000001', state: 'submitted' }),
      clientRequest({ id: 'cr-triage-00000000000000000002', state: 'triage' }),
      clientRequest({
        id: 'cr-stale-00000000000000000003',
        state: 'needs_clarification',
        updatedAt: new Date(NOW.getTime() - (STALE_FOLLOW_UP_WINDOW_MS + DAY)),
      }),
      // fresh clarification — on no bucket, so it lifts no count.
      clientRequest({
        id: 'cr-fresh-00000000000000000004',
        state: 'needs_clarification',
        updatedAt: new Date(NOW.getTime() - 1 * HOUR),
      }),
    ];

    const service = serviceWith(workRows, approvalRows, clientRows);

    const summary = await service.summaryOf(context, manager(), NOW);

    expect(summary).toEqual({
      personalWork: { total: 3, overdue: 1, dueSoon: 1 },
      waiting: { total: 4, approvals: 1, clientRequests: 2, staleFollowUps: 1 },
    });
  });

  it('reports zeros when nothing needs the caller', async () => {
    const summary = await serviceWith([], [], []).summaryOf(context, manager(), NOW);

    expect(summary).toEqual({
      personalWork: { total: 0, overdue: 0, dueSoon: 0 },
      waiting: { total: 0, approvals: 0, clientRequests: 0, staleFollowUps: 0 },
    });
  });
});
