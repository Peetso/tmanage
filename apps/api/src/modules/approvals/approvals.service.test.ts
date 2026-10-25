import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { approvalStateMachine, assertSafeAuditMetadata } from '@tmanage/domain';
import type { ApprovalState, RecordedReviewerDecision } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
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
import { DeliverableVersionNotFoundError } from './deliverable-versions.repository.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import { ClientProjectionNotFoundError } from './client-projections.repository.js';
import type { ClientProjectionsRepository } from './client-projections.repository.js';
import type { ClientProjectionRow } from '../../common/database/schema.js';

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
    versionNo: 1,
    contentHash,
    fileAssetId: null,
    fileVersionId: null,
    note: null,
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
  /** The per-reviewer decisions (0235, F15), as the real repository stores them. */
  readonly decisions: RecordedReviewerDecision[] = [];

  constructor(private row: ApprovalRow) {}

  current(): ApprovalRow {
    return { ...this.row };
  }

  async reviewerDecisions(): Promise<readonly RecordedReviewerDecision[]> {
    return [...this.decisions];
  }

  async recordReviewerDecision(
    _tx: never,
    _c: TenantContext,
    input: {
      approvalId: string;
      reviewerUserId: string;
      decision: RecordedReviewerDecision['decision'];
    },
  ): Promise<void> {
    if (this.decisions.some((d) => d.reviewerUserId === input.reviewerUserId)) {
      throw new Error('duplicate reviewer decision');
    }
    this.decisions.push({ reviewerUserId: input.reviewerUserId, decision: input.decision });
  }

  async touch(_tx: never, _c: TenantContext, id: string, expectedVersion: number) {
    if (id !== this.row.id) throw new ApprovalNotFoundError(id);
    if (this.row.version !== expectedVersion) {
      throw new ApprovalVersionConflictError(id, this.row.version);
    }
    this.row = { ...this.row, version: this.row.version + 1 };
    return { ...this.row };
  }

  async requireById(_tx: never, _c: TenantContext, id: string): Promise<ApprovalRow> {
    if (id !== this.row.id) throw new ApprovalNotFoundError(id);
    return { ...this.row };
  }

  async requireByVersion(
    _tx: never,
    _c: TenantContext,
    deliverableVersionId: string,
  ): Promise<ApprovalRow> {
    if (deliverableVersionId !== this.row.deliverableVersionId) {
      throw new ApprovalNotFoundError(deliverableVersionId);
    }
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
  async requireById(_tx: never, _c: TenantContext, id: string): Promise<DeliverableVersionRow> {
    // Faithful to the real repository: an absent (or cross-tenant, scoped-out) version is a
    // typed not-found, not a bare Error — that is what the service maps to 404.
    if (!this.latest) throw new DeliverableVersionNotFoundError(id);
    return this.latest;
  }
}

function service(approvals: FakeApprovals, versions: FakeVersions): ApprovalsService {
  // These cases exercise decide/open only; the client-projections repository is never reached,
  // so a bare stand-in keeps the fakes-only posture without a query path.
  return new ApprovalsService(
    fakeDatabase(),
    approvals as unknown as ApprovalsRepository,
    versions as unknown as DeliverableVersionsRepository,
    {} as unknown as ClientProjectionsRepository,
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

  it('maps a missing or cross-tenant approval to a 404 ApiError, not a raw 500 (requireById miss)', async () => {
    // The row exists under id …aa1; the caller names a different id — a genuine not-found, and
    // the same path a cross-tenant caller hits since the scoped read reports another tenant's
    // row as absent. Before the fix this ApprovalNotFoundError escaped to the filter's 500.
    const approvals = new FakeApprovals(approvalRow());
    const svc = service(approvals, new FakeVersions(versionRow(HASH_A)));

    const error = await svc
      .decide(context, reviewer(REVIEWER), '00000000-0000-7000-8000-0000000000ff', {
        decision: 'approve',
        expectedVersion: 1,
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('not_found');
    // The body is indistinguishable from any other not-found: the shared message, no details.
    expect((error as ApiError).message).toBe(MESSAGES.notFound);
    expect((error as ApiError).details).toBeUndefined();
    expect(approvals.current().state).toBe('requested');
  });
});

// ── Client deep-link decide (x101) ────────────────────────────────────────────

const CLIENT_ORG = '00000000-0000-7000-8000-0000000000c9';
const CLIENT_CONTACT = '00000000-0000-7000-8000-0000000000f9';

/**
 * A client reviewer. Holds `approval.decide` in its ceiling; the object-layer gate is the role
 * ceiling plus the project relation (`projectIds`). The projection's `approvedContacts` is a
 * client-visible display field, not an authorization list, so it does not gate the decision.
 */
function clientReviewer(userId: string, overrides: Partial<Principal> = {}): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'client',
    role: 'client_reviewer',
    membershipId: '00000000-0000-7000-8000-000000000009',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
    ...overrides,
  };
}

