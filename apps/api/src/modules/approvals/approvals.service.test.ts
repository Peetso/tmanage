import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { approvalStateMachine } from '@tmanage/domain';
import type { ApprovalState } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ApprovalRow, DeliverableVersionRow } from '../../common/database/schema.js';
import { ApprovalsService } from './approvals.service.js';
import {
  ApprovalNotFoundError,
  ApprovalTransitionError,
  ApprovalVersionConflictError,
} from './approvals.repository.js';
import type { ApprovalDecisionFacts } from './approvals.repository.js';
import type { ApprovalsRepository } from './approvals.repository.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';

/**
 * FR-05's decision behaviour, with fakes for the two repositories.
 *
 * The three things only the service can get wrong, and that the DB round-trip does not need to
 * repeat: the reviewer relation is the real gate (AUTH-08), the decision re-checks the captured
 * hash against the current governed version (INT-16/INT-17), and a decided approval carries the
 * immutable actor, time and hash (US-C03). The fakes stand in for the database only — `authorize()`
 * and `approvalStateMachine` run for real, so the object-layer decision and the append-only
 * lifecycle are exercised, not mocked.
 */

const ORG = '00000000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-7000-8000-0000000000b1';
const PROJECT = '00000000-0000-7000-8000-0000000000c1';
const DELIVERABLE = '00000000-0000-7000-8000-0000000000d1';
const VERSION = '00000000-0000-7000-8000-0000000000e1';
const REVIEWER = '00000000-0000-7000-8000-0000000000f1';
const OUTSIDER = '00000000-0000-7000-8000-0000000000f2';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

/** A workspace admin — holds `approval.decide` and `deliverable.review` in its ceiling. */
function reviewer(userId: string): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role: 'workspace_admin',
    membershipId: '00000000-0000-7000-8000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG } as TenantContext;

function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: '00000000-0000-7000-8000-000000000aa1',
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: DELIVERABLE,
    deliverableVersionId: VERSION,
    contentHash: HASH_A,
    state: 'requested',
    policy: 'all_required',
    reviewerIds: [REVIEWER],
    decidedByUserId: null,
    decidedAt: null,
    feedback: null,
    invalidationReason: null,
    version: 1,
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    ...overrides,
  };
}

function versionRow(contentHash: string): DeliverableVersionRow {
  return {
    id: VERSION,
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: DELIVERABLE,
    contentHash,
    createdByUserId: REVIEWER,
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
  };
}

