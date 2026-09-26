import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { HomeService, STALE_FOLLOW_UP_WINDOW_MS } from './home.service.js';
import type { WaitingEntry } from './home.service.js';
import type { MyDayRepository } from './my-day.repository.js';
import type { WaitingRepository } from './waiting.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, ClientRequestRow } from '../../common/database/schema.js';

// HOME-04's Waiting ranking + the per-bucket relation/tenant filters + the stale-age test, proven
// over fakes: the `approvals` (x92) and `client_requests` (REQ-001) reads are already DB-proven,
// and the ranking, reviewer relation, triage relation and age test are pure over rows, so no
// `.db.test.ts` is owed. The delegated bucket is scoped out (no assignee column on `work_items`).
const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const ME = 'user-0000-0000-0000-0000-000000000001';
const SOMEONE_ELSE = 'user-0000-0000-0000-0000-000000000009';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** An entry's id and waiting-since instant, narrowing the discriminated union in assertions. */
function idOf(entry: WaitingEntry): string {
  return entry.kind === 'approval' ? entry.approvalId : entry.clientRequestId;
}
function sinceOf(entry: WaitingEntry): string {
  return entry.kind === 'approval' ? entry.requestedAt : entry.waitingSince;
}

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

/** Only the fields the reason, the triage relation and the age test read; the rest fill the row. */
function clientRequest(overrides: Partial<ClientRequestRow>): ClientRequestRow {
  return {
    id: 'client-request-0000-000000000000',
    organizationId: ORG,
    projectId: PROJECT,
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    submittedByUserId: SOMEONE_ELSE,
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

// A `member` holds `approval.read` but NOT `client_request.triage`, so it exercises the approval
// bucket and proves the triage relation drops every client request from a non-triager.
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

// A `manager` holds both `approval.read` (reviewer) and `client_request.triage`, so it exercises
// every bucket. Project-scoped, so a request on a project it is not on is dropped by `authorize`.
function triager(userId: string = ME, projectIds: readonly string[] = [PROJECT]): Principal {
  return { ...reviewer(userId, projectIds), role: 'manager' };
}

// The fake repository returns the canned rows; the service still applies the reviewer relation and
// `authorize` to approvals (a non-reviewer / cross-tenant row must drop) and the triage relation +
// age test to client requests (a non-triager / cross-tenant / fresh-clarification row must drop).
function serviceWith(
  rows: readonly ApprovalRow[],
  clientRows: readonly ClientRequestRow[] = [],
): HomeService {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const waiting = {
    listPending: async () => rows,
    listOpenClientRequests: async () => clientRows,
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
    expect(view.items.map((entry) => [idOf(entry), entry.reason])).toEqual([
      [requestedOlder.id, 'approval_requested'],
      [requestedNewer.id, 'approval_requested'],
      [viewedOld.id, 'approval_viewed'],
    ]);
    // Every entry is the extensible approval kind and carries the request instant as an ISO string.
    expect(view.items.every((entry) => entry.kind === 'approval')).toBe(true);
    const [first] = view.items;
    expect(first ? sinceOf(first) : undefined).toBe(
      new Date(NOW.getTime() - 2 * DAY).toISOString(),
    );
    expect(JSON.stringify(view)).not.toContain(OTHER_ORG);
    expect(JSON.stringify(view)).not.toContain(notMine.id);
  });

  it('breaks a time tie by approval id for a total, stable order', async () => {
    const tieB = approval({ id: 'a-tie-b-00000000000000000000002', createdAt: NOW });
    const tieA = approval({ id: 'a-tie-a-00000000000000000000001', createdAt: NOW });

    const service = serviceWith([tieB, tieA]);

    const view = await service.waitingOf(context, reviewer());

    expect(view.items.map((entry) => idOf(entry))).toEqual([tieA.id, tieB.id]);
  });

  it('returns no items for a reviewer with none, and drops an approval the user does not review', async () => {
    const empty = serviceWith([]);
    expect((await empty.waitingOf(context, reviewer())).items).toEqual([]);

    const othersOnly = serviceWith([approval({ reviewerIds: [SOMEONE_ELSE] })]);
    expect((await othersOnly.waitingOf(context, reviewer())).items).toEqual([]);
  });
});