function projectionRow(approvedContacts: readonly string[]): ClientProjectionRow {
  return {
    id: '00000000-0000-7000-8000-000000000cc1',
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: DELIVERABLE,
    deliverableVersionId: VERSION,
    contentHash: HASH_A,
    projection: {
      title: 'Homepage hero',
      summary: null,
      milestoneState: null,
      forecastDate: null,
      publishedRisk: null,
      decision: null,
      approvedContacts: [...approvedContacts],
    },
    publishedByUserId: REVIEWER,
    publishedAt: new Date('2026-09-20T00:00:00.000Z'),
  };
}

/** An in-memory projections repository keyed on the governed version, like the real one. */
class FakeProjections {
  constructor(private readonly row: ClientProjectionRow | null) {}
  async requireByVersion(
    _tx: never,
    _c: TenantContext,
    deliverableVersionId: string,
  ): Promise<ClientProjectionRow> {
    if (!this.row || deliverableVersionId !== this.row.deliverableVersionId) {
      throw new ClientProjectionNotFoundError(deliverableVersionId);
    }
    return this.row;
  }
}

function clientService(
  approvals: FakeApprovals,
  versions: FakeVersions,
  projections: FakeProjections,
): ApprovalsService {
  return new ApprovalsService(
    fakeDatabase(),
    approvals as unknown as ApprovalsRepository,
    versions as unknown as DeliverableVersionsRepository,
    projections as unknown as ClientProjectionsRepository,
  );
}

describe('ApprovalsService.clientDecide', () => {
  it('persists an approval when an approved client contact on the relation decides', async () => {
    const approvals = new FakeApprovals(approvalRow({ reviewerIds: [CLIENT_CONTACT] }));
    const svc = clientService(
      approvals,
      new FakeVersions(versionRow(HASH_A)),
      new FakeProjections(projectionRow([CLIENT_CONTACT])),
    );

    const view = await svc.clientDecide(context, clientReviewer(CLIENT_CONTACT), VERSION, {
      decision: 'approve',
    });

    expect(view.state).toBe('approved');
    expect(view.deliverableVersionId).toBe(VERSION);
    expect(view.decidedAt).not.toBeNull();
    // The actor is recorded on the row as the client contact — via the existing decide fields.
    expect(approvals.current().state).toBe('approved');
    expect(approvals.current().decidedByUserId).toBe(CLIENT_CONTACT);
  });

  it('records the note when a client requests changes', async () => {
    const approvals = new FakeApprovals(approvalRow({ reviewerIds: [CLIENT_CONTACT] }));
    const svc = clientService(
      approvals,
      new FakeVersions(versionRow(HASH_A)),
      new FakeProjections(projectionRow([CLIENT_CONTACT])),
    );

    const view = await svc.clientDecide(context, clientReviewer(CLIENT_CONTACT), VERSION, {
      decision: 'request_changes',
      feedback: 'Please soften the headline.',
    });

    expect(view.state).toBe('changes_requested');
    expect(view.feedback).toBe('Please soften the headline.');
    expect(approvals.current().state).toBe('changes_requested');
  });

  it('refuses a client who is not on the project relation, writing nothing (object layer)', async () => {
    const approvals = new FakeApprovals(approvalRow({ reviewerIds: [CLIENT_CONTACT] }));
    const svc = clientService(
      approvals,
      new FakeVersions(versionRow(HASH_A)),
      new FakeProjections(projectionRow([CLIENT_CONTACT])),
    );

    const error = await svc
      .clientDecide(context, clientReviewer(CLIENT_CONTACT, { projectIds: [] }), VERSION, {
        decision: 'approve',
      })
      .catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).auditCode).toBe('not_project_member');
    expect(approvals.current().state).toBe('requested');
    expect(approvals.current().decidedByUserId).toBeNull();
  });

  it('refuses a client viewer whose role has no approval.decide ceiling', async () => {
    const approvals = new FakeApprovals(approvalRow({ reviewerIds: [CLIENT_CONTACT] }));
    const svc = clientService(
      approvals,
      new FakeVersions(versionRow(HASH_A)),
      new FakeProjections(projectionRow([CLIENT_CONTACT])),
    );

    const error = await svc
      .clientDecide(context, clientReviewer(CLIENT_CONTACT, { role: 'client_viewer' }), VERSION, {
        decision: 'approve',
      })
      .catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).auditCode).toBe('capability_not_in_role_ceiling');
    expect(approvals.current().state).toBe('requested');
  });

  it('maps a cross-tenant client with an unknown version to 404, never a 500, and writes nothing (Known trap)', async () => {
    const approvals = new FakeApprovals(approvalRow({ reviewerIds: [CLIENT_CONTACT] }));
    const svc = clientService(
      approvals,
      new FakeVersions(versionRow(HASH_A)),
      new FakeProjections(projectionRow([CLIENT_CONTACT])),
    );

    const error = await svc
      .clientDecide(
        context,
        clientReviewer(CLIENT_CONTACT, { organizationId: OTHER_ORG }),
        '00000000-0000-7000-8000-0000000000ee',
        { decision: 'approve' },
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('not_found');
    expect((error as ApiError).message).toBe(MESSAGES.notFound);
    expect((error as ApiError).details).toBeUndefined();
    expect(approvals.current().state).toBe('requested');
  });

  it('refuses a second decision on an already-decided version (append-only)', async () => {
    const approvals = new FakeApprovals(
      approvalRow({ state: 'approved', version: 3, reviewerIds: [CLIENT_CONTACT] }),
    );
    const svc = clientService(
      approvals,
      new FakeVersions(versionRow(HASH_A)),
      new FakeProjections(projectionRow([CLIENT_CONTACT])),
    );

    const error = await svc
      .clientDecide(context, clientReviewer(CLIENT_CONTACT), VERSION, { decision: 'approve' })
      .catch((e: unknown) => e);

    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).auditCode).toBe('approval_terminal');
  });
});

