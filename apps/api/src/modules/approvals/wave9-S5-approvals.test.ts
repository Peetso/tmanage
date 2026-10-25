import { describe, expect, it, vi } from 'vitest';
import { approvalStateMachine } from '@tmanage/domain';
import type { ApprovalState, Principal, RecordedReviewerDecision } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type {
  ApprovalRow,
  ClientProjectionRow,
  DeliverableVersionRow,
} from '../../common/database/schema.js';
import { ApprovalsService } from './approvals.service.js';
import {
  ApprovalNotFoundError,
  ApprovalTransitionError,
  ApprovalVersionConflictError,
} from './approvals.repository.js';
import type {
  ApprovalDecisionFacts,
  ApprovalsRepository,
  InternalReviewerCandidate,
} from './approvals.repository.js';
import { DeliverableVersionNotFoundError } from './deliverable-versions.repository.js';
import type { DeliverableVersionsRepository } from './deliverable-versions.repository.js';
import { ClientProjectionNotFoundError } from './client-projections.repository.js';
import type { ClientProjectionsRepository } from './client-projections.repository.js';

/**
 * Wave 9 S5 — regression proofs for audit run 1 findings F14, F15, F16 and F17, each reproducing the
 * audit's exploit step against the real service, the real `authorize()` and the real state machine
 * over in-memory repositories, plus the legitimate path that must keep working.
 */

const ORG = '00000000-0000-7000-8000-0000000000a1';
const PROJECT = '00000000-0000-7000-8000-0000000000c1';
const DELIVERABLE = '00000000-0000-7000-8000-0000000000d1';
const V1 = '00000000-0000-7000-8000-0000000000e1';
const V2 = '00000000-0000-7000-8000-0000000000e2';
const ALICE = '00000000-0000-7000-8000-0000000000f1'; // manager, sends
const MALLORY = '00000000-0000-7000-8000-0000000000f2'; // member, not a reviewer
const REV_A = '00000000-0000-7000-8000-0000000000f3'; // member reviewer
const REV_B = '00000000-0000-7000-8000-0000000000f4'; // member reviewer
const CAROL = '00000000-0000-7000-8000-0000000000f5'; // chosen client approver
const DAVE = '00000000-0000-7000-8000-0000000000f6'; // client member, not chosen
const CLIENT_ORG = '00000000-0000-7000-8000-0000000000c9';
const HASH = 'a'.repeat(64);

const context = { organizationId: ORG, userId: ALICE } as TenantContext;

function internal(userId: string, role: Principal['role']): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: `m-${userId}`,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