describe('HomeService.waitingOf across the three buckets (x102)', () => {
  it('ranks approvals, client-wait and stale follow-ups in the documented total order, dropping cross-tenant and fresh-clarification rows (AC1, AC3)', async () => {
    const approvalRequested = approval({
      id: 'a-requested-0000000000000000001',
      state: 'requested',
      createdAt: new Date(NOW.getTime() - 1 * DAY),
    });
    const clientSubmitted = clientRequest({
      id: 'cr-submitted-000000000000000001',
      state: 'submitted',
      updatedAt: new Date(NOW.getTime() - 2 * DAY),
    });
    const clientTriage = clientRequest({
      id: 'cr-triage-00000000000000000002',
      state: 'triage',
      updatedAt: new Date(NOW.getTime() - 3 * DAY),
    });
    // needs_clarification aged past the window → the stale bucket.
    const staleClarification = clientRequest({
      id: 'cr-stale-00000000000000000003',
      state: 'needs_clarification',
      updatedAt: new Date(NOW.getTime() - (STALE_FOLLOW_UP_WINDOW_MS + DAY)),
    });
    // needs_clarification still fresh → on no bucket at all (genuinely waiting on the client).
    const freshClarification = clientRequest({
      id: 'cr-fresh-00000000000000000004',
      state: 'needs_clarification',
      updatedAt: new Date(NOW.getTime() - 1 * HOUR),
    });
    // A client request in another tenant — dropped by `authorize`, never selected.
    const foreignClient = clientRequest({
      id: 'cr-foreign-000000000000000009',
      organizationId: OTHER_ORG,
      projectId: 'project-0000-0000-0000-0000-000000000099',
      state: 'submitted',
      updatedAt: new Date(NOW.getTime() - 10 * DAY),
    });

    const service = serviceWith(
      [approvalRequested],
      [foreignClient, freshClarification, clientTriage, staleClarification, clientSubmitted],
    );

    const view = await service.waitingOf(context, triager(), NOW);

    // rank 0 approval_requested → 2 client_submitted → 3 client_triage → 4 stale_follow_up.
    expect(view.items.map((entry) => [idOf(entry), entry.kind, entry.reason])).toEqual([
      [approvalRequested.id, 'approval', 'approval_requested'],
      [clientSubmitted.id, 'client_request', 'client_submitted'],
      [clientTriage.id, 'client_request', 'client_triage'],
      [staleClarification.id, 'client_request', 'stale_follow_up'],
    ]);
    // The fresh clarification, the cross-tenant request and any delegated arm are all absent.
    const json = JSON.stringify(view);
    expect(json).not.toContain(freshClarification.id);
    expect(json).not.toContain(foreignClient.id);
    expect(json).not.toContain(OTHER_ORG);
    expect(
      view.items.every((entry) => entry.kind === 'approval' || entry.kind === 'client_request'),
    ).toBe(true);
    // The client-wait row carries its own title and the "waiting since" is updated_at.
    const submittedEntry = view.items.find((entry) => idOf(entry) === clientSubmitted.id);
    expect(submittedEntry && sinceOf(submittedEntry)).toBe(
      new Date(NOW.getTime() - 2 * DAY).toISOString(),
    );
  });

  it('drops every client request from a caller without client_request.triage, as the requests module refuses it (AC2)', async () => {
    const submitted = clientRequest({ id: 'cr-notriage-00000000000000001', state: 'submitted' });
    const stale = clientRequest({
      id: 'cr-notriage-stale-000000000002',
      state: 'needs_clarification',
      updatedAt: new Date(NOW.getTime() - (STALE_FOLLOW_UP_WINDOW_MS + DAY)),
    });

    // `reviewer()` is a `member`: holds approval.read, not client_request.triage.
    const service = serviceWith([], [submitted, stale]);

    expect((await service.waitingOf(context, reviewer(), NOW)).items).toEqual([]);
  });

  it('drops a client request on a project the triager is not a member of', async () => {
    const offProject = clientRequest({
      id: 'cr-offproject-0000000000000001',
      projectId: 'project-0000-0000-0000-0000-000000000077',
      state: 'submitted',
    });

    const service = serviceWith([], [offProject]);

    // Triager scoped to PROJECT only → authorize denies (not_project_member).
    expect((await service.waitingOf(context, triager(ME, [PROJECT]), NOW)).items).toEqual([]);
  });
});