describe('ApprovalsService.open', () => {
  it('maps a missing or cross-tenant deliverable version to a 404 ApiError, not a raw 500', async () => {
    // The version read is tenant-scoped, so another tenant's version — or a nonexistent one —
    // is a typed not-found. Before the fix open had no catch and it escaped to the filter's 500.
    const approvals = new FakeApprovals(approvalRow());
    const svc = service(approvals, new FakeVersions(null));

    const error = await svc
      .open(context, reviewer(REVIEWER), {
        deliverableVersionId: VERSION,
        reviewerIds: [REVIEWER],
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).code).toBe('not_found');
    expect((error as ApiError).message).toBe(MESSAGES.notFound);
    expect((error as ApiError).details).toBeUndefined();
  });
});

// ── Q3: the team is told, and the decision is audited ──────────────────────────

const SENDER = '00000000-0000-7000-8000-0000000000f7';

function recorders() {
  return {
    outbox: { append: vi.fn() },
    audit: {
      record: vi.fn(async (_t: unknown, _c: unknown, input: { metadata: unknown }) => {
        assertSafeAuditMetadata(input.metadata);
      }),
    },
  };
}

function wiredService(approvals: FakeApprovals, versions: FakeVersions) {
  const { outbox, audit } = recorders();
  const published = { ...projectionRow([CLIENT_CONTACT]), publishedByUserId: SENDER };
  const projections = {
    requireByVersion: async () => published,
    findByVersion: async () => published,
  };
  const svc = new ApprovalsService(
    fakeDatabase(),
    approvals as unknown as ApprovalsRepository,
    versions as unknown as DeliverableVersionsRepository,
    projections as unknown as ClientProjectionsRepository,
    outbox as never,
    audit as never,
  );
  return { svc, outbox, audit };
}

describe('ApprovalsService decisions (Q3)', () => {
  it('a client approval appends approval.decided.v1 for the sender and an approval.approved row', async () => {
    const { svc, outbox, audit } = wiredService(
      new FakeApprovals(approvalRow({ reviewerIds: [CLIENT_CONTACT] })),
      new FakeVersions(versionRow(HASH_A)),
    );
    await svc.clientDecide(context, clientReviewer(CLIENT_CONTACT), VERSION, {
      decision: 'approve',
    });

    expect(outbox.append).toHaveBeenCalledOnce();
    expect(outbox.append.mock.calls[0]?.[2]).toEqual({
      type: 'approval.decided.v1',
      aggregateId: approvalRow().id,
      payload: {
        approvalId: approvalRow().id,
        deliverableId: DELIVERABLE,
        deliverableVersionId: VERSION,
        projectId: PROJECT,
        decision: 'approved',
        decidedByUserId: CLIENT_CONTACT,
        requestedByUserId: SENDER,
      },
    });
    expect(audit.record.mock.calls[0]?.[2]).toEqual({
      action: 'approval.approved',
      objectId: approvalRow().id,
      result: 'allowed',
      metadata: {
        deliverable_id: DELIVERABLE,
        deliverable_version_id: VERSION,
        project_id: PROJECT,
      },
    });
  });

  it('a staff change request records approval.changes_requested and never the feedback', async () => {
    const { svc, outbox, audit } = wiredService(
      new FakeApprovals(approvalRow()),
      new FakeVersions(versionRow(HASH_A)),
    );
    await svc.decide(context, reviewer(REVIEWER), approvalRow().id, {
      decision: 'request_changes',
      expectedVersion: 1,
      feedback: 'Tighten the hero headline.',
    });

    expect(outbox.append.mock.calls[0]?.[2]).toMatchObject({
      payload: { decision: 'changes_requested', requestedByUserId: SENDER },
    });
    expect(audit.record.mock.calls[0]?.[2]).toMatchObject({ action: 'approval.changes_requested' });
    expect(JSON.stringify([outbox.append.mock.calls, audit.record.mock.calls])).not.toContain(
      'Tighten',
    );
  });

  it('an invalidated decision (governed content changed) tells nobody and writes no decision row', async () => {
    const { svc, outbox, audit } = wiredService(
      new FakeApprovals(approvalRow({ contentHash: HASH_A })),
      new FakeVersions(versionRow(HASH_B)),
    );
    const view = await svc.decide(context, reviewer(REVIEWER), approvalRow().id, {
      decision: 'approve',
      expectedVersion: 1,
    });

    expect(view.state).toBe('invalidated');
    expect(outbox.append).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