/** A fake database whose `transaction` runs the unit of work with an ignored runner. */
function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    transaction: <T>(_c: TenantContext, work: (tx: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** An in-memory approvals repository that validates transitions with the real state machine. */
class FakeApprovals {
  constructor(private row: ApprovalRow) {}

  current(): ApprovalRow {
    return { ...this.row };
  }

  async requireById(_tx: never, _c: TenantContext, id: string): Promise<ApprovalRow> {
    if (id !== this.row.id) throw new ApprovalNotFoundError(id);
    return { ...this.row };
  }

  async transition(
    _tx: never,
    _c: TenantContext,
    id: string,
    expectedVersion: number,
    to: ApprovalState,
    facts: ApprovalDecisionFacts = {},
  ): Promise<ApprovalRow> {
    if (id !== this.row.id) throw new ApprovalNotFoundError(id);
    const from = this.row.state as ApprovalState;
    const verdict = approvalStateMachine.transition(from, to, {
      decidedByUserId: facts.decidedByUserId ?? null,
      decidedAt: facts.decidedAt ?? null,
      contentHash: facts.contentHash ?? null,
      feedback: facts.feedback ?? null,
      invalidationReason: facts.invalidationReason ?? null,
    });
    if (!verdict.ok) {
      throw new ApprovalTransitionError(from, to, verdict.reason, verdict.missing, verdict.detail);
    }
    if (this.row.version !== expectedVersion) {
      throw new ApprovalVersionConflictError(id, this.row.version);
    }
    this.row = {
      ...this.row,
      state: to,
      version: this.row.version + 1,
      updatedAt: new Date(),
      ...(facts.decidedByUserId !== undefined ? { decidedByUserId: facts.decidedByUserId } : {}),
      ...(facts.decidedAt !== undefined ? { decidedAt: facts.decidedAt } : {}),
      ...(facts.feedback !== undefined ? { feedback: facts.feedback } : {}),
      ...(facts.invalidationReason !== undefined
        ? { invalidationReason: facts.invalidationReason }
        : {}),
    };
    return { ...this.row };
  }
}

class FakeVersions {
  constructor(private readonly latest: DeliverableVersionRow | null) {}
  async latestForDeliverable(): Promise<DeliverableVersionRow | null> {
    return this.latest;
  }
  async requireById(): Promise<DeliverableVersionRow> {
    if (!this.latest) throw new Error('no version');
    return this.latest;
  }
}

function service(approvals: FakeApprovals, versions: FakeVersions): ApprovalsService {
  return new ApprovalsService(
    fakeDatabase(),
    approvals as unknown as ApprovalsRepository,
    versions as unknown as DeliverableVersionsRepository,
  );
}

describe('ApprovalsService.decide', () => {
  it('records an immutable approval over the current governed version (open→viewed→approve)', async () => {
    const approvals = new FakeApprovals(approvalRow());
    const svc = service(approvals, new FakeVersions(versionRow(HASH_A)));

    const view = await svc.decide(context, reviewer(REVIEWER), approvalRow().id, {
      decision: 'approve',
      expectedVersion: 1,
    });

    expect(view.state).toBe('approved');
    expect(view.decidedByUserId).toBe(REVIEWER);
    expect(view.decidedAt).not.toBeNull();
    expect(view.contentHash).toBe(HASH_A);
    // requested -> viewed -> approved is two writes off the seeded version.
    expect(view.version).toBe(3);
    expect(approvals.current().state).toBe('approved');
  });

  it('refuses a decision from a principal who is not an assigned reviewer (AUTH-08)', async () => {
    // The outsider holds approval.decide in its ceiling, but is not in reviewer_ids.
    const approvals = new FakeApprovals(approvalRow({ reviewerIds: [REVIEWER] }));
    const svc = service(approvals, new FakeVersions(versionRow(HASH_A)));

    const error = await svc
      .decide(context, reviewer(OUTSIDER), approvalRow().id, {
        decision: 'approve',
        expectedVersion: 1,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).auditCode).toBe('not_assigned_reviewer');
    // The refusal wrote nothing: the approval is still pending.
    expect(approvals.current().state).toBe('requested');
    expect(approvals.current().decidedByUserId).toBeNull();
  });

  it('invalidates a pending approval when the governed content has changed (INT-17)', async () => {
    // Captured HASH_A; the deliverable's current version is now HASH_B.
    const approvals = new FakeApprovals(approvalRow({ contentHash: HASH_A }));
    const svc = service(approvals, new FakeVersions(versionRow(HASH_B)));

    const view = await svc.decide(context, reviewer(REVIEWER), approvalRow().id, {
      decision: 'approve',
      expectedVersion: 1,
    });

    expect(view.state).toBe('invalidated');
    expect(view.decidedByUserId).toBeNull();
    expect(view.invalidationReason).not.toBeNull();
    expect(approvals.current().state).toBe('invalidated');
  });

  it('records feedback when changes are requested (FR-05)', async () => {
    const approvals = new FakeApprovals(approvalRow());
    const svc = service(approvals, new FakeVersions(versionRow(HASH_A)));

    const view = await svc.decide(context, reviewer(REVIEWER), approvalRow().id, {
      decision: 'request_changes',
      expectedVersion: 1,
      feedback: 'Tighten the hero headline.',
    });

    expect(view.state).toBe('changes_requested');
    expect(view.feedback).toBe('Tighten the hero headline.');
    expect(view.decidedByUserId).toBe(REVIEWER);
  });

  it('rejects request_changes with no feedback (FR-05) before touching the row', async () => {
    const approvals = new FakeApprovals(approvalRow());
    const svc = service(approvals, new FakeVersions(versionRow(HASH_A)));

    const error = await svc
      .decide(context, reviewer(REVIEWER), approvalRow().id, {
        decision: 'request_changes',
        expectedVersion: 1,
        feedback: '   ',
      })
      .catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(422);
    expect(approvals.current().state).toBe('requested');
  });

  it('refuses to re-decide a terminal approval (append-only, INT-16)', async () => {
    const approvals = new FakeApprovals(approvalRow({ state: 'approved', version: 3 }));
    const svc = service(approvals, new FakeVersions(versionRow(HASH_A)));

    const error = await svc
      .decide(context, reviewer(REVIEWER), approvalRow().id, {
        decision: 'approve',
        expectedVersion: 3,
      })
      .catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).auditCode).toBe('approval_terminal');
  });

  it('rejects a cross-tenant decision — the resource never resolves', async () => {
    const approvals = new FakeApprovals(approvalRow());
    const svc = service(approvals, new FakeVersions(versionRow(HASH_A)));
    const foreign = { ...reviewer(REVIEWER), organizationId: OTHER_ORG };

    const error = await svc
      .decide(context, foreign, approvalRow().id, { decision: 'approve', expectedVersion: 1 })
      .catch((e: unknown) => e);

    // authorize() denies on tenant mismatch before any object reasoning; the service maps it to 404.
    expect((error as ApiError).status).toBe(404);
    expect(approvals.current().state).toBe('requested');
  });
});