function client(userId: string, role: Principal['role'] = 'client_reviewer'): Principal {
  return {
    userId,
    organizationId: ORG,
    kind: 'client',
    role,
    membershipId: `m-${userId}`,
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

function version(id: string, versionNo: number): DeliverableVersionRow {
  return {
    id,
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: DELIVERABLE,
    versionNo,
    contentHash: HASH,
    fileAssetId: null,
    fileVersionId: null,
    note: null,
    createdByUserId: ALICE,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
  };
}

let seq = 0;
function approval(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
  seq += 1;
  return {
    id: `00000000-0000-7000-8000-${seq.toString().padStart(12, '0')}`,
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: DELIVERABLE,
    deliverableVersionId: V1,
    contentHash: HASH,
    state: 'requested',
    policy: 'all_required',
    reviewerIds: [CAROL],
    decidedByUserId: null,
    decidedAt: null,
    feedback: null,
    invalidationReason: null,
    version: 1,
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
    updatedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
    ...overrides,
  };
}

/** One in-memory tenant: approvals, per-reviewer decisions, versions, projection and people. */
function world(options: {
  readonly approvals?: ApprovalRow[];
  readonly versions?: DeliverableVersionRow[];
  readonly people?: Record<string, string>;
}) {
  const rows: ApprovalRow[] = [...(options.approvals ?? [])];
  const decisions = new Map<string, RecordedReviewerDecision[]>();
  const versions = options.versions ?? [version(V1, 1)];
  const people: Record<string, string> = options.people ?? {
    [ALICE]: 'manager',
    [MALLORY]: 'member',
    [REV_A]: 'member',
    [REV_B]: 'member',
  };

  const find = (id: string) => rows.find((r) => r.id === id) ?? null;
  const byVersion = (versionId: string) =>
    rows
      .filter((r) => r.deliverableVersionId === versionId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const approvalsRepo = {
    findById: async (_t: unknown, _c: TenantContext, id: string) => find(id),
    requireById: async (_t: unknown, _c: TenantContext, id: string) => {
      const row = find(id);
      if (!row) throw new ApprovalNotFoundError(id);
      return { ...row };
    },
    findByVersion: async (_t: unknown, _c: TenantContext, v: string) => byVersion(v)[0] ?? null,
    requireByVersion: async (_t: unknown, _c: TenantContext, v: string) => {
      const row = byVersion(v)[0];
      if (!row) throw new ApprovalNotFoundError(v);
      return { ...row };
    },
    listByVersion: async (_t: unknown, _c: TenantContext, v: string) => byVersion(v),
    open: vi.fn(
      async (
        _t: unknown,
        _c: TenantContext,
        input: { deliverableVersionId: string; reviewerIds: readonly string[] },
      ) => {
        const row = approval({
          deliverableVersionId: input.deliverableVersionId,
          reviewerIds: [...input.reviewerIds],
        });
        rows.push(row);
        return { ...row };
      },
    ),
    transition: async (
      _t: unknown,
      _c: TenantContext,
      id: string,
      expectedVersion: number,
      to: ApprovalState,
      facts: ApprovalDecisionFacts = {},
    ) => {
      const row = find(id);
      if (!row) throw new ApprovalNotFoundError(id);
      const from = row.state as ApprovalState;
      const verdict = approvalStateMachine.transition(from, to, {
        decidedByUserId: facts.decidedByUserId ?? null,
        decidedAt: facts.decidedAt ?? null,
        contentHash: facts.contentHash ?? null,
        feedback: facts.feedback ?? null,
        invalidationReason: facts.invalidationReason ?? null,
      });
      if (!verdict.ok) {
        throw new ApprovalTransitionError(
          from,
          to,
          verdict.reason,
          verdict.missing,
          verdict.detail,
        );
      }
      if (row.version !== expectedVersion) throw new ApprovalVersionConflictError(id, row.version);
      Object.assign(row, {
        state: to,
        version: row.version + 1,
        ...(facts.decidedByUserId !== undefined ? { decidedByUserId: facts.decidedByUserId } : {}),
        ...(facts.decidedAt !== undefined ? { decidedAt: facts.decidedAt } : {}),
        ...(facts.feedback !== undefined ? { feedback: facts.feedback } : {}),
      });
      return { ...row };
    },
    touch: async (_t: unknown, _c: TenantContext, id: string, expectedVersion: number) => {
      const row = find(id);
      if (!row) throw new ApprovalNotFoundError(id);
      if (row.version !== expectedVersion) throw new ApprovalVersionConflictError(id, row.version);
      row.version += 1;
      return { ...row };
    },
    reviewerDecisions: async (_t: unknown, _c: TenantContext, id: string) => [
      ...(decisions.get(id) ?? []),
    ],
    recordReviewerDecision: async (
      _t: unknown,
      _c: TenantContext,
      input: {
        approvalId: string;
        reviewerUserId: string;
        decision: RecordedReviewerDecision['decision'];
      },
    ) => {
      const list = decisions.get(input.approvalId) ?? [];
      list.push({ reviewerUserId: input.reviewerUserId, decision: input.decision });
      decisions.set(input.approvalId, list);
    },
    internalReviewerCandidates: async (
      _t: unknown,
      _c: TenantContext,
      _projectId: string,
      userIds: readonly string[],
    ): Promise<readonly InternalReviewerCandidate[]> =>
      userIds.flatMap((userId) => (people[userId] ? [{ userId, role: people[userId] }] : [])),
  };

  const versionsRepo = {
    requireById: async (_t: unknown, _c: TenantContext, id: string) => {
      const row = versions.find((v) => v.id === id);
      if (!row) throw new DeliverableVersionNotFoundError(id);
      return row;
    },
    latestForDeliverable: async () =>
      [...versions].sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))[0] ?? null,
  };

  const projection: ClientProjectionRow = {
    id: 'p-1',
    organizationId: ORG,
    projectId: PROJECT,
    deliverableId: DELIVERABLE,
    deliverableVersionId: V1,
    contentHash: HASH,
    projection: {
      title: 'Homepage · v1',
      summary: null,
      milestoneState: null,
      forecastDate: null,
      publishedRisk: null,
      decision: null,
      approvedContacts: [],
    },
    publishedByUserId: ALICE,
    publishedAt: new Date('2026-10-01T00:00:00.000Z'),
  };
  const projectionsRepo = {
    requireByVersion: async (_t: unknown, _c: TenantContext, v: string) => {
      if (v !== projection.deliverableVersionId) throw new ClientProjectionNotFoundError(v);
      return projection;
    },
    findByVersion: async () => projection,
  };

  const database = {
    transaction: <T>(_c: TenantContext, work: (tx: never) => Promise<T>) => work({} as never),
  } as unknown as TenantDatabase;
  const outbox = { append: vi.fn() };
  const service = new ApprovalsService(
    database,
    approvalsRepo as unknown as ApprovalsRepository,
    versionsRepo as unknown as DeliverableVersionsRepository,
    projectionsRepo as unknown as ClientProjectionsRepository,
    outbox as never,
  );
  return { service, rows, decisions, outbox, approvalsRepo };
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

// ── F14 ───────────────────────────────────────────────────────────────────────

describe('F14 — the client decision route binds to the named client approvers', () => {
  it('refuses an internal non-reviewer (404) and writes nothing', async () => {
    const sent = approval({ reviewerIds: [CAROL] });
    const { service, rows, decisions } = world({ approvals: [sent] });

    const error = await refusal(
      service.clientDecide(context, internal(MALLORY, 'member'), V1, { decision: 'approve' }),
    );
    expect(error.status).toBe(404);
    expect(error.auditCode).toBe('not_a_client_principal');
    expect(rows[0]?.state).toBe('requested');
    expect(rows[0]?.decidedByUserId).toBeNull();
    expect(decisions.size).toBe(0);
  });

  it('refuses a client member who was not chosen as approver (404) and writes nothing', async () => {
    const { service, rows, decisions } = world({ approvals: [approval({ reviewerIds: [CAROL] })] });

    const error = await refusal(
      service.clientDecide(context, client(DAVE, 'client_member'), V1, { decision: 'approve' }),
    );
    expect(error.status).toBe(404);
    expect(error.auditCode).toBe('not_assigned_reviewer');
    expect(rows[0]?.state).toBe('requested');
    expect(decisions.size).toBe(0);
  });

  it('the chosen client approver still decides', async () => {
    const { service, rows } = world({ approvals: [approval({ reviewerIds: [CAROL] })] });

    const view = await service.clientDecide(context, client(CAROL), V1, { decision: 'approve' });
    expect(view.state).toBe('approved');
    expect(rows[0]?.decidedByUserId).toBe(CAROL);
  });
});

// ── F15 ───────────────────────────────────────────────────────────────────────

describe('F15 — several reviewers are counted by the approval policy', () => {
  it('all_required: B alone does not approve; A then completes it', async () => {
    const opened = approval({ reviewerIds: [REV_A, REV_B], policy: 'all_required' });
    const { service, rows, outbox } = world({ approvals: [opened] });

    const afterB = await service.decide(context, internal(REV_B, 'member'), opened.id, {
      decision: 'approve',
      expectedVersion: 1,
    });
    expect(afterB.state).toBe('viewed');
    expect(afterB.decidedByUserId).toBeNull();
    expect(outbox.append).not.toHaveBeenCalled();

    const afterA = await service.decide(context, internal(REV_A, 'member'), opened.id, {
      decision: 'approve',
      expectedVersion: afterB.version,
    });
    expect(afterA.state).toBe('approved');
    expect(afterA.decidedByUserId).toBe(REV_A);
    expect(rows[0]?.state).toBe('approved');
    expect(outbox.append).toHaveBeenCalledOnce();
  });

  it('all_required: the same reviewer cannot decide twice (409)', async () => {
    const opened = approval({ reviewerIds: [REV_A, REV_B] });
    const { service, decisions } = world({ approvals: [opened] });
    const first = await service.decide(context, internal(REV_B, 'member'), opened.id, {
      decision: 'approve',
      expectedVersion: 1,
    });

    const error = await refusal(
      service.decide(context, internal(REV_B, 'member'), opened.id, {
        decision: 'approve',
        expectedVersion: first.version,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.auditCode).toBe('reviewer_already_decided');
    expect(decisions.get(opened.id)).toHaveLength(1);
  });

  it('ordered_sequence: the second reviewer deciding first is refused (409), nothing recorded', async () => {
    const opened = approval({ reviewerIds: [REV_A, REV_B], policy: 'ordered_sequence' });
    const { service, rows, decisions } = world({ approvals: [opened] });

    const error = await refusal(
      service.decide(context, internal(REV_B, 'member'), opened.id, {
        decision: 'approve',
        expectedVersion: 1,
      }),
    );
    expect(error.status).toBe(409);
    expect(error.auditCode).toBe('reviewer_out_of_turn');
    expect(rows[0]?.state).toBe('requested');
    expect(decisions.size).toBe(0);
  });

  it('any_one: the first decision is still final', async () => {
    const opened = approval({ reviewerIds: [REV_A, REV_B], policy: 'any_one' });
    const { service } = world({ approvals: [opened] });

    const view = await service.decide(context, internal(REV_B, 'member'), opened.id, {
      decision: 'approve',
      expectedVersion: 1,
    });
    expect(view.state).toBe('approved');
  });

  it('client route: one of two required client approvers leaves the approval waiting', async () => {
    const { service, rows } = world({ approvals: [approval({ reviewerIds: [CAROL, DAVE] })] });

    const view = await service.clientDecide(context, client(CAROL), V1, { decision: 'approve' });
    expect(view.state).toBe('viewed');
    expect(rows[0]?.decidedByUserId).toBeNull();

    const last = await service.clientDecide(context, client(DAVE, 'client_member'), V1, {
      decision: 'approve',
    });
    expect(last.state).toBe('approved');
  });
});

// ── F16 / F17 ─────────────────────────────────────────────────────────────────

describe('F16/F17 — opening an approval follows the send rules', () => {
  it('F16: a version the client already approved cannot be re-opened (409 approval_terminal)', async () => {
    const decided = approval({ state: 'approved', decidedByUserId: CAROL, decidedAt: new Date() });
    const { service, rows } = world({ approvals: [decided] });

    const error = await refusal(
      service.open(context, internal(ALICE, 'manager'), {
        deliverableVersionId: V1,
        reviewerIds: [REV_A],
      }),
    );
    expect(error.status).toBe(409);
    expect(error.auditCode).toBe('approval_terminal');
    expect(rows).toHaveLength(1);
  });

  it('F17: a version waiting for the client cannot get a second approval, and the client still decides', async () => {
    const sent = approval({ reviewerIds: [CAROL] });
    const { service, rows } = world({ approvals: [sent] });

    const error = await refusal(
      service.open(context, internal(ALICE, 'manager'), {
        deliverableVersionId: V1,
        reviewerIds: [REV_A],
      }),
    );
    expect(error.status).toBe(409);
    expect(error.auditCode).toBe('approval_pending');
    expect(rows).toHaveLength(1);

    const view = await service.clientDecide(context, client(CAROL), V1, { decision: 'approve' });
    expect(view.state).toBe('approved');
    expect(rows[0]?.decidedByUserId).toBe(CAROL);
  });

  it('a superseded version cannot be opened (409 version_superseded)', async () => {
    const { service, rows } = world({ versions: [version(V1, 1), version(V2, 2)] });

    const error = await refusal(
      service.open(context, internal(ALICE, 'manager'), {
        deliverableVersionId: V1,
        reviewerIds: [REV_A],
      }),
    );
    expect(error.status).toBe(409);
    expect(error.auditCode).toBe('version_superseded');
    expect(rows).toHaveLength(0);
  });

  it('F17: the requester cannot name themselves as reviewer (422)', async () => {
    const { service, rows } = world({});

    const error = await refusal(
      service.open(context, internal(ALICE, 'manager'), {
        deliverableVersionId: V1,
        reviewerIds: [ALICE],
      }),
    );
    expect(error.status).toBe(422);
    expect(error.auditCode).toBe('approval_self_review');
    expect(rows).toHaveLength(0);
  });

  it('F17: a member without deliverable.publish cannot open an approval', async () => {
    const { service, rows } = world({});

    const error = await refusal(
      service.open(context, internal(MALLORY, 'member'), {
        deliverableVersionId: V1,
        reviewerIds: [REV_A],
      }),
    );
    expect(error.status).toBe(404);
    expect(error.auditCode).toBe('capability_not_in_role_ceiling');
    expect(rows).toHaveLength(0);
  });

  it('reviewers must be project members who can approve (422 for a client id or a stranger)', async () => {
    const { service, rows } = world({});

    for (const outsider of [CAROL, '00000000-0000-7000-8000-0000000000ff']) {
      const error = await refusal(
        service.open(context, internal(ALICE, 'manager'), {
          deliverableVersionId: V1,
          reviewerIds: [REV_A, outsider],
        }),
      );
      expect(error.status).toBe(422);
      expect(error.auditCode).toBe('approval_reviewer_ineligible');
    }
    expect(rows).toHaveLength(0);
  });

  it('a manager still opens a staff review for eligible project members', async () => {
    const { service, rows } = world({});

    const view = await service.open(context, internal(ALICE, 'manager'), {
      deliverableVersionId: V1,
      reviewerIds: [REV_A, REV_B],
    });
    expect(view.state).toBe('requested');
    expect(view.reviewerIds).toEqual([REV_A, REV_B]);
    expect(rows).toHaveLength(1);
  });
});
