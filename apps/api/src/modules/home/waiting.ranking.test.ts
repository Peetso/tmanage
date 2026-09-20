import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomeService } from './home.service.js';
import type { MyDayRepository } from './my-day.repository.js';
import type { WaitingRepository } from './waiting.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow } from '../../common/database/schema.js';

// HOME-04's Waiting ranking + the reviewer/tenant filters, proven over fakes: the `approvals`
// read is already DB-proven (x92) and the ranking + reviewer relation is pure over rows, so no
// `.db.test.ts` is owed. The delegated bucket is scoped out (no assignee column on `work_items`).
const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const ME = 'user-0000-0000-0000-0000-000000000001';
const SOMEONE_ELSE = 'user-0000-0000-0000-0000-000000000009';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Only the fields the ranking and the two filters read; the rest are filled so the row is whole. */
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

function reviewer(userId: string = ME, projectIds: readonly string[] = [PROJECT]): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: false,
  };
}

// The fake repository returns the canned rows; the service still applies the reviewer relation
// (a non-reviewer's approval must be dropped) and `authorize` (a cross-tenant row must be dropped).
function serviceWith(rows: readonly ApprovalRow[]): HomeService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const waiting = {
    listPending: async () => rows,
  } as unknown as WaitingRepository;
  const myDay = {} as unknown as MyDayRepository;
  return new HomeService(database, myDay, waiting);
}

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

describe('HomeService.waitingOf ranking', () => {
  it('ranks requested before viewed, oldest first, dropping non-reviewer and cross-tenant rows', async () => {
    // Shuffled input; ids chosen so id-order and time-order disagree.
    const requestedOlder = approval({
      id: 'a-requested-older-00000000000002',
      state: 'requested',
      createdAt: new Date(NOW.getTime() - 2 * DAY),
    });
    const requestedNewer = approval({
      id: 'a-requested-newer-00000000000001',
      state: 'requested',
      createdAt: new Date(NOW.getTime() - 1 * HOUR),
    });
    const viewedOld = approval({
      id: 'a-viewed-000000000000000000000003',
      state: 'viewed',
      createdAt: new Date(NOW.getTime() - 3 * DAY),
    });
    // ME is not a reviewer — must never appear, even though it is the oldest (would rank first).
    const notMine = approval({
      id: 'a-not-a-reviewer-000000000000004',
      state: 'requested',
      reviewerIds: [SOMEONE_ELSE],
      createdAt: new Date(NOW.getTime() - 10 * DAY),
    });
    // A reviewer relation in another tenant — dropped by the tenant check, not the reviewer one.
    const foreign = approval({
      id: 'a-foreign-0000000000000000000009',
      organizationId: OTHER_ORG,
      projectId: 'project-0000-0000-0000-0000-000000000099',
      reviewerIds: [ME],
      createdAt: new Date(NOW.getTime() - 5 * DAY),
    });

    const service = serviceWith([requestedNewer, viewedOld, notMine, foreign, requestedOlder]);

    const view = await service.waitingOf(context, reviewer());

    // Requested (oldest first), then viewed; the non-reviewer and foreign rows are gone.
    expect(view.items.map((entry) => [entry.approvalId, entry.reason])).toEqual([
      [requestedOlder.id, 'approval_requested'],
      [requestedNewer.id, 'approval_requested'],
      [viewedOld.id, 'approval_viewed'],
    ]);
    // Every entry is the extensible approval kind and carries the request instant as an ISO string.
    expect(view.items.every((entry) => entry.kind === 'approval')).toBe(true);
    const [first] = view.items;
    expect(first?.requestedAt).toBe(new Date(NOW.getTime() - 2 * DAY).toISOString());
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
    expect(JSON.stringify(view)).not.toContain(notMine.id);
  });

  it('breaks a time tie by approval id for a total, stable order', async () => {
    const tieB = approval({ id: 'a-tie-b-00000000000000000000002', createdAt: NOW });
    const tieA = approval({ id: 'a-tie-a-00000000000000000000001', createdAt: NOW });

    const service = serviceWith([tieB, tieA]);

    const view = await service.waitingOf(context, reviewer());

    expect(view.items.map((entry) => entry.approvalId)).toEqual([tieA.id, tieB.id]);
  });

  it('returns no items for a reviewer with none, and drops an approval the user does not review', async () => {
    const empty = serviceWith([]);
    expect((await empty.waitingOf(context, reviewer())).items).toEqual([]);

    const othersOnly = serviceWith([approval({ reviewerIds: [SOMEONE_ELSE] })]);
    expect((await othersOnly.waitingOf(context, reviewer())).items).toEqual([]);
  });
});
